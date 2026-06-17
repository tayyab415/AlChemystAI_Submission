import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentClient } from "../agentClient";
import { ConsoleStore } from "../store";
import type { ServerMessage } from "../protocol";

type FakeMessageEvent = { data: string };

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: FakeMessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }

  receive(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe("AgentClient watchdogs", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalWebSocket) globalThis.WebSocket = originalWebSocket;
  });

  it("does not mark a slow connected stream interrupted before any reconnect", async () => {
    const store = new ConsoleStore();
    const client = new AgentClient("ws://test/ws", store);
    client.connect();

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket?.open();
    client.sendUserMessage("slow response");
    socket?.receive({ type: "TOKEN", seq: 1, stream_id: "s1", text: "still working" });

    await vi.advanceTimersByTimeAsync(16_000);

    const last = store.messages[store.messages.length - 1];
    expect(last?.role).toBe("assistant");
    if (last?.role !== "assistant") return;
    expect(last.status).toBe("streaming");
    expect(store.trace.some((row) => row.kind === "event" && /stream marked interrupted/.test(row.summary))).toBe(
      false,
    );

    client.disconnect();
  });
});
