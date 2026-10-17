import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactElement, type SetStateAction } from "react";
import { Composer } from "./components/Composer";
import { MessageBubble, type ChatMessage } from "./components/MessageBubble";
import { ToolCallCard } from "./components/ToolCallCard";
import type { ExtensionToWebviewMessage, RestoredMessage, RestoredTool, RuntimeStatus, ToolCallView, SessionListEntry } from "./protocol";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
let eventSequence = 0;
type TimelineItem = { kind: "message"; value: ChatMessage } | { kind: "tool"; value: ToolCallView };

export function App(): ReactElement {
  const [status, setStatus] = useState<RuntimeStatus>("idle");
  const [statusDetail, setStatusDetail] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tools, setTools] = useState<ToolCallView[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [sessionName, setSessionName] = useState<string>();
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [lastPrompt, setLastPrompt] = useState<string>();
  const [error, setError] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = status === "starting" || status === "running" || status === "stopping";

  useEffect(() => {
    const onMessage = (event: MessageEvent<ExtensionToWebviewMessage>): void => {
      handleExtensionMessage(event.data, {
        setStatus,
        setStatusDetail,
        setMessages,
        setTools,
        setSessionName,
        setError, setSessions,
        setTimeline, setActiveSessionId,
      });
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "webview/ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [timeline]);

  const canRetry = useMemo(() => Boolean(lastPrompt && status !== "error"), [lastPrompt, status]);

  return (
    <div className="app-shell">
      <main className="main-panel">
        <header className="topbar">
          <div className="brand-lockup">
            <div className="brand-mark">L</div>
            <div className="brand-copy">
              <div className="topbar-title">{sessionName || "LOGOS workspace"} <span className="version-badge">v0.1.2</span></div>
              <div className="topbar-subtitle">Aerospace design &amp; simulation agent</div>
            </div>
          </div>
          <div className="history-menu-wrap">
            <div className={`connection-badge connection-${status}`}><span className="connection-dot" />{statusLabel(status).toUpperCase()}</div>
            <button type="button" className="history-button" onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen} title="Chat history" aria-label="Chat history">◷</button>
            {historyOpen ? <div className="history-menu" role="menu">
              <button type="button" className="history-new" onClick={() => { setHistoryOpen(false); vscode.postMessage({ type: "session/new" }); }}>＋ New session</button>
              {sessions.map((session) => <button type="button" role="menuitem" className={`history-item ${session.sessionId === activeSessionId ? "active" : ""}`} key={session.sessionId} onClick={() => { setHistoryOpen(false); vscode.postMessage({ type: "session/select", sessionId: session.sessionId }); }}>{session.title}</button>)}
            </div> : null}
          </div>
        </header>

        {error ? (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(undefined)} aria-label="Dismiss error">
              ×
            </button>
          </div>
        ) : null}

        <div className="conversation" ref={scrollRef}>
          {messages.length === 0 && tools.length === 0 ? (
            <div className="empty-state">
              <div className="empty-logo">L</div>
              <h1>What are we building today?</h1>
              <p>Ask LOGOS to inspect the workspace, plan a change, or run a simulation workflow.</p>
            </div>
          ) : null}
          {timeline.map((item) => item.kind === "message" ? <MessageBubble key={item.value.id} message={item.value} /> : <ToolCallCard key={item.value.id} tool={item.value} />)}
        </div>

        <Composer
          busy={busy}
          onSend={(text) => {
            setLastPrompt(text);
            if (!sessionName) setSessionName(text.slice(0, 42));
            setError(undefined);
            vscode.postMessage({ type: "chat/send", text });
          }}
          onAbort={() => vscode.postMessage({ type: "chat/abort" })}
          onRetry={() => {
            if (lastPrompt) vscode.postMessage({ type: "chat/retry", text: lastPrompt });
          }}
          canRetry={canRetry}
        />
      </main>
    </div>
  );
}

interface Handlers {
  setStatus: (status: RuntimeStatus) => void;
  setStatusDetail: (detail: string | undefined) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setTools: Dispatch<SetStateAction<ToolCallView[]>>;
  setSessionName: (name: string | undefined) => void;
  setError: (message: string | undefined) => void;
  setSessions: (sessions: SessionListEntry[]) => void;
  setTimeline: Dispatch<SetStateAction<TimelineItem[]>>;
  setActiveSessionId: (sessionId: string | undefined) => void;
}

function handleExtensionMessage(message: ExtensionToWebviewMessage, handlers: Handlers): void {
  switch (message.type) {
    case "runtime/status":
      handlers.setStatus(message.status);
      handlers.setStatusDetail(message.detail);
      return;
    case "runtime/error":
      handlers.setStatus("error");
      handlers.setStatusDetail(undefined);
      handlers.setError(message.message);
      return;
    case "session/list":
      handlers.setSessions(message.sessions);
      handlers.setActiveSessionId(message.activeSessionId);
      if (message.activeSessionId) {
        handlers.setSessionName(message.sessions.find((session) => session.sessionId === message.activeSessionId)?.title);
      }
      return;
    case "message/user":
      { const item = { id: message.id, role: "user" as const, text: message.text, status: "complete" as const, order: ++eventSequence } as ChatMessage; handlers.setMessages((current) => [...current, item]); handlers.setTimeline((current) => [...current, { kind: "message", value: item }]); }
      return;
    case "message/started":
      { const item = { id: message.id, role: "assistant" as const, text: "", status: "streaming" as const, order: ++eventSequence } as ChatMessage; handlers.setMessages((current) => current.some((entry) => entry.id === message.id) ? current : [...current, item]); handlers.setTimeline((current) => current.some((entry) => entry.kind === "message" && entry.value.id === message.id) ? current : [...current, { kind: "message", value: item }]); }
      return;
    case "message/text_delta":
      handlers.setMessages((current) => updateMessage(current, message.id, (item) => ({ ...item, text: item.text + message.delta })));
      handlers.setTimeline((current) => updateTimelineMessage(current, message.id, (item) => ({ ...item, text: item.text + message.delta })));
      return;
    case "message/completed":
      handlers.setMessages((current) => updateMessage(current, message.id, (item) => ({ ...item, text: message.text, status: message.isError ? "error" : "complete" })));
      handlers.setTimeline((current) => updateTimelineMessage(current, message.id, (item) => ({ ...item, text: message.text, status: message.isError ? "error" : "complete" })));
      return;
    case "tool/started":
      { const tool = { ...message.tool, order: ++eventSequence } as ToolCallView; handlers.setTools((current) => replaceTool(current, tool)); handlers.setTimeline((current) => current.some((entry) => entry.kind === "tool" && entry.value.id === tool.id) ? current.map((entry) => entry.kind === "tool" && entry.value.id === tool.id ? { kind: "tool", value: { ...tool, order: (entry.value as ToolCallView & { order?: number }).order } as ToolCallView } : entry) : [...current, { kind: "tool", value: tool }]); }
      return;
    case "tool/updated":
      handlers.setTools((current) => replaceTool(current, message.tool));
      handlers.setTimeline((current) => updateTimelineTool(current, message.tool));
      return;
    case "tool/completed":
      handlers.setTools((current) => replaceTool(current, message.tool));
      handlers.setTimeline((current) => updateTimelineTool(current, message.tool));
      return;
    case "session/restore":
      handlers.setSessionName(message.sessionName);
      handlers.setMessages((current) => current.some((item) => item.status === "streaming") ? current : message.messages.map(toChatMessage));
      handlers.setTools((current) => current.some((item) => item.status === "running") ? current : []);
      handlers.setTimeline((current) => current.some((item) => (item.kind === "message" && item.value.status === "streaming") || (item.kind === "tool" && item.value.status === "running")) ? current : restoreTimeline(message.messages, message.tools ?? []));
      return;
    case "session/reset":
      handlers.setSessionName(undefined);
      handlers.setMessages([]);
      handlers.setTools([]);
      handlers.setTimeline([]);
      handlers.setError(undefined);
      return;
    case "run/settled":
      return;
  }
}

function updateMessage(
  messages: ChatMessage[],
  id: string,
  update: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  if (!messages.some((message) => message.id === id)) {
    return [...messages, update({ id, role: "assistant", text: "", status: "streaming" })];
  }
  return messages.map((message) => (message.id === id ? update(message) : message));
}

function replaceTool(tools: ToolCallView[], next: ToolCallView): ToolCallView[] {
  const index = tools.findIndex((tool) => tool.id === next.id);
  if (index < 0) return [...tools, next];
  return tools.map((tool) => (tool.id === next.id ? { ...next, order: (tool as ToolCallView & { order?: number }).order } as ToolCallView : tool));
}

function updateTimelineMessage(items: TimelineItem[], id: string, update: (message: ChatMessage) => ChatMessage): TimelineItem[] {
  return items.map((item) => item.kind === "message" && item.value.id === id ? { kind: "message", value: update(item.value) } : item);
}

function updateTimelineTool(items: TimelineItem[], next: ToolCallView): TimelineItem[] {
  return items.map((item) => item.kind === "tool" && item.value.id === next.id ? { kind: "tool", value: { ...next, order: (item.value as ToolCallView & { order?: number }).order } as ToolCallView } : item);
}

function toChatMessage(message: RestoredMessage): ChatMessage {
  return { ...message, status: "complete" };
}

function restoreTimeline(messages: RestoredMessage[], tools: RestoredTool[]): TimelineItem[] {
  const entries: Array<
    | { kind: "message"; value: ChatMessage; position: number }
    | { kind: "tool"; value: ToolCallView; position: number }
  > = [
    ...messages.map((value) => ({
      kind: "message" as const,
      value: toChatMessage(value),
      position: value.position ?? 0,
    })),
    ...tools.map((value) => ({
      kind: "tool" as const,
      value,
      position: value.position,
    })),
  ];

  return entries
    .sort((a, b) => a.position - b.position)
    .map((entry): TimelineItem => (
      entry.kind === "message"
        ? { kind: "message", value: entry.value }
        : { kind: "tool", value: entry.value }
    ));
}

function statusLabel(status: RuntimeStatus): string {
  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Working";
    case "stopping":
      return "Stopping";
    case "ready":
      return "Ready";
    case "error":
      return "Error";
    default:
      return "Offline";
  }
}
