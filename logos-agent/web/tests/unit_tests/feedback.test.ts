import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../server/store.ts";
import { Jobs } from "../../server/jobs.ts";
import { Meter } from "../../server/usage.ts";
import { Feedback } from "../../server/feedback.ts";
import { HttpError } from "../../server/errors.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "logos-feedback-")), store = new Store(join(root, "db.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  new Jobs(store); new Meter(store); const feedback = new Feedback(store);
  const alice = store.user("alice", "甲"), bob = store.user("bob", "乙"), admin = store.user("admin", "管理员", true);
  const project = store.createProject(alice.id, "secret project", "private"), session = store.createSession(alice.id, project.id);
  return { store, feedback, alice, bob, admin, project, session };
}
const input = { kind: "bug", title: "保存失败", description: "点击保存后出现错误" };
const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;

test("feedback validates ownership, bounded fields, isolation and normalized duplicates", t => {
  const { feedback: f, alice, bob, admin, project, session, store } = fixture(t);
  store.renameSession(alice.id, session.id, "PRIVATE SESSION BODY");
  assert.throws(() => f.submit(bob, { ...input, project: project.id }), status(404));
  assert.throws(() => f.submit(bob, { ...input, session: session.id }), status(404));
  const other = store.createProject(alice.id, "other", "other");
  assert.throws(() => f.submit(alice, { ...input, project: other.id, session: session.id }), status(400));
  for (const changes of [{ title: " " }, { title: "a".repeat(121) }, { description: "a".repeat(5001) }, { kind: "evil" }, { description: "bad\u0000" }, { project: {} }]) assert.throws(() => f.submit(alice, { ...input, ...changes }), status(400));
  const row = f.submit(alice, { ...input, session: session.id, owner: bob.id, status: "accepted", prompt: "DO NOT COPY" });
  assert.equal(row.owner, alice.id); assert.equal(row.project, project.id); assert.equal(row.status, "pending");
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE SESSION BODY|DO NOT COPY|fingerprint/);
  assert.equal(f.list(bob, new URLSearchParams()).items.length, 0);
  assert.equal(f.list(alice, new URLSearchParams()).items[0].id, row.id);
  assert.throws(() => f.list(bob, new URLSearchParams(), true), status(403));
  assert.equal(f.list(admin, new URLSearchParams(), true).items.length, 1);
  assert.throws(() => f.submit(alice, { ...input, title: " 保存失败 " }), status(409));
});

test("rate limit, pagination and review permissions resist leaderboard spam", t => {
  const { feedback: f, alice, bob, admin, store } = fixture(t), now = Date.now();
  for (let i = 0; i < 10; i++) f.submit(alice, { ...input, title: "问题" + i }, now);
  assert.throws(() => f.submit(alice, { ...input, title: "第11条" }, now), status(429));
  const first = f.list(alice, new URLSearchParams("limit=3"));
  assert.equal(first.items.length, 3); assert.equal(first.hasMore, true);
  const second = f.list(alice, new URLSearchParams("limit=3&offset=3"));
  assert.ok(second.items.every(row => !first.items.some(other => row.id === other.id)));
  for (const query of ["limit=0", "limit=101", "offset=-1", "offset=100001", "limit=abc", "status=madeup"]) assert.throws(() => f.list(alice, new URLSearchParams(query)), status(400));
  const id = first.items[0].id;
  assert.throws(() => f.review(bob, id, { status: "accepted" }), status(403));
  assert.throws(() => f.review(admin, "missing", { status: "accepted" }), status(404));
  assert.throws(() => f.review(admin, id, { status: "pending" }), status(400));
  f.review(admin, id, { status: "accepted", note: "已确认" }, now);
  assert.deepEqual(f.leaderboards(now).feedback.map(row => ({ ...row })), [{ name: "甲", count: 1 }]);
  f.review(admin, id, { status: "resolved" }, now);
  assert.equal(f.leaderboards(now).feedback[0].count, 1);
  f.review(admin, id, { status: "duplicate" }, now);
  assert.equal(f.leaderboards(now).feedback.length, 0);
  f.review(admin, id, { status: "rejected" }, now);
  assert.equal(f.leaderboards(now).feedback.length, 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM feedback_reviews").get() as { n: number }).n, 4);
  const own = f.submit(admin, input, now);
  assert.throws(() => f.review(admin, own.id, { status: "accepted" }), status(403));
});

test("leaderboards count only Beijing active days with genuine metered completed runs and expose names/counts", t => {
  const { feedback: f, store, alice, bob, admin, project, session } = fixture(t);
  const now = Date.parse("2026-11-12T12:00:00+08:00"), start = Date.parse("2026-10-14T00:00:00+08:00");
  function run(id: string, when: number, state = "completed", known = 1, amount = 2, metered = "completed", owner = alice.id) {
    store.db.prepare("INSERT INTO runs(id,owner,project,session,connection,model,thinking,prompt,status,created,started,finished,error,request_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, alice.id, project.id, session.id, "c", "m", "off", "SECRET PROMPT", state, when - 10, when - 9, when, null, id);
    store.db.prepare("INSERT INTO model_requests(id,owner,project,session,run,connection,connection_name,model,protocol,config_version,created,finished,status,known,input) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, owner, project.id, session.id, id, "c", "secret connection", "m", "openai", 1, when - 8, when - 1, metered, known, amount);
  }
  run("a", now - 100); run("b", now - 200); run("yesterday", now - 86400000); run("boundary", start);
  run("old", start - 1); run("future", now + 1); run("failed", now - 3 * 86400000, "failed");
  run("unknown", now - 4 * 86400000, "completed", 0); run("zero", now - 5 * 86400000, "completed", 1, 0);
  run("meter-failed", now - 6 * 86400000, "completed", 1, 1, "failed"); run("wrong-owner", now - 7 * 86400000, "completed", 1, 1, "completed", bob.id);
  const old = f.submit(alice, input, start - 1); f.review(admin, old.id, { status: "accepted" }, now);
  const current = f.submit(alice, { ...input, title: "当前问题" }, start); f.review(admin, current.id, { status: "accepted" }, now);
  const result = f.leaderboards(now);
  assert.equal(result.start, start); assert.deepEqual(result.usage.map(row => ({ ...row })), [{ name: "甲", count: 3 }]);
  assert.deepEqual(result.feedback.map(row => ({ ...row })), [{ name: "甲", count: 1 }]);
  for (const row of [...result.usage, ...result.feedback]) assert.deepEqual(Object.keys(row).sort(), ["count", "name"]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET PROMPT|secret connection|private|input|session/);
});
