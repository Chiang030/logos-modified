import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionSettingsStore, isolatedRuntimeEnvironment, discoverModels, fallbackDiscovery, type OpenAiTokenSource } from "../src/connectionSettings";
import type { ConnectionSettings } from "../src/shared/protocol";

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

function connection(overrides: Partial<ConnectionSettings>): ConnectionSettings {
  return { providerId: "custom", baseUrl: "", api: "openai-completions", modelId: "", modelIds: [], systemPrompt: "system", appendPrompt: "append", skillsEnabled: true, skillPaths: [], ...overrides };
}

describe("independent LOGOS settings", () => {
  it("persists model and prompts while keeping the key out of files and webview", async () => {
    const { store, directory, secrets } = await fixture();
    const defaults = await store.load();
    await store.save({ ...defaults, baseUrl: "https://example.com/v1/chat/completions", modelId: "private-model", systemPrompt: "Custom role" }, "private-test-key");
    const view = await store.view();
    expect(view.baseUrl).toBe("https://example.com/v1");
    expect(view.hasApiKey).toBe(true);
    expect(view.hasOpenAiLogin).toBe(false);
    expect(JSON.stringify(view)).not.toContain("private-test-key");
    expect(await readFile(join(directory, "connection.json"), "utf8")).not.toContain("private-test-key");
    const runtime = await store.prepareRuntime(join(directory, "profile"), directory);
    expect(runtime.env.PI_CODING_AGENT_DIR).toBe(join(directory, "profile"));
    expect(runtime.env.LOGOS_VSCODE_API_KEY).toBe("private-test-key");
    expect(await readFile(join(directory, "profile", "system.md"), "utf8")).toBe("Custom role");
    expect(await readFile(join(directory, "profile", "models.json"), "utf8")).not.toContain("private-test-key");
    await expect(store.save({ ...view, baseUrl: "https://other.example/v1" })).rejects.toThrow("URL");
    expect(secrets.size).toBe(1);
  });
  it("removes inherited Pi profiles and provider credentials", () => {
    const env = isolatedRuntimeEnvironment({ PATH: "bin", PI_CODING_AGENT_DIR: "other-profile", PI_CONFIG_DIR: "pi", OPENAI_API_KEY: "wrong", ANTHROPIC_AUTH_TOKEN: "wrong", LOGOS_SIM_COMMAND: "wrong" }, "logos-profile");
    expect(env).toEqual({ PATH: "bin", PI_CODING_AGENT_DIR: "logos-profile", PI_OFFLINE: "1" });
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

describe("provider presets in connection settings", () => {
  it("derives providerId from legacy configs on load without rewriting the file", async () => {
    const { store, directory } = await fixture();
    const { providerId: _legacyId, ...legacyFields } = connection({ baseUrl: "https://api.deepseek.com", modelId: "deepseek-chat" });
    await writeFile(join(directory, "connection.json"), JSON.stringify(legacyFields), "utf8");
    expect((await store.load()).providerId).toBe("deepseek");
    expect(JSON.parse(await readFile(join(directory, "connection.json"), "utf8")).providerId).toBeUndefined();
    await writeFile(join(directory, "connection.json"), JSON.stringify(connection({ baseUrl: "https://api.openai.com/v1", modelId: "gpt-5.5" })), "utf8");
    expect((await store.load()).providerId).toBe("custom");
  });
  it("persists the derived providerId and flips drifted preset URLs to custom", async () => {
    const { store } = await fixture();
    await store.save(connection({ providerId: "deepseek", baseUrl: "https://api.deepseek.com", modelId: "deepseek-chat" }), "key");
    expect((await store.load()).providerId).toBe("deepseek");
    await store.save(connection({ providerId: "deepseek", baseUrl: "https://api.deepseek.com/v2", modelId: "deepseek-chat" }), "key");
    expect((await store.load()).providerId).toBe("custom");
  });
  it("still requires a fresh key when switching between key presets", async () => {
    const { store } = await fixture();
    await store.save(connection({ providerId: "deepseek", baseUrl: "https://api.deepseek.com", modelId: "deepseek-chat" }), "old-key");
    await expect(store.save(connection({ providerId: "zhipu", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", modelId: "glm-4.6" }))).rejects.toThrow("URL");
  });
  it("clears the stale per-URL key when switching onto the ChatGPT preset", async () => {
    const { store, secrets } = await fixture();
    await store.save(connection({ providerId: "deepseek", baseUrl: "https://api.deepseek.com", modelId: "deepseek-chat" }), "old-key");
    expect(secrets.size).toBe(1);
    await store.save(connection({ providerId: "openai-chatgpt", baseUrl: "https://api.openai.com/v1", modelId: "gpt-5.5" }));
    expect(secrets.size).toBe(0);
    const view = await store.view();
    expect(view.hasApiKey).toBe(false);
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
  it("reports upstream models when the endpoint answers, and errors for dead custom URLs", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "model-a" }] }));
      } else {
        response.statusCode = 404;
        response.end("no models here");
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No server address");
      const { store } = await fixture();
      const upstream = await store.models(`http://127.0.0.1:${address.port}/v1`, "openai-completions");
      expect(upstream).toEqual({ modelIds: ["model-a"], source: "upstream" });
      await expect(store.models(`http://127.0.0.1:${address.port}/custom`, "openai-completions")).rejects.toThrow("手动输入模型 ID");
    } finally { await new Promise<void>((done) => server.close(() => done())); }
  });
});

describe("ChatGPT preset runtime wiring", () => {
  it("injects the OAuth access token through the runtime env channel", async () => {
    const { store, directory } = await fixture({ currentAccessToken: async () => "oauth-access-token" });
    await store.save(connection({ providerId: "openai-chatgpt", baseUrl: "https://api.openai.com/v1", api: "openai-responses", modelId: "gpt-5.5" }));
    const runtime = await store.prepareRuntime(join(directory, "profile"), directory);
    expect(runtime.env.LOGOS_VSCODE_API_KEY).toBe("oauth-access-token");
    const modelsJson = await readFile(join(directory, "profile", "models.json"), "utf8");
    expect(modelsJson).toContain("$LOGOS_VSCODE_API_KEY");
    expect(modelsJson).not.toContain("oauth-access-token");
    expect(JSON.parse(modelsJson).providers["logos-endpoint"].api).toBe("openai-responses");
  });
  it("refuses to start the runtime without a ChatGPT login", async () => {
    const { store, directory } = await fixture({ currentAccessToken: async () => undefined });
    await store.save(connection({ providerId: "openai-chatgpt", baseUrl: "https://api.openai.com/v1", api: "openai-responses", modelId: "gpt-5.5" }));
    await expect(store.prepareRuntime(join(directory, "profile"), directory)).rejects.toThrow("登录 ChatGPT");
  });
  it("reports the login state in the settings view", async () => {
    const { store } = await fixture({ hasCredential: async () => true, currentAccessToken: async () => "token" });
    expect((await store.view()).hasOpenAiLogin).toBe(true);
  });
});
