import { afterEach, describe, expect, it } from "vitest";
import Ws, { WebSocketServer } from "ws";
import { AgentClient } from "../lib/agentClient";
import { ConsoleStore } from "../lib/store";
import type { ServerMessage } from "../lib/protocol";

type ClientFrame = Record<string, unknown>;

class NodeWebSocketCompat {
  static OPEN = Ws.OPEN;

  private socket: Ws;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.socket = new Ws(url);
    this.socket.on("open", () => this.onopen?.());
    this.socket.on("message", (data) => this.onmessage?.({ data: data.toString() }));
    this.socket.on("close", () => this.onclose?.());
    this.socket.on("error", () => this.onerror?.());
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(): void {
    this.socket.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error("Timed out waiting for condition");
}

function send(ws: Ws, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function parse(raw: Ws.RawData): ClientFrame {
  const text = raw.toString();
  return JSON.parse(text) as ClientFrame;
}

describe("deterministic reconnect/replay handling", () => {
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    if (originalWebSocket) globalThis.WebSocket = originalWebSocket;
  });

  it("resumes first, replays missed events safely, ACKs tools, and PONGs empty challenges", async () => {
    globalThis.WebSocket = NodeWebSocketCompat as unknown as typeof WebSocket;

    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server port");

    const clientFrames: ClientFrame[] = [];
    const framesByConnection: ClientFrame[][] = [];
    const connections: Ws[] = [];
    server.on("connection", (ws) => {
      const framesForConnection: ClientFrame[] = [];
      connections.push(ws);
      framesByConnection.push(framesForConnection);
      ws.on("message", (raw) => {
        const frame = parse(raw);
        clientFrames.push(frame);
        framesForConnection.push(frame);
      });
    });

    const store = new ConsoleStore();
    const client = new AgentClient(`ws://127.0.0.1:${address.port}`, store);

    try {
      client.connect();
      await waitUntil(() => connections.length === 1);
      client.sendUserMessage("reconnect please");

      const first = connections[0];
      expect(first).toBeDefined();
      if (!first) return;

      send(first, { type: "TOKEN", seq: 1, stream_id: "s1", text: "Hello " });
      send(first, { type: "TOKEN", seq: 2, stream_id: "s1", text: "before " });
      send(first, {
        type: "TOOL_CALL",
        seq: 3,
        stream_id: "s1",
        call_id: "tc_1",
        tool_name: "lookup",
        args: { id: 42 },
      });

      await waitUntil(() => clientFrames.some((f) => f.type === "TOOL_ACK" && f.call_id === "tc_1"));
      first.terminate();

      await waitUntil(() => connections.length === 2);
      const second = connections[1];
      expect(second).toBeDefined();
      if (!second) return;

      await waitUntil(() => clientFrames.some((f) => f.type === "RESUME"));
      const secondConnectionFrames = framesByConnection[1] ?? [];
      expect(secondConnectionFrames[0]).toEqual({ type: "RESUME", last_seq: 3 });

      send(second, { type: "TOKEN", seq: 2, stream_id: "s1", text: "DUPLICATE " });
      send(second, { type: "TOKEN", seq: 6, stream_id: "s1", text: "done" });
      send(second, {
        type: "TOOL_RESULT",
        seq: 4,
        stream_id: "s1",
        call_id: "tc_1",
        result: { ok: true },
      });
      send(second, { type: "TOOL_RESULT", seq: 4, stream_id: "s1", call_id: "tc_1", result: { ok: false } });
      send(second, { type: "TOKEN", seq: 5, stream_id: "s1", text: "after " });
      send(second, { type: "PING", seq: 7, challenge: "" });
      send(second, { type: "STREAM_END", seq: 8, stream_id: "s1" });

      await waitUntil(() => {
        const last = store.messages[store.messages.length - 1];
        return last?.role === "assistant" && last.status === "done";
      });
      await waitUntil(() => clientFrames.some((f) => f.type === "PONG" && f.echo === ""));

      const last = store.messages[store.messages.length - 1];
      expect(last?.role).toBe("assistant");
      if (last?.role !== "assistant") return;

      expect(last.status).toBe("done");
      expect(last.segments).toHaveLength(3);
      expect(last.segments[0]).toMatchObject({ kind: "text", text: "Hello before " });
      expect(last.segments[1]).toMatchObject({
        kind: "tool",
        callId: "tc_1",
        toolName: "lookup",
        status: "done",
        result: { ok: true },
      });
      expect(last.segments[2]).toMatchObject({ kind: "text", text: "after done" });
      expect(store.connection.duplicatesDropped).toBe(2);
    } finally {
      client.disconnect();
      server.close();
    }
  }, 10_000);
});
