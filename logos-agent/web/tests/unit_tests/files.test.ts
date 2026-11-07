import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFiles, segments } from "../../server/files.ts";

async function* chunks(text: string): AsyncIterable<Uint8Array> { yield Buffer.from(text); }

test("descriptor traversal rejects escapes and symlinks across user spaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "logos-files-")), files = new WorkspaceFiles(root);
  try {
    await files.folder("alice", "wing");
    await files.upload("bob", "secret.txt", chunks("bob-private"), 100);
    const home = await files.home("alice");
    await symlink(await files.home("bob"), join(home, "outside"));
    for (const path of ["../bob", "/etc", "wing/../secret", "a\\b", "a//b", "a\0b"]) assert.throws(() => segments(path));
    await assert.rejects(files.read("alice", "outside/secret.txt"));
    await assert.rejects(files.upload("alice", "outside/new.txt", chunks("bad"), 100));
    assert.equal((await files.list("alice", "")).some((e) => e.name === "outside"), false);
    await symlink(join(await files.home("bob"), "secret.txt"), join(home, "link.txt"));
    await assert.rejects(files.read("alice", "link.txt"));
    assert.equal(await readFile(join(await files.home("bob"), "secret.txt"), "utf8"), "bob-private");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uploads publish complete files, preserve existing contents and clean interrupted writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "logos-upload-")), files = new WorkspaceFiles(root);
  try {
    await files.upload("alice", "nested/a.txt", chunks("original"), 100);
    await assert.rejects(files.upload("alice", "nested/a.txt", chunks("changed"), 100), /已存在/);
    await assert.rejects(files.upload("alice", "nested/large.txt", chunks("123456"), 3), /限制/);
    async function* interrupted(): AsyncIterable<Uint8Array> { yield Buffer.from("partial"); throw new Error("disconnect"); }
    await assert.rejects(files.upload("alice", "nested/partial.txt", interrupted(), 100), /disconnect/);
    const rows = await files.list("alice", "nested");
    assert.deepEqual(rows.map((r) => r.name), ["a.txt"]);
    const handle = await files.read("alice", "nested/a.txt");
    try { assert.equal(await handle.readFile("utf8"), "original"); } finally { await handle.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
