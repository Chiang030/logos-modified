// Exercise real model requests and Pi retries against a local endpoint, without an API key.
// --baseline reproduces the old repeated-balance-error behavior without the LOGOS guard.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "logos-model-errors-"));
const baseline = process.argv.includes("--baseline");
const modulePath = join(root, "client.mjs");
await build({ stdin: { contents: 'export { RpcClient } from "./src/rpcClient";',
  resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: modulePath });
const { RpcClient } = await import(pathToFileURL(modulePath).href);
let scenario = "balance", requests = 0;
const server = createServer(async (req, res) => {
  for await (const _chunk of req) { /* Consume the request before responding. */ }
  requests++;
  if (scenario === "balance" || (scenario === "transient" && requests === 1)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify(scenario === "balance" ? { code: "1113", message: "余额不足或无可用资源包,请充值。" }
      : { error: { code: "rate_limit_exceeded", message: "Too many requests; retry shortly." } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", model: "error-smoke", choices: [{ index: 0, delta: { role: "assistant", content: "RECOVERED" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const profile = join(root, "profile"); await mkdir(profile);
await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { "logos-smoke": {
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "local-fixture",
  models: [{ id: "error-smoke" }],
} } }));
await writeFile(join(profile, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, provider: { maxRetries: 0 } } }));
const child = spawn(resolve("runtime/vendor/node", process.platform === "win32" ? "node.exe" : "node"), [
  resolve("runtime/vendor/pi/cli.js"), "--mode", "rpc", "--session-dir", join(root, "sessions"),
  "--provider", "logos-smoke", "--model", "error-smoke", "--no-extensions", "--no-skills", "--no-approve", "--offline",
  ...(baseline ? [] : ["-e", resolve(process.argv.includes("--bundled-domain")
    ? "runtime/logos-agent/pi-domain/extensions/index.mjs" : "../pi-domain/extensions/model-errors.mjs")]),
], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: profile }, stdio: "pipe", windowsHide: true });
const client = new RpcClient(child);
const records = [];
let stderr = "";
client.onRecord((record) => records.push(record));
client.onStderr((text) => { stderr += text; });
try {
  const initial = await client.getState();
  await run("balance");
  const errors = records.filter((record) => record.type === "message_end" && record.message?.stopReason === "error");
  assert.equal(requests, baseline ? 4 : 1, `Unexpected billing request count: ${requests}`);
  assert.equal(errors.length, baseline ? 4 : 1);
  assert.equal(records.find((record) => record.type === "agent_settled")?.aborted, false);
  assert.equal((await client.getState()).isStreaming, false);
  assert.match(errors[0].message.errorMessage, /1113/);
  if (!baseline) {
    assert(!records.some((record) => record.type === "auto_retry_start"), "Billing errors must not even schedule a retry");
    await client.newSession();
    await client.requestWithTimeout({ type: "switch_session", sessionPath: initial.sessionFile });
    const restored = await client.getMessages();
    assert.equal(restored.messages.filter((message) => message.role === "assistant" && message.stopReason === "error").length, 1, "The failure must survive session restoration");
    await run("transient");
    assert.equal(requests, 2, "Transient 429 must still retry");
    assert(records.some((record) => record.type === "message_end" && record.message?.stopReason !== "error"));
    await run("success");
    assert.equal(requests, 1, "A later user request must remain usable");
  }
  console.log(baseline ? "Reproduced: one user prompt causes four HTTP requests and four balance-error replies."
    : "Model error smoke passed: billing 429 makes one HTTP request and one persisted error reply without scheduling retries; transient 429 recovers; subsequent prompts work.");
} finally {
  await client.dispose();
  await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
}
async function run(next) {
  scenario = next; requests = 0; records.length = 0;
  await client.prompt("你好");
  const deadline = Date.now() + 30_000;
  while (!records.some((record) => record.type === "agent_settled") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  assert(records.some((record) => record.type === "agent_settled"), `Run did not settle: ${stderr}`);
}
