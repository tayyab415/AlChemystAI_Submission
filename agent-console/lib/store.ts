// Central render-state store.
//
// Why not Redux/Zustand: token events arrive at 30+/sec. We want appends to
// mutate a stable model (no per-token array copies) and to coalesce React
// notifications onto animation frames. A tiny external store with
// useSyncExternalStore gives exactly that with zero dependencies, and keeps
// protocol handling (AgentClient) fully decoupled from rendering.

import { useSyncExternalStore } from "react";
import type { ServerMessage } from "./protocol";

let nextId = 0;
const uid = (prefix: string): string => `${prefix}_${++nextId}`;

// ── Chat model ─────────────────────────────────────────────────

export interface TextSegment {
  kind: "text";
  id: string;
  text: string;
}

export interface ToolSegment {
  kind: "tool";
  id: string;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: "awaiting_result" | "done";
  seq: number;
}

export type Segment = TextSegment | ToolSegment;

export interface UserChatMessage {
  role: "user";
  id: string;
  text: string;
  t: number;
}

export interface AssistantChatMessage {
  role: "assistant";
  id: string;
  streamId: string | null;
  segments: Segment[];
  status: "streaming" | "done" | "interrupted";
  t: number;
}

export type ChatMessage = UserChatMessage | AssistantChatMessage;

// ── Trace model ────────────────────────────────────────────────

export type TraceDirection = "in" | "out" | "meta";

export interface TokenGroupRow {
  id: string;
  kind: "tokens";
  streamId: string;
  count: number;
  text: string;
  firstSeq: number;
  lastSeq: number;
  firstT: number;
  lastT: number;
  targetId: string; // chat element to highlight
}

export interface EventRow {
  id: string;
  kind: "event";
  type: string;
  dir: TraceDirection;
  seq?: number;
  t: number;
  summary: string;
  detail?: unknown;
  callId?: string;
  targetId?: string;
}

export type TraceRow = TokenGroupRow | EventRow;

// ── Context model ──────────────────────────────────────────────

export interface ContextSnapshotEntry {
  seq: number;
  t: number;
  data: Record<string, unknown>;
  bytes: number;
}

export interface ContextTrack {
  contextId: string;
  snapshots: ContextSnapshotEntry[];
  cursor: number; // index into snapshots shown by the scrubber
}

// ── Connection model ───────────────────────────────────────────

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";

export interface ConnectionState {
  status: ConnectionStatus;
  attempt: number;
  nextRetryMs: number | null;
  lastSeq: number;
  duplicatesDropped: number;
  outOfOrderHeld: number;
}

// ── Store ──────────────────────────────────────────────────────

export class ConsoleStore {
  version = 0;
  messages: ChatMessage[] = [];
  trace: TraceRow[] = [];
  contexts: ContextTrack[] = [];
  connection: ConnectionState = {
    status: "idle",
    attempt: 0,
    nextRetryMs: null,
    lastSeq: 0,
    duplicatesDropped: 0,
    outOfOrderHeld: 0,
  };
  highlightChatId: string | null = null;
  highlightTraceId: string | null = null;
  /** Incremented when a highlight is set, so panels can re-trigger scroll. */
  highlightNonce = 0;

  private listeners = new Set<() => void>();
  private framePending = false;

  // stream_id -> assistant message id
  private streamToMessage = new Map<string, string>();
  // call_id -> { trace row id, chat segment id }
  private callIndex = new Map<string, { traceId: string; segmentId: string }>();
  private pendingAssistantId: string | null = null;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  /** Coalesce notifications to one per animation frame. */
  private emit(): void {
    this.version++;
    if (this.framePending) return;
    this.framePending = true;
    const flush = (): void => {
      this.framePending = false;
      for (const fn of this.listeners) fn();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  // ── Mutators called by AgentClient ───────────────────────────

  setConnection(patch: Partial<ConnectionState>): void {
    this.connection = { ...this.connection, ...patch };
    this.emit();
  }

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", id: uid("u"), text, t: Date.now() });
    // Pre-create the assistant reply shell so tokens have a home and the
    // layout reserves space before the first token arrives.
    const reply: AssistantChatMessage = {
      role: "assistant",
      id: uid("a"),
      streamId: null,
      segments: [],
      status: "streaming",
      t: Date.now(),
    };
    this.messages.push(reply);
    this.pendingAssistantId = reply.id;
    this.streamToMessage.clear();
    this.pushEvent("USER_MESSAGE", "out", undefined, text.slice(0, 120), { content: text });
    this.emit();
  }

  /** Record a client->server protocol message in the trace. */
  traceClient(type: string, summary: string, detail?: unknown): void {
    this.pushEvent(type, "out", undefined, summary, detail);
    this.emit();
  }

  traceMeta(summary: string, detail?: unknown): void {
    this.pushEvent("CLIENT", "meta", undefined, summary, detail);
    this.emit();
  }

  /** Apply one in-order, deduplicated server message to the model. */
  applyServer(msg: ServerMessage): void {
    switch (msg.type) {
      case "TOKEN":
        this.applyToken(msg.seq, msg.stream_id, msg.text);
        break;
      case "TOOL_CALL": {
        const m = this.assistantFor(msg.stream_id);
        const segment: ToolSegment = {
          kind: "tool",
          id: uid("tc"),
          callId: msg.call_id,
          toolName: msg.tool_name,
          args: msg.args,
          result: null,
          status: "awaiting_result",
          seq: msg.seq,
        };
        m.segments.push(segment);
        const row = this.pushEvent(
          "TOOL_CALL",
          "in",
          msg.seq,
          `${msg.tool_name}(${previewJson(msg.args, 60)})`,
          msg,
          msg.call_id,
          segment.id,
        );
        this.callIndex.set(msg.call_id, { traceId: row.id, segmentId: segment.id });
        break;
      }
      case "TOOL_RESULT": {
        const ref = this.callIndex.get(msg.call_id);
        if (ref) {
          const seg = this.findSegment(ref.segmentId);
          if (seg && seg.kind === "tool") {
            seg.result = msg.result;
            seg.status = "done";
          }
        }
        this.pushEvent(
          "TOOL_RESULT",
          "in",
          msg.seq,
          `${msg.call_id} → ${previewJson(msg.result, 60)}`,
          msg,
          msg.call_id,
          ref?.segmentId,
        );
        break;
      }
      case "CONTEXT_SNAPSHOT": {
        const bytes = roughByteSize(msg.data);
        let track = this.contexts.find((c) => c.contextId === msg.context_id);
        if (!track) {
          track = { contextId: msg.context_id, snapshots: [], cursor: 0 };
          this.contexts.push(track);
        }
        const followingLatest = track.cursor === track.snapshots.length - 1 || track.snapshots.length === 0;
        track.snapshots.push({ seq: msg.seq, t: Date.now(), data: msg.data, bytes });
        if (followingLatest) track.cursor = track.snapshots.length - 1;
        this.pushEvent(
          "CONTEXT_SNAPSHOT",
          "in",
          msg.seq,
          `${msg.context_id} (${formatBytes(bytes)})`,
          { context_id: msg.context_id, bytes },
        );
        break;
      }
      case "PING":
        this.pushEvent(
          "PING",
          "in",
          msg.seq,
          msg.challenge === "" ? "challenge: «empty» (corrupt)" : `challenge: ${msg.challenge}`,
          msg,
        );
        break;
      case "STREAM_END": {
        const id = this.streamToMessage.get(msg.stream_id);
        const m = this.messages.find(
          (x): x is AssistantChatMessage => x.role === "assistant" && x.id === id,
        );
        if (m) m.status = "done";
        if (this.pendingAssistantId === id) this.pendingAssistantId = null;
        this.pushEvent("STREAM_END", "in", msg.seq, msg.stream_id, msg);
        break;
      }
      case "ERROR":
        this.pushEvent("ERROR", "in", msg.seq, `${msg.code}: ${msg.message}`, msg);
        break;
    }
    this.connection = { ...this.connection, lastSeq: Math.max(this.connection.lastSeq, msg.seq) };
    this.emit();
  }

  /** Mark any still-streaming assistant message as interrupted (stall watchdog). */
  markStreamsInterrupted(reason: string): boolean {
    let any = false;
    for (const m of this.messages) {
      if (m.role === "assistant" && m.status === "streaming" && m.segments.length > 0) {
        m.status = "interrupted";
        any = true;
      }
    }
    if (any) {
      this.traceMeta(`stream marked interrupted: ${reason}`);
      this.emit();
    }
    return any;
  }

  hasStreamingMessage(): boolean {
    return this.messages.some((m) => m.role === "assistant" && m.status === "streaming");
  }

  // ── Selection / highlight ────────────────────────────────────

  highlightFromTrace(row: TraceRow): void {
    this.highlightTraceId = row.id;
    this.highlightChatId = row.kind === "tokens" ? row.targetId : row.targetId ?? null;
    this.highlightNonce++;
    this.emit();
  }

  highlightFromChat(segmentId: string): void {
    this.highlightChatId = segmentId;
    const row = this.trace.find(
      (r) => (r.kind === "tokens" ? r.targetId : r.targetId) === segmentId,
    );
    this.highlightTraceId = row ? row.id : null;
    this.highlightNonce++;
    this.emit();
  }

  setContextCursor(contextId: string, cursor: number): void {
    const track = this.contexts.find((c) => c.contextId === contextId);
    if (!track) return;
    track.cursor = Math.max(0, Math.min(cursor, track.snapshots.length - 1));
    this.emit();
  }

  // ── Internals ────────────────────────────────────────────────

  private applyToken(seq: number, streamId: string, text: string): void {
    const m = this.assistantFor(streamId);
    const last = m.segments[m.segments.length - 1];
    let target: TextSegment;
    if (last && last.kind === "text") {
      target = last;
    } else {
      target = { kind: "text", id: uid("t"), text: "" };
      m.segments.push(target);
    }
    target.text += text;

    // Trace: group consecutive tokens of the same stream into one row.
    const lastRow = this.trace[this.trace.length - 1];
    if (lastRow && lastRow.kind === "tokens" && lastRow.streamId === streamId) {
      lastRow.count++;
      lastRow.text += text;
      lastRow.lastSeq = seq;
      lastRow.lastT = Date.now();
      lastRow.targetId = target.id;
    } else {
      this.trace.push({
        id: uid("r"),
        kind: "tokens",
        streamId,
        count: 1,
        text,
        firstSeq: seq,
        lastSeq: seq,
        firstT: Date.now(),
        lastT: Date.now(),
        targetId: target.id,
      });
    }
  }

  private assistantFor(streamId: string): AssistantChatMessage {
    const existingId = this.streamToMessage.get(streamId);
    if (existingId) {
      const found = this.messages.find(
        (m): m is AssistantChatMessage => m.role === "assistant" && m.id === existingId,
      );
      if (found) return found;
    }
    // Bind the pre-created reply shell, or create one (server-initiated stream).
    let m = this.messages.find(
      (x): x is AssistantChatMessage => x.role === "assistant" && x.id === this.pendingAssistantId,
    );
    if (!m) {
      m = {
        role: "assistant",
        id: uid("a"),
        streamId,
        segments: [],
        status: "streaming",
        t: Date.now(),
      };
      this.messages.push(m);
    }
    m.streamId = streamId;
    this.streamToMessage.set(streamId, m.id);
    return m;
  }

  private findSegment(segmentId: string): Segment | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m && m.role === "assistant") {
        const seg = m.segments.find((s) => s.id === segmentId);
        if (seg) return seg;
      }
    }
    return undefined;
  }

  private pushEvent(
    type: string,
    dir: TraceDirection,
    seq: number | undefined,
    summary: string,
    detail?: unknown,
    callId?: string,
    targetId?: string,
  ): EventRow {
    const row: EventRow = {
      id: uid("r"),
      kind: "event",
      type,
      dir,
      seq,
      t: Date.now(),
      summary,
      detail,
      callId,
      targetId,
    };
    this.trace.push(row);
    return row;
  }
}

function previewJson(v: unknown, max: number): string {
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return "";
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return "[unserialisable]";
  }
}

function roughByteSize(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export const store = new ConsoleStore();

/** Subscribe a component to store changes (coalesced per animation frame). */
export function useStoreVersion(): number {
  return useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
}
