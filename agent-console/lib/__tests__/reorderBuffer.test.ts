import { describe, expect, it } from "vitest";
import { ReorderBuffer } from "../reorderBuffer";
import type { ServerMessage, TokenMessage } from "../protocol";

const tok = (seq: number): TokenMessage => ({
  type: "TOKEN",
  seq,
  text: `t${seq}`,
  stream_id: "s1",
});

const seqs = (msgs: ServerMessage[]): number[] => msgs.map((m) => m.seq);

describe("ReorderBuffer", () => {
  it("starts empty", () => {
    const b = new ReorderBuffer();
    expect(b.lastSeq).toBe(0);
    expect(b.pendingCount).toBe(0);
    expect(b.lowestPending).toBeNull();
  });

  it("passes through a single in-order element", () => {
    const b = new ReorderBuffer();
    const r = b.push(tok(1));
    expect(r.duplicate).toBe(false);
    expect(seqs(r.ready)).toEqual([1]);
    expect(b.lastSeq).toBe(1);
  });

  it("holds out-of-order messages until the gap fills", () => {
    const b = new ReorderBuffer();
    expect(seqs(b.push(tok(2)).ready)).toEqual([]);
    expect(seqs(b.push(tok(3)).ready)).toEqual([]);
    expect(b.pendingCount).toBe(2);
    expect(b.lowestPending).toBe(2);
    expect(seqs(b.push(tok(1)).ready)).toEqual([1, 2, 3]);
    expect(b.pendingCount).toBe(0);
    expect(b.lastSeq).toBe(3);
  });

  it("reorders a fully reversed sequence", () => {
    const b = new ReorderBuffer();
    const all: number[] = [];
    for (const s of [5, 4, 3, 2, 1]) all.push(...seqs(b.push(tok(s)).ready));
    expect(all).toEqual([1, 2, 3, 4, 5]);
  });

  it("drops duplicates of already-processed seqs", () => {
    const b = new ReorderBuffer();
    b.push(tok(1));
    const r = b.push(tok(1));
    expect(r.duplicate).toBe(true);
    expect(r.ready).toEqual([]);
    expect(b.duplicateCount).toBe(1);
  });

  it("drops duplicates of messages still held in the buffer", () => {
    const b = new ReorderBuffer();
    b.push(tok(3));
    const r = b.push(tok(3));
    expect(r.duplicate).toBe(true);
    expect(b.pendingCount).toBe(1);
  });

  it("handles interleaved duplicates and gaps (chaos pattern)", () => {
    const b = new ReorderBuffer();
    const out: number[] = [];
    for (const s of [2, 1, 1, 4, 3, 4, 2, 5]) out.push(...seqs(b.push(tok(s)).ready));
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(b.duplicateCount).toBe(3);
  });

  it("forceFlush hands over held messages in order and advances lastSeq", () => {
    const b = new ReorderBuffer();
    b.push(tok(1));
    b.push(tok(5));
    b.push(tok(3));
    const flushed = b.forceFlush();
    expect(seqs(flushed)).toEqual([3, 5]);
    expect(b.lastSeq).toBe(5);
    expect(b.pendingCount).toBe(0);
  });

  it("forceFlush on an empty buffer is a no-op", () => {
    const b = new ReorderBuffer();
    b.push(tok(1));
    expect(b.forceFlush()).toEqual([]);
    expect(b.lastSeq).toBe(1);
  });

  it("resetTurn restarts seq tracking for a new conversation turn", () => {
    const b = new ReorderBuffer();
    b.push(tok(1));
    b.push(tok(2));
    b.push(tok(9)); // held
    b.resetTurn();
    expect(b.lastSeq).toBe(0);
    expect(b.pendingCount).toBe(0);
    expect(seqs(b.push(tok(1)).ready)).toEqual([1]);
  });

  it("RESUME replay: messages after lastSeq process in order, replays of processed seqs are dropped", () => {
    const b = new ReorderBuffer();
    for (const s of [1, 2, 3]) b.push(tok(s));
    // server replays everything > last_seq=3
    const out: number[] = [];
    for (const s of [4, 5, 6]) out.push(...seqs(b.push(tok(s)).ready));
    expect(out).toEqual([4, 5, 6]);
    expect(b.push(tok(2)).duplicate).toBe(true);
  });
});
