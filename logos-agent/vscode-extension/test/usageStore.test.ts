import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageStore } from "../src/usageStore";
import { MEMBERS } from "../src/shared/members";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(): Promise<UsageStore> {
  const path = await mkdtemp(join(tmpdir(), "logos-usage-")); directories.push(path);
  return new UsageStore(path);
}
function response(timestamp = 123): Record<string, unknown> {
  return { role: "assistant", provider: "api", model: "model", timestamp, content: [{ type: "text", text: "Private content" }],
    stopReason: "stop", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 5, totalTokens: 100 } };
}

describe("member attribution and usage", () => {
  it("has no implicit user, persists selection, and rejects unlisted members", async () => {
    const store = await fixture(); expect(await store.selected()).toBeUndefined();
    await expect(store.select("intruder")).rejects.toThrow("名单");
    await store.select(MEMBERS[0].id);
    expect(await new UsageStore(directories[0]).selected()).toEqual(MEMBERS[0]);
  });

  it("keeps session identity immutable and rejects forged display names", async () => {
    const store = await fixture(); await store.bind("s", { id: MEMBERS[0].id, name: "Someone else" });
    await store.select(MEMBERS[1].id);
    await expect(store.bind("s", MEMBERS[1])).rejects.toThrow("请新建会话");
    expect(await store.owner("s")).toEqual(MEMBERS[0]);
  });

  it("deduplicates restored responses and does not double-count reasoning or cached input", async () => {
    const store = await fixture(); await store.bind("s", MEMBERS[0]);
    await store.record("s", [response(), response()]);
    await new UsageStore(directories[0]).record("s", [response()]);
    const view = await store.view();
    expect(view.summaries[0]).toMatchObject({ sessions: 1, responses: 1, input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 });
    expect(view.models[0]).toMatchObject({ provider: "api", model: "model", total: 100 });
    const persisted = await readFile(store.filePath, "utf8");
    expect(persisted).not.toContain("Private content");
    expect(persisted).not.toContain("cost");
  });

  it("does not infer identity for legacy transcripts", async () => {
    const store = await fixture(); await store.select(MEMBERS[0].id); await store.record("legacy", [response()]);
    expect((await store.view()).summaries[0]).toMatchObject({ sessions: 0, responses: 0, total: 0 });
  });

  it("separates errors and unknown/zero usage instead of reporting verified zero consumption", async () => {
    const store = await fixture(); await store.bind("s", MEMBERS[0]);
    await store.record("s", [
      { ...response(1), usage: undefined, stopReason: "error" },
      { ...response(2), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { ...response(3), usage: { input: -10, output: 5, cacheRead: 0, cacheWrite: 0 }, stopReason: "aborted" },
    ]);
    expect((await store.view()).summaries[0]).toMatchObject({ responses: 3, unknownUsage: 3, failed: 2, total: 0 });
  });

  it("serializes concurrent records from store instances and separates model usage", async () => {
    const store = await fixture(); const other = new UsageStore(directories[0]);
    await store.bind("one", MEMBERS[0]); await store.bind("two", MEMBERS[1]);
    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? store : other).record(index % 2 ? "one" : "two", [response(index)])));
    const view = await store.view();
    expect(view.summaries[0]).toMatchObject({ responses: 10, total: 1000 });
    expect(view.summaries[1]).toMatchObject({ responses: 10, total: 1000 });
    expect(view.models).toHaveLength(2);
  });

  it("preserves corrupt records and refuses to silently replace accounting history", async () => {
    const store = await fixture(); await writeFile(store.filePath, "{corrupt");
    await expect(store.select(MEMBERS[0].id)).rejects.toThrow();
    expect(await readFile(store.filePath, "utf8")).toBe("{corrupt");
  });
});
