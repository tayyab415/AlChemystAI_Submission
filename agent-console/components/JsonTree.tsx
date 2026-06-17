"use client";

// Lazy JSON tree: children are only materialised when a node is expanded,
// so a 500KB+ snapshot costs O(visible nodes), not O(payload). Renders the
// union of previous + current keys so removed keys appear as ghosts, and
// colours nodes from the diff path map.

import { memo, useState } from "react";
import { joinPath, type ChangeKind } from "@/lib/jsonDiff";

const AUTO_EXPAND_CHILDREN = 12;
const MAX_CHILDREN_PER_PAGE = 100;

interface NodeProps {
  name: string;
  path: string;
  value: unknown;
  prevValue: unknown;
  changes: Map<string, ChangeKind>;
  depth: number;
  forcedKind?: ChangeKind;
}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return typeof v === "object" && v !== null;
}

function childEntries(v: unknown): Array<[string | number, unknown]> {
  if (Array.isArray(v)) return v.map((x, i) => [i, x]);
  if (isContainer(v)) return Object.entries(v);
  return [];
}

function preview(v: unknown): string {
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (isContainer(v)) return `{${Object.keys(v).length} keys}`;
  if (typeof v === "string") return JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}…` : v);
  return String(v);
}

export const JsonNode = memo(function JsonNode({
  name,
  path,
  value,
  prevValue,
  changes,
  depth,
  forcedKind,
}: NodeProps): JSX.Element {
  const kind = forcedKind ?? changes.get(path);
  const container = isContainer(value) || (kind === "removed" && isContainer(prevValue));
  const shown = kind === "removed" ? prevValue : value;
  const entries = container ? childEntries(shown) : [];
  const [open, setOpen] = useState(
    depth === 0 || (depth < 2 && entries.length > 0 && entries.length <= AUTO_EXPAND_CHILDREN),
  );
  const [page, setPage] = useState(1);

  const cls = kind ? `jt-${kind}` : "";

  if (!container) {
    return (
      <div className={`jt-row ${cls}`} style={{ paddingLeft: depth * 14 }}>
        <span className="jt-key">{name}</span>
        <span className="jt-colon">: </span>
        <span className="jt-val">{preview(shown)}</span>
        {kind === "changed" && prevValue !== undefined && !isContainer(prevValue) && (
          <span className="jt-prev"> (was {preview(prevValue)})</span>
        )}
        {kind && <span className={`jt-badge jt-badge-${kind}`}>{kind}</span>}
      </div>
    );
  }

  const visible = entries.slice(0, page * MAX_CHILDREN_PER_PAGE);
  const prevEntries = isContainer(prevValue) ? childEntries(prevValue) : [];
  const currentKeys = new Set(entries.map(([k]) => String(k)));
  const removedChildren =
    kind === "removed"
      ? []
      : prevEntries.filter(([k]) => !currentKeys.has(String(k)));

  return (
    <div>
      <div
        className={`jt-row jt-container ${cls}`}
        style={{ paddingLeft: depth * 14 }}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="jt-arrow">{open ? "▾" : "▸"}</span>
        <span className="jt-key">{name}</span>
        <span className="jt-colon">: </span>
        <span className="jt-preview">{preview(shown)}</span>
        {kind && <span className={`jt-badge jt-badge-${kind}`}>{kind}</span>}
      </div>
      {open && (
        <div>
          {visible.map(([k, v]) => {
            const childPath = joinPath(path, k);
            const prevChild = isContainer(prevValue)
              ? Array.isArray(prevValue)
                ? prevValue[Number(k)]
                : (prevValue as Record<string, unknown>)[String(k)]
              : undefined;
            return (
              <JsonNode
                key={String(k)}
                name={String(k)}
                path={childPath}
                value={v}
                prevValue={prevChild}
                changes={changes}
                depth={depth + 1}
                forcedKind={kind === "removed" ? "removed" : undefined}
              />
            );
          })}
          {removedChildren.map(([k, v]) => (
            <JsonNode
              key={`removed-${String(k)}`}
              name={String(k)}
              path={joinPath(path, k)}
              value={undefined}
              prevValue={v}
              changes={changes}
              depth={depth + 1}
              forcedKind="removed"
            />
          ))}
          {entries.length > visible.length && (
            <button
              className="jt-more"
              style={{ marginLeft: (depth + 1) * 14 }}
              onClick={() => setPage((p) => p + 1)}
            >
              Show {Math.min(MAX_CHILDREN_PER_PAGE, entries.length - visible.length)} more of{" "}
              {entries.length - visible.length} remaining…
            </button>
          )}
        </div>
      )}
    </div>
  );
});
