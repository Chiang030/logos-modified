import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/store.ts";
import { Meter } from "../../server/usage.ts";
import { modelBroker } from "../../server/broker.ts";
import type { Connection } from "../../server/models.ts";
import type { Run } from "../../server/jobs.ts";

test("transport failures return actionable JSON without secrets and retain unknown failed usage", async t => {
  const root = await mkdtemp(join(tmpdir(), "logos-broker-"));
  const store = new Store(join(root, "db.sqlite")), meter = new Meter(store);
  const connection: Connection = { id: "connection", name: "Fixture", baseUrl: "https://fixture.invalid", protocol: "openai-completions",
    models: ["fixture"], enabled: true, contextWindow: 128000, maxTokens: 8192, reasoning: false, version: 1, hasKey: true };
  const run: Run = { id: "run", owner: "owner", project: "project", session: "session", connection: connection.id, model: "fixture",
    thinking: "off", prompt: "Fixture", status: "running", created: Date.now(), started: Date.now(), finished: null, error: null, request_key: "request" };
  const socket = join(root, "model.sock"), secret = "fixture-secret-must-not-appear";
  const broker = await modelBroker(socket, connection, secret, run, meter);
  t.after(async () => { await broker.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  for (const [code, expected] of [["ENOTFOUND", "域名无法解析"], ["ECONNREFUSED", "连接被拒绝"], ["UND_ERR_CONNECT_TIMEOUT", "超时"], ["UNKNOWN", "无法连接模型 API"]]) {
    const failure = new TypeError(secret, { cause: Object.assign(new Error(secret), { code }) });
    const mocked = t.mock.method(globalThis, "fetch", async () => { throw failure; });
    try {
      const response = await new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
        const incoming = request({ socketPath: socket, path: "/chat/completions", method: "POST", headers: { "Content-Type": "application/json" } }, response => {
          let body = "";
          response.setEncoding("utf8"); response.on("data", part => { body += part; });
          response.on("end", () => resolve({ status: response.statusCode!, type: String(response.headers["content-type"]), body }));
          response.on("error", reject);
        });
        incoming.on("error", reject); incoming.end(JSON.stringify({ model: "fixture", stream: true }));
      });
      assert.equal(response.status, 502); assert.equal(response.type, "application/json");
      assert.ok(JSON.parse(response.body).error.message.includes(expected));
      assert.ok(!response.body.includes(secret));
    } finally { mocked.mock.restore(); }
  }
  const usage = store.db.prepare("SELECT status,known FROM model_requests").all();
  assert.equal(usage.length, 4);
  for (const row of usage) { assert.equal(row.status, "failed"); assert.equal(row.known, 0); }
});
