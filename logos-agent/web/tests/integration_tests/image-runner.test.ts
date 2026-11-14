import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { Store } from "../../server/store.ts";
import { Models } from "../../server/models.ts";
import { Jobs } from "../../server/jobs.ts";
import { Meter } from "../../server/usage.ts";
import { probe } from "../../worker/runtime.ts";

// Real Pi process + real broker, but ONLY a loopback fake provider and dummy key.
// Linux required: worker uses Unix sockets, /bin/ps and process-group signals.
test("real Pi sends inline image content to provider and rejects text-only models", { timeout: 60000, skip: process.platform !== "linux" ? "Linux worker process/socket integration required" : false }, async () => {
  assert.equal((await probe()).ready, true, "Linux runtime prerequisites missing");
  const root = await mkdtemp(join(tmpdir(), "logos-image-runner-"));
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const store = new Store(join(root, "state/application.sqlite"));
  const models = new Models(store, join(root, "state")), jobs = new Jobs(store), meter = new Meter(store);
  const requests: { authorization?: string; body: { messages?: { role: string; content: unknown }[] } }[] = [];
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    const base = { id: "image-fixture", object: "chat.completion.chunk", created: 1, model: "vision-fixture" };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("data: " + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Fixture received." }, finish_reason: null }] }) + "\n\n");
    response.write("data: " + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n");
    response.write("data: " + JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }) + "\n\n");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    const bundle = join(root, "runner.mjs");
    await build({ entryPoints: [join(repo, "logos-agent/web/worker/runner.ts")], bundle: true, platform: "node", format: "esm", outfile: bundle, packages: "external" });
    const { executeRun } = await import(pathToFileURL(bundle).href) as { executeRun: typeof import("../../worker/runner.ts").executeRun };
    const owner = store.user("image-owner", "Image Test"), project = store.createProject(owner.id, "Image", "case");
    await mkdir(join(root, "users", owner.id, "workspace/case"), { recursive: true });
    const connection = models.save({ name: "Loopback image fixture", baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, protocol: "openai-completions", models: ["vision-fixture", "text-fixture"], visionModels: ["vision-fixture"], apiKey: "image-fixture-secret" });
    const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8AARGDiPwMAHfAD/aAzCYkAAAAASUVORK5CYII=" };
    jobs.heartbeat(true, "ready");
    const session = store.createSession(owner.id, project.id);
    const run = jobs.submit(owner.id, project.id, session.id, connection, "vision-fixture", "Describe attached image", "image-first", "off", [image]);
    assert.ok(jobs.claim());
    await executeRun(repo, root, jobs, models, meter, run);
    assert.equal(jobs.get(owner.id, run.id).status, "completed", jobs.get(owner.id, run.id).error ?? "run failed");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, "Bearer image-fixture-secret");
    const user = requests[0].body.messages?.find(message => message.role === "user");
    assert.ok(Array.isArray(user?.content), "Provider must receive multimodal content, not a string path");
    const blocks = user.content as { type: string; text?: string; image_url?: { url: string } }[];
    assert.ok(blocks.some(block => block.type === "text" && block.text?.includes("Describe attached image")));
    assert.equal(blocks.find(block => block.type === "image_url")?.image_url?.url, `data:${image.mimeType};base64,${image.data}`, "Fixture user payload: " + JSON.stringify(requests[0].body.messages?.filter(message => message.role === "user")));
    assert.deepEqual(store.db.prepare("SELECT status FROM model_requests WHERE run=?").all(run.id).map(row => row.status), ["completed"]);
    const textSession = store.createSession(owner.id, project.id);
    const rejected = jobs.submit(owner.id, project.id, textSession.id, connection, "text-fixture", "Must not discard image", "text-only", "off", [image]);
    assert.ok(jobs.claim());
    await executeRun(repo, root, jobs, models, meter, rejected);
    assert.equal(jobs.get(owner.id, rejected.id).status, "failed");
    assert.match(jobs.get(owner.id, rejected.id).error ?? "", /视觉/);
    assert.equal(requests.length, 1, "Text-only model must fail before any provider call");
    // A valid PNG signature alone is insufficient: this fixture has a corrupt IDAT CRC.
    // Pi's decoder omits it; the broker must fail closed rather than send a text-only request.
    const corrupt = { ...image, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9X8AAAAASUVORK5CYII=" };
    const brokenSession = store.createSession(owner.id, project.id);
    const broken = jobs.submit(owner.id, project.id, brokenSession.id, connection, "vision-fixture", "Do not silently omit corrupt image", "corrupt-image", "off", [corrupt]);
    assert.ok(jobs.claim());
    await executeRun(repo, root, jobs, models, meter, broken);
    assert.equal(jobs.get(owner.id, broken.id).status, "failed", "Corrupt image must not complete as a text-only request");
    assert.equal(requests.length, 1, "Omitted/corrupt images must not reach the upstream provider");
  } finally {
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
