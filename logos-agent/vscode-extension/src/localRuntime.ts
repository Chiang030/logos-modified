import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { ConnectionSettingsStore, LOCAL_PROVIDER } from "./connectionSettings";
import * as vscode from "vscode";
import { RpcClient, type RpcExit, type RpcRecord } from "./rpcClient";
import { NodeRuntimeError, resolveLaunchSpec, verifyNodeRuntime } from "./runtimeLaunch";
import { SessionStore } from "./sessionStore";
import { preparePilotTelemetry } from "./pilotTelemetry";
import { isRecord, type ContextUsage, type ModelOption, type RuntimeConfig, type RuntimeStatus } from "./shared/protocol";

export interface RuntimeEvent {
  type: "status" | "record" | "stderr" | "protocol_error" | "exit" | "log" | "node_error";
  status?: RuntimeStatus;
  detail?: string;
  record?: RpcRecord;
  text?: string;
  error?: Error;
  exit?: RpcExit;
}

export interface LocalRuntimeOptions {
  extensionRoot: string;
  workspaceRoot: string;
  sessionDirectory: string;
  sessionStore?: SessionStore;
  settings: ConnectionSettingsStore;
  profileDirectory: string;
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
      const settings = await this.options.settings.load();
      if (!settings.baseUrl || !settings.modelId) throw new Error("请在 LOGOS 设置中填写 API URL、选择模型并保存。");
      const spec = resolveLaunchSpec({
        extensionRoot: this.options.extensionRoot,
        workspaceRoot: this.options.workspaceRoot,
      });
      const node = await verifyNodeRuntime(spec.command);
      this.emit({ type: "log", text: `Node.js ${node.version} detected via ${node.command}` });
      this.emit({ type: "log", text: `Starting ${spec.bundled ? "bundled" : "configured"} LOGOS core: ${spec.scriptPath}` });
      await mkdir(this.options.sessionDirectory, { recursive: true });
      const configuration = vscode.workspace.getConfiguration("logos");
      const prepared = await preparePilotTelemetry(
        await this.options.settings.prepareRuntime(this.options.profileDirectory, this.options.workspaceRoot),
        { enabled: configuration.get<boolean>("observability.enabled", false), dataDirectory: configuration.get<string>("observability.pilotDataDirectory", "") },
      );
      this.emit({ type: "log", text: prepared.detail });
      const args = [
        ...spec.args,
        "--mode",
        "rpc",
        "--session-dir",
        this.options.sessionDirectory,
        ...prepared.args,
      ];

      const child = spawn(spec.command, args, {
        cwd: this.options.workspaceRoot,
        env: prepared.env,
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
      await client.request({ type: "set_model", provider: "logos-endpoint", modelId: settings.modelId });
      this.setStatus(state.isStreaming === true ? "running" : "ready");
      const messages = await client.getMessages<Record<string, unknown>>();
      this.emit({ type: "record", record: { type: "logos/session_restore", ...messages, state } });
    } catch (error) {
      if (error instanceof NodeRuntimeError) this.emit({ type: "node_error", error });
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
      models: (modelData.models ?? []).map(toModelOption).filter((model): model is ModelOption => model?.provider === LOCAL_PROVIDER),
      activeModel: toModelOption(state.model),
      thinkingLevel: typeof state.thinkingLevel === "string" ? state.thinkingLevel : undefined,
      thinkingLevels: (thinkingData.levels ?? []).filter((level): level is string => typeof level === "string"),
      contextUsage: toContextUsage(stats.contextUsage),
    };
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    if (provider !== LOCAL_PROVIDER) throw new Error("请通过 LOGOS 设置配置模型服务。");
    const client = await this.ensureClient();
    await client.request({ type: "set_model", provider, modelId });
    const settings = await this.options.settings.load();
    await this.options.settings.save({ ...settings, modelId });
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
