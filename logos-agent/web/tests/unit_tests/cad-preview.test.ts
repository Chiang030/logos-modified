import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CadPreview } from "../../server/cad-preview.ts";

const step = "ISO-10303-21;\nHEADER;ENDSEC;\nDATA;ENDSEC;\nEND-ISO-10303-21;\n";
const stl = Buffer.alloc(134);
stl.writeUInt32LE(1, 80); stl.writeFloatLE(1, 84 + 8); stl.writeFloatLE(1, 84 + 24); stl.writeFloatLE(1, 84 + 40);
test("CAD previews read pinned source, create only temporary tessellation, and preserve source", async t => {
  const root = await mkdtemp(join(tmpdir(), "logos-cad-test-")), path = join(root, "original.step");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path, step); const source = await open(path);
  t.after(() => source.close());
  let copy = "";
  const service = new CadPreview(root, async (input, output) => { copy = input; assert.equal(await readFile(input, "utf8"), step); await writeFile(output, stl); });
  assert.deepEqual(await service.render("alice", source, "中文.STEP", new AbortController().signal), stl);
  assert.equal(await readFile(path, "utf8"), step);
  await assert.rejects(readFile(copy), { code: "ENOENT" });
});
test("invalid or incomplete STEP is rejected before conversion and converter errors stay safe", async t => {
  const root = await mkdtemp(join(tmpdir(), "logos-cad-test-")), path = join(root, "bad.step");
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const service = new CadPreview(root, async () => { calls++; throw new Error("private path or subprocess output"); });
  for (const content of ["", "not STEP", "ISO-10303-21;\ntruncated"]) {
    await writeFile(path, content); const source = await open(path);
    try { await assert.rejects(service.render("alice", source, "bad.step", new AbortController().signal), { status: 415 }); }
    finally { await source.close(); }
  }
  assert.equal(calls, 0);
  await writeFile(path, step); const source = await open(path);
  try {
    await assert.rejects(service.render("alice", source, "bad.exe", new AbortController().signal), { status: 415 });
    await assert.rejects(service.render("alice", source, "good.step", new AbortController().signal), { status: 422, message: "STEP 转换失败或超时，请下载原文件检查几何；源文件未修改" });
    await assert.rejects(service.render("alice", source, "good.step", new AbortController().signal), { status: 422 });
  } finally { await source.close(); }
  assert.equal(calls, 2); // Failed conversion releases the user's slot.
});
test("empty, truncated or non-finite tessellations never return preview success", async t => {
  const root = await mkdtemp(join(tmpdir(), "logos-cad-test-")), path = join(root, "test.step");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path, step); const source = await open(path); t.after(() => source.close());
  const badCoordinate = Buffer.from(stl); badCoordinate.writeFloatLE(Number.NaN, 96);
  for (const bytes of [Buffer.from("solid empty\nendsolid empty\n"), stl.subarray(0, 120), badCoordinate]) {
    const service = new CadPreview(root, async (_input, output) => { await writeFile(output, bytes); });
    await assert.rejects(service.render("alice", source, "test.step", new AbortController().signal), { status: 422 });
  }
});
test("CAD conversion is bounded per user and respects cancellation", async t => {
  const root = await mkdtemp(join(tmpdir(), "logos-cad-test-")), path = join(root, "test.step");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path, step); const source = await open(path); t.after(() => source.close());
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = new CadPreview(root, async (_input, _output, signal) => { entered(); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); });
  const controller = new AbortController(), pending = service.render("alice", source, "test.step", controller.signal);
  const rejected = assert.rejects(pending, { status: 499 });
  await started;
  await assert.rejects(service.render("alice", source, "test.step", controller.signal), { status: 429 });
  controller.abort(); await rejected;
});
