import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/store.ts";
import { equal, beginLogin, completeLogin, type Config } from "../../server/auth.ts";

test("identity, project and conversation ownership survive a database restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "logos-store-")), file = join(directory, "db.sqlite");
  let store = new Store(file);
  try {
    const alice = store.user("tenant:alice", "同名用户"), bob = store.user("tenant:bob", "同名用户");
    assert.notEqual(alice.id, bob.id);
    assert.equal(store.user("tenant:alice", "新名字").id, alice.id);
    const project = store.createProject(alice.id, "Wing", "wing");
    assert.equal(store.createProject(alice.id, "Other label", "wing").id, project.id);
    assert.throws(() => store.createProject(alice.id, "Nested", "wing/a"), /嵌套/);
    assert.throws(() => store.project(bob.id, project.id), /不存在/);
    const session = store.createSession(alice.id, project.id);
    assert.throws(() => store.renameSession(bob.id, session.id, "hijacked"), /不存在/);
    const login = store.login(alice);
    store.close(); store = new Store(file);
    assert.equal(store.authenticate(login.token).user.name, "新名字");
    assert.equal(store.sessions(alice.id, project.id)[0].id, session.id);
    store.logout(login.token);
    assert.throws(() => store.authenticate(login.token), /登录/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("OAuth state is one-use, credentials remain server-side and tenant is enforced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "logos-oauth-")), store = new Store(join(directory, "db.sqlite"));
  const config: Config = { host: "127.0.0.1", port: 0, data: directory, preview: false, uploadLimit: 1000, appId: "test-app", appSecret: "fixture-secret", tenant: "company", admins: ["alice"], publicUrl: "https://logos.example.test" };
  try {
    assert.equal(equal("é", "a"), false);
    const login = beginLogin(config, store), url = new URL(login.location);
    assert.equal(url.searchParams.get("redirect_uri"), config.publicUrl + "/auth/feishu/callback");
    assert.equal(url.href.includes(config.appSecret), false);
    const state = url.searchParams.get("state")!;
    assert.equal(store.consumeState(state), true); assert.equal(store.consumeState(state), false);
    const exchange = (tenant: string): typeof fetch => async (input, init) => {
      if (String(input).endsWith("/oauth/token")) {
        assert.equal(JSON.parse(String(init?.body)).client_secret, config.appSecret);
        return Response.json({ code: 0, access_token: "test-token" });
      }
      return Response.json({ code: 0, data: { open_id: "alice", tenant_key: tenant, name: "Alice" } });
    };
    const user = await completeLogin(config, store, "code", exchange("company"));
    assert.equal(user.admin, true);
    await assert.rejects(completeLogin(config, store, "code", exchange("another-company")), /允许的企业/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Lark uses international endpoints and accepts string success codes without mixing identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "logos-lark-")), store = new Store(join(directory, "db.sqlite"));
  const config: Config = { host: "127.0.0.1", port: 0, data: directory, preview: false, uploadLimit: 1000, platform: "lark", appId: "test-app", appSecret: "fixture-secret", tenant: "company", admins: [], publicUrl: "https://logos.example.test" };
  try {
    const url = new URL(beginLogin(config, store).location);
    assert.equal(url.origin, "https://accounts.larksuite.com");
    assert.equal(url.searchParams.get("client_id"), config.appId);
    assert.equal(url.searchParams.get("redirect_uri"), config.publicUrl + "/auth/feishu/callback");
    assert.equal(url.href.includes(config.appSecret), false);
    const feishuUser = store.user("test-app:company:alice", "Alice");
    let identity: string | undefined;
    for (const code of [0, "0"]) {
      const exchange: typeof fetch = async (input, init) => {
        const endpoint = new URL(String(input));
        assert.equal(endpoint.origin, "https://open.larksuite.com");
        if (endpoint.pathname === "/open-apis/authen/v2/oauth/token") {
          assert.equal(JSON.parse(String(init?.body)).client_secret, config.appSecret);
          return Response.json({ code, access_token: "lark-test-token" });
        }
        assert.equal(endpoint.pathname, "/open-apis/authen/v1/user_info");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer lark-test-token");
        return Response.json({ code: 0, data: { open_id: "alice", tenant_key: "company", name: "Alice" } });
      };
      const user = await completeLogin(config, store, "authorization-code", exchange);
      assert.notEqual(user.id, feishuUser.id);
      if (identity) assert.equal(user.id, identity);
      identity = user.id;
    }
    await assert.rejects(completeLogin(config, store, "invalid-code", async () =>
      Response.json({ code: "20002", error: "invalid_client", access_token: "must-not-be-used" })), /Lark授权交换失败/);
    await assert.rejects(completeLogin(config, store, "foreign-tenant", async (input) =>
      String(input).endsWith("/oauth/token")
        ? Response.json({ code: "0", access_token: "token" })
        : Response.json({ code: 0, data: { open_id: "alice", tenant_key: "another-company", name: "Alice" } })), /允许的企业/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("remembered login survives reloads and restarts, renews for 30 days, and respects expiry/logout", async t => {
  const directory = await mkdtemp(join(tmpdir(), "logos-login-lifetime-")), file = join(directory, "db.sqlite");
  let store = new Store(file), now = Date.now();
  t.mock.method(Date, "now", () => now);
  const day = 24 * 3600_000;
  try {
    const login = store.login(store.user("remembered", "Remembered user"));
    now += 13 * 3600_000;
    assert.equal(store.refreshLogin(login.token).csrf, login.csrf);
    store.close(); store = new Store(file);
    now += 29 * day;
    assert.equal(store.refreshLogin(login.token).user.name, "Remembered user");
    now += 29 * day;
    assert.equal(store.refreshLogin(login.token).csrf, login.csrf);
    store.logout(login.token);
    assert.throws(() => store.refreshLogin(login.token), /登录/);
    const expired = store.login(store.user("expired", "Expired user"));
    now += 30 * day;
    assert.throws(() => store.refreshLogin(expired.token), /登录/);
    assert.throws(() => store.authenticate(expired.token), /登录/);
    assert.throws(() => store.refreshLogin(undefined), /登录/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
