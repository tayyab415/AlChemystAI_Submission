"use client";

import { useEffect, useRef, useState } from "react";
import { AgentClient } from "@/lib/agentClient";
import { store } from "@/lib/store";
import { ChatPanel } from "@/components/ChatPanel";
import { TracePanel } from "@/components/TracePanel";
import { ContextPanel } from "@/components/ContextPanel";
import { ConnectionBadge } from "@/components/ConnectionBadge";

const WS_URL = process.env.NEXT_PUBLIC_AGENT_WS_URL ?? "ws://127.0.0.1:4747/ws";

export default function Page(): JSX.Element {
  const clientRef = useRef<AgentClient | null>(null);
  const [tracOpen, setTraceOpen] = useState(true);
  const [contextOpen, setContextOpen] = useState(true);

  useEffect(() => {
    const client = new AgentClient(WS_URL, store);
    clientRef.current = client;
    client.connect();
    return () => client.disconnect();
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Agent Console</span>
        <ConnectionBadge />
        <div className="topbar-actions">
          <button
            className={`toggle ${tracOpen ? "on" : ""}`}
            onClick={() => setTraceOpen((v) => !v)}
          >
            Trace
          </button>
          <button
            className={`toggle ${contextOpen ? "on" : ""}`}
            onClick={() => setContextOpen((v) => !v)}
          >
            Context
          </button>
        </div>
      </header>
      <main
        className="panes"
        style={{
          gridTemplateColumns: `minmax(360px, 1.2fr)${tracOpen ? " minmax(300px, 1fr)" : ""}${contextOpen ? " minmax(300px, 1fr)" : ""}`,
        }}
      >
        <ChatPanel onSend={(text) => clientRef.current?.sendUserMessage(text)} />
        {tracOpen && <TracePanel />}
        {contextOpen && <ContextPanel />}
      </main>
    </div>
  );
}
