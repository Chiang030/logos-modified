import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as vscode from "vscode";
import { RpcClient, type RpcExit, type RpcRecord } from "./rpcClient";
import { SessionStore } from "./sessionStore";
import { isRecord, type ContextUsage, type ModelOption, type RuntimeConfig, type RuntimeStatus } from "./shared/protocol";

export interface RuntimeEvent {
  type: "status" | "record" | "stderr" | "protocol_error" | "exit";
  status?: RuntimeStatus;
  detail?: string;
  record?: RpcRecord;
  text?: string;
  error?: Error;
  exit?: RpcExit;
}

export interface LocalRuntimeOptions {
  workspaceRoot: string;
  sessionDirectory: string;
  sessionStore?: SessionStore;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  scriptPath: string;
}

export class LocalRuntime implements vscode.Disposable {
  private readonly eventEmitter = new vscode.EventEmitter<RuntimeEvent>();
  private client: RpcClient | undefined;
  private status: RuntimeStatus = "idle";
  private lastState: Record<string, unknown> | undefined;
  private readonly disposables: Array<() => void> = [];
  private disposed = false;
  private startPromise: Promise<void> | undefined;

  readonly onDidEvent = this.eventEmitter.event;

  constructor(private readonly options: LocalRuntimeOptions) {}

  get currentStatus(): RuntimeStatus {
    return this.status;
  }

  get isRunning(): boolean {
    return this.client?.isRunning === true;
  }

  get state(): Record<string, unknown> | undefined {
    return this.lastState;
  }

  async refreshState(): Promise<Record<string, unknown>> {
    const client = await this.ensureClient();
    this.lastState = await client.getState<Record<string, unknown>>();
    return this.lastState;
  }

  async start(): Promise<void> {
    if (this.client?.isRunning) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try { await this.startPromise; } finally { this.startPromise = undefined; }
  }

  private async startInternal(): Promise<void> {
    this.setStatus("starting");

    try {
      const spec = resolveLaunchSpec(this.options.workspaceRoot);
      await mkdir(this.options.sessionDirectory, { recursive: true });
      const config = vscode.workspace.getConfiguration("logos");
      const args = [
        ...spec.args,
        "--mode",
        "rpc",
        "--session-dir",
        this.options.sessionDirectory,
      ];
      const provider = config.get<string>("provider")?.trim();
      const model = config.get<string>("model")?.trim();
      if (provider && !model) throw new Error("logos.provider requires logos.model");
      if (provider) args.push("--provider", provider);
      if (model) args.push("--model", model);

      const child = spawn(spec.command, args, {
        cwd: this.options.workspaceRoot,
        env: await loadLocalEnvironment(this.options.workspaceRoot, spec.scriptPath),
        stdio: "pipe",
        windowsHide: true,
      });
      const client = new RpcClient(child);
      this.client = client;
      this.disposables.push(
        client.onRecord((record) => this.emit({ type: "record", record })),
        client.onStderr((text) => this.emit({ type: "stderr", text })),
        client.onProtocolError((error) => this.emit({ type: "protocol_error", error })),
        client.onExit((exit) => {
          this.emit({ type: "exit", exit });
          if (this.status !== "stopping") this.setStatus("error", `LOGOS exited (${exit.code ?? exit.signal ?? "unknown"})`);
        }),
      );

      let state = await client.getState<Record<string, unknown>>();
      const previous = await this.options.sessionStore?.load();
      if (previous?.sessionFile && previous.sessionFile !== state.sessionFile && existsSync(previous.sessionFile)) {
        try {
          await client.requestWithTimeout({ type: "switch_session", sessionPath: previous.sessionFile });
          state = await client.getState<Record<string, unknown>>();
        } catch {
          // A stale session should not prevent the workspace from opening.
        }
      }
      this.lastState = state;
      this.setStatus(state.isStreaming === true ? "running" : "ready");
      const messages = await client.getMessages<Record<string, unknown>>();
      this.emit({ type: "record", record: { type: "logos/session_restore", ...messages, state } });
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
      await this.disposeClient();
      throw error;
    }
  }

  async prompt(text: string): Promise<void> {
    const client = await this.ensureClient();
    const streaming = this.lastState?.isStreaming === true;
    await client.prompt(text, streaming ? "followUp" : undefined);
  }

  async getRuntimeConfig(): Promise<RuntimeConfig> {
    const client = await this.ensureClient();
    const [state, modelData, thinkingData, stats] = await Promise.all([
      client.getState<Record<string, unknown>>(),
      client.requestWithTimeout<{ models?: unknown[] }>({ type: "get_available_models" }, 10_000),
      client.requestWithTimeout<{ levels?: unknown[] }>({ type: "get_available_thinking_levels" }, 10_000),
      client.requestWithTimeout<{ contextUsage?: unknown }>({ type: "get_session_stats" }, 10_000),
    ]);
    this.lastState = state;
    return {
      models: (modelData.models ?? []).map(toModelOption).filter((model): model is ModelOption => model !== undefined),
      activeModel: toModelOption(state.model),
      thinkingLevel: typeof state.thinkingLevel === "string" ? state.thinkingLevel : undefined,
      thinkingLevels: (thinkingData.levels ?? []).filter((level): level is string => typeof level === "string"),
      contextUsage: toContextUsage(stats.contextUsage),
    };
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const client = await this.ensureClient();
    await client.request({ type: "set_model", provider, modelId });
  }

  async setThinkingLevel(level: string): Promise<void> {
    const client = await this.ensureClient();
    await client.request({ type: "set_thinking_level", level });
  }

  async abort(): Promise<void> {
    if (!this.client?.isRunning) return;
    await this.client.abort();
  }

  async newSession(): Promise<void> {
    const client = await this.ensureClient();
    try { await client.newSession(); } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("new_session timed out")) throw error;
    }
    this.lastState = undefined;
    this.emit({ type: "record", record: { type: "logos/session_reset" } });
  }

  async switchSession(sessionPath: string, expectedSessionId?: string): Promise<void> {
    const client = await this.ensureClient();
    const resolvedPath = await this.resolveSessionPath(sessionPath);
    try { await client.requestWithTimeout({ type: "switch_session", sessionPath: resolvedPath }); } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("switch_session timed out")) throw error;
    }
    const state = await client.getState<Record<string, unknown>>();
    if (expectedSessionId && state.sessionId !== expectedSessionId) {
      throw new Error(`LOGOS did not switch to session ${expectedSessionId}`);
    }
    const messages = await client.getMessages<Record<string, unknown>>();
    this.lastState = state;
    this.emit({ type: "record", record: { type: "logos/session_restore", ...messages, state } });
  }

  private async resolveSessionPath(sessionPath: string): Promise<string> {
    if (existsSync(sessionPath)) return sessionPath;
    const fileName = sessionPath.split(/[\\/]/).pop() ?? sessionPath;
    const match = fileName.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
    if (!match) return sessionPath;
    try {
      const entries = await readdir(this.options.sessionDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(match[0])) continue;
        return join(this.options.sessionDirectory, entry.name);
      }
    } catch {
      // Let the runtime report the original path error.
    }
    return sessionPath;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    if (this.startPromise) {
      try { await this.startPromise; } catch { return; }
    }
    if (!this.client) return;
    this.setStatus("stopping");
    await this.disposeClient();
    this.setStatus("idle");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.stop();
    this.eventEmitter.dispose();
  }

  private async ensureClient(): Promise<RpcClient> {
    if (!this.client?.isRunning) await this.start();
    if (!this.client) throw new Error("LOGOS runtime is unavailable");
    return this.client;
  }

  private async disposeClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    for (const dispose of this.disposables.splice(0)) dispose();
    if (client) await client.dispose();
  }

  private setStatus(status: RuntimeStatus, detail?: string): void {
    this.status = status;
    this.emit({ type: "status", status, detail });
  }

  private emit(event: RuntimeEvent): void {
    if (this.disposed) return;
    if (event.type === "record" && event.record) {
      if (event.record.type === "agent_start") this.lastState = { ...this.lastState, isStreaming: true };
      if (event.record.type === "agent_settled") this.lastState = { ...this.lastState, isStreaming: false };
    }
    this.eventEmitter.fire(event);
  }
}

export function resolveLaunchSpec(workspaceRoot: string): LaunchSpec {
  const configured = vscode.workspace.getConfiguration("logos").get<string>("executablePath")?.trim();
  const candidates = configured
    ? [configured]
    : [
        join(workspaceRoot, "bin", "logos.mjs"),
        join(workspaceRoot, "logos-agent", "bin", "logos.mjs"),
        join(workspaceRoot, "dist", "verify-deployment", "logos-server", "logos-agent", "bin", "logos.mjs"),
        join(workspaceRoot, "logos-agent", "dist", "verify-deployment", "logos-server", "logos-agent", "bin", "logos.mjs"),
      ];
  const scriptPath = candidates.map((candidate) => resolve(workspaceRoot, candidate)).find((candidate) => existsSync(candidate));
  if (!scriptPath) {
    const msg = configured
      ? `Configured LOGOS entry does not exist: ${configured}`
      : "Could not find logos-agent/bin/logos.mjs in the current workspace. Set logos.executablePath to the local entry script.";
    throw new Error(msg);
  }
  if (!isAbsolute(scriptPath)) throw new Error(`LOGOS entry must be an absolute path: ${scriptPath}`);
  if (!scriptPath.endsWith(".mjs") && !scriptPath.endsWith(".js")) {
    throw new Error(`LOGOS entry must be a Node.js .mjs or .js file: ${scriptPath}`);
  }
  return { command: process.execPath, args: [scriptPath], scriptPath };
}

async function loadLocalEnvironment(workspaceRoot: string, scriptPath: string): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  const candidates = [
    join(workspaceRoot, "logos-agent", ".env"),
    resolve(dirname(scriptPath), "..", ".env"),
  ];
  for (const candidate of new Set(candidates)) {
    try {
      const contents = await readFile(candidate, "utf8");
      for (const line of contents.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match || env[match[1]]) continue;
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        env[match[1]] = value;
      }
      break;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return env;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function toModelOption(value: unknown): ModelOption | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") return undefined;
  return {
    provider: value.provider,
    id: value.id,
    name: typeof value.name === "string" ? value.name : undefined,
    contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : undefined,
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : undefined,
  };
}

function toContextUsage(value: unknown): ContextUsage | undefined {
  if (!isRecord(value) || typeof value.contextWindow !== "number") return undefined;
  return {
    tokens: typeof value.tokens === "number" ? value.tokens : null,
    contextWindow: value.contextWindow,
    percent: typeof value.percent === "number" ? value.percent : null,
  };
}
