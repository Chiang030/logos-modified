import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessionStore";

describe("SessionStore", () => {
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
