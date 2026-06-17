// AgentClient — WebSocket connection lifecycle + protocol side effects.
//
// State machine:
//
//   idle ──connect()──▶ connecting ──open──▶ connected
//     ▲                     │                   │
//     │                  error/close         close/error/heartbeat-timeout
//     │                     ▼                   ▼
//     └──disconnect()── reconnecting ◀──────────┘
//                          │  backoff: 500ms → 1s → 2s → 4s → 10s (cap)
//                          └──timer──▶ connecting (on open: RESUME first)
//
// Responsibilities:
//  - PONG every PING immediately on receipt (even if the PING frame is
//    out-of-order — the 3s deadline must not wait on gap filling).
//  - TOOL_ACK when a TOOL_CALL is processed; early-ACK if one is stuck
//    behind a seq gap for >1.2s (the 2s ACK deadline beats strict ordering).
//  - RESUME with the highest fully-processed seq, sent as the very first
//    frame on a reconnected socket.
//  - Feed every frame through the ReorderBuffer; apply ready messages to
//    the store in seq order.
//  - Watchdogs: dead-socket detection (no traffic > 35s) and interrupted-
//    stream detection after a resume that yields no further progress.

import { parseServerMessage, type ClientMessage, type ServerMessage } from "./protocol";
import { ReorderBuffer } from "./reorderBuffer";
import type { ConsoleStore } from "./store";

const BACKOFF_MS = [500, 1000, 2000, 4000, 10000] as const;
const PONG_DEBOUNCE_MS = 40;
const ACK_GAP_RESCUE_MS = 1200;
const STALL_FORCE_FLUSH_MS = 12_000;
const DEAD_SOCKET_MS = 35_000;
const INTERRUPTED_STREAM_MS = 15_000;

export class AgentClient {
  private url: string;
  private store: ConsoleStore;
  private ws: WebSocket | null = null;
  private buffer = new ReorderBuffer();
  private hasEverConnected = false;
  private attempt = 0;
  private manuallyClosed = false;

  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private latestChallenge: string | null = null;
  private ackedCalls = new Set<string>();
  private ackRescueTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private deadSocketTimer: ReturnType<typeof setTimeout> | null = null;
  private interruptedTimer: ReturnType<typeof setTimeout> | null = null;
  private resumedThisTurn = false;

  constructor(url: string, store: ConsoleStore) {
    this.url = url;
    this.store = store;
  }

  connect(): void {
    this.manuallyClosed = false;
    this.openSocket();
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.store.setConnection({ status: "offline", nextRetryMs: null });
  }

  sendUserMessage(content: string): void {
    // The server resets seq/history on every USER_MESSAGE — mirror that.
    this.buffer.resetTurn();
    this.ackedCalls.clear();
    this.resumedThisTurn = false;
    this.clearInterruptedWatchdog();
    this.store.setConnection({ lastSeq: 0, outOfOrderHeld: 0 });
    this.store.addUserMessage(content);
    this.send({ type: "USER_MESSAGE", content });
  }

  // ── Socket lifecycle ─────────────────────────────────────────

  private openSocket(): void {
    this.clearRetry();
    this.store.setConnection({
      status: this.hasEverConnected ? "reconnecting" : "connecting",
      attempt: this.attempt,
      nextRetryMs: null,
    });

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      const reconnected = this.hasEverConnected;
      this.hasEverConnected = true;
      this.attempt = 0;
      this.store.setConnection({ status: "connected", attempt: 0, nextRetryMs: null });
      if (reconnected) {
        // RESUME must be the first frame on the new connection.
        const lastSeq = this.buffer.lastSeq;
        this.send({ type: "RESUME", last_seq: lastSeq });
        this.store.traceClient("RESUME", `last_seq=${lastSeq}`);
        this.resumedThisTurn = true;
        this.armInterruptedWatchdog();
      } else {
        this.store.traceMeta("connected");
      }
      this.armDeadSocketWatchdog();
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      this.armDeadSocketWatchdog();
      const data = typeof ev.data === "string" ? ev.data : "";
      const msg = parseServerMessage(data);
      if (!msg) {
        this.store.traceMeta(`unparseable frame dropped (${data.slice(0, 80)})`);
        return;
      }
      this.handleFrame(msg);
    };

    ws.onclose = (ev?: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.manuallyClosed) return;
      const displaced = ev?.code === 1000 && ev.reason === "replaced";
      this.store.traceMeta(
        displaced
          ? "connection replaced — another client connected (close extra tabs)"
          : "connection lost",
      );
      // Single-client server: multiple tabs fight and cause reconnect storms.
      this.scheduleRetry(displaced ? 30_000 : undefined);
    };

    ws.onerror = () => {
      // onclose always follows; nothing to do here.
    };
  }

  private scheduleRetry(delayOverrideMs?: number): void {
    const delay =
      delayOverrideMs ??
      BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ??
      10000;
    this.attempt++;
    this.store.setConnection({
      status: "reconnecting",
      attempt: this.attempt,
      nextRetryMs: delay,
    });
    this.clearRetry();
    this.retryTimer = setTimeout(() => this.openSocket(), delay);
  }

  // ── Frame handling ───────────────────────────────────────────

  private handleFrame(msg: ServerMessage): void {
    // PINGs are answered at receive time, before ordering: the 3-second
    // PONG deadline cannot wait for a gap to fill. Debounced so a burst of
    // replayed PINGs after RESUME yields one PONG for the newest challenge.
    if (msg.type === "PING") {
      this.latestChallenge = msg.challenge;
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        if (this.latestChallenge !== null) {
          this.send({ type: "PONG", echo: this.latestChallenge });
          this.store.traceClient(
            "PONG",
            this.latestChallenge === "" ? "echo: «empty»" : `echo: ${this.latestChallenge}`,
          );
          this.latestChallenge = null;
        }
      }, PONG_DEBOUNCE_MS);
    }

    const { ready, duplicate } = this.buffer.push(msg);
    if (duplicate) {
      this.store.setConnection({ duplicatesDropped: this.buffer.duplicateCount });
      return;
    }

    for (const m of ready) this.process(m);

    const held = this.buffer.pendingCount;
    this.store.setConnection({ outOfOrderHeld: held });

    if (held > 0) {
      this.armAckRescue();
      this.armStallFlush();
    } else {
      this.clearStallFlush();
    }
    // Re-arm the interrupted-stream watchdog only on stream progress —
    // heartbeat PINGs arrive every 12s and must not keep a dead stream
    // looking alive forever.
    if (this.resumedThisTurn && ready.some((m) => m.type !== "PING")) this.armInterruptedWatchdog();
  }

  /** Apply one in-order message and perform its protocol side effect. */
  private process(m: ServerMessage): void {
    this.store.applyServer(m);
    if (m.type === "TOOL_CALL") this.ackToolCall(m.call_id);
    if (m.type === "STREAM_END") this.clearInterruptedWatchdog();
  }

  private ackToolCall(callId: string): void {
    if (this.ackedCalls.has(callId)) return;
    this.ackedCalls.add(callId);
    this.send({ type: "TOOL_ACK", call_id: callId });
    this.store.traceClient("TOOL_ACK", callId);
  }

  /**
   * If a TOOL_CALL is sitting in the reorder buffer behind a gap, ACK it
   * early rather than blow the 2s deadline. Rendering still happens in seq
   * order once the gap fills.
   */
  private armAckRescue(): void {
    if (this.ackRescueTimer) return;
    this.ackRescueTimer = setTimeout(() => {
      this.ackRescueTimer = null;
      for (const held of this.buffer.peekHeld()) {
        if (held.type === "TOOL_CALL" && !this.ackedCalls.has(held.call_id)) {
          this.store.traceMeta(`early TOOL_ACK for ${held.call_id} (held behind seq gap)`);
          this.ackToolCall(held.call_id);
        }
      }
    }, ACK_GAP_RESCUE_MS);
  }

  /**
   * Last-resort: a gap that never fills (should not happen — RESUME covers
   * drops and the server flushes its reorder buffer at stream end). After
   * 12s, flush what we have so the UI is not stuck, and log it loudly.
   */
  private armStallFlush(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.buffer.pendingCount === 0) return;
      const gapAt = this.buffer.lastSeq + 1;
      const flushed = this.buffer.forceFlush();
      this.store.traceMeta(
        `WARNING: seq gap at ${gapAt} never filled — force-flushed ${flushed.length} held messages`,
      );
      for (const m of flushed) this.process(m);
      this.store.setConnection({ outOfOrderHeld: 0 });
    }, STALL_FORCE_FLUSH_MS);
  }

  private clearStallFlush(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  // ── Watchdogs ────────────────────────────────────────────────

  /** Chaos drops use terminate() with no close frame; some platforms delay
   *  the close event. Heartbeats arrive every 12s, so >35s of silence on an
   *  "open" socket means it is dead — force a reconnect cycle. */
  private armDeadSocketWatchdog(): void {
    if (this.deadSocketTimer) clearTimeout(this.deadSocketTimer);
    this.deadSocketTimer = setTimeout(() => {
      if (this.ws && !this.manuallyClosed) {
        this.store.traceMeta("no traffic for 35s on open socket — forcing reconnect");
        const ws = this.ws;
        this.ws = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // already dead
        }
        this.scheduleRetry();
      }
    }, DEAD_SOCKET_MS);
  }

  /** The server does NOT resume a script aborted by a connection drop —
   *  RESUME replays history but generates nothing new, so a stream can end
   *  without STREAM_END. If a message is still "streaming" with no events
   *  for 15s, surface that honestly instead of spinning forever. */
  private armInterruptedWatchdog(): void {
    if (!this.resumedThisTurn) return;
    this.clearInterruptedWatchdog();
    this.interruptedTimer = setTimeout(() => {
      if (this.store.hasStreamingMessage()) {
        this.store.markStreamsInterrupted(
          "no events for 15s (server does not resume aborted scripts after a drop)",
        );
      }
    }, INTERRUPTED_STREAM_MS);
  }

  private clearInterruptedWatchdog(): void {
    if (this.interruptedTimer) {
      clearTimeout(this.interruptedTimer);
      this.interruptedTimer = null;
    }
  }

  // ── Utilities ────────────────────────────────────────────────

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearRetry();
    this.clearStallFlush();
    for (const t of [
      this.pongTimer,
      this.ackRescueTimer,
      this.deadSocketTimer,
      this.interruptedTimer,
    ]) {
      if (t) clearTimeout(t);
    }
    this.pongTimer = null;
    this.ackRescueTimer = null;
    this.deadSocketTimer = null;
    this.interruptedTimer = null;
  }
}
