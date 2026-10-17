import { join } from "node:path";
import * as vscode from "vscode";
import { LocalRuntime } from "./localRuntime";
import { SessionStore } from "./sessionStore";
import { LogosWebviewProvider } from "./webviewBridge";

export function activate(context: vscode.ExtensionContext): void {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspace?.uri.fsPath;
  if (!workspaceRoot) {
    void vscode.window.showWarningMessage("Open a workspace to use LOGOS.");
    return;
  }

  const storageRoot = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
  const sessions = new SessionStore(join(storageRoot, "sessions"));
  const runtime = new LocalRuntime({
    workspaceRoot,
    sessionDirectory: join(storageRoot, "runtime-sessions"),
    sessionStore: sessions,
  });
  const provider = new LogosWebviewProvider(context, runtime, sessions);
  const output = vscode.window.createOutputChannel("LOGOS");
  const outputSubscription = runtime.onDidEvent((event) => {
    if (event.type === "stderr" && event.text) output.append(event.text);
    if (event.type === "protocol_error" && event.error) output.appendLine(`[protocol] ${event.error.message}`);
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
