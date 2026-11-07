import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../../server/store.ts";
import { WorkspaceFiles } from "../../server/files.ts";
import { createHandler } from "../../server/app.ts";
import type { Config } from "../../server/auth.ts";

test("authenticated file/project workflow enforces users, CSRF and unavailable execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "logos-http-")), store = new Store(join(root, "db.sqlite")), files = new WorkspaceFiles(join(root, "users"));
  const config: Config = { host: "127.0.0.1", port: 0, publicUrl: "", data: root, preview: false, appId: "", appSecret: "", tenant: "", admins: [], uploadLimit: 1000 };
  const server = createServer(createHandler({ config, store, files, assets: join(root, "assets") }));
  const alice = store.user("alice", "Alice"), bob = store.user("bob", "Bob"), a = store.login(alice), b = store.login(bob);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  config.publicUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  async function request(path: string, session = a, data?: unknown, method?: string): Promise<Response> {
    return fetch(config.publicUrl + path, { method: method ?? (data === undefined ? "GET" : "POST"), headers: {
      Cookie: "logos_session=" + session.token, "X-CSRF-Token": session.csrf, Origin: config.publicUrl, "Content-Type": "application/json",
    }, body: data === undefined ? undefined : method === "PUT" ? String(data) : JSON.stringify(data) });
  }
  try {
    assert.equal((await fetch(config.publicUrl + "/api/projects")).status, 401);
    const bootstrap = await (await request("/api/bootstrap")).json();
    assert.equal(bootstrap.user.id, alice.id); assert.equal(bootstrap.feishuReady, false);
    assert.equal((await fetch(config.publicUrl + "/auth/feishu", { redirect: "manual" })).status, 503);
    const forged = await fetch(config.publicUrl + "/api/folders", { method: "POST", headers: { Cookie: "logos_session=" + a.token }, body: '{"path":"forged"}' });
    assert.equal(forged.status, 403);
    assert.equal((await request("/api/folders", a, { path: "wing" })).status, 201);
    const project = (await (await request("/api/projects", a, { name: "Wing", directory: "wing", owner: bob.id })).json()).project;
    assert.equal(project.owner, alice.id);
    assert.equal((await request("/api/upload?project=" + project.id + "&path=case.txt", a, "case-data", "PUT")).status, 201);
    assert.equal((await request("/api/upload?project=" + project.id + "&path=case.txt", a, "overwrite", "PUT")).status, 409);
    assert.equal((await request("/api/preview?project=" + project.id + "&path=case.txt", b)).status, 404);
    assert.equal((await request("/api/file?project=" + project.id + "&path=case.txt", b)).status, 404);
    assert.equal((await request("/api/upload?project=" + project.id + "&path=bad", b, "bad", "PUT")).status, 404);
    assert.equal((await request("/api/files?path=..%2Fbob", a)).status, 400);
    const text = await (await request("/api/preview?project=" + project.id + "&path=case.txt")).json();
    assert.equal(text.text, "case-data");
    const download = await request("/api/file?project=" + project.id + "&path=case.txt");
    assert.match(download.headers.get("content-disposition") ?? "", /attachment/); assert.equal(await download.text(), "case-data");
    const session = (await (await request("/api/sessions", a, { project: project.id })).json()).session;
    assert.equal((await request("/api/sessions?project=" + project.id, b)).status, 404);
    const runtime = await request("/api/bridge", a, { project: project.id, command: { type: "chat/send", text: "hello" } });
    assert.equal(runtime.status, 503);
    assert.equal((await request("/api/bridge", b, { project: project.id, command: { type: "session/rename", sessionId: session.id, title: "hijacked" } })).status, 404);
    assert.deepEqual((await (await request("/api/projects", b)).json()).projects, []);
    await request("/api/logout", a, {});
    assert.equal((await request("/api/projects", a)).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    store.close(); await rm(root, { recursive: true, force: true });
  }
});
