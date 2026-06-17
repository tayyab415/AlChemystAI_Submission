import type { ServerMessage } from "./protocol";

export interface PushResult {
  /** Messages that became processable, in strict seq order. */
  ready: ServerMessage[];
  /** True if the pushed message was a duplicate (already processed or already buffered). */
  duplicate: boolean;
}

/**
 * Seq-ordering and deduplication buffer.
 *
 * Invariant: `lastProcessed` is the highest seq for which *every* seq <= it
 * has been handed to the consumer. Out-of-order arrivals are held in a
 * Map<seq, msg> until the gap below them fills. Duplicates (seq already
 * processed, or already held) are dropped and counted.
 *
 * A Map keyed by seq (rather than a sorted heap) is enough because the
 * server's chaos reorder window is small (4 messages); draining is a
 * sequential walk from lastProcessed+1, which is O(k) per push.
 */
export class ReorderBuffer {
  private lastProcessed = 0;
  private held = new Map<number, ServerMessage>();
  private duplicatesDropped = 0;

  get lastSeq(): number {
    return this.lastProcessed;
  }

  get pendingCount(): number {
    return this.held.size;
  }

  get duplicateCount(): number {
    return this.duplicatesDropped;
  }

  /** Lowest seq currently waiting on a gap (or null if buffer empty). */
  get lowestPending(): number | null {
    if (this.held.size === 0) return null;
    let min = Infinity;
    for (const s of this.held.keys()) if (s < min) min = s;
    return min;
  }

  /** Peek at a buffered message without draining (used for early TOOL_ACK). */
  peekHeld(): ServerMessage[] {
    return [...this.held.values()];
  }

  push(msg: ServerMessage): PushResult {
    if (msg.seq <= this.lastProcessed || this.held.has(msg.seq)) {
      this.duplicatesDropped++;
      return { ready: [], duplicate: true };
    }
    this.held.set(msg.seq, msg);
    return { ready: this.drain(), duplicate: false };
  }

  /** Pull every contiguously-available message starting at lastProcessed+1. */
  private drain(): ServerMessage[] {
    const out: ServerMessage[] = [];
    let next = this.lastProcessed + 1;
    while (this.held.has(next)) {
      const m = this.held.get(next);
      if (m) out.push(m);
      this.held.delete(next);
      this.lastProcessed = next;
      next++;
    }
    return out;
  }

  /**
   * Emergency flush: hand over everything held, in seq order, advancing
   * lastProcessed past gaps. Only used by the stall watchdog — a skipped gap
   * is unrecoverable via RESUME, so the caller logs it loudly.
   */
  forceFlush(): ServerMessage[] {
    const out = [...this.held.values()].sort((a, b) => a.seq - b.seq);
    this.held.clear();
    const last = out[out.length - 1];
    if (last) this.lastProcessed = Math.max(this.lastProcessed, last.seq);
    return out;
  }

  /** New conversation turn: the server resets seq to 0 on USER_MESSAGE. */
  resetTurn(): void {
    this.lastProcessed = 0;
    this.held.clear();
  }
}
