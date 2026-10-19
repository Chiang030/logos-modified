import { join } from "node:path";
import * as vscode from "vscode";
import { LocalRuntime } from "./localRuntime";
import { SessionStore } from "./sessionStore";
import { LogosWebviewProvider } from "./webviewBridge";
import { installBundledRuntime } from "./bundledInstallation";
import { ConnectionSettingsStore } from "./connectionSettings";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspace?.uri.fsPath;
  if (!workspaceRoot) {
    void vscode.window.showWarningMessage("Open a workspace to use LOGOS.");
    return;
  }

  const storageRoot = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
  const installation = await installBundledRuntime(context.extensionUri.fsPath, context.globalStorageUri.fsPath);
  const settings = new ConnectionSettingsStore(
    join(context.globalStorageUri.fsPath, "logos-agent", "config"),
    join(installation, "logos-agent", "pi-domain"), context.secrets,
  );
  const sessions = new SessionStore(join(storageRoot, "sessions"));
  const runtime = new LocalRuntime({
    extensionRoot: installation,
    workspaceRoot,
    sessionDirectory: join(storageRoot, "runtime-sessions"),
    sessionStore: sessions,
    settings,
    profileDirectory: join(storageRoot, "logos-agent", "profile"),
  });
  const provider = new LogosWebviewProvider(context, runtime, sessions, settings);
  const output = vscode.window.createOutputChannel("LOGOS");
  const outputSubscription = runtime.onDidEvent((event) => {
    if (event.type === "stderr" && event.text) output.append(event.text);
    if (event.type === "log" && event.text) output.appendLine(`[runtime] ${event.text}`);
    if (event.type === "protocol_error" && event.error) output.appendLine(`[protocol] ${event.error.message}`);
    if (event.type === "node_error" && event.error) {
      output.appendLine(`[runtime] ${event.error.message}`);
      void showNodeRuntimeActions(event.error.message, runtime, output);
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("logos.openChat", () => provider.openPanel()),
    vscode.commands.registerCommand("logos.restartRuntime", () => runtime.restart()),
    vscode.commands.registerCommand("logos.newSession", () => runtime.newSession()),
    output,
    outputSubscription,
    runtime,
    provider,
  );
}

export function deactivate(): void {}

let nodeRuntimePrompt: Promise<void> | undefined;

function showNodeRuntimeActions(message: string, runtime: LocalRuntime, output: vscode.OutputChannel): Promise<void> {
  if (nodeRuntimePrompt) return nodeRuntimePrompt;
  nodeRuntimePrompt = (async () => {
    const action = await vscode.window.showErrorMessage(message, "Retry", "Download Node.js");
    if (action === "Retry") {
      try {
        await runtime.restart();
      } catch (error) {
        output.appendLine(`[runtime] Retry failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (action === "Download Node.js") {
      await vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org/en/download"));
    }
  })().finally(() => { nodeRuntimePrompt = undefined; });
  return nodeRuntimePrompt;
}
