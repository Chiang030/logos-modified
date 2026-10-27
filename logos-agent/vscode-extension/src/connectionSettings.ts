import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  isApiProtocol, isConnectionsSettings, isRecord,
  type ApiProtocol, type ConnectionEntry, type ConnectionsSettings, type ModelSource, type SettingsView,
} from "./shared/protocol";
import { presetById, presetForBaseUrl, resolveProviderId, isProviderId, type ProviderId } from "./shared/providerPresets";
import { prepareMcpProfile } from "./mcpProfile";

export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/** Source of a live ChatGPT OAuth access token, refreshed when near expiry. */
export interface OpenAiTokenSource {
  hasCredential(): Promise<boolean>;
  currentAccessToken(): Promise<string | undefined>;
}

export interface PreparedRuntime {
  args: string[];
  env: NodeJS.ProcessEnv;
  provider: string;
  modelId: string;
}

export const LOCAL_PROVIDER = "logos-endpoint";
/** 旧单配置迁移出来的连接 id；沿用旧的 provider 名和 Key 槽位，旧会话记录不受影响。 */
export const LEGACY_CONNECTION_ID = "legacy";
export const KEY_VARIABLE = "LOGOS_VSCODE_API_KEY";

/** 运行时 provider 名：每条连接一个，迁移配置沿用 `logos-endpoint`。 */
export function localProviderId(connectionId: string): string {
  if (connectionId === LEGACY_CONNECTION_ID) return LOCAL_PROVIDER;
  return `${LOCAL_PROVIDER}-${connectionId.replace(/[^a-zA-Z0-9]/g, "")}`;
}

/** 连接 Key 的环境变量名：models.json 以 `$VAR` 引用，真实值只进入子进程环境。 */
export function keyVariableFor(connectionId: string): string {
  if (connectionId === LEGACY_CONNECTION_ID) return KEY_VARIABLE;
  return `${KEY_VARIABLE}_${connectionId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()}`;
}

export class ConnectionSettingsStore {
  private readonly secretId: string;

  constructor(
    readonly directory: string,
    readonly domainDirectory: string,
    private readonly secrets: SecretStore,
    private readonly openAi?: OpenAiTokenSource,
  ) {
    this.secretId = `logos.apiKey.${createHash("sha256").update(directory).digest("hex")}`;
  }

  async load(): Promise<ConnectionsSettings> {
    try {
      const settings: unknown = JSON.parse(await readFile(join(this.directory, "connections.json"), "utf8"));
      if (!isConnectionsSettings(settings)) throw new Error("Invalid LOGOS connection settings");
      return this.normalized(settings);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const migrated = await this.loadLegacy();
      if (migrated) return this.normalized(migrated);
      return this.defaults();
    }
  }

  /** 旧 `connection.json` 读时迁移为新结构，不写盘；Key 仍在旧槽位，保存新结构后自然切换。 */
  private async loadLegacy(): Promise<ConnectionsSettings | undefined> {
    let legacy: unknown;
    try {
      legacy = JSON.parse(await readFile(join(this.directory, "connection.json"), "utf8"));
    } catch {
      return undefined;
    }
    if (!isRecord(legacy) || typeof legacy.baseUrl !== "string" || !legacy.baseUrl.trim()
      || !isApiProtocol(legacy.api) || typeof legacy.modelId !== "string") return undefined;
    const entry: ConnectionEntry = {
      id: LEGACY_CONNECTION_ID,
      name: legacyConnectionName(legacy),
      providerId: isProviderId(legacy.providerId) ? legacy.providerId : "custom",
      baseUrl: legacy.baseUrl,
      api: legacy.api,
      modelId: legacy.modelId,
      // 旧文件可能只填了 modelId，补进列表保证迁移后的连接可用。
      modelIds: (() => {
        const ids = Array.isArray(legacy.modelIds) ? legacy.modelIds.filter((id): id is string => typeof id === "string") : [];
        return ids.includes(legacy.modelId) || !legacy.modelId.trim() ? ids : [legacy.modelId, ...ids];
      })(),
    };
    return {
      connections: [entry],
      activeConnectionId: entry.id,
      activeModelId: entry.modelId,
      systemPrompt: typeof legacy.systemPrompt === "string" ? legacy.systemPrompt : "",
      appendPrompt: typeof legacy.appendPrompt === "string" ? legacy.appendPrompt : "",
      skillsEnabled: legacy.skillsEnabled !== false,
      skillPaths: Array.isArray(legacy.skillPaths) ? legacy.skillPaths.filter((path): path is string => typeof path === "string") : [],
    };
  }

  private async defaults(): Promise<ConnectionsSettings> {
    const [systemPrompt, appendPrompt] = await Promise.all([
      readFile(join(this.domainDirectory, "prompts", "system.md"), "utf8"),
      readFile(join(this.domainDirectory, "prompts", "append.md"), "utf8"),
    ]);
    return { connections: [], activeConnectionId: undefined, activeModelId: "", systemPrompt, appendPrompt, skillsEnabled: true, skillPaths: [] };
  }

  /** 按当前 URL 重新推导 providerId（幂等），并把活动指针修正到真实存在的连接与模型上。 */
  private normalized(settings: ConnectionsSettings): ConnectionsSettings {
    const connections = settings.connections.map((entry) => ({ ...entry, providerId: resolveProviderId(entry.baseUrl, entry.providerId) }));
    const usable = connections.filter((entry) => entry.baseUrl && entry.modelId);
    const active = usable.find((entry) => entry.id === settings.activeConnectionId) ?? usable[0];
    const activeModelId = active && active.modelIds.includes(settings.activeModelId) ? settings.activeModelId : active?.modelId ?? "";
    return { ...settings, connections, activeConnectionId: active?.id, activeModelId };
  }

  async view(): Promise<SettingsView> {
    const [settings, skillEntries, hasOpenAiLogin] = await Promise.all([
      this.load(), readdir(join(this.domainDirectory, "skills"), { withFileTypes: true }),
      this.openAi ? this.openAi.hasCredential() : Promise.resolve(false),
    ]);
    const hasApiKeyByConnection: Record<string, boolean> = {};
    for (const entry of settings.connections) {
      hasApiKeyByConnection[entry.id] = entry.providerId === "openai-chatgpt"
        ? Boolean(await this.openAi?.hasCredential())
        : Boolean(await this.secrets.get(this.keyId(entry.id)));
    }
    return { ...settings, hasApiKeyByConnection, hasOpenAiLogin,
      bundledSkills: skillEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
      configDirectory: this.directory, domainDirectory: this.domainDirectory };
  }

  async saveGlobal(global: Pick<ConnectionsSettings, "systemPrompt" | "appendPrompt" | "skillsEnabled" | "skillPaths">): Promise<void> {
    await this.write({ ...(await this.load()), ...global });
  }

  async saveConnection(input: ConnectionEntry, apiKey?: string, deleteApiKey = false): Promise<void> {
    const next = validateConnection(input);
    const settings = await this.load();
    const previous = settings.connections.find((entry) => entry.id === next.id);
    // 同一条连接换 URL 时，旧 Key 可能是另一家服务的凭据，不能悄悄带给新地址。
    if (previous && previous.baseUrl !== next.baseUrl && !apiKey?.trim() && !deleteApiKey && await this.secrets.get(this.keyId(next.id))) {
      throw new Error("URL 已更改，请重新输入该服务的 API Key，或选择删除已保存的 Key。");
    }
    if (deleteApiKey) await this.secrets.delete(this.keyId(next.id));
    else if (apiKey?.trim() && next.providerId !== "openai-chatgpt") await this.secrets.store(this.keyId(next.id), apiKey.trim());
    const connections = previous
      ? settings.connections.map((entry) => (entry.id === next.id ? next : entry))
      : [...settings.connections, next];
    let { activeConnectionId, activeModelId } = settings;
    if (activeConnectionId === next.id) {
      activeModelId = next.modelIds.includes(activeModelId) ? activeModelId : next.modelId;
    } else if (!activeConnectionId || !connections.some((entry) => entry.id === activeConnectionId)) {
      activeConnectionId = next.id;
      activeModelId = next.modelId;
    }
    await this.write(this.normalized({ ...settings, connections, activeConnectionId, activeModelId }));
  }

  async deleteConnection(connectionId: string): Promise<void> {
    const settings = await this.load();
    if (!settings.connections.some((entry) => entry.id === connectionId)) return;
    await this.secrets.delete(this.keyId(connectionId));
    const connections = settings.connections.filter((entry) => entry.id !== connectionId);
    const wasActive = settings.activeConnectionId === connectionId;
    const fallback = connections.find((entry) => entry.baseUrl && entry.modelId);
    await this.write(this.normalized({
      ...settings,
      connections,
      activeConnectionId: wasActive ? fallback?.id : settings.activeConnectionId,
      activeModelId: wasActive ? fallback?.modelId ?? "" : settings.activeModelId,
    }));
  }

  async setActiveModel(connectionId: string, modelId: string): Promise<void> {
    const settings = await this.load();
    const entry = settings.connections.find((candidate) => candidate.id === connectionId);
    if (!entry) throw new Error("该 API 配置已被删除，请重新打开设置。");
    if (!entry.modelIds.includes(modelId)) throw new Error("所选模型不在该配置的模型列表中，请更新该配置。");
    await this.write({ ...settings, activeConnectionId: connectionId, activeModelId: modelId });
  }

  async models(baseUrl: string, api: ApiProtocol, apiKey?: string): Promise<{ modelIds: string[]; source: ModelSource }> {
    const normalized = normalizeBaseUrl(baseUrl);
    const key = await this.discoveryKey(normalized, apiKey);
    try {
      return { modelIds: await discoverModels(normalized, api, key), source: "upstream" };
    } catch (error) {
      return fallbackDiscovery(normalized, error);
    }
  }

  private async discoveryKey(normalized: string, apiKey?: string): Promise<string | undefined> {
    if (apiKey !== undefined) return apiKey.trim() || undefined;
    const entry = (await this.load()).connections.find((candidate) => candidate.baseUrl === normalized);
    if (!entry) return undefined;
    if (entry.providerId === "openai-chatgpt") return await this.openAi?.currentAccessToken();
    return await this.secrets.get(this.keyId(entry.id));
  }

  /** 启动参数、models.json 与子进程环境；每条可用连接注册为一个 provider，ChatGPT 连接走 OAuth 令牌。 */
  async prepareRuntime(profile: string, workspaceRoot: string): Promise<PreparedRuntime> {
    const settings = await this.load();
    const usable = settings.connections.filter((entry) => entry.baseUrl && entry.modelIds.length);
    const active = usable.find((entry) => entry.id === settings.activeConnectionId && entry.modelIds.includes(settings.activeModelId));
    if (!active) throw new Error("请在 LOGOS 设置中新建 API 配置并选择模型后保存。");
    await mkdir(profile, { recursive: true });
    const env = isolatedRuntimeEnvironment(process.env, profile);
    await prepareMcpProfile(profile, process.env, env);
    const providers: Record<string, unknown> = {};
    for (const entry of usable) {
      const credential = await this.credentialFor(entry);
      if (entry.providerId === "openai-chatgpt" && !credential) {
        if (entry.id === active.id) throw new Error("请先在 LOGOS 设置中登录 ChatGPT，再启动运行时。");
        continue; // 未登录的 ChatGPT 连接没有可用凭据，不注册进模型列表。
      }
      providers[localProviderId(entry.id)] = {
        baseUrl: normalizeBaseUrl(entry.baseUrl), api: entry.api, apiKey: `$${keyVariableFor(entry.id)}`,
        models: [...new Set([entry.modelId, ...entry.modelIds])].filter(Boolean).map((id) => ({ id })),
      };
      env[keyVariableFor(entry.id)] = credential || "logos-local-no-auth";
    }
    await writeFile(join(profile, "models.json"), JSON.stringify({ providers }, null, 2));
    await writeFile(join(profile, "system.md"), settings.systemPrompt);
    await writeFile(join(profile, "append.md"), settings.appendPrompt);
    const args = ["--system-prompt", join(profile, "system.md"), "--append-system-prompt", join(profile, "append.md"), "--no-skills", "--no-extensions", "--no-prompt-templates", "--no-themes", "--no-approve", "--offline"];
    args.push("-e", join(this.domainDirectory, "extensions", "index.mjs"));
    if (settings.skillsEnabled) args.push("--skill", join(this.domainDirectory, "skills"));
    for (const path of settings.skillPaths) args.push("--skill", resolve(workspaceRoot, path));
    const provider = localProviderId(active.id);
    args.push("--provider", provider, "--model", settings.activeModelId);
    return { args, env, provider, modelId: settings.activeModelId };
  }

  private async credentialFor(entry: ConnectionEntry): Promise<string | undefined> {
    if (entry.providerId === "openai-chatgpt") return await this.openAi?.currentAccessToken();
    return await this.secrets.get(this.keyId(entry.id));
  }

  /** Key 的凭据槽位：迁移配置沿用旧槽位，新配置各占一个。 */
  private keyId(connectionId: string): string {
    return connectionId === LEGACY_CONNECTION_ID ? this.secretId : `${this.secretId}.${connectionId}`;
  }

  private async write(settings: ConnectionsSettings): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `connections-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, join(this.directory, "connections.json"));
  }
}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("请输入有效的 API URL，例如 https://example.com/v1"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("API URL 仅支持 HTTP/HTTPS，请勿在 URL 中包含 Key、查询参数或登录信息。");
  }
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|messages|models)\/?$/, "").replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

export async function discoverModels(baseUrl: string, api: ApiProtocol, key?: string): Promise<string[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) {
    if (api === "google-generative-ai") headers["x-goog-api-key"] = key;
    else if (api === "anthropic-messages") headers["x-api-key"] = key;
    else headers.Authorization = `Bearer ${key}`;
  }
  if (api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
  let response: Response;
  try {
    response = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, { headers, signal: AbortSignal.timeout(15_000), redirect: "error" });
  } catch { throw new Error("无法获取模型：请检查 API URL、网络和证书，或手动输入模型 ID。"); }
  if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}）。请检查 URL 和 API Key，或手动输入模型 ID。`);
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error("模型接口没有返回有效 JSON。"); }
  const rows = isRecord(data) ? data.data ?? data.models : data;
  if (!Array.isArray(rows)) throw new Error("模型列表格式不受支持，请手动输入模型 ID。");
  const ids = rows.flatMap((row) => {
    const id = typeof row === "string" ? row : isRecord(row) ? row.id ?? row.name : undefined;
    return typeof id === "string" && id.trim() ? [id.replace(/^models\//, "")] : [];
  });
  if (!ids.length) throw new Error("上游返回空模型列表，请手动输入模型 ID。");
  return [...new Set(ids)].sort();
}

function validateConnection(value: ConnectionEntry): ConnectionEntry {
  if (!value.baseUrl.trim()) throw new Error("请填写 API URL。");
  if (!value.modelId.trim()) throw new Error("请先选择或输入模型 ID。");
  const baseUrl = normalizeBaseUrl(value.baseUrl);
  const modelId = value.modelId.trim();
  const modelIds = [...new Set([modelId, ...value.modelIds.map((id) => id.trim()).filter(Boolean)])];
  return {
    id: value.id,
    name: value.name.trim() || defaultConnectionName(value.providerId, baseUrl),
    providerId: resolveProviderId(baseUrl, value.providerId),
    api: value.api,
    baseUrl,
    modelId,
    modelIds,
  };
}

function defaultConnectionName(providerId: ProviderId, baseUrl: string): string {
  const label = presetById(providerId)?.label.replace(/[（(].*$/, "").trim();
  if (label) return label;
  try { return new URL(baseUrl).host; } catch { return "自定义服务"; }
}

export function isolatedRuntimeEnvironment(source: NodeJS.ProcessEnv, profile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (/^(PI_|LOGOS_)|(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/.test(name.toUpperCase())) continue;
    env[name] = value;
  }
  env.PI_CODING_AGENT_DIR = profile;
  env.PI_OFFLINE = "1";
  return env;
}

function legacyConnectionName(legacy: Record<string, unknown>): string {
  return typeof legacy.name === "string" && legacy.name.trim() ? legacy.name.trim() : "迁移的配置";
}

export function fallbackDiscovery(normalized: string, error: unknown): { modelIds: string[]; source: ModelSource } {
  const preset = presetForBaseUrl(normalized);
  if (preset?.fallbackModels.length) return { modelIds: [...preset.fallbackModels], source: "fallback" };
  throw error;
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
