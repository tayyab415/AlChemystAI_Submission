"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { store, useStoreVersion, type TraceRow } from "@/lib/store";

// Fixed-height rows + windowed rendering: with tokens grouped into single
// rows the list stays small, but chaos sessions still produce hundreds of
// rows — we only mount the visible slice, so a 30 events/sec burst costs a
// constant amount of DOM work per frame.
const ROW_H = 30;
const OVERSCAN = 8;

const FILTERS = [
  "ALL",
  "TOKEN",
  "TOOL_CALL",
  "TOOL_RESULT",
  "CONTEXT_SNAPSHOT",
  "PING/PONG",
  "ERROR",
  "CLIENT",
] as const;

type Filter = (typeof FILTERS)[number];

function rowMatches(row: TraceRow, filter: Filter, query: string): boolean {
  if (filter !== "ALL") {
    if (row.kind === "tokens") {
      if (filter !== "TOKEN") return false;
    } else if (filter === "PING/PONG") {
      if (row.type !== "PING" && row.type !== "PONG") return false;
    } else if (filter === "CLIENT") {
      if (row.dir !== "out" && row.dir !== "meta") return false;
    } else if (row.type !== filter) {
      return false;
    }
  }
  if (query) {
    const q = query.toLowerCase();
    const hay = row.kind === "tokens" ? row.text : `${row.type} ${row.summary}`;
    if (!hay.toLowerCase().includes(q)) return false;
  }
  return true;
}

export function TracePanel(): JSX.Element {
  const version = useStoreVersion();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<TraceRow | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const rows = useMemo(
    () => store.trace.filter((r) => rowMatches(r, filter, query)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, filter, query],
  );

  // Auto-follow the tail unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) setViewH(el.clientHeight);
  }, []);

  // Scroll to the trace row when a chat element is clicked.
  const nonce = store.highlightNonce;
  useEffect(() => {
    if (!store.highlightTraceId) return;
    const idx = rows.findIndex((r) => r.id === store.highlightTraceId);
    if (idx >= 0 && scrollRef.current) {
      stick.current = false;
      scrollRef.current.scrollTop = idx * ROW_H - viewH / 2;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const total = rows.length * ROW_H;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const visible = rows.slice(start, end);

  return (
    <section className="panel trace-panel">
      <div className="panel-head">
        Trace
        <span className="panel-sub">{store.trace.length} events</span>
      </div>
      <div className="trace-filters">
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          {FILTERS.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
        <input
          placeholder="search content…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div
        className="trace-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScrollTop(el.scrollTop);
          setViewH(el.clientHeight);
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        <div style={{ height: total, position: "relative" }}>
          {visible.map((row, i) => (
            <Row
              key={row.id}
              row={row}
              top={(start + i) * ROW_H}
              selected={selected?.id === row.id}
              highlighted={store.highlightTraceId === row.id}
              onClick={() => {
                setSelected(row);
                store.highlightFromTrace(row);
              }}
            />
          ))}
        </div>
      </div>
      {selected && <DetailPane row={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}

function Row({
  row,
  top,
  selected,
  highlighted,
  onClick,
}: {
  row: TraceRow;
  top: number;
  selected: boolean;
  highlighted: boolean;
  onClick: () => void;
}): JSX.Element {
  if (row.kind === "tokens") {
    const secs = ((row.lastT - row.firstT) / 1000).toFixed(1);
    return (
      <div
        className={`trace-row dir-in type-TOKEN ${selected ? "selected" : ""} ${highlighted ? "highlighted" : ""}`}
        style={{ top }}
        onClick={onClick}
      >
        <span className="tr-seq">
          {row.firstSeq}–{row.lastSeq}
        </span>
        <span className="tr-type">TOKEN×{row.count}</span>
        <span className="tr-sum">
          Streamed {row.count} tokens ({secs}s) — {row.text.slice(0, 60)}
        </span>
      </div>
    );
  }
  const linked = row.callId !== undefined;
  return (
    <div
      className={`trace-row dir-${row.dir} type-${row.type} ${linked ? "linked" : ""} ${selected ? "selected" : ""} ${highlighted ? "highlighted" : ""}`}
      style={{ top }}
      onClick={onClick}
    >
      <span className="tr-seq">{row.seq ?? (row.dir === "out" ? "→" : "·")}</span>
      <span className="tr-type">
        {row.type === "TOOL_RESULT" && <span className="tr-link">└ </span>}
        {row.type}
      </span>
      <span className="tr-sum">{row.summary}</span>
    </div>
  );
}

function DetailPane({ row, onClose }: { row: TraceRow; onClose: () => void }): JSX.Element {
  const body =
    row.kind === "tokens"
      ? `Streamed ${row.count} tokens in ${((row.lastT - row.firstT) / 1000).toFixed(2)}s (seq ${row.firstSeq}–${row.lastSeq})\n\n${row.text}`
      : JSON.stringify(row.detail ?? { type: row.type, summary: row.summary }, null, 2);
  return (
    <div className="trace-detail">
      <div className="trace-detail-head">
        <span>{row.kind === "tokens" ? `TOKEN ×${row.count}` : row.type}</span>
        <button onClick={onClose}>×</button>
      </div>
      <pre>{body}</pre>
    </div>
  );
}
