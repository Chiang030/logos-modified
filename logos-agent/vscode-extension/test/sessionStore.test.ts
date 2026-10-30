import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessionStore";

describe("SessionStore", () => {
  const temporary: string[] = [];
  afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
  async function fixture() { const path = await mkdtemp(join(tmpdir(), "logos-recovery-")); temporary.push(path); return path; }

  it("serializes concurrent saves and retains more than 50 sessions", async () => {
    const path = await fixture(); const store = new SessionStore(path);
    await Promise.all(Array.from({ length: 65 }, (_, index) => store.save({ sessionId: `s-${index}` })));
    expect(await store.list()).toHaveLength(65);
    expect((await store.load())?.sessionId).toBe("s-64");
    expect(JSON.parse(await readFile(join(path, "session.json.bak"), "utf8")).sessions).toHaveLength(64);
  });

  it("preserves renamed titles across automatic saves and reload", async () => {
    const path = await fixture(); const store = new SessionStore(path);
    await store.save({ sessionId: "s", title: "Automatic" });
    await store.rename("s", "  My project  ");
    await store.save({ sessionId: "s", title: "New automatic" });
    expect(await new SessionStore(path).load()).toMatchObject({ title: "My project", manualTitle: true });
    await expect(store.rename("s", " ")).rejects.toThrow("不能为空");
  });

  it("recovers the backup and orphan transcripts, preserving corrupt data", async () => {
    const path = await fixture(); const store = new SessionStore(path);
    await store.save({ sessionId: "first", title: "Saved" });
    await store.save({ sessionId: "second" });
    await writeFile(join(path, "session.json"), "{broken");
    const transcript = JSON.stringify({ type: "session", id: "orphan", timestamp: "2026-01-01" }) + "\n";
    await writeFile(join(path, "orphan.jsonl"), transcript);
    await writeFile(join(path, "broken.jsonl"), "invalid");
    await store.reconcile(path);
    expect((await store.list()).map((item) => item.sessionId)).toEqual(["first", "orphan"]);
    expect((await readdir(path)).some((name) => name.includes(".corrupt-"))).toBe(true);
    expect(store.diagnostics.join(" ")).toContain("broken.jsonl");
    expect(await readFile(join(path, "orphan.jsonl"), "utf8")).toBe(transcript);
  });

  it("marks unfinished runs interrupted without rerunning tools", async () => {
    const path = await fixture(); const store = new SessionStore(path);
    await store.save({ sessionId: "run", outcome: "running" });
    await store.reconcile(path);
    expect(await store.load()).toMatchObject({ outcome: "interrupted" });
  });
  it("persists and reloads the active session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "logos-session-"));
    const store = new SessionStore(directory);
    await store.save({ sessionFile: "/tmp/session.jsonl", sessionId: "abc" });
    await expect(store.load()).resolves.toMatchObject({ sessionFile: "/tmp/session.jsonl", sessionId: "abc" });
    expect(await readFile(join(directory, "session.json"), "utf8")).toContain("session.jsonl");
  });

  it("treats a missing session file as a new session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "logos-session-"));
    await expect(new SessionStore(directory).load()).resolves.toBeUndefined();
  });

  it("keeps an index of multiple sessions and restores legacy files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "logos-session-"));
    const store = new SessionStore(directory);
    await store.save({ sessionFile: "/tmp/one.jsonl", sessionId: "one", title: "First" });
    await store.save({ sessionFile: "/tmp/two.jsonl", sessionId: "two", title: "Second" });
    await expect(store.load()).resolves.toMatchObject({ sessionId: "two" });
    await expect(store.list()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "one" }), expect.objectContaining({ sessionId: "two" })]));
    await store.clear();
    await expect(store.list()).resolves.toHaveLength(2);
    await expect(store.load()).resolves.toBeUndefined();
  });
});
