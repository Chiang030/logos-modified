import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { ConnectionSettingsStore, localProviderId } from "./connectionSettings";
import * as vscode from "vscode";
import { RpcClient, type RpcExit, type RpcRecord } from "./rpcClient";
import { NodeRuntimeError, resolveLaunchSpec, selectNodeRuntime } from "./runtimeLaunch";
import { SessionStore } from "./sessionStore";
import { preparePilotTelemetry } from "./pilotTelemetry";
import { readMcpWarnings } from "./mcpProfile";
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
  private stderrTail = "";
  private skipRestore = false;

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
    if (this.startPromise) return this.startPromise;
    if (this.client?.isRunning) return;
    this.startPromise = this.startInternal();
    try { await this.startPromise; } finally { this.startPromise = undefined; }
  }

  private async startInternal(): Promise<void> {
    this.setStatus("starting");
    this.stderrTail = "";

    try {
      const configuration = vscode.workspace.getConfiguration("logos");
      const spec = resolveLaunchSpec({
        extensionRoot: this.options.extensionRoot,
        workspaceRoot: this.options.workspaceRoot,
      });
      const node = await selectNodeRuntime({
        extensionRoot: this.options.extensionRoot,
        configuredExecutable: configuration.get<string>("nodeExecutable", ""),
      });
      this.emit({ type: "log", text: `Node.js ${node.version} via ${nodeSourceLabel(node.source)} (${node.command})` });
      this.emit({ type: "log", text: `Starting ${spec.bundled ? "bundled" : "configured"} LOGOS core: ${spec.scriptPath}` });
      await mkdir(this.options.sessionDirectory, { recursive: true });
      const prepared = await preparePilotTelemetry(
        await this.options.settings.prepareRuntime(this.options.profileDirectory, this.options.workspaceRoot),
        { enabled: configuration.get<boolean>("observability.enabled", false), dataDirectory: configuration.get<string>("observability.pilotDataDirectory", "") },
      );
      const proxy = vscode.workspace.getConfiguration("http").get<string>("proxy", "");
      if (proxy && !prepared.env.HTTPS_PROXY && !prepared.env.https_proxy) prepared.env.HTTPS_PROXY = proxy;
      if (proxy && !prepared.env.HTTP_PROXY && !prepared.env.http_proxy) prepared.env.HTTP_PROXY = proxy;
      for (const warning of await readMcpWarnings(this.options.profileDirectory)) {
        this.emit({ type: "log", text: `MCP: ${warning}` });
      }
      this.emit({ type: "log", text: prepared.detail });
      const args = [
        ...spec.args,
        "--mode",
        "rpc",
        "--session-dir",
        this.options.sessionDirectory,
        ...prepared.args,
      ];

      const child = spawn(node.command, args, {
        cwd: this.options.workspaceRoot,
        env: prepared.env,
        stdio: "pipe",
        windowsHide: true,
      });
      const client = new RpcClient(child);
      this.client = client;
      this.disposables.push(
        client.onRecord((record) => this.emit({ type: "record", record })),
        client.onStderr((text) => { this.stderrTail = (this.stderrTail + text).slice(-12000); this.emit({ type: "stderr", text }); }),
        client.onProtocolError((error) => this.emit({ type: "protocol_error", error })),
        client.onExit((exit) => {
          this.emit({ type: "exit", exit });
          if (this.status !== "stopping") this.setStatus("error", `LOGOS exited (${exit.code ?? exit.signal ?? "unknown"})\n${this.stderrTail}`);
        }),
      );

      let state = await client.getState<Record<string, unknown>>();
      const previous = this.skipRestore ? undefined : await this.options.sessionStore?.load();
      if (previous?.sessionFile && previous.sessionFile !== state.sessionFile) {
        const path = await this.resolveSessionPath(previous.sessionFile);
        if (!existsSync(path)) throw new Error(`会话文件不存在，已保留历史索引：${path}`);
        await client.requestWithTimeout({ type: "switch_session", sessionPath: path }, 10_000);
        state = await client.getState<Record<string, unknown>>();
        if (previous.sessionId && state.sessionId !== previous.sessionId) throw new Error("恢复会话失败，已保留历史索引。");
      }
      this.lastState = state;
      const model = isRecord(state.model) ? state.model : undefined;
      const connections = (await this.options.settings.load()).connections;
      const restoredModelAvailable = previous && model && connections.some((entry) => localProviderId(entry.id) === model.provider && entry.modelIds.includes(String(model.id)));
      if (!restoredModelAvailable && (model?.provider !== prepared.provider || model?.id !== prepared.modelId)) {
        await client.requestWithTimeout({ type: "set_model", provider: prepared.provider, modelId: prepared.modelId }, 10_000);
      }
      this.setStatus(state.isStreaming === true ? "running" : "ready");
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
    // 每条本地连接是一个 provider；只保留属于这些连接的模型，并标注归属供底部切换器分组。
    const connections = new Map((await this.options.settings.load()).connections.map((entry) => [localProviderId(entry.id), entry] as const));
    const decorate = (model: ModelOption | undefined): ModelOption | undefined => {
      const entry = model ? connections.get(model.provider) : undefined;
      return entry && model ? { ...model, connectionId: entry.id, connectionName: entry.name } : undefined;
    };
    return {
      models: (modelData.models ?? []).map(toModelOption).map(decorate).filter((model): model is ModelOption => model !== undefined),
      activeModel: decorate(toModelOption(state.model)),
      thinkingLevel: typeof state.thinkingLevel === "string" ? state.thinkingLevel : undefined,
      thinkingLevels: (thinkingData.levels ?? []).filter((level): level is string => typeof level === "string"),
      contextUsage: toContextUsage(stats.contextUsage),
    };
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const entry = (await this.options.settings.load()).connections.find((candidate) => localProviderId(candidate.id) === provider);
    if (!entry) throw new Error("请通过 LOGOS 设置配置模型服务。");
    const client = await this.ensureClient();
    await client.requestWithTimeout({ type: "set_model", provider, modelId }, 10_000);
    await this.options.settings.setActiveModel(entry.id, modelId);
  }

  async setThinkingLevel(level: string): Promise<void> {
    const client = await this.ensureClient();
    const available = await client.requestWithTimeout<{ levels: string[] }>({ type: "get_available_thinking_levels" });
    if (!available.levels.includes(level)) throw new Error("当前模型不支持此思考深度，请检查模型能力设置。");
    await client.requestWithTimeout({ type: "set_thinking_level", level }, 10_000);
    const state = await this.refreshState();
    if (state.thinkingLevel !== level) throw new Error(`模型未接受该思考深度，实际为 ${String(state.thinkingLevel)}。`);
  }

  async abort(): Promise<void> {
    if (!this.client?.isRunning) return;
    await this.client.abort();
  }

  async newSession(): Promise<void> {
    this.skipRestore = true;
    let client: RpcClient;
    try { client = await this.ensureClient(); } finally { this.skipRestore = false; }
    await client.newSession();
    this.lastState = await client.getState<Record<string, unknown>>();
  }

  async switchSession(sessionPath: string, expectedSessionId?: string): Promise<void> {
    this.skipRestore = true;
    let client: RpcClient;
    try { client = await this.ensureClient(); } finally { this.skipRestore = false; }
    const resolvedPath = await this.resolveSessionPath(sessionPath);
    if (!existsSync(resolvedPath)) throw new Error(`会话文件不存在：${resolvedPath}`);
    const previous = this.lastState;
    try {
      await client.requestWithTimeout({ type: "switch_session", sessionPath: resolvedPath }, 10_000);
      const state = await client.getState<Record<string, unknown>>();
      if (expectedSessionId && state.sessionId !== expectedSessionId) throw new Error(`LOGOS did not switch to session ${expectedSessionId}`);
      this.lastState = state;
    } catch (error) {
      if (typeof previous?.sessionFile === "string" && existsSync(previous.sessionFile)) {
        await client.requestWithTimeout({ type: "switch_session", sessionPath: previous.sessionFile }, 10_000);
        this.lastState = await client.getState<Record<string, unknown>>();
      }
      throw error;
    }
  }

  async snapshot(): Promise<RpcRecord> {
    const client = await this.ensureClient();
    const state = await this.refreshState();
    const messages = await client.getMessages<Record<string, unknown>>();
    return { type: "logos/session_restore", ...messages, state };
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
    if (this.startPromise || !this.client?.isRunning) await this.start();
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
      if (event.record.type === "agent_start") { this.lastState = { ...this.lastState, isStreaming: true }; this.setStatus("running"); }
      if (event.record.type === "agent_settled") { this.lastState = { ...this.lastState, isStreaming: false }; this.setStatus("ready"); }
    }
    this.eventEmitter.fire(event);
  }
}

function nodeSourceLabel(source: "setting" | "path" | "bundled"): string {
  if (source === "setting") return "logos.nodeExecutable";
  if (source === "path") return "PATH";
  return "bundled runtime";
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
