import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Store } from "../../server/store.ts";
import { Models } from "../../server/models.ts";
import { Jobs } from "../../server/jobs.ts";
import { Meter } from "../../server/usage.ts";
import { probe } from "../../worker/runtime.ts";

test("ChatGPT host runs respect model thinking capabilities while retaining metering and token isolation", { timeout: 60000 }, async t => {
  if (!(await probe()).ready) { t.skip("Host runtime is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "logos-chatgpt-thinking-"));
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const store = new Store(join(root, "state/application.sqlite")), models = new Models(store, join(root, "state"));
  const jobs = new Jobs(store), meter = new Meter(store), access = "chatgpt-thinking-fixture-token";
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.db.prepare("UPDATE openai_account SET secret=? WHERE id=1").run(models.encodeSecret(JSON.stringify({ type: "oauth", access, expires: Date.now() + 60000 })));
  const cases = [{ model: "gpt-6.1-sol", effort: "low" }, { model: "gpt-6-astra", effort: "low" }, { model: "gpt-6-sol", effort: "none" }];
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer " + access);
    const input = JSON.parse(String(init?.body)); requests.push(input);
    const expected = cases.find(entry => entry.model === input.model)!;
    if (input.reasoning?.effort !== expected.effort) return Response.json({ error: { message: "Unsupported reasoning.effort" } }, { status: 400 });
    const item = { id: "message-fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
    const response = { id: "response-fixture", status: "completed", model: input.model, output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
    return new Response(new TextEncoder().encode(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join("")));
  });
  const bundle = join(root, "runner.mjs");
  await build({ entryPoints: [join(repo, "logos-agent/web/worker/runner.ts")], bundle: true, platform: "node", format: "esm", outfile: bundle, packages: "external" });
  const { executeRun } = await import(pathToFileURL(bundle).href) as { executeRun: typeof import("../../worker/runner.ts").executeRun };
  const connection = models.save({ name: "ChatGPT fixture", baseUrl: "https://api.openai.com/v1", protocol: "openai-responses", authType: "openai-chatgpt", reasoning: true, models: cases.map(entry => entry.model) });
  const user = store.user("thinking-owner", "Thinking"), project = store.createProject(user.id, "Thinking", "case");
  await mkdir(join(root, "users", user.id, "workspace/case"), { recursive: true });
  jobs.heartbeat(true, "ready");
  for (const entry of cases) {
    await t.test(entry.model, async () => {
      const session = store.createSession(user.id, project.id);
      const run = jobs.submit(user.id, project.id, session.id, connection, entry.model, "Reply with OK.", entry.model, "off");
      assert.ok(jobs.claim()); await executeRun(repo, root, jobs, models, meter, run);
      const done = jobs.get(user.id, run.id); assert.equal(done.status, "completed", done.error ?? JSON.stringify(jobs.events(user.id, session.id, 0)));
      const config = await readFile(join(root, "state/sessions", session.id, "home/.pi/agent/models.json"), "utf8");
      assert.ok(!config.includes(access));
      assert.equal(JSON.parse(config).providers["logos-admin"].models[0].thinkingLevelMap.off, entry.effort === "none" ? "none" : null);
    });
  }
  assert.equal(requests.length, cases.length);
  const usage = store.db.prepare("SELECT status,known FROM model_requests").all();
  assert.equal(usage.length, cases.length);
  for (const row of usage) { assert.equal(row.status, "completed"); assert.equal(row.known, 1); }
});
