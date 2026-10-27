import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionSettingsStore, LEGACY_CONNECTION_ID, isolatedRuntimeEnvironment, keyVariableFor, localProviderId, discoverModels, fallbackDiscovery, type OpenAiTokenSource } from "../src/connectionSettings";
import type { ConnectionEntry } from "../src/shared/protocol";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(openAi?: Partial<OpenAiTokenSource>) {
  const directory = await mkdtemp(join(tmpdir(), "logos settings 中文 "));
  directories.push(directory);
  const secrets = new Map<string, string>();
  const tokenSource: OpenAiTokenSource = {
    hasCredential: async () => openAi?.hasCredential !== undefined ? await openAi.hasCredential() : false,
    currentAccessToken: async () => openAi?.currentAccessToken?.(),
  };
  const store = new ConnectionSettingsStore(directory, resolve("runtime/logos-agent/pi-domain"), {
    get: async (key) => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async (key) => { secrets.delete(key); },
  }, openAi ? tokenSource : undefined);
  return { directory, secrets, store };
}

function entry(overrides: Partial<ConnectionEntry> = {}): ConnectionEntry {
  return { id: "conn-a", name: "配置 A", providerId: "custom", baseUrl: "https://example.com/v1", api: "openai-completions", modelId: "model-a", modelIds: ["model-a"], ...overrides };
}

describe("multiple LOGOS connections", () => {
  it("persists several connections with per-connection keys kept out of files", async () => {
    const { store, directory } = await fixture();
    await store.saveConnection(entry({ id: "conn-a", name: "", baseUrl: "https://example.com/v1/chat/completions" }), "key-a");
    await store.saveConnection(entry({ id: "conn-b", baseUrl: "https://other.example/v1", modelId: "model-b", modelIds: ["model-b"] }), "key-b");
    const settings = await store.load();
    expect(settings.connections.map((connection) => connection.id)).toEqual(["conn-a", "conn-b"]);
    expect(settings.connections[0].name).toBe("example.com");
    expect(settings.activeConnectionId).toBe("conn-a");
    const view = await store.view();
    expect(view.hasApiKeyByConnection).toEqual({ "conn-a": true, "conn-b": true });
    expect(JSON.stringify(view)).not.toContain("key-a");
    expect(await readFile(join(directory, "connections.json"), "utf8")).not.toContain("key-");
    const runtime = await store.prepareRuntime(join(directory, "profile"), directory);
    expect(runtime.args).toContain("--provider");
    expect(runtime.args.slice(runtime.args.indexOf("--provider") + 1)).toEqual(["logos-endpoint-conna", "--model", "model-a"]);
    expect(runtime.env[keyVariableFor("conn-a")]).toBe("key-a");
    expect(runtime.env[keyVariableFor("conn-b")]).toBe("key-b");
    const modelsJson = await readFile(join(directory, "profile", "models.json"), "utf8");
    expect(modelsJson).not.toContain("key-a");
    expect(Object.keys(JSON.parse(modelsJson).providers)).toEqual([localProviderId("conn-a"), localProviderId("conn-b")]);
  });
  it("switches the active model across connections and persists the choice", async () => {
    const { store, directory } = await fixture();
    await store.saveConnection(entry(), "key-a");
    await store.saveConnection(entry({ id: "conn-b", baseUrl: "https://other.example/v1", modelId: "model-b", modelIds: ["model-b"] }));
    await store.setActiveModel("conn-b", "model-b");
    expect(await store.load()).toMatchObject({ activeConnectionId: "conn-b", activeModelId: "model-b" });
    const runtime = await store.prepareRuntime(join(directory, "profile"), directory);
    expect(runtime.provider).toBe(localProviderId("conn-b"));
    expect(runtime.modelId).toBe("model-b");
    await expect(store.setActiveModel("conn-b", "unknown-model")).rejects.toThrow("模型列表");
    await expect(store.setActiveModel("gone", "model-a")).rejects.toThrow("已被删除");
  });
  it("deletes a connection with its key and re-points the active selection", async () => {
    const { store, directory, secrets } = await fixture();
    await store.saveConnection(entry(), "key-a");
    await store.saveConnection(entry({ id: "conn-b", baseUrl: "https://other.example/v1", modelId: "model-b", modelIds: ["model-b"] }), "key-b");
    await store.setActiveModel("conn-b", "model-b");
    await store.deleteConnection("conn-b");
    expect((await store.load()).activeConnectionId).toBe("conn-a");
    expect(secrets.size).toBe(1);
    await store.deleteConnection("conn-a");
    const settings = await store.load();
    expect(settings.connections).toEqual([]);
    expect(settings.activeConnectionId).toBeUndefined();
    expect(secrets.size).toBe(0);
    await expect(store.prepareRuntime(join(directory, "profile"), directory)).rejects.toThrow("新建 API 配置");
  });
  it("requires a fresh key when a connection changes URL", async () => {
    const { store, secrets } = await fixture();
    await store.saveConnection(entry(), "key-a");
    await expect(store.saveConnection(entry({ baseUrl: "https://other.example/v1", modelId: "model-a", modelIds: ["model-a"] }))).rejects.toThrow("URL 已更改");
    await store.saveConnection(entry({ baseUrl: "https://other.example/v1" }), undefined, true);
    expect(secrets.size).toBe(0);
    expect((await store.load()).connections[0].baseUrl).toBe("https://other.example/v1");
  });
  it("saves global prompt and skill settings without touching connections", async () => {
    const { store } = await fixture();
    await store.saveConnection(entry(), "key-a");
    await store.saveGlobal({ systemPrompt: "Custom role", appendPrompt: "append", skillsEnabled: false, skillPaths: ["tools/skills"] });
    const settings = await store.load();
    expect(settings.systemPrompt).toBe("Custom role");
    expect(settings.skillsEnabled).toBe(false);
    expect(settings.connections).toHaveLength(1);
  });
  it("uses the saved key of the matching connection for model discovery", async () => {
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer saved-key");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "model-a" }] }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No server address");
      const { store } = await fixture();
      await store.saveConnection(entry({ baseUrl: `http://127.0.0.1:${address.port}/v1` }), "saved-key");
      expect(await store.models(`http://127.0.0.1:${address.port}/v1`, "openai-completions")).toEqual({ modelIds: ["model-a"], source: "upstream" });
    } finally { await new Promise<void>((done) => server.close(() => done())); }
  });
});

describe("legacy single-connection migration", () => {
  it("migrates connection.json on load without writing, deriving the provider", async () => {
    const { store, directory } = await fixture();
    await writeFile(join(directory, "connection.json"), JSON.stringify({
      baseUrl: "https://api.deepseek.com", api: "openai-completions", modelId: "deepseek-chat",
      modelIds: ["deepseek-chat"], systemPrompt: "system", appendPrompt: "append", skillsEnabled: true, skillPaths: [],
    }), "utf8");
    const settings = await store.load();
    expect(settings.connections).toHaveLength(1);
    expect(settings.connections[0]).toMatchObject({ id: LEGACY_CONNECTION_ID, providerId: "deepseek", modelId: "deepseek-chat" });
    expect(settings.activeConnectionId).toBe(LEGACY_CONNECTION_ID);
    expect(settings.systemPrompt).toBe("system");
  });
  it("keeps serving the legacy key slot through the migrated connection", async () => {
    const { store, directory } = await fixture();
    await store.saveConnection(entry({ id: LEGACY_CONNECTION_ID, name: "旧配置" }), "legacy-key");
    await rm(join(directory, "connections.json"));
    await writeFile(join(directory, "connection.json"), JSON.stringify({ baseUrl: "https://example.com/v1", api: "openai-completions", modelId: "model-a", modelIds: ["model-a"] }), "utf8");
    const runtime = await store.prepareRuntime(join(directory, "profile"), directory);
    expect(runtime.provider).toBe("logos-endpoint");
    expect(runtime.env.LOGOS_VSCODE_API_KEY).toBe("legacy-key");
    const modelsJson = JSON.parse(await readFile(join(directory, "profile", "models.json"), "utf8"));
    expect(modelsJson.providers["logos-endpoint"].apiKey).toBe("$LOGOS_VSCODE_API_KEY");
    await store.saveConnection(entry({ id: LEGACY_CONNECTION_ID }), "fresh-key");
    expect(JSON.parse(await readFile(join(directory, "connections.json"), "utf8")).connections[0].id).toBe(LEGACY_CONNECTION_ID);
  });
  it("removes inherited Pi profiles and provider credentials", () => {
    const env = isolatedRuntimeEnvironment({ PATH: "bin", PI_CODING_AGENT_DIR: "other-profile", PI_CONFIG_DIR: "pi", OPENAI_API_KEY: "wrong", ANTHROPIC_AUTH_TOKEN: "wrong", LOGOS_SIM_COMMAND: "wrong" }, "logos-profile");
    expect(env).toEqual({ PATH: "bin", PI_CODING_AGENT_DIR: "logos-profile", PI_OFFLINE: "1" });
  });
});

describe("model discovery fallback", () => {
  it("returns the preset fallback list when discovery fails on a preset URL", () => {
    expect(fallbackDiscovery("https://open.bigmodel.cn/api/coding/paas/v4", new Error("HTTP 404")))
      .toEqual({ modelIds: ["glm-4.6", "glm-4.5-air"], source: "fallback" });
    expect(fallbackDiscovery("https://api.deepseek.com", new Error("offline")))
      .toEqual({ modelIds: ["deepseek-chat", "deepseek-reasoner"], source: "fallback" });
  });
  it("rethrows discovery errors for custom URLs", () => {
    expect(() => fallbackDiscovery("https://example.com/v1", new Error("请手动输入模型 ID"))).toThrow("请手动输入模型 ID");
  });
  it("fetches and deduplicates actual upstream models with the supplied key", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe("/v1/models");
      expect(request.headers.authorization).toBe("Bearer test-key");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }] }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No server address");
      expect(await discoverModels(`http://127.0.0.1:${address.port}/v1`, "openai-completions", "test-key")).toEqual(["model-a", "model-b"]);
    } finally { await new Promise<void>((done) => server.close(() => done())); }
  });
});

describe("ChatGPT connections", () => {
  it("injects the OAuth token for the active ChatGPT connection", async () => {
    const { store, directory } = await fixture({ currentAccessToken: async () => "oauth-access-token" });
    await store.saveConnection(entry({ id: "gpt", providerId: "openai-chatgpt", baseUrl: "https://api.openai.com/v1", api: "openai-responses", modelId: "gpt-5.5", modelIds: ["gpt-5.5"] }));
    const runtime = await store.prepareRuntime(join(directory, "profile"), directory);
    expect(runtime.env[keyVariableFor("gpt")]).toBe("oauth-access-token");
    const modelsJson = await readFile(join(directory, "profile", "models.json"), "utf8");
    expect(modelsJson).not.toContain("oauth-access-token");
    expect(JSON.parse(modelsJson).providers[localProviderId("gpt")].api).toBe("openai-responses");
  });
  it("refuses to start when the active ChatGPT connection has no login", async () => {
    const { store, directory } = await fixture({ currentAccessToken: async () => undefined });
    await store.saveConnection(entry({ id: "gpt", providerId: "openai-chatgpt", baseUrl: "https://api.openai.com/v1", api: "openai-responses", modelId: "gpt-5.5", modelIds: ["gpt-5.5"] }));
    await expect(store.prepareRuntime(join(directory, "profile"), directory)).rejects.toThrow("登录 ChatGPT");
  });
  it("skips unlogged ChatGPT connections that are not active", async () => {
    const { store, directory } = await fixture({ currentAccessToken: async () => undefined });
    await store.saveConnection(entry({ id: "conn-a" }), "key-a");
    await store.saveConnection(entry({ id: "gpt", providerId: "openai-chatgpt", baseUrl: "https://api.openai.com/v1", api: "openai-responses", modelId: "gpt-5.5", modelIds: ["gpt-5.5"] }));
    const runtime = await store.prepareRuntime(join(directory, "profile"), directory);
    expect(Object.keys(JSON.parse(await readFile(join(directory, "profile", "models.json"), "utf8")).providers)).toEqual([localProviderId("conn-a")]);
    expect(runtime.provider).toBe(localProviderId("conn-a"));
  });
  it("reports the login state in the settings view", async () => {
    const { store } = await fixture({ hasCredential: async () => true, currentAccessToken: async () => "token" });
    await store.saveConnection(entry({ id: "gpt", providerId: "openai-chatgpt", baseUrl: "https://api.openai.com/v1", api: "openai-responses", modelId: "gpt-5.5", modelIds: ["gpt-5.5"] }));
    expect((await store.view()).hasApiKeyByConnection.gpt).toBe(true);
  });
});
