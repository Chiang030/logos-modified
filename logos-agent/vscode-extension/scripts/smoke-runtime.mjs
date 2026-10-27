import { createServer } from "node:http";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { BUILD_TARGETS, parseTargetArgument, targetDefinition } from "./package-targets.mjs";

const extensionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetArgument = parseTargetArgument(process.argv) ?? `${process.platform}-${process.arch}`;
if (!BUILD_TARGETS.includes(targetArgument) && targetArgument !== `${process.platform}-${process.arch}`) {
  throw new Error(`Unknown smoke target ${targetArgument}; expected one of: ${BUILD_TARGETS.join(", ")}`);
}
const targetPlatform = targetArgument.split("-")[0];
// Cross-platform smoke cannot execute the target binary on this host; validate the
// payload with the host Node.js instead.
if (targetPlatform !== process.platform) {
  console.log(`Cross-platform smoke for ${targetArgument}: running the payload with the host Node.js; the bundled binary is not executed.`);
}
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
// `.complete` is a copy of payload-manifest.json; fail fast when the staged
// payload was built for a different target than this smoke run asserts.
const payloadManifest = JSON.parse(await readFile(join(installed, ".complete"), "utf8"));
assert.equal(payloadManifest.platform, targetArgument, `runtime/ holds a ${payloadManifest.platform} payload; re-run prepare:runtime`);
await verifyBundledSim(installed);
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
assert.deepEqual(await store.models(url, "openai-completions", "smoke-test-key"), { modelIds: ["logos-smoke-model"], source: "upstream" });
await store.saveConnection({
  id: "smoke-conn", name: "Smoke", providerId: "custom", baseUrl: url, api: "openai-completions",
  modelId: "logos-smoke-model", modelIds: ["logos-smoke-model"],
}, "smoke-test-key");
let prepared = await store.prepareRuntime(join(temporaryRoot, "isolated profile"), temporaryRoot);
const withPilot = process.argv.includes("--with-pilot");
const pilotDirectory = process.env.LOONGSUITE_PILOT_DATA_DIR || join(homedir(), ".loongsuite-pilot");
if (withPilot) {
  const telemetryModule = join(temporaryRoot, "telemetry.mjs");
  await build({ entryPoints: [join(extensionDirectory, "src", "pilotTelemetry.ts")], outfile: telemetryModule, bundle: true, platform: "node", format: "esm" });
  const { preparePilotTelemetry } = await import(pathToFileURL(telemetryModule).href);
  prepared = await preparePilotTelemetry(prepared, { enabled: true, dataDirectory: pilotDirectory });
  assert(prepared.env.LOONGSUITE_PILOT_DATA_DIR, prepared.detail);
}
await mkdir(sessionDirectory, { recursive: true });
await mkdir(join(temporaryRoot, ".pi"), { recursive: true });
await writeFile(join(temporaryRoot, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "wrong-pi", extensions: ["does-not-exist"] }));
const smokeNode = targetPlatform === process.platform
  ? join(installed, "vendor", "node", targetPlatform === "win32" ? "node.exe" : "node")
  : process.execPath;
const child = spawn(smokeNode, [join(installed, "vendor", "pi", "cli.js"), "--mode", "rpc", "--session-dir", sessionDirectory, ...prepared.args], {
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
  assert.equal(initial.model.provider, "logos-endpoint-smokeconn");
  const commands = await request("get_commands");
  assert(commands.commands.some((item) => item.name === "logos"), `LOGOS extension missing: ${stderr}`);
  assert(commands.commands.some((item) => item.name === "skill:logos-simulation-workflow"), "LOGOS skills missing");
  assert(commands.commands.some((item) => item.name === "skill:gmsh"), "Gmsh skill missing");
  assert(commands.commands.some((item) => item.name === "skill:kicad"), "KiCad skill missing");
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
  if (withPilot) {
    const logDirectory = join(pilotDirectory, "logs", "pi-coding-agent");
    const files = (await readdir(logDirectory)).filter((name) => name.endsWith(".jsonl"));
    const lines = (await Promise.all(files.map((name) => readFile(join(logDirectory, name), "utf8")))).join("\n");
    const events = lines.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event["gen_ai.session.id"] === initial.sessionId);
    assert(events.some((event) => event["event.name"] === "llm.request"), `Pilot request missing: ${stderr}`);
    assert(events.some((event) => event["event.name"] === "llm.response"), `Pilot response missing: ${stderr}`);
    assert(!lines.includes("smoke-test-key"), "Model credential leaked into telemetry");
    console.log(`Pilot captured LOGOS session ${initial.sessionId}; trace ${events.find((event) => event.trace_id)?.trace_id}`);
  }
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

/** Bundled sim backends must be present and resolvable; execution runs only on a matching host. */
async function verifyBundledSim(installed) {
  // Only these targets ship a backend; anything else (linux-arm64, host
  // fallbacks like darwin) has nothing to verify.
  if (targetArgument !== "win32-x64" && targetArgument !== "linux-x64") return;
  const python = join(installed, "logos-agent", "integrations", ".venv",
    ...targetDefinition(targetArgument).simInterpreter.split("/"));
  try { await access(python); } catch { assert.fail("Bundled sim runtime missing"); }
  if (process.platform !== "win32" || targetArgument !== "win32-x64") return; // Structure-only for foreign targets.
  const version = await capture(python, ["-m", "sim", "--version"]);
  assert.match(version.stdout, /version \d+\.\d+/, `Bundled sim CLI broken: ${version.output}`);
  const discovery = await capture(python, ["-m", "sim", "--json", "--no-interactive", "discover", "mechanical"]);
  assert.equal(discovery.code, 0, `sim discover failed: ${discovery.output}`);
  assert.notEqual(JSON.parse(discovery.stdout).ok, false, discovery.output);
  // Exercise the real tool path: the domain runner must resolve the bundled
  // interpreter by default instead of falling back to `sim` on PATH.
  const { runSimulation } = await import(pathToFileURL(join(installed, "logos-agent", "pi-domain", "src", "simulation", "runner.mjs")).href);
  const result = await runSimulation({ action: "discover", args: ["mechanical"] }, { cwd: temporaryRoot });
  assert(result.command.endsWith("python.exe"), `simulation tool resolved ${result.command}`);
  assert.equal(result.transport_ok, true, JSON.stringify(result.error ?? result));
  assert.equal(result.error, null, JSON.stringify(result.error));
}

function capture(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, output: `${stdout}${stderr}` });
    });
  });
}
