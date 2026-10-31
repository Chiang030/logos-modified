import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { redactDiagnostic } from "./diagnostics";
import { DEFAULT_FEED_URL, UpdateFeedError, buildAuthHeaders, resolveFeedUrl, selectUpdate, shouldAutoCheck,
  type ReleaseAsset, type ReleaseInfo, type UpdateInfo } from "./updateFeed";

const LAST_CHECK_KEY = "logos.update.lastSuccessfulCheck.v2";
const TOKEN_SECRET_KEY = "logos.update.githubToken";
const RETRY_INTERVAL_MS = 5 * 60_000;
interface SuccessfulCheck { checkedAt: number; feedUrl: string; version: string; }

export function registerUpdateChecks(context: vscode.ExtensionContext): vscode.Disposable {
  const output = vscode.window.createOutputChannel("LOGOS Updates");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  status.command = "logos.checkUpdate";
  status.show();
  const updater = new UpdateChecker(context, output, status);
  const startup = setTimeout(() => void updater.check(false), 2_000);
  const periodic = setInterval(() => void updater.check(false), RETRY_INTERVAL_MS);
  return vscode.Disposable.from(output, status,
    { dispose: () => { clearTimeout(startup); clearInterval(periodic); updater.dispose(); } },
    vscode.commands.registerCommand("logos.checkUpdate", () => updater.check(true)),
    vscode.commands.registerCommand("logos.update.showLogs", () => output.show()),
    vscode.commands.registerCommand("logos.update.setToken", async () => { await promptForToken(context); await updater.check(true); }),
    vscode.commands.registerCommand("logos.update.clearToken", async () => { await clearToken(context); await updater.check(true); }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("logos.update")) void updater.check(false, true);
    }));
}

class UpdateChecker implements vscode.Disposable {
  private inFlight: Promise<void> | undefined;
  private installedVersion: string | undefined;
  private disposed = false;
  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel,
    private readonly status: vscode.StatusBarItem) {
    this.report("等待检查", "启动后检查更新；点击可立即检查，输出面板 LOGOS Updates 可查看过程。");
  }
  dispose(): void { this.disposed = true; }
  check(manual: boolean, force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run(manual, force).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private report(label: string, detail: string): void {
    if (this.disposed) return;
    const safe = redactDiagnostic(detail);
    this.status.text = `$(extensions) LOGOS：${label}`;
    this.status.tooltip = `${safe}\n点击检查更新；命令 LOGOS: Show Update Logs 查看详情。`;
    this.output.appendLine(`[${new Date().toISOString()}] ${safe}`);
  }
  private async run(manual: boolean, force: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration("logos");
    if (!manual && !config.get<boolean>("update.autoCheck", true)) {
      this.report("自动检查已关闭", "logos.update.autoCheck 已关闭，仍可手动检查。"); return;
    }
    if (this.installedVersion) {
      this.report("等待重载", `v${this.installedVersion} 已安装，重新加载窗口后生效。`);
      if (manual) this.offerReload(this.installedVersion);
      return;
    }
    const feedUrl = resolveFeedUrl(config.get<string>("update.feedUrl"));
    const version = String(this.context.extension.packageJSON.version);
    const previous = this.context.globalState.get<SuccessfulCheck>(LAST_CHECK_KEY);
    if (!manual && !force && previous?.feedUrl === feedUrl && previous.version === version
      && !shouldAutoCheck(previous.checkedAt, Date.now())) {
      this.report("定时检查已启用", `更新源 ${feedUrl}；上次成功检查 ${new Date(previous.checkedAt).toISOString()}，成功检查间隔 1 小时。`); return;
    }
    try {
      this.report("正在检查", `正在检查 v${version} 的更新，更新源：${feedUrl}`);
      const token = feedUrl === DEFAULT_FEED_URL ? undefined : await resolveToken(this.context);
      const releases = await fetchReleases(feedUrl, token);
      if (this.disposed) return;
      const update = selectUpdate(releases, version, process.platform, process.arch);
      if (update) {
        this.report(`发现 v${update.version}`, `发现新版本 v${update.version}，当前 v${version}。`);
        if (!manual && config.get<boolean>("update.autoInstall", true)) await this.install(update, token);
        else this.offerUpdate(update, token);
      } else {
        this.report("已是最新", `检查成功：没有适用于 ${process.platform}-${process.arch} 且高于 v${version} 的稳定版本。`);
        if (manual) void vscode.window.showInformationMessage(`LOGOS 已是最新可用版本（v${version}）。`);
      }
      if (!this.disposed) await this.context.globalState.update(LAST_CHECK_KEY, { feedUrl, version, checkedAt: Date.now() });
    } catch (error) { this.failure(error, manual, feedUrl); }
  }
  private failure(error: unknown, manual: boolean, feedUrl?: string): void {
    void this.context.globalState.update(LAST_CHECK_KEY, undefined).then(undefined, (failure) => {
      this.output.appendLine(`无法清除更新节流状态：${redactDiagnostic(failure)}`);
    });
    const detail = `更新失败：${redactDiagnostic(error)}${feedUrl ? `；更新源：${feedUrl}` : ""}。自动检查将在 5 分钟后重试，也可立即手动检查。`;
    this.report("更新失败（点击重试）", detail);
    if (manual) void vscode.window.showErrorMessage(detail, "查看更新日志").then((action) => {
      if (action === "查看更新日志") this.output.show();
    });
  }
  private offerUpdate(update: UpdateInfo, token?: string): void {
    void vscode.window.showInformationMessage(`LOGOS 新版本 v${update.version} 可用。`, "立即更新", "查看发布说明").then(async (action) => {
      if (this.disposed) return;
      if (action === "查看发布说明" && update.releaseUrl) await vscode.env.openExternal(vscode.Uri.parse(update.releaseUrl));
      else if (action === "立即更新") {
        if (this.inFlight) await this.inFlight;
        if (this.installedVersion || this.disposed) return;
        this.inFlight = this.install(update, token).catch((error) => this.failure(error, true)).finally(() => { this.inFlight = undefined; });
        await this.inFlight;
      }
    }).then(undefined, (error) => this.failure(error, true));
  }
  private offerReload(version: string): void {
    void vscode.window.showInformationMessage(`LOGOS v${version} 已安装，重新加载窗口后生效。`, "重新加载窗口").then((action) => {
      if (action === "重新加载窗口") void vscode.commands.executeCommand("workbench.action.reloadWindow");
    });
  }
  private async install(update: UpdateInfo, token?: string): Promise<void> {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `LOGOS 正在更新到 v${update.version}…` }, async (progress) => {
      this.report("正在下载", `正在下载 ${update.asset.name}`);
      progress.report({ message: "下载并校验安装包…" });
      const path = await downloadAsset(this.context, update.asset, token, (message) => {
        progress.report({ message }); this.status.tooltip = message;
        if (message.startsWith("下载连接中断")) this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
      });
      try {
        if (this.disposed) return;
        this.report("正在安装", `正在通过当前 VS Code 窗口安装 ${update.asset.name}`);
        progress.report({ message: "安装到当前 VS Code…" });
        await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(path));
        this.installedVersion = update.version;
      } finally { await rm(path, { force: true }).catch((error) => this.output.appendLine(`清理安装包失败：${redactDiagnostic(error)}`)); }
    });
    if (this.installedVersion) {
      this.report("等待重载", `v${update.version} 已安装，重新加载窗口后生效。`);
      this.offerReload(update.version);
    }
  }
}

async function resolveToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const stored = await context.secrets.get(TOKEN_SECRET_KEY);
  if (stored) return stored;
  try { return (await vscode.authentication.getSession("github", ["repo"], { silent: true }))?.accessToken; }
  catch { return undefined; }
}

async function fetchReleases(feedUrl: string, token?: string): Promise<ReleaseInfo[]> {
  const response = await fetch(`${feedUrl.replace(/\/+$/, "")}/releases?per_page=30`, {
    headers: buildAuthHeaders(token), redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new UpdateFeedError(`更新源返回 HTTP ${response.status}`, response.status);
  const releases: unknown = await response.json();
  if (!Array.isArray(releases) || !releases.every((release) => release && typeof release.tag_name === "string")) {
    throw new Error("更新源返回的内容不是有效的 Release 列表");
  }
  return releases as ReleaseInfo[];
}

async function fetchAsset(asset: ReleaseAsset, token: string | undefined, progress: (message: string) => void): Promise<Buffer> {
  // Anonymous public downloads use the release URL; private assets use the authenticated API.
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(!token && asset.browser_download_url ? asset.browser_download_url : asset.url, {
        headers: buildAuthHeaders(token, "application/octet-stream"), signal: AbortSignal.timeout(600_000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new UpdateFeedError(`下载 VSIX 失败：HTTP ${response.status}`, response.status); }
      if (!response.body) throw new Error("下载响应为空");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let received = 0; let reported = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          received += value.byteLength;
          if (received > (asset.size ?? 1024 * 1024 * 1024)) throw new UpdateFeedError("下载内容超过预期大小");
          chunks.push(value);
          if (received - reported >= 1024 * 1024) {
            progress(`已下载 ${(received / 1024 / 1024).toFixed(1)} MB${asset.size ? ` / ${(asset.size / 1024 / 1024).toFixed(1)} MB` : ""}`);
            reported = received;
          }
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      return Buffer.concat(chunks, received);
    } catch (error) {
      if (attempt >= 3 || error instanceof UpdateFeedError) throw error;
      progress(`下载连接中断，正在重试（${attempt}/2）：${redactDiagnostic(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function downloadAsset(context: vscode.ExtensionContext, asset: ReleaseAsset, token: string | undefined,
  progress: (message: string) => void): Promise<string> {
  const bytes = await fetchAsset(asset, token, progress);
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error("下载内容不是有效的 VSIX/ZIP 安装包");
  if (asset.size !== undefined && asset.size !== bytes.length) throw new Error("VSIX 下载不完整：大小与发布信息不符");
  if (asset.digest?.startsWith("sha256:") && asset.digest.toLowerCase() !== `sha256:${createHash("sha256").update(bytes).digest("hex")}`) {
    throw new Error("VSIX 的 SHA-256 与发布信息不符，已拒绝安装");
  }
  const directory = join(context.globalStorageUri.fsPath, "updates");
  await mkdir(directory, { recursive: true });
  const final = join(directory, asset.name);
  const staged = `${final}.tmp`;
  try { await writeFile(staged, bytes); await rename(staged, final); }
  finally { await rm(staged, { force: true }); }
  return final;
}

async function promptForToken(context: vscode.ExtensionContext): Promise<void> {
  const token = await vscode.window.showInputBox({
    prompt: "GitHub 访问令牌（fine-grained PAT，需目标仓库 Contents 读取权限）",
    placeHolder: "github_pat_…",
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) return;
  const trimmed = token.trim();
  if (trimmed) await context.secrets.store(TOKEN_SECRET_KEY, trimmed);
  else await context.secrets.delete(TOKEN_SECRET_KEY);
  void vscode.window.showInformationMessage(trimmed ? "LOGOS 更新令牌已保存。" : "LOGOS 更新令牌已清除。");
}

async function clearToken(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(TOKEN_SECRET_KEY);
  void vscode.window.showInformationMessage("LOGOS 更新令牌已清除。");
}
