import { createServer } from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const extensionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "LOGOS smoke 中文 space "));
const sessionDirectory = join(temporaryRoot, "session data");
const settingsModule = join(temporaryRoot, "settings.mjs");
await build({ entryPoints: [join(extensionDirectory, "src", "connectionSettings.ts")], outfile: settingsModule, bundle: true, platform: "node", format: "esm" });
const { ConnectionSettingsStore } = await import(pathToFileURL(settingsModule).href);
const installerModule = join(temporaryRoot, "installer.mjs");
await build({ entryPoints: [join(extensionDirectory, "src", "bundledInstallation.ts")], outfile: installerModule, bundle: true, platform: "node", format: "esm" });
const { installBundledRuntime } = await import(pathToFileURL(installerModule).href);
const installed = await installBundledRuntime(extensionDirectory, join(temporaryRoot, "local storage"));
assert.equal(await installBundledRuntime(extensionDirectory, join(temporaryRoot, "local storage")), installed);
const store = new ConnectionSettingsStore(join(temporaryRoot, "config"), join(installed, "logos-agent", "pi-domain"), {
  get: async () => "smoke-test-key", store: async () => {}, delete: async () => {},
});
let captured;
const server = createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ id: "logos-smoke-model" }] })); return;
  }
  let body = ""; for await (const chunk of req) body += chunk;
  captured = { body: JSON.parse(body), authorization: req.headers.authorization, path: req.url };
  res.setHeader("Content-Type", "text/event-stream");
  for (const delta of [{ role: "assistant", content: "LOGOS_SMOKE_OK" }, {}]) res.write(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", model: "logos-smoke-model", choices: [{ index: 0, delta, finish_reason: delta.content ? null : "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}/v1`;
assert.deepEqual(await store.models(url, "openai-completions", "smoke-test-key"), ["logos-smoke-model"]);
await store.save({ ...await store.load(), baseUrl: url, modelId: "logos-smoke-model", modelIds: ["logos-smoke-model"] });
const prepared = await store.prepareRuntime(join(temporaryRoot, "isolated profile"), temporaryRoot);
await mkdir(sessionDirectory, { recursive: true });
await mkdir(join(temporaryRoot, ".pi"), { recursive: true });
await writeFile(join(temporaryRoot, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "wrong-pi", extensions: ["does-not-exist"] }));
const child = spawn(join(installed, "vendor", "node", "node.exe"), [join(installed, "vendor", "pi", "cli.js"), "--mode", "rpc", "--session-dir", sessionDirectory, ...prepared.args], {
  cwd: temporaryRoot, env: prepared.env, stdio: "pipe", windowsHide: true,
});
let sequence = 0, buffer = "", stderr = "";
const pending = new Map(), records = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
    if (!line) continue;
    const record = JSON.parse(line); records.push(record);
    if (record.type === "response" && pending.has(record.id)) {
      const waiter = pending.get(record.id); pending.delete(record.id);
      if (record.success === false) waiter.reject(new Error(record.error)); else waiter.resolve(record.data);
    }
  }
});
child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
try {
  const initial = await request("get_state");
  assert(initial.sessionId);
  assert.equal(initial.model.provider, "logos-endpoint");
  const commands = await request("get_commands");
  assert(commands.commands.some((item) => item.name === "logos"), `LOGOS extension missing: ${stderr}`);
  assert(commands.commands.some((item) => item.name === "skill:logos-simulation-workflow"), "LOGOS skills missing");
  await request("prompt", { message: "Reply with OK." });
  const deadline = Date.now() + 15000;
  while (!records.some((record) => record.type === "agent_settled") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
  assert(captured, `No upstream request: ${JSON.stringify(records)} ${stderr}`);
  assert.equal(captured.authorization, "Bearer smoke-test-key");
  assert.equal(captured.path, "/v1/chat/completions");
  assert.equal(captured.body.model, "logos-smoke-model");
  assert(captured.body.messages.some((message) => message.role === "system" && message.content.includes("LOGOS Base Role")), "Missing Logos system prompt");
  assert(captured.body.tools.some((tool) => tool.function.name === "simulation"), "Missing Logos simulation tool");
  const messages = await request("get_messages");
  assert(JSON.stringify(messages).includes("LOGOS_SMOKE_OK"), `Streaming response missing: ${JSON.stringify(messages)}`);
  await request("abort");
  await request("new_session");
  await request("switch_session", { sessionPath: initial.sessionFile });
  await request("get_state");
  console.log("LOGOS smoke passed: upstream discovery, isolated profile, bundled extension + skills + prompts + simulation tools, streaming, sessions.");
} finally {
  child.stdin.end();
  await new Promise((done) => {
    const timer = setTimeout(() => { child.kill(); done(); }, 2000);
    child.once("exit", () => { clearTimeout(timer); done(); });
  });
  await new Promise((done) => server.close(done));
  await rm(temporaryRoot, { recursive: true, force: true });
}
function request(type, data = {}) {
  const id = `smoke-${++sequence}`;
  return new Promise((done, fail) => {
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${type} timed out: ${stderr}`)); }, 15000);
    pending.set(id, { resolve(value) { clearTimeout(timer); done(value); }, reject(error) { clearTimeout(timer); fail(error); } });
    child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
  });
}
