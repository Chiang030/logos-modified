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

export class LogosWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private viewMessageSubscription: vscode.Disposable | undefined;
  private panelMessageSubscription: vscode.Disposable | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private sequence = 0;
  private assistantSequence = 0;
  private currentAssistantId: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: LocalRuntime,
    private readonly sessions: SessionStore,
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
        case "webview/ready":
          this.post({ type: "runtime/status", status: this.runtime.currentStatus });
          this.post({ type: "session/list", sessions: (await this.sessions.list()).filter((item) => item.sessionId).map((item) => ({ sessionId: item.sessionId!, title: item.title, sessionFile: item.sessionFile })) });
          if (vscode.workspace.getConfiguration("logos").get<boolean>("autoStart", true)) {
            await this.runtime.start();
            this.publishRuntimeConfigInBackground();
          }
          break;
        case "chat/send":
          await this.sendPrompt(value.text);
          break;
        case "chat/abort":
          await this.runtime.abort();
          break;
        case "session/new":
          await this.runtime.newSession();
          await this.sessions.clear();
          {
            const state = await this.runtime.refreshState();
            const sessionId = typeof state.sessionId === "string" ? state.sessionId : undefined;
            const sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : undefined;
            if (sessionId) {
              await this.sessions.save({ sessionId, sessionFile, title: "New session" });
              const sessions = await this.sessions.list();
              this.post({
                type: "session/list",
                sessions: sessions.filter((item) => item.sessionId).map((item) => ({ sessionId: item.sessionId!, title: item.title, sessionFile: item.sessionFile })),
                activeSessionId: sessionId,
              });
            }
          }
          await this.publishRuntimeConfig();
          break;
        case "session/select": {
          const session = (await this.sessions.list()).find((item) => item.sessionId === value.sessionId);
          if (!session?.sessionFile) throw new Error("Selected session has no persisted session file");
          this.currentAssistantId = undefined;
          this.post({ type: "session/reset" });
          await this.runtime.switchSession(session.sessionFile, session.sessionId);
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
          await this.runtime.restart();
          await this.publishRuntimeConfig();
          break;
      }
    } catch (error) {
      this.post({ type: "runtime/error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async sendPrompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    await this.runtime.start();
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
    await this.runtime.prompt(trimmed);
  }

  private handleRuntimeEvent(event: RuntimeEvent): void {
    switch (event.type) {
      case "status":
        this.post({ type: "runtime/status", status: event.status ?? "idle", detail: event.detail });
        return;
      case "stderr":
        return;
      case "protocol_error":
        this.post({ type: "runtime/error", message: event.error?.message ?? "Invalid LOGOS RPC output" });
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
      void this.restoreSession(record);
      return;
    }
    if (type === "logos/session_reset") {
      this.post({ type: "session/reset" });
      return;
    }
    if (type === "agent_start") {
      this.post({ type: "runtime/status", status: "running" });
      return;
    }
    if (type === "agent_settled") {
      this.post({ type: "run/settled", aborted: record.aborted === true });
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
        if (this.currentAssistantId) this.post({ type: "message/completed", id: this.currentAssistantId, text: textFromContent(message.content) });
        this.currentAssistantId = undefined;
      }
      return;
    }
    if (type === "tool_execution_start") {
      this.currentAssistantId = undefined;
      this.post({ type: "tool/started", tool: this.toolFromRecord(record, "running") });
      return;
    }
    if (type === "tool_execution_update") {
      this.post({ type: "tool/updated", tool: this.toolFromRecord(record, "running") });
      return;
    }
    if (type === "tool_execution_end") {
      this.post({ type: "tool/completed", tool: this.toolFromRecord(record, record.isError === true ? "error" : "completed") });
      return;
    }
    if (type === "extension_error") {
      this.post({ type: "runtime/error", message: typeof record.error === "string" ? record.error : "LOGOS extension error" });
    }
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
      output: result,
      status,
      durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
    };
  }

  private async restoreSession(record: RpcRecord): Promise<void> {
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const restoredTools: RestoredTool[] = [];
    const restored: RestoredMessage[] = messages.flatMap((value, index) => {
      if (!isRecord(value)) return [];
      const role = value.role;
      if (role === "toolResult") {
        const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : `restored-tool-${index}`;
        restoredTools.push({ id: toolCallId, name: typeof value.toolName === "string" ? value.toolName : "tool", output: textFromContent(value.content), status: value.isError === true ? "error" : "completed", durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined, position: index });
        return [];
      }
      if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") return [];
      return [{ id: `restored-${index}`, role, text: textFromContent(value.content), position: index }];
    });
    const state = isRecord(record.state) ? record.state : undefined;
    const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : undefined;
    const sessionId = typeof state?.sessionId === "string" ? state.sessionId : undefined;
    const previous = sessionId ? (await this.sessions.list()).find((item) => item.sessionId === sessionId) : undefined;
    await this.sessions.save({ sessionFile, sessionId, title: previous?.title });
    this.post({
      type: "session/restore",
      messages: restored,
      tools: restoredTools,
      sessionName: typeof state?.sessionName === "string" ? state.sessionName : undefined,
    });
    const sessions = await this.sessions.list();
    this.post({ type: "session/list", sessions: sessions.filter((item) => item.sessionId).map((item) => ({ sessionId: item.sessionId!, title: item.title, sessionFile: item.sessionFile })), activeSessionId: sessionId });
  }

  private post(message: ExtensionToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
    void this.panel?.webview.postMessage(message);
  }

  private async publishRuntimeConfig(): Promise<void> {
    const config: RuntimeConfig = await this.runtime.getRuntimeConfig();
    this.post({ type: "runtime/config", config });
  }

  private publishRuntimeConfigInBackground(): void {
    void this.publishRuntimeConfig().catch(() => undefined);
  }

  private configureWebview(webview: vscode.Webview): vscode.Disposable {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")] };
    webview.html = createWebviewHtml(webview, this.context.extensionUri);
    return webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message));
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
