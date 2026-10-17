import { useEffect, useRef, useState, type Dispatch, type ReactElement, type SetStateAction } from "react";
import { History } from "lucide-react";
import fullLogo from "../../resources/logos_full_restored_transparent.png";
import { Composer } from "./components/Composer";
import { MessageBubble, type ChatMessage } from "./components/MessageBubble";
import { ToolCallCard } from "./components/ToolCallCard";
import type { ExtensionToWebviewMessage, RestoredMessage, RestoredTool, RuntimeConfig, RuntimeStatus, ToolCallView, SessionListEntry } from "./protocol";

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
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>({ models: [], thinkingLevels: [] });
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = status === "starting" || status === "running" || status === "stopping";
  const hasVisibleConversation = timeline.some((item) => (
    item.kind === "tool" || isVisibleMessage(item.value)
  ));

  useEffect(() => {
    const onMessage = (event: MessageEvent<ExtensionToWebviewMessage>): void => {
      handleExtensionMessage(event.data, {
        setStatus,
        setStatusDetail,
        setRuntimeConfig,
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

  return (
    <div className="logos-panel">
      <main className="main-panel">
        <header className="topbar">
          <div className="brand-lockup">
            <img className="brand-full-logo" src={fullLogo} alt="LOGOS Aircraft Design and Simulation Agent" />
          </div>
          <div className="history-menu-wrap">
            <div className="connection-badge connection-ready"><span className="connection-dot" />AGENT CONNECTED<span className="connection-separator">•</span><span className="connection-mode">MACH-SYS</span></div>
            <button type="button" className="history-button" onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen} title="Session History" aria-label="Session History"><History size={15} /></button>
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

        <div className="conversation custom-scrollbar" ref={scrollRef}>
          {!hasVisibleConversation ? (
            <div className="empty-state">
              <div className="empty-title-row"><h1>LOGOS Coding Agent</h1></div>
              <p>Aircraft Design &amp; Simulation Copilot for VS Code</p>
              <p className="empty-detail">Ready to inspect code, run CFD meshes, or optimize aero geometry.</p>
            </div>
          ) : null}
          {timeline.map((item) => item.kind === "message" ? <MessageBubble key={item.value.id} message={item.value} /> : <ToolCallCard key={item.value.id} tool={item.value} />)}
        </div>

        <Composer
          busy={busy}
          models={runtimeConfig.models}
          activeModel={runtimeConfig.activeModel}
          thinkingLevel={runtimeConfig.thinkingLevel}
          thinkingLevels={runtimeConfig.thinkingLevels}
          contextUsage={runtimeConfig.contextUsage}
          onSelectModel={(model) => vscode.postMessage({ type: "model/select", provider: model.provider, modelId: model.id })}
          onSelectThinking={(level) => vscode.postMessage({ type: "thinking/select", level })}
          onSend={(text) => {
            if (!sessionName) setSessionName(text.slice(0, 42));
            setError(undefined);
            vscode.postMessage({ type: "chat/send", text });
          }}
          onAbort={() => vscode.postMessage({ type: "chat/abort" })}
          value={draft}
          onValueChange={setDraft}
        />
      </main>
    </div>
  );
}

interface Handlers {
  setStatus: (status: RuntimeStatus) => void;
  setStatusDetail: (detail: string | undefined) => void;
  setRuntimeConfig: (config: RuntimeConfig) => void;
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
    case "runtime/config":
      handlers.setRuntimeConfig(message.config);
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
      { const tool = { ...message.tool, order: ++eventSequence } as ToolCallView; handlers.setTools((current) => replaceTool(current, tool)); handlers.setMessages((current) => removeEmptyAssistantMessages(current)); handlers.setTimeline((current) => { const withoutPlaceholder = removeEmptyAssistantTimeline(current); return withoutPlaceholder.some((entry) => entry.kind === "tool" && entry.value.id === tool.id) ? withoutPlaceholder.map((entry) => entry.kind === "tool" && entry.value.id === tool.id ? { kind: "tool", value: { ...tool, order: (entry.value as ToolCallView & { order?: number }).order } as ToolCallView } : entry) : [...withoutPlaceholder, { kind: "tool", value: tool }]; }); }
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

function isVisibleMessage(message: ChatMessage): boolean {
  if (message.role === "system") return false;
  return message.text.trim().length > 0 || (message.role === "assistant" && message.status === "streaming");
}

function removeEmptyAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => !(message.role === "assistant" && message.text.trim().length === 0));
}

function removeEmptyAssistantTimeline(items: TimelineItem[]): TimelineItem[] {
  return items.filter((item) => !(item.kind === "message" && item.value.role === "assistant" && item.value.text.trim().length === 0));
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

