import { execFile } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  DEFAULT_FEED_URL,
  UpdateFeedError,
  buildAuthHeaders,
  resolveCodeCli,
  resolveFeedUrl,
  selectUpdate,
  shouldAutoCheck,
  type ReleaseAsset,
  type ReleaseInfo,
  type UpdateInfo,
} from "./updateFeed";

const LAST_CHECK_KEY = "logos.update.lastCheck";
const TOKEN_SECRET_KEY = "logos.update.githubToken";

export function registerUpdateChecks(context: vscode.ExtensionContext): vscode.Disposable {
  const commands = [
    vscode.commands.registerCommand("logos.checkUpdate", () => void checkForUpdates(context, true)),
    vscode.commands.registerCommand("logos.update.setToken", () => void promptForToken(context)),
    vscode.commands.registerCommand("logos.update.clearToken", () => void clearToken(context)),
  ];
  void runAutomaticCheck(context);
  return vscode.Disposable.from(...commands);
}

async function runAutomaticCheck(context: vscode.ExtensionContext): Promise<void> {
  try {
    if (!vscode.workspace.getConfiguration("logos").get<boolean>("update.autoCheck", true)) return;
    const lastCheck = context.globalState.get<number>(LAST_CHECK_KEY);
    if (shouldAutoCheck(lastCheck, Date.now())) {
      await checkForUpdates(context, false);
      // Only advance the throttle after a real check; refreshing it on every
      // activation would starve daily users of checks entirely.
      void context.globalState.update(LAST_CHECK_KEY, Date.now());
    }
  } catch {
    // 启动静默检查失败不打扰用户。
  }
}

async function checkForUpdates(context: vscode.ExtensionContext, manual: boolean): Promise<void> {
  const configuredFeedUrl = vscode.workspace.getConfiguration("logos").get<string>("update.feedUrl");
  const feedUrl = resolveFeedUrl(configuredFeedUrl ?? DEFAULT_FEED_URL);
  const token = await resolveToken(context, manual);
  let releases: ReleaseInfo[];
  try {
    releases = await fetchReleases(feedUrl, token);
  } catch (error) {
    if (manual) void vscode.window.showErrorMessage(buildFeedErrorMessage(error, token));
    return;
  }
  const currentVersion = String(context.extension.packageJSON.version);
  const update = selectUpdate(releases, currentVersion, process.platform, process.arch);
  if (!update) {
    if (manual) void vscode.window.showInformationMessage(`LOGOS 已是最新版本（v${currentVersion}）。`);
    return;
  }
  const action = await vscode.window.showInformationMessage(
    `LOGOS 新版本 v${update.version} 可用（当前 v${currentVersion}）。`, "立即更新", "查看发布说明");
  if (action === "查看发布说明" && update.releaseUrl) {
    await vscode.env.openExternal(vscode.Uri.parse(update.releaseUrl));
  } else if (action === "立即更新") {
    await installUpdate(context, update, token);
  }
}

async function resolveToken(context: vscode.ExtensionContext, interactive: boolean): Promise<string | undefined> {
  const options: vscode.AuthenticationGetSessionOptions = interactive ? { createIfNone: true } : { silent: true };
  let session: vscode.AuthenticationSession | undefined;
  try {
    session = await vscode.authentication.getSession("github", ["repo"], options);
  } catch {
    session = undefined;
  }
  return session?.accessToken ?? context.secrets.get(TOKEN_SECRET_KEY);
}

async function fetchReleases(feedUrl: string, token: string | undefined): Promise<ReleaseInfo[]> {
  const response = await fetch(`${feedUrl.replace(/\/+$/, "")}/releases?per_page=30`, {
    headers: buildAuthHeaders(token),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new UpdateFeedError(`更新源返回 HTTP ${response.status}`, response.status);
  return response.json() as Promise<ReleaseInfo[]>;
}

function buildFeedErrorMessage(error: unknown, token: string | undefined): string {
  const status = error instanceof UpdateFeedError ? error.status : undefined;
  if (status === 401 || status === 403 || status === 404) {
    if (!token) {
      return "更新源需要 GitHub 授权（私有仓库）。请在弹出的 GitHub 登录中授权，或运行 LOGOS: Set Update Token 配置访问令牌。";
    }
    return `更新源拒绝了当前凭据（HTTP ${status}）。请检查令牌对该仓库的 Contents 读取权限，或运行 LOGOS: Set Update Token 重新配置。`;
  }
  return `检查更新失败：${error instanceof Error ? error.message : String(error)}`;
}

async function installUpdate(context: vscode.ExtensionContext, update: UpdateInfo, token: string | undefined): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `LOGOS 正在更新到 v${update.version}…` },
      async () => {
        const vsixPath = await downloadAsset(context, update.asset, token);
        await installVsix(vsixPath);
        await rm(vsixPath, { force: true });
      });
    const action = await vscode.window.showInformationMessage(`LOGOS v${update.version} 已安装，重新加载窗口后生效。`, "重新加载窗口");
    if (action === "重新加载窗口") void vscode.commands.executeCommand("workbench.action.reloadWindow");
  } catch (error) {
    void vscode.window.showErrorMessage(`更新失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function downloadAsset(context: vscode.ExtensionContext, asset: ReleaseAsset, token: string | undefined): Promise<string> {
  const response = await fetch(asset.url, {
    headers: buildAuthHeaders(token, "application/octet-stream"),
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new UpdateFeedError(`下载 VSIX 失败：HTTP ${response.status}`, response.status);
  const updatesDirectory = join(context.globalStorageUri.fsPath, "updates");
  await mkdir(updatesDirectory, { recursive: true });
  const staged = join(updatesDirectory, `${asset.name}.tmp`);
  const final = join(updatesDirectory, asset.name);
  await writeFile(staged, Buffer.from(await response.arrayBuffer()));
  await rename(staged, final);
  return final;
}

async function installVsix(vsixPath: string): Promise<void> {
  const cli = resolveCodeCli(process.execPath);
  await new Promise<void>((resolve, reject) => {
    execFile(cli.command, [...cli.prefixArgs, "--install-extension", vsixPath], { timeout: 120_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || stdout || "").trim() || error.message));
        else resolve();
      });
  });
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
