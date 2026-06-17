"use client";

import { useMemo, useState } from "react";
import { diffJson } from "@/lib/jsonDiff";
import { formatBytes, store, useStoreVersion } from "@/lib/store";
import { JsonNode } from "./JsonTree";

export function ContextPanel(): JSX.Element {
  useStoreVersion();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const tracks = store.contexts;
  const track =
    tracks.find((t) => t.contextId === selectedId) ?? tracks[tracks.length - 1];

  return (
    <section className="panel context-panel">
      <div className="panel-head">
        Context Inspector
        {track && (
          <span className="panel-sub">
            {track.snapshots.length} snapshot{track.snapshots.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {tracks.length === 0 ? (
        <div className="chat-empty">Context snapshots will appear here as the agent works.</div>
      ) : (
        <>
          <div className="ctx-tabs">
            {tracks.map((t) => (
              <button
                key={t.contextId}
                className={`ctx-tab ${t === track ? "on" : ""}`}
                onClick={() => setSelectedId(t.contextId)}
              >
                {t.contextId}
              </button>
            ))}
          </div>
          {track && <TrackView contextId={track.contextId} />}
        </>
      )}
    </section>
  );
}

function TrackView({ contextId }: { contextId: string }): JSX.Element | null {
  useStoreVersion();
  const track = store.contexts.find((t) => t.contextId === contextId);
  const cursor = track?.cursor ?? 0;
  const current = track?.snapshots[cursor];
  const previous = cursor > 0 ? track?.snapshots[cursor - 1] : undefined;

  // Diff only the selected pair, memoised — never on the token hot path.
  const diff = useMemo(
    () => (previous && current ? diffJson(previous.data, current.data) : null),
    [previous, current],
  );

  if (!track || !current) return null;

  return (
    <div className="ctx-body">
      <div className="ctx-scrubber">
        <button
          disabled={cursor === 0}
          onClick={() => store.setContextCursor(contextId, cursor - 1)}
        >
          ◀
        </button>
        <input
          type="range"
          min={0}
          max={track.snapshots.length - 1}
          value={cursor}
          onChange={(e) => store.setContextCursor(contextId, Number(e.target.value))}
        />
        <button
          disabled={cursor >= track.snapshots.length - 1}
          onClick={() => store.setContextCursor(contextId, cursor + 1)}
        >
          ▶
        </button>
        <span className="ctx-pos">
          {cursor + 1}/{track.snapshots.length} · seq {current.seq} ·{" "}
          {formatBytes(current.bytes)}
        </span>
      </div>
      {diff && (
        <div className="ctx-diffbar">
          <span className="d-added">+{diff.added} added</span>
          <span className="d-removed">−{diff.removed} removed</span>
          <span className="d-changed">~{diff.changed} changed</span>
          {diff.truncated && <span className="d-trunc">diff truncated (large payload)</span>}
          {diff.added + diff.removed + diff.changed === 0 && (
            <span className="d-none">no changes vs previous</span>
          )}
        </div>
      )}
      <div className="ctx-tree">
        <JsonNode
          name={contextId}
          path=""
          value={current.data}
          prevValue={previous?.data}
          changes={diff?.changes ?? new Map()}
          depth={0}
        />
      </div>
    </div>
  );
}
