import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isConnectionSettings, isRecord, type ApiProtocol, type ConnectionSettings, type SettingsView } from "./shared/protocol";

export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export const LOCAL_PROVIDER = "logos-endpoint";
export const KEY_VARIABLE = "LOGOS_VSCODE_API_KEY";

export class ConnectionSettingsStore {
  private readonly secretId: string;

  constructor(
    readonly directory: string,
    readonly domainDirectory: string,
    private readonly secrets: SecretStore,
  ) {
    this.secretId = `logos.apiKey.${createHash("sha256").update(directory).digest("hex")}`;
  }

  async load(): Promise<ConnectionSettings> {
    try {
      const settings: unknown = JSON.parse(await readFile(join(this.directory, "connection.json"), "utf8"));
      if (!isConnectionSettings(settings)) throw new Error("Invalid LOGOS connection settings");
      return settings;
    } catch (error) {
      if (!isMissing(error)) throw error;
      return this.defaults();
    }
  }

  private async defaults(): Promise<ConnectionSettings> {
    const [systemPrompt, appendPrompt] = await Promise.all([
      readFile(join(this.domainDirectory, "prompts", "system.md"), "utf8"),
      readFile(join(this.domainDirectory, "prompts", "append.md"), "utf8"),
    ]);
    return { baseUrl: "", api: "openai-completions", modelId: "", modelIds: [], systemPrompt, appendPrompt, skillsEnabled: true, skillPaths: [] };
  }

  async view(): Promise<SettingsView> {
    const [settings, apiKey, entries] = await Promise.all([
      this.load(), this.secrets.get(this.secretId), readdir(join(this.domainDirectory, "skills"), { withFileTypes: true }),
    ]);
    return { ...settings, configDirectory: this.directory, domainDirectory: this.domainDirectory, hasApiKey: Boolean(apiKey), bundledSkills: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() };
  }

  async save(settings: ConnectionSettings, apiKey?: string, deleteApiKey = false): Promise<void> {
    const next = validateSettings(settings);
    const previous = await this.load();
    if (previous.baseUrl && previous.baseUrl !== next.baseUrl && !apiKey?.trim() && !deleteApiKey && await this.secrets.get(this.secretId)) {
      throw new Error("URL 已更改，请重新输入该服务的 API Key，或选择删除已保存的 Key。");
    }
    if (deleteApiKey) await this.secrets.delete(this.secretId);
    else if (apiKey?.trim()) await this.secrets.store(this.secretId, apiKey.trim());
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `connection-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, join(this.directory, "connection.json"));
  }

  async models(baseUrl: string, api: ApiProtocol, apiKey?: string): Promise<string[]> {
    const normalized = normalizeBaseUrl(baseUrl);
    const current = await this.load();
    const savedKey = normalized === current.baseUrl ? await this.secrets.get(this.secretId) : undefined;
    return discoverModels(normalized, api, apiKey === undefined ? savedKey : apiKey.trim() || undefined);
  }

  async prepareRuntime(profile: string, workspaceRoot: string): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
    const settings = await this.load();
    const key = await this.secrets.get(this.secretId);
    await mkdir(profile, { recursive: true });
    const models = settings.baseUrl && settings.modelId ? buildModelsConfig(settings) : { providers: {} };
    await writeFile(join(profile, "models.json"), JSON.stringify(models, null, 2));
    await writeFile(join(profile, "system.md"), settings.systemPrompt);
    await writeFile(join(profile, "append.md"), settings.appendPrompt);
    const args = ["--system-prompt", join(profile, "system.md"), "--append-system-prompt", join(profile, "append.md"), "--no-skills", "--no-extensions", "--no-prompt-templates", "--no-themes", "--no-approve", "--offline"];
    args.push("-e", join(this.domainDirectory, "extensions", "index.mjs"));
    if (settings.skillsEnabled) args.push("--skill", join(this.domainDirectory, "skills"));
    for (const path of settings.skillPaths) args.push("--skill", resolve(workspaceRoot, path));
    if (settings.modelId && settings.baseUrl) args.push("--provider", LOCAL_PROVIDER, "--model", settings.modelId);
    const env = isolatedRuntimeEnvironment(process.env, profile);
    // The key exists only in SecretStorage and the child environment, never models.json.
    env[KEY_VARIABLE] = key || "logos-local-no-auth";
    return { args, env };
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

export function buildModelsConfig(settings: ConnectionSettings): object {
  const ids = [...new Set([...settings.modelIds, settings.modelId])].filter(Boolean);
  return { providers: { [LOCAL_PROVIDER]: {
    baseUrl: normalizeBaseUrl(settings.baseUrl), api: settings.api, apiKey: `$${KEY_VARIABLE}`,
    models: ids.map((id) => ({ id })),
  } } };
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

function validateSettings(value: ConnectionSettings): ConnectionSettings {
  if (value.baseUrl.trim() && !value.modelId.trim()) throw new Error("请先选择或输入模型 ID。");
  return { api: value.api, systemPrompt: value.systemPrompt, appendPrompt: value.appendPrompt, skillsEnabled: value.skillsEnabled, baseUrl: value.baseUrl.trim() ? normalizeBaseUrl(value.baseUrl) : "", modelId: value.modelId.trim(),
    modelIds: [...new Set(value.modelIds.map((id) => id.trim()).filter(Boolean))],
    skillPaths: value.skillPaths.map((path) => path.trim()).filter(Boolean) };
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
