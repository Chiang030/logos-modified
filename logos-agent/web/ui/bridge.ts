import type { HostBridge } from "../../vscode-extension/webview-ui/src/hostBridge";
import type { ExtensionToWebviewMessage } from "../../vscode-extension/webview-ui/src/protocol";
import { api, type Conversation, type Project, type User } from "./api";

export class BrowserBridge implements HostBridge {
  listeners = new Set<(message: ExtensionToWebviewMessage) => void>();
  project: Project; user: User; preview: boolean; version: string;
  notice: (message: string) => void; openFile: (path: string) => void;
  active?: string;
  constructor(project: Project, user: User, preview: boolean, version: string, notice: (message: string) => void, openFile: (path: string) => void) {
    this.project = project; this.user = user; this.preview = preview; this.version = version; this.notice = notice; this.openFile = openFile;
  }
  subscribe(listener: (message: ExtensionToWebviewMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(message: ExtensionToWebviewMessage): void { for (const listener of this.listeners) listener(message); }
  identity(): void {
    this.emit({ type: "identity/loaded", identity: { selected: this.user, members: [this.user], summaries: [], models: [], recordFile: "" } });
  }
  postMessage(value: unknown): void {
    void this.command(value as Record<string, unknown>).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "操作失败";
      this.emit({ type: "runtime/error", message, fatal: false }); this.notice(message);
    });
  }
  async command(command: Record<string, unknown>): Promise<void> {
    switch (command.type) {
      case "webview/ready":
        this.identity(); this.emit({ type: "extension/info", version: this.version });
        this.emit({ type: "runtime/config", config: { models: [], thinkingLevels: [] } });
        this.emit({ type: "runtime/status", status: "idle", detail: "执行环境尚未就绪" });
        this.emit({ type: "session/loading", loading: false }); await this.history(); return;
      case "identity/load": this.identity(); this.notice("当前身份来自飞书登录，不能在页面中切换姓名"); return;
      case "settings/load": this.notice("模型账号由管理员统一配置。管理功能与真实运行将在后续阶段接入。"); return;
      case "software/scan": this.emit({ type: "software/error", message: "服务器软件扫描由管理员维护" }); this.notice("服务器软件扫描由管理员维护"); return;
      case "diagnostics/open": this.notice("当前未启动 Agent。执行隔离验证失败，任务入口保持关闭。"); return;
      case "link/open": {
        const href = String(command.href ?? "");
        if (/^https?:\/\//i.test(href)) { window.open(href, "_blank", "noopener,noreferrer"); return; }
        if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) throw new Error("该文件链接不支持在网页中打开");
        this.openFile(href.replace(/^\.\//, "")); return;
      }
      case "session/new":
        if (this.preview) { this.active = undefined; this.emit({ type: "session/reset" }); return; }
        this.active = (await api<{ session: Conversation }>("/api/sessions", { project: this.project.id })).session.id;
        this.emit({ type: "session/reset" }); await this.history(); return;
      case "session/select": {
        const sessions = await this.history();
        if (!sessions.some((s) => s.id === command.sessionId)) throw new Error("会话不存在");
        this.active = String(command.sessionId); this.emit({ type: "session/reset" }); await this.history(); return;
      }
      case "chat/send":
        if (this.preview) throw new Error("这是只读界面预览，没有提交任务或调用模型");
        await api("/api/bridge", { project: this.project.id, command }); return;
      case "chat/abort": this.notice("当前没有运行中的任务"); return;
      case "session/rename":
        if (this.preview) return;
        await api("/api/bridge", { project: this.project.id, command }); await this.history(); return;
      default: this.notice("此功能尚未启用");
    }
  }
  async history(): Promise<Conversation[]> {
    const sessions = this.preview ? [] : (await api<{ sessions: Conversation[] }>("/api/sessions?project=" + encodeURIComponent(this.project.id))).sessions;
    this.active ??= sessions[0]?.id;
    this.emit({ type: "session/list", sessions: sessions.map((s) => ({ sessionId: s.id, title: s.title })), activeSessionId: this.active });
    return sessions;
  }
}
