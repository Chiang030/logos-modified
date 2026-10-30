import { join } from "node:path";
import * as vscode from "vscode";
import { LocalRuntime } from "./localRuntime";
import { SessionStore } from "./sessionStore";
import { LogosWebviewProvider } from "./webviewBridge";
import { installBundledRuntime } from "./bundledInstallation";
import { ConnectionSettingsStore } from "./connectionSettings";
import { OpenAiAuthStore } from "./auth/openAiAuthStore";
import { registerUpdateChecks } from "./updateChecker";
import { NodeRuntimeError } from "./runtimeLaunch";
import { redactDiagnostic } from "./diagnostics";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // 更新检查不依赖工作区，需在无工作区的提前返回之前注册。
  context.subscriptions.push(registerUpdateChecks(context));
  const workspace = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspace?.uri.fsPath;
  if (!workspaceRoot) {
    void vscode.window.showWarningMessage("Open a workspace to use LOGOS.");
    return;
  }

  const storageRoot = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
  const installation = await installBundledRuntime(context.extensionUri.fsPath, context.globalStorageUri.fsPath);
  const openAiAuth = new OpenAiAuthStore(context.secrets, context.globalState);
  const settings = new ConnectionSettingsStore(
    join(context.globalStorageUri.fsPath, "logos-agent", "config"),
    join(installation, "logos-agent", "pi-domain"), context.secrets, openAiAuth,
  );
  const sessions = new SessionStore(join(storageRoot, "sessions"));
  try { await sessions.reconcile(join(storageRoot, "runtime-sessions")); }
  catch (error) { sessions.diagnostics.push(`恢复会话索引失败：${redactDiagnostic(error)}`); }
  const runtime = new LocalRuntime({
    extensionRoot: installation,
    workspaceRoot,
    sessionDirectory: join(storageRoot, "runtime-sessions"),
    sessionStore: sessions,
    settings,
    profileDirectory: join(storageRoot, "logos-agent", "profile"),
  });
  const provider = new LogosWebviewProvider(context, runtime, sessions, settings, openAiAuth);
  const output = vscode.window.createOutputChannel("LOGOS");
  void settings.software().catch((error) => output.appendLine(`[software] ${redactDiagnostic(error)}`));
  const outputSubscription = runtime.onDidEvent((event) => {
    if (event.type === "stderr" && event.text) output.append(redactDiagnostic(event.text));
    if (event.type === "log" && event.text) output.appendLine(`[runtime] ${redactDiagnostic(event.text)}`);
    if (event.type === "protocol_error" && event.error) output.appendLine(`[protocol] ${redactDiagnostic(event.error)}`);
    if (event.type === "node_error" && event.error) {
      output.appendLine(`[runtime] ${event.error.message}`);
      const reason = event.error instanceof NodeRuntimeError ? event.error.reason : undefined;
      void showNodeRuntimeActions(event.error.message, reason, runtime, output);
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("logos.openChat", () => provider.openPanel()),
    vscode.commands.registerCommand("logos.restartRuntime", () => runtime.restart()),
    vscode.commands.registerCommand("logos.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("logos.showLogs", () => output.show()),
    output,
    outputSubscription,
    runtime,
    provider,
  );
}

export function deactivate(): void {}

let nodeRuntimePrompt: Promise<void> | undefined;

function showNodeRuntimeActions(
  message: string,
  reason: NodeRuntimeError["reason"] | undefined,
  runtime: LocalRuntime,
  output: vscode.OutputChannel,
): Promise<void> {
  if (nodeRuntimePrompt) return nodeRuntimePrompt;
  const actions = ["Retry"];
  if (reason === "missing" || reason === "unsupported") actions.push("Download Node.js");
  if (reason === "missing" || reason === "unexecutable" || reason === "platform") actions.push("Configure Node Path");
  nodeRuntimePrompt = (async () => {
    const action = await vscode.window.showErrorMessage(message, ...actions);
    if (action === "Retry") {
      try {
        await runtime.restart();
      } catch (error) {
        output.appendLine(`[runtime] Retry failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (action === "Download Node.js") {
      await vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org/en/download"));
    } else if (action === "Configure Node Path") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "logos.nodeExecutable");
    }
  })().finally(() => { nodeRuntimePrompt = undefined; });
  return nodeRuntimePrompt;
}
