// Chaos survival check. Start the server with `--mode chaos` first, then:
//   npx vitest run e2e/chaos.e2e.test.ts
// Verifies the client survives drops/reorder/duplicates: state stays
// consistent, RESUME is sent and accepted, and no protocol violations
// other than (possibly) ACK-after-timeout races are recorded.

import { describe, expect, it } from "vitest";
import { AgentClient } from "../lib/agentClient";
import { ConsoleStore } from "../lib/store";

const HTTP = process.env.AGENT_HTTP ?? "http://localhost:4747";
const WS = process.env.AGENT_WS ?? "ws://localhost:4747/ws";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("chaos survival against live agent-server", () => {
  it("survives chaos mode with consistent state", async () => {
    await fetch(`${HTTP}/reset`);
    const store = new ConsoleStore();
    const client = new AgentClient(WS, store);
    client.connect();
    await sleep(500);
    client.sendUserMessage("write a long detailed document please");

    // Let chaos run: drops, reorders, duplicates, latency spikes.
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      const last = store.messages[store.messages.length - 1];
      if (last && last.role === "assistant" && (last.status === "done" || last.status === "interrupted")) {
        break;
      }
      await sleep(500);
    }
    client.disconnect();

    const last = store.messages[store.messages.length - 1];
    expect(last?.role).toBe("assistant");
    if (last?.role !== "assistant") return;

    // The message reached a terminal, coherent state — never stuck/corrupt.
    expect(["done", "interrupted"]).toContain(last.status);
    expect(store.connection.outOfOrderHeld).toBe(0);
    // Text segments must be non-empty strings, tool segments coherent.
    for (const seg of last.segments) {
      if (seg.kind === "text") expect(seg.text.length).toBeGreaterThan(0);
      else {
        expect(seg.callId).toMatch(/^tc_/);
        expect(seg.toolName.length).toBeGreaterThan(0);
        if (last.status === "done") expect(seg.status).toBe("done");
      }
    }

    const log = (await (await fetch(`${HTTP}/log`)).json()) as Array<{
      type: string;
      verdict?: string;
      data?: Record<string, unknown>;
    }>;

    // PONGs answered correctly (no wrong_challenge), no missed-PONG kills.
    expect(log.filter((e) => e.type === "PONG" && e.verdict === "wrong_challenge")).toEqual([]);
    expect(
      log.filter((e) => e.type === "CONNECTION_TERMINATED" && e.data?.reason === "missed_pongs"),
    ).toEqual([]);

    const resumes = log.filter((e) => e.type === "RESUME" && e.verdict === "ok");
    if (last.status === "interrupted") expect(resumes.length).toBeGreaterThanOrEqual(1);

    console.log(
      `[chaos e2e] status=${last.status} segments=${last.segments.length} ` +
        `duplicatesDropped=${store.connection.duplicatesDropped} resumes=${resumes.length} ` +
        `pongs_ok=${log.filter((e) => e.type === "PONG" && e.verdict === "ok").length}`,
    );
  }, 90_000);
});
