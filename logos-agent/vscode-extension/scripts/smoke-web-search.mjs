// Exercise the bundled web_search through Pi RPC using a local model fixture.
// Usage: node scripts/smoke-web-search.mjs --live [--query "search terms"]
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

if (!process.argv.includes("--live")) throw new Error("Use --live to permit real public search requests.");
const queryIndex = process.argv.indexOf("--query");
const query = queryIndex < 0 ? "北京天气 今天 2026年10月31日" : process.argv[queryIndex + 1];
assert(query, "--query requires text");
const root = await mkdtemp(join(tmpdir(), "logos-search-smoke-"));
let client;
let requests = 0;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests++;
    const completed = body.messages.some((message) => message.role === "tool");
    const delta = completed ? { role: "assistant", content: "Search complete." } : {
      role: "assistant", tool_calls: [{ index: 0, id: "live-search", type: "function",
        function: { name: "web_search", arguments: JSON.stringify({ query, count: 5 }) } }],
    };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", model: "search-smoke",
      choices: [{ index: 0, delta, finish_reason: completed ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    res.writeHead(500); res.end(String(error));
  }
});
try {
  const modulePath = join(root, "client.mjs");
  await build({ stdin: { contents: 'export { RpcClient } from "./src/rpcClient";',
    resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: modulePath });
  const { RpcClient } = await import(pathToFileURL(modulePath).href);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const profile = join(root, "profile"); await mkdir(profile);
  await writeFile(join(profile, "models.json"), JSON.stringify({ providers: { "logos-smoke": {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "local-fixture",
    models: [{ id: "search-smoke" }],
  } } }));
  const child = spawn(resolve("runtime/vendor/node", process.platform === "win32" ? "node.exe" : "node"), [
    resolve("runtime/vendor/pi/cli.js"), "--mode", "rpc", "--session-dir", join(root, "sessions"),
    "--provider", "logos-smoke", "--model", "search-smoke", "--no-extensions", "--no-skills", "--no-approve", "--offline",
    "-e", resolve("runtime/logos-agent/pi-domain/extensions/index.mjs"),
  ], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: profile, LOGOS_OBSERVABILITY: "0" }, stdio: "pipe", windowsHide: true });
  client = new RpcClient(child);
  const records = [];
  let stderr = "";
  client.onRecord((record) => records.push(record));
  client.onStderr((text) => { stderr += text; });
  await client.getState();
  const started = Date.now();
  await client.prompt(`Search the web for: ${query}`);
  const deadline = Date.now() + 60_000;
  while (!records.some((record) => record.type === "agent_settled") && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
  }
  assert(records.some((record) => record.type === "agent_settled"), `Run did not settle: ${stderr}`);
  const ends = records.filter((record) => record.type === "tool_execution_end" && record.toolName === "web_search");
  assert.equal(ends.length, 1, JSON.stringify(records));
  assert.notEqual(ends[0].isError, true, JSON.stringify(ends[0]));
  const result = ends[0].result;
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.details.query, query);
  assert(result.details.results.length > 0 && result.details.results.length <= 5);
  for (const item of result.details.results) {
    assert(item.title); assert.match(item.url, /^https?:\/\//); assert.equal(item.source, result.details.source);
  }
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  assert.equal(requests, 2, "Model must receive the tool result and continue once");
  assert(records.some((record) => record.type === "message_end" && record.message?.role === "assistant"
    && record.message.content?.some((part) => part.text === "Search complete.")), "Model did not finish after search");
  console.log(JSON.stringify({ elapsedMs: Date.now() - started, ...result.details }, null, 2));
  console.log("Bundled web_search live smoke passed: actual Pi tool execution, real search results, source attribution and model continuation.");
} finally {
  await client?.dispose();
  if (server.listening) await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
}
