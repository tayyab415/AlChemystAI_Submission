import { describe, expect, it } from "vitest";
import { diffJson } from "../jsonDiff";

describe("diffJson", () => {
  it("reports no changes for identical objects", () => {
    const d = diffJson({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] });
    expect(d.added + d.removed + d.changed).toBe(0);
  });

  it("detects added keys", () => {
    const d = diffJson({ a: 1 }, { a: 1, b: 2 });
    expect(d.changes.get("b")).toBe("added");
    expect(d.added).toBe(1);
  });

  it("detects removed keys", () => {
    const d = diffJson({ a: 1, b: 2 }, { a: 1 });
    expect(d.changes.get("b")).toBe("removed");
    expect(d.removed).toBe(1);
  });

  it("detects changed primitives", () => {
    const d = diffJson({ a: 1 }, { a: 2 });
    expect(d.changes.get("a")).toBe("changed");
  });

  it("walks nested objects and marks ancestor paths", () => {
    const d = diffJson({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
    expect(d.changes.get("a.b.c")).toBe("changed");
    expect(d.changes.get("a.b")).toBe("changed");
    expect(d.changes.get("a")).toBe("changed");
  });

  it("diffs arrays by index, including growth and shrinkage", () => {
    const grow = diffJson({ xs: [1, 2] }, { xs: [1, 5, 9] });
    expect(grow.changes.get("xs[1]")).toBe("changed");
    expect(grow.changes.get("xs[2]")).toBe("added");

    const shrink = diffJson({ xs: [1, 2, 3] }, { xs: [1] });
    expect(shrink.changes.get("xs[1]")).toBe("removed");
    expect(shrink.changes.get("xs[2]")).toBe("removed");
  });

  it("treats type changes (object → array) as a change at that path", () => {
    const d = diffJson({ a: { x: 1 } }, { a: [1] });
    expect(d.changes.get("a")).toBe("changed");
  });

  it("handles null transitions", () => {
    const d = diffJson({ a: null }, { a: 1 });
    expect(d.changes.get("a")).toBe("changed");
  });

  it("truncates on oversized payloads instead of blocking", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 70_000; i++) big[`k${i}`] = i;
    const big2: Record<string, unknown> = { ...big, k0: -1 };
    const d = diffJson(big, big2);
    expect(d.truncated).toBe(true);
  });
});
