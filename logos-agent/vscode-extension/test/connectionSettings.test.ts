import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionSettingsStore, isolatedRuntimeEnvironment, discoverModels } from "../src/connectionSettings";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "logos settings 中文 "));
  directories.push(directory);
  const secrets = new Map<string, string>();
  const store = new ConnectionSettingsStore(directory, resolve("runtime/logos-agent/pi-domain"), {
    get: async (key) => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async (key) => { secrets.delete(key); },
  });
  return { directory, secrets, store };
}

describe("independent LOGOS settings", () => {
  it("persists model and prompts while keeping the key out of files and webview", async () => {
    const { store, directory, secrets } = await fixture();
    const defaults = await store.load();
    await store.save({ ...defaults, baseUrl: "https://example.com/v1/chat/completions", modelId: "private-model", systemPrompt: "Custom role" }, "private-test-key");
    const view = await store.view();
    expect(view.baseUrl).toBe("https://example.com/v1");
    expect(view.hasApiKey).toBe(true);
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
