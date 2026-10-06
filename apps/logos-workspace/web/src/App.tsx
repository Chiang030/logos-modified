import {
  Archive,
  ArrowDownToLine,
  Bot,
  Box,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock3,
  CopyPlus,
  FileCode2,
  FilePlus2,
  Files,
  GitBranch,
  History,
  Inbox,
  Layers3,
  LoaderCircle,
  Menu,
  MessageSquareText,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import type {
  Agent,
  AgentSession,
  DispatchInput,
  InspectorTab,
  Message,
  Overview,
  Run,
  Workspace,
  WorkspaceEvent,
  WorkspaceFile,
} from "./types";

type Modal = "session" | "fork" | "dispatch" | "file" | "publish" | "workspace" | null;
type MobileView = "agents" | "conversation" | "inspector";
type FileScope = "shared" | "private" | "session" | "run";

const AGENT_ICONS: Record<string, ReactNode> = {
  chief_engineer: <Layers3 size={17} />,
  modeling_agent: <Braces size={17} />,
  validation_agent: <ShieldCheck size={17} />,
};

const STATUS_LABELS: Record<string, string> = {
  active: "就绪",
  archived: "已归档",
  queued: "等待中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  delivered: "已投递",
  accepted: "已接收",
  in_progress: "处理中",
};

const ACTIVE_RUNS = new Set(["queued", "running"]);
const dateTime = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "--";

function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}

function shortId(id: string) {
  return id.length > 10 ? id.slice(0, 8) : id;
}

function AppIconButton({
  label,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button className="icon-button" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="empty-state">
      {icon}
      <span>{children}</span>
    </div>
  );
}

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [activeAgentId, setActiveAgentId] = useState("chief_engineer");
  const [activeSessionId, setActiveSessionId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<Modal>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("tasks");
  const [projectScope, setProjectScope] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("conversation");
  const [liveEvents, setLiveEvents] = useState<WorkspaceEvent[]>([]);
  const refreshTimer = useRef<number | null>(null);
  const messagesEnd = useRef<HTMLDivElement | null>(null);

  const loadWorkspaces = useCallback(async () => {
    const items = await api.workspaces();
    setWorkspaces(items);
    if (!workspaceId && items[0]) setWorkspaceId(items[0].id);
    return items;
  }, [workspaceId]);

  const refresh = useCallback(
    async (quiet = false) => {
      if (!workspaceId) return;
      if (!quiet) setRefreshing(true);
      try {
        const data = await api.overview(workspaceId);
        setOverview(data);
        setWorkspaces((current) => current.map((item) => (item.id === data.workspace.id ? data.workspace : item)));
        setError("");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "无法读取工作区");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    loadWorkspaces().catch((reason) => {
      setError(reason instanceof Error ? reason.message : "无法连接后端");
      setLoading(false);
    });
  }, [loadWorkspaces]);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    refresh();
  }, [workspaceId, refresh]);

  useEffect(() => {
    if (!overview) return;
    const current = overview.sessions.find((item) => item.id === activeSessionId && item.status !== "archived");
    if (current) {
      if (current.agent_id !== activeAgentId) setActiveAgentId(current.agent_id);
      return;
    }
    const next =
      overview.sessions.find((item) => item.agent_id === activeAgentId && item.status !== "archived") ??
      overview.sessions.find((item) => item.status !== "archived");
    if (next) {
      setActiveAgentId(next.agent_id);
      setActiveSessionId(next.id);
    }
  }, [overview, activeSessionId, activeAgentId]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    api
      .messages(activeSessionId)
      .then(setMessages)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取消息"));
  }, [activeSessionId, overview?.runs]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  useEffect(() => {
    if (!workspaceId) return;
    const source = new EventSource(api.eventUrl(workspaceId));
    const handle = (raw: Event) => {
      if (raw instanceof MessageEvent && raw.data) {
        try {
          const event = JSON.parse(raw.data) as WorkspaceEvent;
          setLiveEvents((current) =>
            current.some((item) => item.id === event.id) ? current : [...current, event].slice(-300),
          );
        } catch {
          // Keep-alives and malformed diagnostics should not interrupt refreshes.
        }
      }
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => refresh(true), 120);
    };
    [
      "message_created",
      "task_dispatched",
      "run_queued",
      "run_started",
      "agent_message",
      "tool_started",
      "tool_completed",
      "artifact_published",
      "run_completed",
      "run_failed",
      "workspace_updated",
    ].forEach((event) => source.addEventListener(event, handle));
    source.onerror = () => source.close();
    return () => {
      source.close();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [workspaceId, refresh]);

  const activeSession = overview?.sessions.find((item) => item.id === activeSessionId) ?? null;
  const activeAgent = overview?.agents.find((item) => item.id === activeAgentId) ?? null;
  const currentRuns = useMemo(
    () => overview?.runs.filter((run) => run.session_id === activeSessionId) ?? [],
    [overview, activeSessionId],
  );
  const activeRun = currentRuns.find((run) => ACTIVE_RUNS.has(run.status)) ?? null;

  function selectSession(session: AgentSession) {
    setActiveAgentId(session.agent_id);
    setActiveSessionId(session.id);
    setMobileView("conversation");
  }

  async function afterAction(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      setModal(null);
      setNotice(success);
      window.setTimeout(() => setNotice(""), 3000);
      await refresh(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    }
  }

  if (loading && !overview) {
    return (
      <main className="boot-screen">
        <LoaderCircle className="spin" size={24} />
        <span>正在打开工程工作区</span>
      </main>
    );
  }

  if (!overview) {
    return (
      <main className="boot-screen error-screen">
        <Zap size={24} />
        <strong>无法打开工作区</strong>
        <span>{error || "当前没有可用工作区"}</span>
        <button className="primary-button" onClick={() => setModal("workspace")}>
          <Plus size={16} /> 新建工作区
        </button>
        {modal === "workspace" && (
          <WorkspaceDialog
            onClose={() => setModal(null)}
            onSubmit={(name, description) =>
              afterAction(async () => {
                const created = await api.createWorkspace(name, description);
                setWorkspaces((items) => [created, ...items]);
                setWorkspaceId(created.id);
              }, "工作区已创建")
            }
          />
        )}
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-label="Logos">
          <Box size={19} />
        </div>
        <select
          className="workspace-select"
          aria-label="选择工作区"
          value={workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
        >
          {workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <div className="revision-badge">
          <GitBranch size={14} /> 共享版本 v{overview.workspace.current_revision}
        </div>
        <div className="topbar-spacer" />
        <AppIconButton label="刷新" onClick={() => refresh()} disabled={refreshing}>
          <RefreshCw className={refreshing ? "spin" : ""} size={17} />
        </AppIconButton>
        <button className="primary-button dispatch-button" onClick={() => setModal("dispatch")}>
          <ArrowDownToLine size={16} /> 派发任务
        </button>
      </header>

      <main className="workspace-layout">
        <aside className={`agent-panel panel-view ${mobileView === "agents" ? "mobile-active" : ""}`}>
          <div className="panel-heading">
            <div>
              <span className="eyebrow">工程协作</span>
              <h1>智能体与会话</h1>
            </div>
            <AppIconButton label="新建工作区" onClick={() => setModal("workspace")}>
              <Plus size={17} />
            </AppIconButton>
          </div>
          <div className="agent-tree">
            {overview.agents.map((agent) => (
              <AgentGroup
                key={agent.id}
                agent={agent}
                sessions={overview.sessions.filter((item) => item.agent_id === agent.id)}
                runs={overview.runs}
                activeAgentId={activeAgentId}
                activeSessionId={activeSessionId}
                onAgent={() => setActiveAgentId(agent.id)}
                onSession={selectSession}
                onNew={() => {
                  setActiveAgentId(agent.id);
                  setModal("session");
                }}
              />
            ))}
          </div>
        </aside>

        <section className={`conversation-panel panel-view ${mobileView === "conversation" ? "mobile-active" : ""}`}>
          <div className="conversation-header">
            <div className="agent-avatar">{activeAgent ? AGENT_ICONS[activeAgent.id] : <Bot size={17} />}</div>
            <div className="conversation-title">
              <div className="title-row">
                <span>{activeAgent?.name ?? "智能体"}</span>
                <ChevronRight size={14} />
                <strong>{activeSession?.title ?? "未选择会话"}</strong>
              </div>
              <div className="session-meta">
                <span>Thread {activeSession ? shortId(activeSession.thread_id) : "--"}</span>
                <span>输入 v{activeSession?.shared_revision ?? 0}</span>
                {activeSession?.source_session_id && <span>Fork 来源 {shortId(activeSession.source_session_id)}</span>}
              </div>
            </div>
            <div className="conversation-actions">
              <AppIconButton label="Fork 当前会话" disabled={!activeSession} onClick={() => setModal("fork")}>
                <CopyPlus size={17} />
              </AppIconButton>
              <AppIconButton
                label="归档当前会话"
                disabled={!activeSession}
                onClick={() =>
                  activeSession &&
                  afterAction(() => api.archiveSession(activeSession.id), "会话已归档")
                }
              >
                <Archive size={17} />
              </AppIconButton>
            </div>
          </div>

          {activeRun && (
            <div className="active-run-strip">
              <LoaderCircle className="spin" size={15} />
              <span>{statusLabel(activeRun.status)}</span>
              <code>{shortId(activeRun.id)}</code>
              <div className="strip-spacer" />
              <button className="text-button danger" onClick={() => afterAction(() => api.stopRun(activeRun.id, "cancel"), "已请求取消") }>
                <Square size={14} /> 取消
              </button>
              <button className="text-button" onClick={() => afterAction(() => api.stopRun(activeRun.id, "interrupt"), "已请求中断") }>
                <CircleStop size={14} /> 中断
              </button>
            </div>
          )}

          <div className="message-stream" aria-live="polite">
            {messages.length === 0 ? (
              <Empty icon={<MessageSquareText size={23} />}>此会话还没有消息</Empty>
            ) : (
              messages.map((message) => (
                <MessageItem key={message.id} message={message} agents={overview.agents} activeAgent={activeAgent} />
              ))
            )}
            <RuntimeActivity events={liveEvents.filter((event) => event.session_id === activeSessionId)} />
            <div ref={messagesEnd} />
          </div>

          <MessageComposer
            disabled={!activeSession || Boolean(activeRun)}
            agentName={activeAgent?.name ?? "智能体"}
            onSubmit={(content) =>
              activeSession && afterAction(() => api.sendMessage(activeSession.id, content), "消息已进入处理队列")
            }
          />
        </section>

        <aside className={`inspector-panel panel-view ${mobileView === "inspector" ? "mobile-active" : ""}`}>
          <div className="inspector-header">
            <div>
              <span className="eyebrow">上下文</span>
              <h2>{projectScope ? "项目全局" : activeSession?.title ?? "当前会话"}</h2>
            </div>
            <div className="scope-switch" aria-label="信息范围">
              <button className={!projectScope ? "selected" : ""} onClick={() => setProjectScope(false)}>会话</button>
              <button className={projectScope ? "selected" : ""} onClick={() => setProjectScope(true)}>项目</button>
            </div>
          </div>
          <InspectorTabs active={inspectorTab} onChange={setInspectorTab} />
          <InspectorContent
            tab={inspectorTab}
            overview={overview}
            activeSession={activeSession}
            projectScope={projectScope}
            onFile={() => setModal("file")}
            onPublish={() => setModal("publish")}
            onRestore={(revision) => afterAction(() => api.restore(workspaceId, revision), `已从 v${revision} 创建恢复版本`)}
          />
        </aside>
      </main>

      <nav className="mobile-nav" aria-label="工作区区域">
        <button className={mobileView === "agents" ? "selected" : ""} onClick={() => setMobileView("agents")}>
          <Menu size={18} /><span>智能体</span>
        </button>
        <button className={mobileView === "conversation" ? "selected" : ""} onClick={() => setMobileView("conversation")}>
          <MessageSquareText size={18} /><span>会话</span>
        </button>
        <button className={mobileView === "inspector" ? "selected" : ""} onClick={() => setMobileView("inspector")}>
          <PanelRight size={18} /><span>任务与产物</span>
        </button>
      </nav>

      {error && (
        <div className="toast error-toast" role="alert">
          <span>{error}</span><button aria-label="关闭" onClick={() => setError("")}><X size={15} /></button>
        </div>
      )}
      {notice && <div className="toast success-toast"><Check size={15} />{notice}</div>}

      {modal === "session" && (
        <SessionDialog
          agent={overview.agents.find((item) => item.id === activeAgentId)!}
          revision={overview.workspace.current_revision}
          onClose={() => setModal(null)}
          onSubmit={(title, revision) =>
            afterAction(async () => {
              const created = await api.createSession(workspaceId, activeAgentId, title, revision);
              setActiveSessionId(created.id);
            }, "会话已创建")
          }
        />
      )}
      {modal === "fork" && activeSession && (
        <ForkDialog
          session={activeSession}
          messages={messages}
          onClose={() => setModal(null)}
          onSubmit={(title, checkpoint) =>
            afterAction(async () => {
              const created = await api.forkSession(activeSession.id, title, checkpoint);
              setActiveSessionId(created.id);
            }, "分支会话已创建")
          }
        />
      )}
      {modal === "dispatch" && (
        <DispatchDialog
          overview={overview}
          defaultAgentId={activeAgentId === "chief_engineer" ? "modeling_agent" : activeAgentId}
          onClose={() => setModal(null)}
          onSubmit={(input, asChief) =>
            afterAction(async () => {
              const result = await api.dispatch(workspaceId, input, asChief);
              setActiveAgentId(result.session.agent_id);
              setActiveSessionId(result.session.id);
            }, "任务已派发")
          }
        />
      )}
      {modal === "file" && activeSession && (
        <FileDialog session={activeSession} runs={currentRuns} onClose={() => setModal(null)} onSaved={() => refresh(true)} />
      )}
      {modal === "publish" && activeSession && (
        <PublishDialog
          workspace={overview.workspace}
          session={activeSession}
          onClose={() => setModal(null)}
          onSubmit={(input) => afterAction(() => api.publish(workspaceId, input), "ChangeSet 已发布")}
        />
      )}
      {modal === "workspace" && (
        <WorkspaceDialog
          onClose={() => setModal(null)}
          onSubmit={(name, description) =>
            afterAction(async () => {
              const created = await api.createWorkspace(name, description);
              setWorkspaces((items) => [created, ...items]);
              setWorkspaceId(created.id);
            }, "工作区已创建")
          }
        />
      )}
    </div>
  );
}

function AgentGroup({
  agent,
  sessions,
  runs,
  activeAgentId,
  activeSessionId,
  onAgent,
  onSession,
  onNew,
}: {
  agent: Agent;
  sessions: AgentSession[];
  runs: Run[];
  activeAgentId: string;
  activeSessionId: string;
  onAgent: () => void;
  onSession: (session: AgentSession) => void;
  onNew: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="agent-group">
      <button className={`agent-row ${activeAgentId === agent.id ? "active" : ""}`} onClick={() => { onAgent(); setOpen((value) => !value); }}>
        <span className={`agent-icon agent-${agent.id}`}>{AGENT_ICONS[agent.id] ?? <Bot size={17} />}</span>
        <span className="agent-copy"><strong>{agent.name}</strong><small>{sessions.filter((item) => item.status !== "archived").length} 个会话</small></span>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {open && (
        <div className="session-list">
          {sessions.filter((item) => item.status !== "archived").map((session) => {
            const run = runs.find((item) => item.session_id === session.id);
            const status = run?.status ?? session.status;
            return (
              <button key={session.id} className={`session-row ${activeSessionId === session.id ? "active" : ""}`} onClick={() => onSession(session)}>
                <span className={`status-dot status-${status}`} />
                <span className="session-copy"><strong>{session.title}</strong><small>v{session.shared_revision} · {statusLabel(status)}</small></span>
              </button>
            );
          })}
          <button className="new-session-row" onClick={onNew}><Plus size={14} /> 新建 Session</button>
        </div>
      )}
    </div>
  );
}

function MessageItem({ message, agents, activeAgent }: { message: Message; agents: Agent[]; activeAgent: Agent | null }) {
  const fromUser = message.sender_type === "user";
  const sender = fromUser ? "你" : agents.find((item) => item.id === message.sender_id)?.name ?? message.sender_id;
  const isPeer = !fromUser && message.sender_id !== activeAgent?.id;
  return (
    <article className={`message-item ${fromUser ? "from-user" : "from-agent"} ${isPeer ? "from-peer" : ""}`}>
      <div className="message-avatar">{fromUser ? <UserRound size={16} /> : AGENT_ICONS[message.sender_id] ?? <Bot size={16} />}</div>
      <div className="message-body">
        <div className="message-meta"><strong>{sender}</strong>{isPeer && <span className="sender-tag">智能体消息</span>}<time>{dateTime(message.created_at)}</time></div>
        <div className="message-content">{message.content}</div>
        <div className="message-foot"><span>#{message.sequence}</span>{message.task_id && <span>任务 {shortId(message.task_id)}</span>}<span>{statusLabel(message.status)}</span></div>
      </div>
    </article>
  );
}

function RuntimeActivity({ events }: { events: WorkspaceEvent[] }) {
  const visible = events
    .filter((event) => ["run_queued", "run_started", "tool_started", "tool_completed", "run_failed"].includes(event.type))
    .slice(-5);
  if (!visible.length) return null;
  return <div className="runtime-activity" aria-label="工具与运行状态">{visible.map((event) => {
    const tool = typeof event.payload.tool === "string" ? event.payload.tool : null;
    const label = event.type === "run_queued" ? "Run 已排队" : event.type === "run_started" ? "Run 已开始" : event.type === "tool_started" ? `调用工具 ${tool ?? ""}` : event.type === "tool_completed" ? `工具完成 ${tool ?? ""}` : "Run 失败";
    return <div key={event.id} className={`runtime-event event-${event.type}`}><span>{event.type === "tool_completed" ? <Check size={13} /> : event.type === "run_failed" ? <X size={13} /> : <LoaderCircle size={13} />}</span><strong>{label}</strong><code>{event.run_id ? shortId(event.run_id) : ""}</code></div>;
  })}</div>;
}

function MessageComposer({ disabled, agentName, onSubmit }: { disabled: boolean; agentName: string; onSubmit: (content: string) => void }) {
  const [content, setContent] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!content.trim() || disabled) return;
    onSubmit(content.trim());
    setContent("");
  }
  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        aria-label={`向${agentName}发送消息`}
        placeholder={disabled ? "当前运行结束后可继续发送" : `向${agentName}发送消息`}
        value={content}
        disabled={disabled}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(event); }
        }}
      />
      <button className="send-button" aria-label="发送" title="发送" disabled={disabled || !content.trim()}><Send size={17} /></button>
    </form>
  );
}

const INSPECTOR_TABS: Array<{ id: InspectorTab; label: string; icon: ReactNode }> = [
  { id: "tasks", label: "任务", icon: <Inbox size={15} /> },
  { id: "runs", label: "运行", icon: <Play size={15} /> },
  { id: "files", label: "文件", icon: <Files size={15} /> },
  { id: "artifacts", label: "产物", icon: <Box size={15} /> },
  { id: "revisions", label: "版本", icon: <History size={15} /> },
];

function InspectorTabs({ active, onChange }: { active: InspectorTab; onChange: (tab: InspectorTab) => void }) {
  return <div className="inspector-tabs">{INSPECTOR_TABS.map((tab) => <button key={tab.id} className={active === tab.id ? "active" : ""} title={tab.label} aria-label={tab.label} onClick={() => onChange(tab.id)}>{tab.icon}<span>{tab.label}</span></button>)}</div>;
}

function InspectorContent({ tab, overview, activeSession, projectScope, onFile, onPublish, onRestore }: {
  tab: InspectorTab; overview: Overview; activeSession: AgentSession | null; projectScope: boolean;
  onFile: () => void; onPublish: () => void; onRestore: (revision: number) => void;
}) {
  const belongs = (sessionId: string | null) => projectScope || sessionId === activeSession?.id;
  if (tab === "tasks") {
    const items = overview.tasks.filter((item) => belongs(item.session_id));
    return <div className="inspector-content">{items.length ? items.map((task) => <div className="data-row" key={task.id}><div className="row-title"><strong>{task.title}</strong><span className={`status-pill status-${task.status}`}>{statusLabel(task.status)}</span></div><p>{task.description}</p><div className="row-meta"><span>{overview.agents.find((a) => a.id === task.assignee_agent_id)?.name}</span><span>输入 v{task.shared_revision}</span><time>{dateTime(task.updated_at)}</time></div></div>) : <Empty icon={<Inbox size={22} />}>没有关联任务</Empty>}</div>;
  }
  if (tab === "runs") {
    const items = overview.runs.filter((item) => belongs(item.session_id));
    return <div className="inspector-content">{items.length ? items.map((run) => <div className="data-row" key={run.id}><div className="row-title"><strong>Run {shortId(run.id)}</strong><span className={`status-pill status-${run.status}`}>{statusLabel(run.status)}</span></div><div className="run-track"><span className={run.started_at ? "done" : ""}>排队</span><i /><span className={run.started_at ? "done" : ""}>执行</span><i /><span className={run.completed_at ? "done" : ""}>结束</span></div>{run.error && <p className="error-copy">{run.error}</p>}<div className="row-meta"><span>{overview.agents.find((a) => a.id === run.agent_id)?.name}</span><time>{dateTime(run.created_at)}</time></div></div>) : <Empty icon={<Play size={22} />}>没有运行记录</Empty>}</div>;
  }
  if (tab === "files") return <FileInspector session={activeSession} projectScope={projectScope} onNew={onFile} onPublish={onPublish} />;
  if (tab === "artifacts") {
    const items = overview.artifacts.filter((item) => belongs(item.session_id));
    return <div className="inspector-content">{items.length ? items.map((artifact) => <div className="data-row artifact-row" key={artifact.id}><FileCode2 size={18} /><div><strong>{artifact.name}</strong><p>{artifact.storage_path}</p><div className="row-meta"><span>{artifact.kind}</span><span>v{artifact.revision}</span><span>{Math.max(1, Math.round(artifact.size_bytes / 1024))} KB</span></div></div></div>) : <Empty icon={<Box size={22} />}>没有已发布产物</Empty>}</div>;
  }
  const revisions = overview.revisions;
  return <div className="inspector-content revision-list">{revisions.length ? revisions.map((revision, index) => <div className="revision-row" key={revision.id}><span className="revision-node">v{revision.number}</span><div><strong>{revision.summary}</strong><div className="row-meta"><span>{revision.created_by}</span><time>{dateTime(revision.created_at)}</time></div></div>{index > 0 && <button className="icon-button small" title={`恢复 v${revision.number}`} aria-label={`恢复 v${revision.number}`} onClick={() => onRestore(revision.number)}><RotateCcw size={14} /></button>}</div>) : <Empty icon={<History size={22} />}>没有版本记录</Empty>}</div>;
}

function FileInspector({ session, projectScope, onNew, onPublish }: { session: AgentSession | null; projectScope: boolean; onNew: () => void; onPublish: () => void }) {
  const [scope, setScope] = useState<FileScope>(projectScope ? "shared" : "session");
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selected, setSelected] = useState<WorkspaceFile | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (projectScope) setScope("shared"); }, [projectScope]);
  useEffect(() => {
    if (!session || scope === "run") { setFiles([]); return; }
    setBusy(true);
    api.files(session.id, scope).then(setFiles).catch(() => setFiles([])).finally(() => setBusy(false));
  }, [session, scope]);
  async function open(file: WorkspaceFile) {
    if (!session) return;
    try { setSelected(await api.readFile(session.id, scope, file.path)); } catch { setSelected(file); }
  }
  return <div className="file-inspector"><div className="file-toolbar"><select value={scope} onChange={(e) => setScope(e.target.value as FileScope)} disabled={projectScope}><option value="session">Session</option><option value="private">Agent 私有</option><option value="shared">共享版本</option></select><div className="strip-spacer" /><AppIconButton label="新建文件" disabled={scope === "shared" || projectScope} onClick={onNew}><FilePlus2 size={16} /></AppIconButton><button className="outline-button" disabled={scope !== "session" || projectScope} onClick={onPublish}><ArrowDownToLine size={15} /> 发布</button></div><div className="file-list">{busy ? <LoaderCircle className="spin centered" size={20} /> : files.length ? files.map((file) => <button key={file.path} className={selected?.path === file.path ? "active" : ""} onClick={() => open(file)}><FileCode2 size={16} /><span><strong>{file.path.split("/").pop()}</strong><small>{file.path}</small></span><small>{Math.max(1, Math.round(file.size_bytes / 1024))} KB</small></button>) : <Empty icon={<Files size={22} />}>此范围没有文件</Empty>}</div>{selected && <pre className="file-preview">{selected.content ?? ""}</pre>}</div>;
}

function DialogFrame({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="dialog" role="dialog" aria-modal="true"><header><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><AppIconButton label="关闭" onClick={onClose}><X size={18} /></AppIconButton></header>{children}</section></div>;
}

function SessionDialog({ agent, revision, onClose, onSubmit }: { agent: Agent; revision: number; onClose: () => void; onSubmit: (title: string, revision: number) => void }) {
  const [title, setTitle] = useState(""); const [pinned, setPinned] = useState(revision);
  return <DialogFrame title="新建 Session" subtitle={agent.name} onClose={onClose}><form className="dialog-form" onSubmit={(e) => { e.preventDefault(); if (title.trim()) onSubmit(title.trim(), pinned); }}><label>会话名称<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：热结构模型 v2" /></label><label>固定共享输入版本<input type="number" min={0} max={revision} value={pinned} onChange={(e) => setPinned(Number(e.target.value))} /></label><div className="dialog-actions"><button type="button" className="text-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim()}><Plus size={16} /> 创建</button></div></form></DialogFrame>;
}

function ForkDialog({ session, messages, onClose, onSubmit }: { session: AgentSession; messages: Message[]; onClose: () => void; onSubmit: (title: string, checkpoint?: string) => void }) {
  const [title, setTitle] = useState(`${session.title} · 分支`); const [checkpoint, setCheckpoint] = useState(messages.at(-1) ? `message:${messages.at(-1)!.sequence}` : "");
  return <DialogFrame title="Fork Session" subtitle={`从“${session.title}”创建独立上下文分支`} onClose={onClose}><form className="dialog-form" onSubmit={(e) => { e.preventDefault(); onSubmit(title.trim(), checkpoint.trim() || undefined); }}><label>分支会话名称<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label><label>源 Checkpoint<input value={checkpoint} onChange={(e) => setCheckpoint(e.target.value)} placeholder="例如 message:4" /></label><div className="context-note"><GitBranch size={16} /><span>新 Session 将继承所选 Checkpoint 之前的消息，但拥有独立 Thread。</span></div><div className="dialog-actions"><button type="button" className="text-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim()}><CopyPlus size={16} /> 创建分支</button></div></form></DialogFrame>;
}

function DispatchDialog({ overview, defaultAgentId, onClose, onSubmit }: { overview: Overview; defaultAgentId: string; onClose: () => void; onSubmit: (input: DispatchInput, asChief: boolean) => void }) {
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [strategy, setStrategy] = useState<DispatchInput["session_strategy"]>("new");
  const eligible = overview.sessions.filter((item) => item.agent_id === agentId && item.status !== "archived");
  const [sessionId, setSessionId] = useState(eligible[0]?.id ?? "");
  const [title, setTitle] = useState(""); const [taskTitle, setTaskTitle] = useState(""); const [message, setMessage] = useState(""); const [checkpoint, setCheckpoint] = useState("latest"); const [asChief, setAsChief] = useState(true);
  useEffect(() => { const first = overview.sessions.find((item) => item.agent_id === agentId && item.status !== "archived"); setSessionId(first?.id ?? ""); }, [agentId, overview.sessions]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const selected = overview.sessions.find((item) => item.id === sessionId);
    const input: DispatchInput = { recipient_agent_id: agentId, session_strategy: strategy, session_title: strategy === "continue" ? selected?.title ?? taskTitle : title, task_title: taskTitle, message, shared_revision: overview.workspace.current_revision };
    if (strategy === "continue") input.session_id = sessionId;
    if (strategy === "fork") { input.source_session_id = sessionId; input.source_checkpoint_id = checkpoint.trim() || "latest"; }
    onSubmit(input, asChief);
  }
  const valid = Boolean(agentId && taskTitle.trim() && message.trim() && (strategy === "continue" || title.trim()) && (strategy === "new" || sessionId));
  return <DialogFrame title="派发任务" subtitle="创建可追踪的跨智能体任务与 Run" onClose={onClose}><form className="dialog-form wide-form" onSubmit={submit}><div className="form-grid"><label>目标智能体<select value={agentId} onChange={(e) => setAgentId(e.target.value)}>{overview.agents.filter((a) => a.id !== "chief_engineer").map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><label>发送身份<select value={asChief ? "chief" : "user"} onChange={(e) => setAsChief(e.target.value === "chief")}><option value="chief">总师智能体</option><option value="user">当前用户</option></select></label></div><fieldset><legend>Session 策略</legend><div className="strategy-control">{(["new", "continue", "fork"] as const).map((mode) => <button type="button" key={mode} className={strategy === mode ? "selected" : ""} onClick={() => setStrategy(mode)}>{mode === "new" ? <Plus size={15} /> : mode === "continue" ? <MessageSquareText size={15} /> : <GitBranch size={15} />}{mode === "new" ? "新建" : mode === "continue" ? "继续" : "Fork"}</button>)}</div></fieldset>{strategy !== "new" && <label>{strategy === "continue" ? "继续指定 Session" : "源 Session"}<select value={sessionId} onChange={(e) => setSessionId(e.target.value)}><option value="" disabled>选择明确的 Session</option>{eligible.map((session) => <option key={session.id} value={session.id}>{session.title} · v{session.shared_revision}</option>)}</select></label>}{strategy === "fork" && <label>源 Checkpoint<input value={checkpoint} onChange={(e) => setCheckpoint(e.target.value)} placeholder="latest 或 message:4" /></label>}{strategy !== "continue" && <label>新 Session 名称<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={strategy === "fork" ? "替代方案分支" : "任务会话名称"} /></label>}<label>任务标题<input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="可追踪的任务名称" /></label><label>任务消息<textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="目标、输入、约束和预期交付" /></label><div className="pin-note"><Settings2 size={15} /><span>固定共享工作区输入 v{overview.workspace.current_revision}</span></div><div className="dialog-actions"><button type="button" className="text-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!valid}><ArrowDownToLine size={16} /> 派发并运行</button></div></form></DialogFrame>;
}

function FileDialog({ session, runs, onClose, onSaved }: { session: AgentSession; runs: Run[]; onClose: () => void; onSaved: () => void }) {
  const [scope, setScope] = useState<"session" | "private" | "run">("session"); const [path, setPath] = useState(""); const [content, setContent] = useState(""); const latestRun = runs[0];
  return <DialogFrame title="新建工作文件" subtitle={session.title} onClose={onClose}><form className="dialog-form" onSubmit={(e) => { e.preventDefault(); api.writeFile(session.id, scope, path.trim(), content, scope === "run" ? latestRun?.id : undefined).then(() => { onSaved(); onClose(); }); }}><label>工作区范围<select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}><option value="session">Session 工作区</option><option value="private">Agent 私有工作区</option>{latestRun && <option value="run">Run 临时区</option>}</select></label><label>相对路径<input value={path} onChange={(e) => setPath(e.target.value)} placeholder="candidate/model.json" /></label><label>文件内容<textarea className="code-editor" value={content} onChange={(e) => setContent(e.target.value)} /></label><div className="dialog-actions"><button type="button" className="text-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!path.trim()}><FilePlus2 size={16} /> 保存</button></div></form></DialogFrame>;
}

function PublishDialog({ workspace, session, onClose, onSubmit }: { workspace: Workspace; session: AgentSession; onClose: () => void; onSubmit: (input: { base_revision: number; agent_id: string; session_id: string; summary: string; items: Array<{ source_path: string; target_path: string; kind: string; media_type: string }> }) => void }) {
  const [source, setSource] = useState(""); const [target, setTarget] = useState(""); const [kind, setKind] = useState("document"); const [summary, setSummary] = useState("");
  return <DialogFrame title="发布 ChangeSet" subtitle={`基于共享版本 v${workspace.current_revision}`} onClose={onClose}><form className="dialog-form" onSubmit={(e) => { e.preventDefault(); onSubmit({ base_revision: workspace.current_revision, agent_id: session.agent_id, session_id: session.id, summary, items: [{ source_path: source, target_path: target, kind, media_type: target.endsWith(".json") ? "application/json" : "text/plain" }] }); }}><label>Session 源文件<input value={source} onChange={(e) => setSource(e.target.value)} placeholder="candidate/model.json" /></label><label>共享区目标路径<input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="models/model.json" /></label><label>产物类型<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="document">文档</option><option value="model">模型</option><option value="configuration">配置</option><option value="result">计算结果</option><option value="evidence">验证证据</option><option value="validation_report">验证报告</option></select></label><label>发布摘要<textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="说明本次正式变更" /></label><div className="context-note"><ShieldCheck size={16} /><span>发布会执行权限、基线和冲突检查，并创建不可变 Artifact。</span></div><div className="dialog-actions"><button type="button" className="text-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!source.trim() || !target.trim() || !summary.trim()}><ArrowDownToLine size={16} /> 发布新版本</button></div></form></DialogFrame>;
}

function WorkspaceDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (name: string, description: string) => void }) {
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  return <DialogFrame title="新建工程工作区" onClose={onClose}><form className="dialog-form" onSubmit={(e) => { e.preventDefault(); onSubmit(name.trim(), description.trim()); }}><label>名称<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="工程名称" /></label><label>描述<textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="项目目标与协作边界" /></label><div className="dialog-actions"><button type="button" className="text-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!name.trim()}><Plus size={16} /> 创建</button></div></form></DialogFrame>;
}
