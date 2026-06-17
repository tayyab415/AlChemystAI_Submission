"use client";

import { store, useStoreVersion } from "@/lib/store";

const LABELS: Record<string, string> = {
  idle: "Idle",
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

export function ConnectionBadge(): JSX.Element {
  useStoreVersion();
  const c = store.connection;
  return (
    <div className="conn-badge-wrap">
      <span className={`conn-badge conn-${c.status}`}>
        <span className="conn-dot" />
        {LABELS[c.status] ?? c.status}
        {c.status === "reconnecting" && c.nextRetryMs !== null && (
          <span className="conn-sub">
            attempt {c.attempt} · retry in {(c.nextRetryMs / 1000).toFixed(1)}s
            {c.attempt >= 2 && " · close other tabs on :3000"}
          </span>
        )}
      </span>
      <span className="conn-stats">
        seq {c.lastSeq}
        {c.outOfOrderHeld > 0 && ` · ${c.outOfOrderHeld} held`}
        {c.duplicatesDropped > 0 && ` · ${c.duplicatesDropped} dup dropped`}
      </span>
    </div>
  );
}
