import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { LocalRuntime, RuntimeEvent } from "./localRuntime";
import { SessionStore } from "./sessionStore";
import {
  isRecord,
  isWebviewToExtensionMessage,
  textFromContent,
  type ExtensionToWebviewMessage,
  type RestoredMessage,
  type RestoredTool,
  type RuntimeConfig,
  type ToolCallView,
} from "./shared/protocol";
import type { RpcRecord } from "./rpcClient";
import { ConnectionSettingsStore } from "./connectionSettings";
import { OpenAiAuthStore } from "./auth/openAiAuthStore";
import { resolveMessageLink } from "./links";
import { redactDiagnostic } from "./diagnostics";
import type { RunOutcome } from "./sessionStore";

interface PendingOpenAiLogin {
  abort: AbortController;
  timeout: NodeJS.Timeout;
  manual?: { resolve(url: string): void; reject(error: Error): void };
}

export class LogosWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private viewMessageSubscription: vscode.Disposable | undefined;
  private panelMessageSubscription: vscode.Disposable | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private sequence = 0;
  private assistantSequence = 0;
  private currentAssistantId: string | undefined;
  private currentAssistantText = "";
  private readonly activeTools = new Map<string, ToolCallView>();
  private openAiLogin: PendingOpenAiLogin | undefined;
  private transition: Promise<void> = Promise.resolve();
  private runFailed = false;
  private restoring = false;
  private sessionReady = false;
  private pendingEvents: RuntimeEvent[] = [];
  private replay: ExtensionToWebviewMessage[] = [];
  private replaying = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: LocalRuntime,
    private readonly sessions: SessionStore,
    private readonly settings: ConnectionSettingsStore,
    private readonly openAiAuth: OpenAiAuthStore,
  ) {
    this.disposables.push(runtime.onDidEvent((event) => this.handleRuntimeEvent(event)));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.viewMessageSubscription?.dispose();
    this.viewMessageSubscription = this.configureWebview(view.webview);
    view.onDidDispose(() => {
      this.viewMessageSubscription?.dispose();
      this.viewMessageSubscription = undefined;
      if (this.view === view) this.view = undefined;
    });
  }

  openPanel(): void {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Active); return; }
    const panel = vscode.window.createWebviewPanel("logos.chatPanel", "LOGOS Chat", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")] });
    this.panel = panel;
    this.panelMessageSubscription = this.configureWebview(panel.webview);
    panel.onDidDispose(() => { this.panelMessageSubscription?.dispose(); this.panelMessageSubscription = undefined; if (this.panel === panel) this.panel = undefined; });
  }

  dispose(): void {
    this.viewMessageSubscription?.dispose();
    this.panelMessageSubscription?.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!isWebviewToExtensionMessage(value)) return;
    try {
      switch (value.type) {
        case "software/load":
          this.post({ type: "software/result", result: await this.settings.software(value.refresh) });
          break;
        case "software/path":
          this.guardSessionChange();
          await this.settings.setSoftwarePath(value.product, value.path);
          this.post({ type: "software/result", result: await this.settings.software() });
          if (this.runtime.isRunning) await this.synchronize(() => this.runtime.restart());
          break;
        case "diagnostics/open":
          await vscode.commands.executeCommand("logos.showLogs");
          break;
        case "link/open": {
          const target = resolveMessageLink(value.href, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "");
          if (target.kind === "external") await vscode.env.openExternal(vscode.Uri.parse(target.url));
          else {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.path));
            const editor = await vscode.window.showTextDocument(document, { preview: true });
            if (target.line) {
              const position = new vscode.Position(Math.min(target.line - 1, document.lineCount - 1), 0);
              editor.selection = new vscode.Selection(position, position);
              editor.revealRange(new vscode.Range(position, position));
            }
          }
          break;
        }
        case "session/rename":
          await this.sessions.rename(value.sessionId, value.title);
          await this.publishSessionList();
          break;
        case "settings/load":
          this.post({ type: "settings/loaded", settings: await this.settings.view() });
          break;
        case "settings/models": {
          const discovery = await this.settings.models(value.baseUrl, value.api, value.apiKey);
          this.post({ type: "settings/models", modelIds: discovery.modelIds, source: discovery.source });
          break;
        }
        case "settings/save":
          await this.guardBusyThenApply(async () => { await this.settings.saveGlobal(value); });
          break;
        case "connection/save":
          await this.guardBusyThenApply(async () => { await this.settings.saveConnection(value.entry, value.apiKey, value.deleteApiKey); });
          break;
        case "connection/delete":
          await this.guardBusyThenApply(async () => { await this.settings.deleteConnection(value.connectionId); });
          break;
        case "settings/openaiLogin":
          await this.beginOpenAiLogin();
          break;
        case "settings/openaiCancelLogin":
          this.cancelOpenAiLogin();
          break;
        case "settings/openaiManualCallback":
          this.openAiLogin?.manual?.resolve(value.url);
          break;
        case "settings/openaiLogout":
          await this.openAiAuth.logout();
          this.post({ type: "settings/loaded", settings: await this.settings.view() });
          break;
        case "webview/ready":
          this.post({ type: "extension/info", version: String(this.context.extension.packageJSON.version) });
          this.post({ type: "session/loading", loading: true });
          this.post({ type: "settings/loaded", settings: await this.settings.view() });
          this.post({ type: "runtime/status", status: this.runtime.currentStatus });
          await this.publishSessionList();
          if ((await this.settings.load()).activeConnectionId && vscode.workspace.getConfiguration("logos").get<boolean>("autoStart", true)) {
            if (this.runtime.isRunning && this.sessionReady && this.replay.length) {
              this.replaying = true;
              try { for (const message of this.replay) this.post(message); } finally { this.replaying = false; }
            } else await this.synchronize();
            this.publishRuntimeConfigInBackground();
          }
          for (const message of this.sessions.diagnostics.splice(0)) this.post({ type: "runtime/error", message, fatal: false });
          this.post({ type: "session/loading", loading: false });
          break;
        case "chat/send":
          await this.sendPrompt(value.text);
          break;
        case "chat/abort":
          await this.runtime.abort();
          break;
        case "session/new":
          this.guardSessionChange();
          await this.synchronize(() => this.runtime.newSession());
          await this.publishRuntimeConfig();
          break;
        case "session/select": {
          const session = (await this.sessions.list()).find((item) => item.sessionId === value.sessionId);
          if (!session?.sessionFile) throw new Error("Selected session has no persisted session file");
          this.guardSessionChange();
          await this.synchronize(() => this.runtime.switchSession(session.sessionFile!, session.sessionId));
          await this.publishRuntimeConfig();
          break;
        }
        case "model/select":
          await this.runtime.setModel(value.provider, value.modelId);
          await this.publishRuntimeConfig();
          break;
        case "thinking/select":
          await this.runtime.setThinkingLevel(value.level);
          await this.publishRuntimeConfig();
          break;
        case "runtime/restart":
          this.guardSessionChange();
          await this.synchronize(() => this.runtime.restart());
          await this.publishRuntimeConfig();
          break;
      }
    } catch (error) {
      // 设置与连接的保存错误显示在设置面板里；其余走运行时错误横幅。
      const fromSettings = value.type.startsWith("settings/") || value.type.startsWith("connection/");
      if (value.type.startsWith("software/")) this.post({ type: "software/error", message: redactDiagnostic(error) });
      else if (fromSettings) this.post({ type: "settings/error", message: redactDiagnostic(error) });
      else this.post({ type: "runtime/error", message: redactDiagnostic(error), fatal: false });
      this.post({ type: "session/loading", loading: false });
    }
  }

  newSession(): Promise<void> { return this.enqueue({ type: "session/new" }); }

  private guardSessionChange(): void {
    if (this.runtime.currentStatus === "running") throw new Error("请先停止当前任务，再切换或新建会话。");
  }

  private enqueue(value: unknown): Promise<void> {
    const next = this.transition.then(() => this.handleMessage(value));
    this.transition = next.catch(() => undefined);
    return next;
  }

  private async publishSessionList(): Promise<void> {
    const active = await this.sessions.load();
    this.post({ type: "session/list", sessions: (await this.sessions.list()).filter((item) => item.sessionId)
      .map((item) => ({ sessionId: item.sessionId!, title: item.title, sessionFile: item.sessionFile })), activeSessionId: active?.sessionId });
  }

  private async synchronize(change?: () => Promise<void>): Promise<void> {
    this.sessionReady = false;
    this.restoring = true;
    this.post({ type: "session/loading", loading: true });
    try {
      if (change) await change(); else await this.runtime.start();
      await this.restoreSession(await this.runtime.snapshot());
      this.sessionReady = true;
    } finally {
      this.restoring = false;
      for (const event of this.pendingEvents.splice(0)) this.handleRuntimeEvent(event);
      this.post({ type: "session/loading", loading: false });
    }
  }

  private async beginOpenAiLogin(): Promise<void> {
    if (this.openAiLogin) return;
    const abort = new AbortController();
    const timeout = setTimeout(() => this.cancelOpenAiLogin(), 10 * 60 * 1000);
    const pending: PendingOpenAiLogin = { abort, timeout };
    this.openAiLogin = pending;
    try {
      await this.openAiAuth.login({
        signal: abort.signal,
        openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
        notify: (event) => this.post(event.type === "url"
          ? { type: "settings/openaiLoginStatus", phase: "waiting", url: event.url }
          : { type: "settings/openaiLoginStatus", phase: "exchanging" }),
        manualCallbackUrl: () => new Promise<string>((resolve, reject) => { pending.manual = { resolve, reject }; }),
      });
      this.post({ type: "settings/openaiLoginStatus", phase: "done" });
      this.post({ type: "settings/loaded", settings: await this.settings.view() });
    } finally {
      clearTimeout(timeout);
      this.openAiLogin = undefined;
      pending.manual?.reject(new Error("登录已结束。"));
    }
  }

  private cancelOpenAiLogin(): void {
    const pending = this.openAiLogin;
    if (!pending) return;
    pending.abort.abort();
    // 等待浏览器回调或手动粘贴时，中断信号本身唤不醒竞速，需要同时拒绝手动粘贴的挂起 Promise。
    pending.manual?.reject(new Error("登录已取消。"));
  }

  /** 设置类保存的统一流程：忙时拒绝 → 停止运行时 → 落盘 → 刷新视图 → 有可用配置就带新配置重启。 */
  private async guardBusyThenApply(apply: () => Promise<void>): Promise<void> {
    if (["starting", "running", "stopping"].includes(this.runtime.currentStatus)) throw new Error("请等待当前任务结束或停止后再保存设置。");
    await apply();
    await this.runtime.stop();
    this.post({ type: "settings/loaded", settings: await this.settings.view() });
    this.post({ type: "settings/saved" });
    const settings = await this.settings.load();
    if (settings.activeConnectionId && settings.activeModelId) {
      await this.synchronize();
      await this.publishRuntimeConfig();
      return;
    }
    // 没有可用配置时清空底部选择器，等用户在设置里新建。
    this.post({ type: "runtime/config", config: { models: [], thinkingLevels: [] } });
  }

  private async sendPrompt(text: string): Promise<void> {    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.runtime.isRunning || !this.sessionReady) await this.synchronize();
    this.publishRuntimeConfigInBackground();
    if (!this.runtime.state) await this.runtime.refreshState();
    const id = `user-${++this.sequence}`;
    const state = this.runtime.state;
    const sessionId = typeof state?.sessionId === "string" ? state.sessionId : undefined;
    const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : undefined;
    if (sessionId) {
      const existing = await this.sessions.list();
      const current = existing.find((item) => item.sessionId === sessionId);
      await this.sessions.save({
        sessionFile,
        sessionId,
        title: current?.title && current.title !== sessionId && current.title !== "New session"
          ? current.title
          : titleFromPrompt(trimmed),
      });
      const sessions = await this.sessions.list();
      this.post({ type: "session/list", sessions: sessions.filter((item) => item.sessionId).map((item) => ({ sessionId: item.sessionId!, title: item.title, sessionFile: item.sessionFile })), activeSessionId: sessionId });
    }
    this.post({ type: "message/user", id, text: trimmed });
    try { await this.runtime.prompt(trimmed); }
    catch (error) { this.failRun(error); }
  }

  private handleRuntimeEvent(event: RuntimeEvent): void {
    if (this.restoring && event.type === "record") { this.pendingEvents.push(event); return; }
    switch (event.type) {
      case "status":
        this.post({ type: "runtime/status", status: event.status ?? "idle", detail: event.detail ? redactDiagnostic(event.detail) : undefined });
        if (event.status === "error") this.failRun(event.detail ?? "运行时错误", "interrupted");
        return;
      case "stderr":
        return;
      case "protocol_error":
        this.failRun(event.error ?? "Invalid LOGOS RPC output", "interrupted");
        return;
      case "exit":
        return;
      case "record":
        if (event.record) this.handleRecord(event.record);
        return;
    }
  }

  private handleRecord(record: RpcRecord): void {
    const type = record.type;
    if (type === "logos/session_restore") {
      void this.restoreSession(record).catch((error) => this.failRun(error));
      return;
    }
    if (type === "logos/session_reset") {
      this.post({ type: "session/reset" });
      return;
    }
    if (type === "agent_start") {
      this.runFailed = false;
      this.saveOutcome("running");
      this.post({ type: "runtime/status", status: "running" });
      return;
    }
    if (type === "agent_settled") {
      const outcome = record.aborted === true ? "aborted" : this.runFailed ? "failed" : "completed";
      this.saveOutcome(outcome);
      this.post({ type: "run/settled", aborted: record.aborted === true, outcome });
      this.post({ type: "runtime/status", status: "ready" });
      void this.publishRuntimeConfig().catch((error) => {
        this.post({ type: "runtime/error", message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (type === "message_start") {
      const message = isRecord(record.message) ? record.message : undefined;
      if (message?.role === "assistant") {
        this.currentAssistantId = `assistant-${++this.assistantSequence}`;
        this.currentAssistantText = "";
        this.post({ type: "message/started", id: this.currentAssistantId });
      }
      return;
    }
    if (type === "message_update") {
      this.handleMessageUpdate(record);
      return;
    }
    if (type === "message_end") {
      const message = isRecord(record.message) ? record.message : undefined;
      if (message?.role === "assistant") {
        const failed = message.stopReason === "error" || message.stopReason === "length" || typeof message.errorMessage === "string";
        const reason = message.errorMessage ?? (message.stopReason === "length" ? "模型达到输出长度上限，本轮回复未完整结束。可发送继续指令。" : "模型请求失败");
        const text = textFromContent(message.content);
        if (this.currentAssistantId) this.post({ type: "message/completed", id: this.currentAssistantId,
          text: text || (failed ? redactDiagnostic(reason) : ""), isError: failed });
        if (failed) this.failRun(reason);
        this.currentAssistantId = undefined;
      }
      return;
    }
    if (type === "tool_execution_start") {
      this.currentAssistantId = undefined;
      const tool = this.toolFromRecord(record, "running");
      this.activeTools.set(tool.id, tool);
      this.post({ type: "tool/started", tool });
      return;
    }
    if (type === "tool_execution_update") {
      const tool = this.toolFromRecord(record, "running");
      const merged = { ...this.activeTools.get(tool.id), ...tool, args: tool.args ?? this.activeTools.get(tool.id)?.args };
      this.activeTools.set(tool.id, merged);
      this.post({ type: "tool/updated", tool: merged });
      return;
    }
    if (type === "tool_execution_end") {
      const tool = this.toolFromRecord(record, record.isError === true ? "error" : "completed");
      this.post({ type: "tool/completed", tool: { ...tool, args: tool.args ?? this.activeTools.get(tool.id)?.args } });
      this.activeTools.delete(tool.id);
      if (record.isError === true) {
        this.runFailed = true;
        this.post({ type: "runtime/error", message: redactDiagnostic(`工具 ${String(record.toolName)} 失败：${JSON.stringify(record.result)}`), fatal: false });
      }
      return;
    }
    if (type === "extension_error") {
      this.failRun(record.error ?? "LOGOS extension error");
    }
  }

  private saveOutcome(outcome: RunOutcome): void {
    const id = this.runtime.state?.sessionId;
    if (typeof id === "string") void this.sessions.setOutcome(id, outcome).catch((error) => {
      this.post({ type: "runtime/error", message: `保存会话状态失败：${redactDiagnostic(error)}`, fatal: false });
    });
  }

  private failRun(error: unknown, outcome: "failed" | "interrupted" = "failed"): void {
    this.runFailed = true;
    this.saveOutcome(outcome);
    this.post({ type: "runtime/error", message: redactDiagnostic(error), fatal: true });
    this.post({ type: "run/settled", aborted: false, outcome });
  }

  private handleMessageUpdate(record: RpcRecord): void {
    const nested = isRecord(record.assistantMessageEvent) ? record.assistantMessageEvent : undefined;
    if (!nested) return;
    if (!this.currentAssistantId) {
      this.currentAssistantId = `assistant-${++this.assistantSequence}`;
      this.post({ type: "message/started", id: this.currentAssistantId });
    }
    const id = this.currentAssistantId;
    if (nested.type === "text_delta" && typeof nested.delta === "string") {
      this.currentAssistantText += nested.delta;
      this.post({ type: "message/text_delta", id, delta: nested.delta });
    }
  }

  private toolFromRecord(record: RpcRecord, status: ToolCallView["status"]): ToolCallView {
    const id = typeof record.toolCallId === "string" ? record.toolCallId : `tool-${++this.sequence}`;
    const name = typeof record.toolName === "string" ? record.toolName : "tool";
    const result = record.result ?? record.partialResult;
    return {
      id,
      name,
      args: record.args,
      output: status === "error" ? redactDiagnostic(typeof result === "string" ? result : JSON.stringify(result)) : result,
      status,
      durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
    };
  }

  private async restoreSession(record: RpcRecord): Promise<void> {
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const state = isRecord(record.state) ? record.state : undefined;
    const restoredTools: RestoredTool[] = [];
    const pendingTools = new Map<string, RestoredTool>();
    const restored: RestoredMessage[] = messages.flatMap((value, index) => {
      if (!isRecord(value)) return [];
      const role = value.role;
      if (role === "assistant" && Array.isArray(value.content)) for (const block of value.content) {
        if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
          pendingTools.set(block.id, { id: block.id, name: block.name, args: block.arguments, status: state?.isStreaming === true ? "running" : "interrupted", position: index });
        }
      }
      if (role === "toolResult") {
        const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : `restored-tool-${index}`;
        restoredTools.push({ id: toolCallId, name: typeof value.toolName === "string" ? value.toolName : "tool", args: pendingTools.get(toolCallId)?.args, output: textFromContent(value.content), status: value.isError === true ? "error" : "completed", durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined, position: index });
        pendingTools.delete(toolCallId);
        return [];
      }
      if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") return [];
      return [{ id: `restored-${index}`, role, text: textFromContent(value.content) || (typeof value.errorMessage === "string" ? redactDiagnostic(value.errorMessage) : ""), position: index, isError: value.stopReason === "error" }];
    });
    restoredTools.push(...pendingTools.values());
    const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : undefined;
    const sessionId = typeof state?.sessionId === "string" ? state.sessionId : undefined;
    const previous = sessionId ? (await this.sessions.list()).find((item) => item.sessionId === sessionId) : undefined;
    if (messages.length > 0) await this.sessions.save({ sessionFile, sessionId, title: previous?.title });
    else await this.sessions.clear();
    this.post({
      type: "session/restore",
      messages: restored,
      tools: restoredTools,
      sessionName: typeof state?.sessionName === "string" ? state.sessionName : undefined,
    });
    if (state?.isStreaming === true) {
      if (this.currentAssistantId) {
        this.post({ type: "message/started", id: this.currentAssistantId });
        this.post({ type: "message/text_delta", id: this.currentAssistantId, delta: this.currentAssistantText });
      }
      for (const tool of this.activeTools.values()) this.post({ type: "tool/started", tool });
    } else { this.currentAssistantId = undefined; this.currentAssistantText = ""; this.activeTools.clear(); }
    if (previous?.outcome === "interrupted" || previous?.outcome === "running" && state?.isStreaming !== true) {
      this.post({ type: "runtime/error", message: "上次运行已中断。已恢复保存的上下文；计算不会自动重跑。", fatal: false });
      if (sessionId) await this.sessions.setOutcome(sessionId, "interrupted");
    }
    const sessions = await this.sessions.list();
    this.post({ type: "session/list", sessions: sessions.filter((item) => item.sessionId).map((item) => ({ sessionId: item.sessionId!, title: item.title, sessionFile: item.sessionFile })), activeSessionId: sessionId });
  }

  private post(message: ExtensionToWebviewMessage): void {
    if (!this.replaying) this.cacheForReopen(message);
    void this.view?.webview.postMessage(message);
    void this.panel?.webview.postMessage(message);
  }

  private cacheForReopen(message: ExtensionToWebviewMessage): void {
    if (message.type === "session/restore" || message.type === "session/reset") { this.replay = [message]; return; }
    if (message.type === "message/text_delta") {
      const previous = this.replay.find((item) => item.type === "message/text_delta" && item.id === message.id);
      if (previous?.type === "message/text_delta") { previous.delta += message.delta; return; }
    }
    if (message.type.startsWith("tool/") && "tool" in message) {
      const index = this.replay.findIndex((item) => "tool" in item && item.tool.id === message.tool.id);
      if (index >= 0) { this.replay[index] = message; return; }
    }
    if (message.type.startsWith("message/") || message.type.startsWith("tool/") || message.type === "run/settled") this.replay.push({ ...message });
  }

  private async publishRuntimeConfig(): Promise<void> {
    const config: RuntimeConfig = await this.runtime.getRuntimeConfig();
    this.post({ type: "runtime/config", config });
  }

  private publishRuntimeConfigInBackground(): void {
    void this.publishRuntimeConfig().catch((error) => this.post({ type: "runtime/error", message: redactDiagnostic(error), fatal: false }));
  }

  private configureWebview(webview: vscode.Webview): vscode.Disposable {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")] };
    webview.html = createWebviewHtml(webview, this.context.extensionUri);
    return webview.onDidReceiveMessage((message: unknown) => {
      // Cancellation must remain available while a prompt request is pending.
      if (isRecord(message) && ["chat/abort", "settings/openaiCancelLogin", "settings/openaiManualCallback", "diagnostics/open", "link/open"].includes(String(message.type))) void this.handleMessage(message);
      else void this.enqueue(message);
    });
  }
}

function titleFromPrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 47)}…` : compact || "Untitled session";
}

function createWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("hex");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.css"));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>LOGOS</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
