import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../server/store.ts";
import { Jobs } from "../../server/jobs.ts";
import { Meter } from "../../server/usage.ts";
import { Feedback, feedbackRoute } from "../../server/feedback.ts";
import { cookies, equal } from "../../server/auth.ts";
import { HttpError } from "../../server/errors.ts";
import { failure } from "../../server/http.ts";

// Standalone route contract harness: mirrors createHandler's existing auth/CSRF boundary.
// The production createHandler wiring is owned and validated by the integrator.
test("feedback HTTP contract authenticates, enforces CSRF/admin, bounds lists and hides other owners", async () => {
  const root = await mkdtemp(join(tmpdir(), "logos-feedback-http-")), store = new Store(join(root, "db.sqlite"));
  new Jobs(store); new Meter(store); const feedback = new Feedback(store);
  const alice = store.user("alice", "甲"), bob = store.user("bob", "乙"), admin = store.user("admin", "管理员", true);
  const a = store.login(alice), b = store.login(bob), c = store.login(admin);
  let origin = "";
  const server = createServer((req, res) => { void (async () => {
    const auth = store.authenticate(cookies(req).logos_session);
    if (req.method !== "GET" && (req.headers.origin !== origin || !equal(String(req.headers["x-csrf-token"] ?? ""), auth.csrf))) throw new HttpError(403, "请求验证失败");
    if (!await feedbackRoute(feedback, auth.user, new URL(req.url ?? "/", origin), req, res)) throw new HttpError(404, "接口不存在");
  })().catch(error => failure(res, error)); });
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    async function request(path: string, identity = a, data?: unknown, method = data === undefined ? "GET" : "POST") {
      return fetch(origin + path, { method, headers: { Cookie: "logos_session=" + identity.token, Origin: origin, "X-CSRF-Token": identity.csrf, "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
    }
    for (const path of ["/api/feedback", "/api/leaderboards", "/api/admin/feedback"]) assert.equal((await fetch(origin + path)).status, 401);
    assert.equal((await request("/api/feedback", { ...a, csrf: "bad" }, { kind: "bug", title: "t", description: "d" })).status, 403);
    assert.equal((await request("/api/admin/feedback", b)).status, 403);
    const project = store.createProject(alice.id, "secret", "private"), session = store.createSession(alice.id, project.id);
    assert.equal((await request("/api/feedback", b, { kind: "bug", title: "t", description: "d", session: session.id })).status, 404);
    const created = await request("/api/feedback", a, { kind: "feature", title: "增加导出", description: "需要导出结果", session: session.id, owner: bob.id, status: "accepted" });
    assert.equal(created.status, 201); const { item } = await created.json(); assert.equal(item.owner, alice.id); assert.equal(item.status, "pending");
    assert.deepEqual((await (await request("/api/feedback", b)).json()).items, []);
    assert.equal((await request("/api/feedback?limit=1000")).status, 400);
    const path = "/api/admin/feedback/" + item.id;
    assert.equal((await request(path, b, { status: "accepted" }, "PATCH")).status, 403);
    assert.equal((await request(path, c, { status: "accepted", note: "确认有效" }, "PATCH")).status, 200);
    assert.equal((await (await request("/api/feedback")).json()).items[0].note, "确认有效");
    const boardResponse = await request("/api/leaderboards"); assert.equal(boardResponse.headers.get("cache-control"), "no-store");
    const board = await boardResponse.json(); assert.deepEqual(board.feedback, [{ name: "甲", count: 1 }]); assert.deepEqual(board.usage, []);
    assert.equal((await request("/api/feedback", a, { kind: "feature", title: "增加导出", description: "需要导出结果" })).status, 409);
    assert.equal((await request("/api/feedback", a, { kind: "feature", title: "x", description: "a".repeat(70000) })).status, 413);
    const malformed = await fetch(origin + "/api/feedback", { method: "POST", headers: { Cookie: "logos_session=" + a.token, Origin: origin, "X-CSRF-Token": a.csrf }, body: "{" }); assert.equal(malformed.status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); await rm(root, { recursive: true, force: true }); }
});
