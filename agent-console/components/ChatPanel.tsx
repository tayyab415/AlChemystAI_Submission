"use client";

import { useEffect, useRef, useState } from "react";
import {
  store,
  useStoreVersion,
  type AssistantChatMessage,
  type Segment,
  type ToolSegment,
} from "@/lib/store";

export function ChatPanel({ onSend }: { onSend: (text: string) => void }): JSX.Element {
  useStoreVersion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Auto-scroll only while the user is already at the bottom, so the chat
  // stays readable (scroll/copy/select) during reconnects and bursts.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  });

  // Scroll-to-highlight when a trace row is clicked.
  const nonce = store.highlightNonce;
  useEffect(() => {
    if (store.highlightChatId) {
      const el = document.getElementById(`chat-${store.highlightChatId}`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  return (
    <section className="panel chat-panel">
      <div className="panel-head">Chat</div>
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {store.messages.length === 0 && (
          <div className="chat-empty">
            Try: <code>hello</code>, <code>summarise the q3 report</code>,{" "}
            <code>analyze and compare</code>, <code>lookup the docs</code>,{" "}
            <code>show me the database schema</code>
          </div>
        )}
        {store.messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg msg-user">
              {m.text}
            </div>
          ) : (
            <AssistantMessage key={m.id} m={m} />
          ),
        )}
      </div>
      <Composer onSend={onSend} />
    </section>
  );
}

function AssistantMessage({ m }: { m: AssistantChatMessage }): JSX.Element {
  return (
    <div className={`msg msg-assistant status-${m.status}`}>
      {m.segments.map((seg) => (
        <SegmentView key={seg.id} seg={seg} />
      ))}
      {m.status === "streaming" && <span className="caret" aria-hidden />}
      {m.status === "interrupted" && (
        <div className="interrupted-note">
          ⚠ Response interrupted — the server dropped mid-stream and does not resume
          aborted scripts. Everything received up to the drop is shown above.
        </div>
      )}
    </div>
  );
}

function SegmentView({ seg }: { seg: Segment }): JSX.Element {
  const highlighted = store.highlightChatId === seg.id;
  if (seg.kind === "text") {
    return (
      <span
        id={`chat-${seg.id}`}
        className={`text-seg ${highlighted ? "highlighted" : ""}`}
      >
        {seg.text}
      </span>
    );
  }
  return <ToolCard seg={seg} highlighted={highlighted} />;
}

function ToolCard({ seg, highlighted }: { seg: ToolSegment; highlighted: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div
      id={`chat-${seg.id}`}
      className={`tool-card ${seg.status} ${highlighted ? "highlighted" : ""}`}
      onClick={() => store.highlightFromChat(seg.id)}
    >
      <div className="tool-card-head">
        <span className="tool-icon">{seg.status === "done" ? "✓" : "⏳"}</span>
        <span className="tool-name">{seg.toolName}</span>
        <span className="tool-status">
          {seg.status === "done" ? "completed" : "waiting for result…"}
        </span>
        <button
          className="tool-expand"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {open ? "−" : "+"}
        </button>
      </div>
      <div className="tool-args">
        <span className="k">args</span> <code>{JSON.stringify(seg.args)}</code>
      </div>
      {/* min-height reserved in CSS so the result landing causes no layout shift */}
      <div className="tool-result">
        {seg.result ? (
          <>
            <span className="k">result</span>{" "}
            <code>
              {open ? JSON.stringify(seg.result, null, 2) : truncate(JSON.stringify(seg.result), 140)}
            </code>
          </>
        ) : (
          <span className="tool-pending-bar" />
        )}
      </div>
    </div>
  );
}

function Composer({ onSend }: { onSend: (text: string) => void }): JSX.Element {
  useStoreVersion();
  const [text, setText] = useState("");
  const connected = store.connection.status === "connected";
  const submit = (): void => {
    const trimmed = text.trim();
    if (!trimmed || !connected) return;
    onSend(trimmed);
    setText("");
  };
  return (
    <div className="composer">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder={connected ? "Message the agent…" : "Waiting for connection…"}
        disabled={!connected}
      />
      <button onClick={submit} disabled={!connected || !text.trim()}>
        Send
      </button>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
