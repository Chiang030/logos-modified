import { useEffect, useState } from 'react';
import {
  History,
  RotateCw,
  CheckCircle2,
  Terminal,
  Cpu,
  ArrowUp,
  ChevronDown,
  Sparkles,
  FileCode,
  Flame,
  Search,
  Wrench
} from 'lucide-react';
import type { ExtensionToWebviewMessage, RuntimeConfig, RuntimeStatus, SessionListEntry, ToolCallView } from './protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

// --- 类型定义 ---
export type TabState = 'empty' | 'chat';

export interface AerodynamicMetric {
  label: string;
  before: string;
  after: string;
  delta: string;
  positive: boolean;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  status: 'streaming' | 'complete' | 'error';
}

export function LogosExtensionPanel() {
  const [previewEmpty, setPreviewEmpty] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [status, setStatus] = useState<RuntimeStatus>('idle');
  const [statusDetail, setStatusDetail] = useState<string>();
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>({ models: [], thinkingLevels: [] });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tools, setTools] = useState<ToolCallView[]>([]);
  const [sessions, setSessions] = useState<SessionListEntry[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [sessionIndex, setSessionIndex] = useState(0);
  const [error, setError] = useState<string>();
  const busy = status === 'starting' || status === 'running' || status === 'stopping';
  const viewState: TabState = previewEmpty || (messages.length === 0 && tools.length === 0) ? 'empty' : 'chat';
  const selectedModel = runtimeConfig.activeModel?.name || runtimeConfig.activeModel?.id || 'Model unavailable';

  useEffect(() => {
    const onMessage = (event: MessageEvent<ExtensionToWebviewMessage>): void => {
      const message = event.data;
      switch (message.type) {
        case 'runtime/status': setStatus(message.status); setStatusDetail(message.detail); break;
        case 'runtime/config': setRuntimeConfig(message.config); break;
        case 'runtime/error': setError(message.message); setStatus('error'); break;
        case 'session/list': setSessions(message.sessions); setActiveSessionId(message.activeSessionId); break;
        case 'session/reset': setMessages([]); setTools([]); setError(undefined); break;
        case 'session/restore': setMessages(message.messages.map((item) => ({ ...item, status: 'complete' }))); setTools(message.tools ?? []); break;
        case 'message/user': setMessages((current) => [...current, { id: message.id, role: 'user', text: message.text, status: 'complete' }]); break;
        case 'message/started': setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, { id: message.id, role: 'assistant', text: '', status: 'streaming' }]); break;
        case 'message/text_delta': setMessages((current) => updateMessage(current, message.id, (item) => ({ ...item, text: item.text + message.delta }))); break;
        case 'message/completed': setMessages((current) => updateMessage(current, message.id, (item) => ({ ...item, text: message.text, status: message.isError ? 'error' : 'complete' }))); break;
        case 'tool/started': setTools((current) => replaceTool(current, message.tool)); break;
        case 'tool/updated': case 'tool/completed': setTools((current) => replaceTool(current, message.tool)); break;
      }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'webview/ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (sessions.length === 0) return;
    const index = sessions.findIndex((session) => session.sessionId === activeSessionId);
    if (index >= 0) setSessionIndex(index);
  }, [activeSessionId, sessions]);

  const sendMessage = (): void => {
    const text = inputValue.trim();
    if (!text || busy) return;
    setPreviewEmpty(false);
    setInputValue('');
    setError(undefined);
    vscode.postMessage({ type: 'chat/send', text });
  };

  const cycleSession = (): void => {
    if (sessions.length === 0) return;
    const nextIndex = (sessionIndex + 1) % sessions.length;
    setSessionIndex(nextIndex);
    vscode.postMessage({ type: 'session/select', sessionId: sessions[nextIndex].sessionId });
  };
  const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');

  // 快捷 Prompt 列表 (Empty State)
  const quickPrompts = [
    {
      icon: <FileCode className="w-4 h-4 text-amber-400" />,
      command: '/optimize',
      desc: 'delta wing sweep angle for cruise Mach 2.2',
      detail: 'CFD boundary condition & wave drag minimization'
    },
    {
      icon: <Flame className="w-4 h-4 text-yellow-400" />,
      command: '/simulate',
      desc: 'run CFD mesh solver on active file',
      detail: 'Executes local mesh_analyzer on aero_dynamics/'
    },
    {
      icon: <Search className="w-4 h-4 text-sky-400" />,
      command: 'Explain',
      desc: 'shockwave dissipation in aero_dynamics/',
      detail: 'Analyze supersonic compression & bow shock behavior'
    },
    {
      icon: <Wrench className="w-4 h-4 text-teal-400" />,
      command: 'Refactor',
      desc: 'lift-to-drag telemetry calculation',
      detail: 'Optimize transonic pitch-up and polar stability curves'
    }
  ];

  return (
    <div className="flex flex-col h-screen w-full bg-[#131313] text-[#e5e7eb] font-sans select-none overflow-hidden border-r border-[#262626]">
      {/* ================= 1. 顶栏 HEADER (高密度紧凑单行) ================= */}
      <header className="h-9 px-3 bg-[#131313] border-b border-[#262626] flex items-center justify-between shrink-0 z-20">
        {/* 左侧 Logo 品牌 */}
        <div 
          className="flex items-center gap-2 cursor-pointer" 
          onClick={() => setPreviewEmpty((current) => !current)} 
          title="点击切换 空态/对话态 预览"
        >
          <div className="flex items-center gap-2">
            <svg className="w-6 h-6 text-white shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M12 2L2 19L12 15L22 19L12 2Z" fill="white" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
              <circle cx="12" cy="12" r="9" stroke="white" strokeWidth="1.2" strokeDasharray="3 3" opacity="0.4" />
            </svg>
            <div className="flex flex-col">
              <span className="text-xs font-black tracking-wider text-white font-mono leading-none">LOGOS</span>
              <span className="text-[7px] text-[#737373] tracking-tight font-sans scale-90 -ml-1">AIRCRAFT DESIGN & SIM</span>
            </div>
          </div>
        </div>

        {/* 右侧状态指示与历史按钮 */}
        <div className="flex items-center gap-2">
          {/* Agent 连接状态指示胶囊 */}
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#1c1c1c] border border-[#2b2b2b] text-[10px] text-[#9ca3af] font-mono">
            <span className={`w-1.5 h-1.5 rounded-full ${status === 'error' ? 'bg-red-400' : status === 'ready' ? 'bg-emerald-400' : 'bg-sky-400 animate-pulse'}`} />
            <span className="tracking-wide">{statusLabel(status)}</span>
            <span className="text-[#525252]">•</span>
            <span className="text-[#737373]" title={error || statusDetail}>MACH-SYS</span>
          </div>

          {/* 历史会话图标 */}
          <button 
            className="w-7 h-7 flex items-center justify-center rounded text-[#9ca3af] hover:text-white hover:bg-[#262626] transition-colors"
            title="Session History"
            onClick={cycleSession}
          >
            <History className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* ================= 2. 中间滚动内容区域 ================= */}
      <main className="flex-1 overflow-y-auto px-3 py-3 space-y-4 custom-scrollbar">
        {viewState === 'empty' ? (
          /* ---------- A. 初始空态 (EMPTY STATE) ---------- */
          <div className="h-full flex flex-col justify-between py-2">
            {/* 居中 Hero 引导 */}
            <div className="flex flex-col items-center text-center mt-6">
              <div className="relative mb-3 flex items-center justify-center w-14 h-14 rounded-2xl bg-[#1b1b1c] border border-[#2a2a2c] shadow-inner shadow-black/50">
                <svg className="w-8 h-8 text-white filter drop-shadow-[0_0_8px_rgba(255,255,255,0.25)]" viewBox="0 0 24 24" fill="none">
                  <path d="M12 2L2 19L12 15L22 19L12 2Z" fill="white" stroke="white" strokeWidth="1.2" strokeLinejoin="round" />
                  <circle cx="12" cy="12" r="9" stroke="white" strokeWidth="1.2" strokeDasharray="3 3" opacity="0.4" />
                </svg>
              </div>

              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-sm font-bold tracking-tight text-white font-mono">LOGOS Coding Agent</h1>
                <span className="px-1.5 py-0.2 rounded bg-sky-950/70 border border-sky-800/60 text-sky-400 text-[10px] font-mono">
                  V4.2
                </span>
              </div>
              <p className="text-[11px] text-[#8e8e93] font-medium mb-1">
                Aircraft Design & Simulation Copilot for VS Code
              </p>
              <p className="text-[11px] text-[#555] font-mono max-w-[280px]">
                Ready to inspect code, run CFD meshes, or optimize aero geometry.
              </p>
            </div>

            {/* 快捷 Prompt 推荐列表 */}
            <div className="space-y-1.5 my-4">
              <div className="flex items-center justify-between px-1 mb-1">
                <span className="text-[9px] font-mono tracking-wider text-[#636366] uppercase">Quick Prompt Suggestions</span>
                <span className="flex items-center gap-1 text-[9px] font-mono text-sky-400">
                  <Sparkles className="w-2.5 h-2.5" /> AERO
                </span>
              </div>

              {quickPrompts.map((item, idx) => (
                <div
                  key={idx}
                  onClick={() => setInputValue(`${item.command} ${item.desc}`)}
                  className="group p-2 rounded-lg bg-[#18181a] hover:bg-[#202023] border border-[#262628] hover:border-[#38bdf8]/40 transition-all cursor-pointer flex items-start gap-2.5"
                >
                  <div className="p-1 rounded bg-[#242428] group-hover:bg-[#2b2b32] shrink-0 mt-0.5">
                    {item.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-[#d1d5db] font-mono truncate">
                      <span className="text-sky-400 font-semibold">{item.command}</span> {item.desc}
                    </p>
                    <p className="text-[10px] text-[#6b7280] font-sans truncate mt-0.5">
                      {item.detail}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* 键盘快捷操作提示 */}
            <div className="p-2 rounded-lg bg-[#161617] border border-[#212124] flex items-center justify-center gap-3 text-[10px] text-[#71717a] font-mono">
              <span>Press <kbd className="px-1.5 py-0.5 bg-[#252528] text-white rounded text-[9px]">Tab</kbd> to accept</span>
              <span><kbd className="px-1 py-0.5 bg-[#252528] text-white rounded text-[9px]">@</kbd> symbols</span>
              <span><kbd className="px-1 py-0.5 bg-[#252528] text-white rounded text-[9px]">/</kbd> aero cmd</span>
            </div>
          </div>
        ) : (
          /* ---------- B. 对话与输出态 (CONVERSATION STATE) ---------- */
          <div className="space-y-3 font-sans">
            {messages.filter((message) => message.role === 'user').map((message) => (
              <div className="space-y-1" key={message.id}>
                <div className="flex items-center gap-2 text-[11px] text-[#737373] font-mono">
                  <span className="font-semibold text-white">You</span><span>•</span><span>{message.id}</span>
                </div>
                <div className="p-2.5 rounded-lg bg-[#1c1c1c] border border-[#2b2b2b] text-xs text-[#e5e7eb] leading-relaxed whitespace-pre-wrap">{message.text}</div>
              </div>
            ))}

            {/* 2. Agent 思考过程 (Thought Process) */}
            <div className="p-2.5 rounded-lg bg-[#161618] border border-[#242426] space-y-2">
              <div className="flex items-center justify-between text-[11px] font-mono">
                <div className="flex items-center gap-1.5 text-[#9ca3af]">
                  <RotateCw className="w-3 h-3 animate-spin text-sky-400" />
                  <span className="font-semibold text-[#d1d5db]">Thought Process</span>
                  <span className="px-1.5 py-0.2 rounded bg-sky-950/70 border border-sky-800/50 text-[9px] text-sky-400">{busy ? 'GENERATING' : 'COMPLETE'}</span>
                </div>
                <span className="text-[10px] text-[#525252] animate-pulse">{busy ? 'streaming response...' : 'response settled'}</span>
              </div>

              {/* 思考链条条目 */}
              <div className="space-y-1 pl-1 text-[11px] font-mono text-[#9ca3af]">
                {tools.length === 0 ? <div className="flex items-center gap-2"><CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" /><span>Awaiting the first runtime operation</span></div> : null}
                {tools.map((tool) => <div className="flex items-center gap-2" key={tool.id}><CheckCircle2 className={`w-3 h-3 ${tool.status === 'error' ? 'text-red-400' : 'text-emerald-400'} shrink-0`} /><span>{tool.status === 'running' ? 'Running' : 'Completed'} <span className="text-sky-300">{tool.name}</span></span></div>)}
              </div>
            </div>

            {/* 3. 工具调用 (Tool Call) */}
            {tools.map((tool) => <div className="px-2.5 py-1.5 rounded bg-[#151515] border border-[#262626] flex items-center justify-between text-[10px] font-mono" key={`call-${tool.id}`}><div className="flex items-center gap-2 text-[#a3a3a3]"><Terminal className="w-3 h-3 text-sky-400" /><span>ran: <span className="text-white font-medium">{tool.name}</span></span></div><span className={`${tool.status === 'error' ? 'text-red-400 bg-red-950/40' : 'text-emerald-400 bg-emerald-950/40'} px-1.5 py-0.2 rounded text-[9px]`}>{tool.status === 'running' ? 'running' : tool.status === 'error' ? 'error' : 'exit code 0'}</span></div>)}

            {/* 4. 代码变更差异 (Code Diff with streaming cursor) */}
            <div className="rounded-lg bg-[#0e0e0e] border border-[#262626] overflow-hidden font-mono text-xs">
              <div className="px-3 py-1.5 bg-[#171717] border-b border-[#262626] flex items-center justify-between text-[10px] text-[#737373]">
                <span># Runtime output</span><span>LOGOS stream</span>
              </div>
              <div className="p-2.5 text-[11px] leading-5 overflow-x-auto">
                <div className="text-[#737373] whitespace-pre-wrap">{latestAssistant?.text || 'Waiting for streamed assistant output…'}</div>
                <div className="flex items-center text-[#737373]">
                  <span>    stream: {latestAssistant?.status || 'idle'}</span>
                  <span className="w-1.5 h-3.5 bg-sky-400 ml-1 shadow-[0_0_8px_#38bdf8] animate-pulse" />
                </div>
              </div>
            </div>

            {/* 5. Agent 回复结论与气动量化遥测指标 */}
            <div className="p-3 rounded-lg bg-[#141416] border border-[#242426] space-y-2.5">
              <div className="flex items-center justify-between text-[11px] font-mono pb-1 border-b border-[#202022]">
                <div className="flex items-center gap-1.5 text-white font-semibold">
                  <Cpu className="w-3.5 h-3.5 text-sky-400" />
                  <span>LOGOS-Aero-4.2 Telemetry</span>
                </div>
                <span className="text-emerald-400 flex items-center gap-1 text-[10px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> EVAL COMPLETED
                </span>
              </div>

              <p className="text-xs text-[#cfcfcf] leading-relaxed whitespace-pre-wrap">{latestAssistant?.text || 'The agent is preparing a response.'}</p>

              {/* 气动量化遥测指标表 */}
              <div className="p-2 rounded bg-[#0b0b0d] border border-[#1e1e20] space-y-1.5 font-mono text-[11px]">
                <div className="flex justify-between items-center text-[#9ca3af]">
                  <span>Runtime tools</span><span className="text-white"><span className="text-emerald-400 font-bold">{tools.length}</span> calls</span>
                </div>
                <div className="flex justify-between items-center text-[#9ca3af]">
                  <span>Context window</span><span className="text-white">{formatContext(runtimeConfig.contextUsage)}</span>
                </div>
                <div className="flex justify-between items-center text-[#9ca3af]">
                  <span>Session</span><span className="text-emerald-400 font-medium">{activeSessionId ? 'Active' : 'Local'}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ================= 3. 底部输入与遥测控制坞 (PROMPT DOCK) ================= */}
      <footer className="p-2.5 bg-[#131313] border-t border-[#262626] space-y-2 shrink-0">
        {/* 输入框 */}
        <div className="relative rounded-lg bg-[#1a1a1a] border border-[#2b2b2b] focus-within:border-sky-500/70 focus-within:ring-1 focus-within:ring-sky-500/30 transition-all">
          <textarea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } }}
            disabled={busy}
            placeholder="Type /simulate or design query..."
            rows={2}
            className="w-full px-2.5 py-2 bg-transparent text-xs text-white placeholder-[#555] outline-none resize-none font-sans"
          />
        </div>

        {/* 控制坞：模型切换 + 上下文遥测 + 发送按键 */}
        <div className="flex items-center justify-between gap-2">
          {/* 左侧：模型选择器 */}
          <div className="relative">
            <button
              onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
              className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#1c1c1c] hover:bg-[#252525] border border-[#2e2e2e] text-[11px] text-[#d1d5db] font-mono transition-colors"
            >
              <Cpu className="w-3 h-3 text-sky-400" />
              <span className="truncate max-w-[150px]">{selectedModel}</span>
              <ChevronDown className="w-3 h-3 text-[#737373]" />
            </button>

            {/* 模型切换下拉菜单 */}
            {isModelDropdownOpen && (
              <div className="absolute bottom-full mb-1 left-0 w-52 bg-[#1c1c1e] border border-[#2e2e32] rounded-lg shadow-2xl py-1 z-50 text-[11px] font-mono">
                {runtimeConfig.models.map((model) => {
                  const m = model.name || model.id;
                  const key = `${model.provider}/${model.id}`;
                  return (
                  <div
                    key={key}
                    onClick={() => {
                      vscode.postMessage({ type: 'model/select', provider: model.provider, modelId: model.id });
                      setIsModelDropdownOpen(false);
                    }}
                    className={`px-2.5 py-1.5 hover:bg-[#2a2a2e] cursor-pointer flex items-center justify-between ${
                      model.provider === runtimeConfig.activeModel?.provider && model.id === runtimeConfig.activeModel?.id ? 'text-sky-400 font-bold bg-[#222226]' : 'text-[#a1a1aa]'
                    }`}
                  >
                    <span>{m}</span>
                    {model.provider === runtimeConfig.activeModel?.provider && model.id === runtimeConfig.activeModel?.id && <CheckCircle2 className="w-3 h-3 text-sky-400" />}
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 中间：上下文比例与 Token 消耗指示 */}
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-[#737373]">
            <span>Context:</span>
            <span className="text-[#a1a1aa] font-semibold">
              {formatContext(runtimeConfig.contextUsage)}
            </span>
            <div className="w-10 h-1.5 bg-[#262626] rounded-full overflow-hidden">
              <div 
                className="h-full bg-sky-400 rounded-full transition-all duration-500" 
                style={{ width: `${runtimeConfig.contextUsage?.percent ?? 0}%` }} 
              />
            </div>
            <span className="text-[9px] text-[#636366]">
              {runtimeConfig.contextUsage?.percent == null ? '0%' : `${Math.round(runtimeConfig.contextUsage.percent)}%`}
            </span>
          </div>

          {/* 右侧：现代化向上发送按键 */}
          <button
            onClick={busy ? () => vscode.postMessage({ type: 'chat/abort' }) : sendMessage}
            disabled={!busy && !inputValue.trim()}
            className="w-7 h-7 flex items-center justify-center rounded-md bg-sky-500 hover:bg-sky-400 text-black font-bold transition-all shadow-[0_0_10px_rgba(56,189,248,0.3)] active:scale-95 shrink-0"
            title="Send (Ctrl+Enter)"
          >
            {busy ? <span className="text-sm">■</span> : <ArrowUp className="w-4 h-4 stroke-[2.5]" />}
          </button>
        </div>
      </footer>
    </div>
  );
}
export default LogosExtensionPanel;
export const App = LogosExtensionPanel;

function statusLabel(status: RuntimeStatus): string {
  switch (status) {
    case 'ready': return 'AGENT CONNECTED';
    case 'running': return 'AGENT RUNNING';
    case 'starting': return 'AGENT STARTING';
    case 'stopping': return 'AGENT STOPPING';
    case 'error': return 'AGENT ERROR';
    default: return 'AGENT OFFLINE';
  }
}

function updateMessage(messages: ChatMessage[], id: string, update: (message: ChatMessage) => ChatMessage): ChatMessage[] {
  if (!messages.some((message) => message.id === id)) return [...messages, update({ id, role: 'assistant', text: '', status: 'streaming' })];
  return messages.map((message) => message.id === id ? update(message) : message);
}

function replaceTool(tools: ToolCallView[], next: ToolCallView): ToolCallView[] {
  const index = tools.findIndex((tool) => tool.id === next.id);
  if (index < 0) return [...tools, next];
  return tools.map((tool) => tool.id === next.id ? { ...tool, ...next } : tool);
}

function formatContext(usage: RuntimeConfig['contextUsage']): string {
  if (!usage) return '—';
  const tokens = usage.tokens == null ? '—' : `${Math.round(usage.tokens / 1000)}k`;
  return `${tokens} / ${Math.round(usage.contextWindow / 1000)}k`;
}
