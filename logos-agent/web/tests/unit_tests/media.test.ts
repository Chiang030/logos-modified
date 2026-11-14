import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { sendFile, failure } from "../../server/http.ts";

test("media streams have browser MIME types, seekable ranges, and explicit downloads", async t => {
  const root = await mkdtemp(join(tmpdir(), "logos-media-")), path = join(root, "fixture"), bytes = Buffer.from("0123456789");
  await writeFile(path, bytes);
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    void open(path, "r").then(file => sendFile(req, res, file, url.pathname, url.searchParams.has("download"))).catch(error => failure(res, error));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  for (const [name, type] of [["movie.MP4", "video/mp4"], ["movie.webm", "video/webm"], ["audio.mp3", "audio/mpeg"], ["audio.wav", "audio/wav"], ["model.glb", "model/gltf-binary"]]) {
    const response = await fetch(origin + "/" + name);
    assert.equal(response.headers.get("content-type"), type); assert.match(response.headers.get("content-disposition")!, /^inline/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  for (const [range, expected, contentRange] of [["bytes=2-5", "2345", "bytes 2-5/10"], ["bytes=7-", "789", "bytes 7-9/10"], ["bytes=-3", "789", "bytes 7-9/10"], ["bytes=8-99", "89", "bytes 8-9/10"]]) {
    const response = await fetch(origin + "/movie.mp4", { headers: { Range: range } });
    assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), contentRange);
    assert.equal(response.headers.get("accept-ranges"), "bytes"); assert.equal(await response.text(), expected);
  }
  for (const range of ["bytes=10-", "bytes=-0", "bytes=6-2", "bytes=-", "bytes=0-1,4-5", "garbage"]) {
    const response = await fetch(origin + "/movie.mp4", { headers: { Range: range } });
    assert.equal(response.status, 416, range); assert.equal(response.headers.get("content-range"), "bytes */10");
    assert.equal(await response.text(), "");
  }
  const download = await fetch(origin + "/movie.mp4?download=1");
  assert.match(download.headers.get("content-disposition")!, /^attachment/); await download.arrayBuffer();
  await writeFile(path, "");
  const empty = await fetch(origin + "/empty.mp4"); assert.equal(empty.status, 200); assert.equal((await empty.arrayBuffer()).byteLength, 0);
  const emptyRange = await fetch(origin + "/empty.mp4", { headers: { Range: "bytes=0-" } });
  assert.equal(emptyRange.status, 416); assert.equal(emptyRange.headers.get("content-range"), "bytes */0");
});
