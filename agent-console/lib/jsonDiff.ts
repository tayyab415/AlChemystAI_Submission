// Structural diff between two JSON values, keyed by dot/bracket path.
// Designed for CONTEXT_SNAPSHOT payloads up to ~1MB: a node-visit budget
// stops the walk before it can freeze the main thread; the UI shows a
// "diff truncated" note when the budget is hit.

export type ChangeKind = "added" | "removed" | "changed";

export interface DiffResult {
  /** path -> change. A change on a path also marks all ancestor paths as "changed". */
  changes: Map<string, ChangeKind>;
  added: number;
  removed: number;
  changed: number;
  truncated: boolean;
}

const NODE_BUDGET = 60_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function joinPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  return base === "" ? key : `${base}.${key}`;
}

export function diffJson(prev: unknown, next: unknown): DiffResult {
  const result: DiffResult = {
    changes: new Map(),
    added: 0,
    removed: 0,
    changed: 0,
    truncated: false,
  };
  let visited = 0;

  const markAncestors = (path: string): void => {
    let p = path;
    while (true) {
      const cut = Math.max(p.lastIndexOf("."), p.lastIndexOf("["));
      if (cut <= 0) break;
      p = p.slice(0, cut);
      if (result.changes.has(p)) break;
      result.changes.set(p, "changed");
    }
  };

  const record = (path: string, kind: ChangeKind): void => {
    result.changes.set(path, kind);
    if (kind === "added") result.added++;
    else if (kind === "removed") result.removed++;
    else result.changed++;
    markAncestors(path);
  };

  const walk = (a: unknown, b: unknown, path: string): void => {
    if (result.truncated) return;
    if (++visited > NODE_BUDGET) {
      result.truncated = true;
      return;
    }
    if (Object.is(a, b)) return;

    const aObj = isPlainObject(a);
    const bObj = isPlainObject(b);
    const aArr = Array.isArray(a);
    const bArr = Array.isArray(b);

    if (aObj && bObj) {
      const aRec = a as Record<string, unknown>;
      const bRec = b as Record<string, unknown>;
      for (const key of Object.keys(aRec)) {
        const p = joinPath(path, key);
        if (!(key in bRec)) record(p, "removed");
        else walk(aRec[key], bRec[key], p);
      }
      for (const key of Object.keys(bRec)) {
        if (!(key in aRec)) record(joinPath(path, key), "added");
      }
      return;
    }

    if (aArr && bArr) {
      const aL = a as unknown[];
      const bL = b as unknown[];
      const shared = Math.min(aL.length, bL.length);
      for (let i = 0; i < shared; i++) walk(aL[i], bL[i], joinPath(path, i));
      for (let i = shared; i < aL.length; i++) record(joinPath(path, i), "removed");
      for (let i = shared; i < bL.length; i++) record(joinPath(path, i), "added");
      return;
    }

    // Primitive vs primitive, or type mismatch (object vs array, etc.)
    if (path === "") {
      result.changed++;
      result.changes.set("", "changed");
    } else {
      record(path, "changed");
    }
  };

  walk(prev, next, "");
  return result;
}
