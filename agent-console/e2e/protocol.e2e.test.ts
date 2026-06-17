// End-to-end protocol compliance check. Runs the real AgentClient against a
// locally running agent-server (start it first), then inspects /log.
// Not part of `npm test` — run with: npx vitest run e2e/protocol.e2e.test.ts

import { describe, expect, it } from "vitest";
import { AgentClient } from "../lib/agentClient";
import { ConsoleStore } from "../lib/store";

const HTTP = process.env.AGENT_HTTP ?? "http://localhost:4747";
const WS = process.env.AGENT_WS ?? "ws://localhost:4747/ws";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("protocol compliance against live agent-server", () => {
  it("streams a tool-call script with correct ACKs and no violations", async () => {
    await fetch(`${HTTP}/reset`);
    const store = new ConsoleStore();
    const client = new AgentClient(WS, store);
    client.connect();
    await sleep(500);
    client.sendUserMessage("summarise the q3 report");

    // Wait for STREAM_END (status done) up to 60s.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const last = store.messages[store.messages.length - 1];
      if (last && last.role === "assistant" && last.status === "done") break;
      await sleep(250);
    }
    client.disconnect();

    const last = store.messages[store.messages.length - 1];
    expect(last?.role).toBe("assistant");
    if (last?.role !== "assistant") return;
    expect(last.status).toBe("done");

    // Stream must contain text + at least one completed tool segment.
    const toolSegs = last.segments.filter((s) => s.kind === "tool");
    expect(toolSegs.length).toBeGreaterThanOrEqual(1);
    for (const t of toolSegs) {
      if (t.kind === "tool") expect(t.status).toBe("done");
    }

    // Server-side verdicts: no violations, TOOL_ACK ok.
    const log = (await (await fetch(`${HTTP}/log`)).json()) as Array<{
      type: string;
      verdict?: string;
    }>;
    const violations = log.filter((e) => e.verdict === "violation");
    expect(violations).toEqual([]);
    const acks = log.filter((e) => e.type === "TOOL_ACK" && e.verdict === "ok");
    expect(acks.length).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
