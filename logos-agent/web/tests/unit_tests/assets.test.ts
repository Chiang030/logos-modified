import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { gzipSync, gunzipSync } from "node:zlib";
import { asset } from "../../server/assets.ts";
import { failure } from "../../server/http.ts";

test("public assets negotiate gzip and validate cached representations without retransmitting their bodies", async t => {
  const root = await mkdtemp(join(tmpdir(), "logos-assets-")), source = "console.log('fixture');";
  await writeFile(join(root, "app.js"), source); await writeFile(join(root, "app.js.gz"), gzipSync(source));
  await writeFile(join(root, "app.css"), "body{}");
  const server = createServer((req, res) => { void asset(root, req.url!, req, res).catch(error => failure(res, error)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const get = (path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; headers: Record<string, unknown>; data: Buffer }> => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: (server.address() as AddressInfo).port, path, method, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, data: Buffer.concat(chunks) }));
    }); req.on("error", reject); req.end();
  });
  const zipped = await get("/app.js", { "Accept-Encoding": "gzip, deflate, br" });
  assert.equal(zipped.status, 200); assert.equal(zipped.headers["content-encoding"], "gzip");
  assert.equal(zipped.headers.vary, "Accept-Encoding"); assert.equal(gunzipSync(zipped.data).toString(), source);
  const cached = await get("/app.js", { "Accept-Encoding": "gzip", "If-None-Match": "W/" + zipped.headers.etag });
  assert.equal(cached.status, 304); assert.equal(cached.data.length, 0);
  const plain = await get("/app.js", { "Accept-Encoding": "gzip;q=0, *;q=1", "If-None-Match": String(zipped.headers.etag) });
  assert.equal(plain.status, 200); assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.data.toString(), source); assert.notEqual(plain.headers.etag, zipped.headers.etag);
  const head = await get("/app.js", { "Accept-Encoding": "gzip" }, "HEAD");
  assert.equal(head.status, 200); assert.equal(Number(head.headers["content-length"]), zipped.data.length); assert.equal(head.data.length, 0);
  const fallback = await get("/app.css", { "Accept-Encoding": "gzip" });
  assert.equal(fallback.status, 200); assert.equal(fallback.headers["content-encoding"], undefined); assert.equal(fallback.data.toString(), "body{}");
  await writeFile(join(root, "app.js.gz"), gzipSync("updated"));
  const updated = await get("/app.js", { "Accept-Encoding": "gzip", "If-None-Match": String(zipped.headers.etag) });
  assert.equal(updated.status, 200); assert.notEqual(updated.headers.etag, zipped.headers.etag);
  assert.equal(gunzipSync(updated.data).toString(), "updated");
  await mkdir(join(root, "chunks"));
  await writeFile(join(root, "chunks", "model-preview-ABC123.js"), "export default 'viewer';");
  const viewer = await get("/chunks/model-preview-ABC123.js");
  assert.equal(viewer.status, 200); assert.equal(viewer.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(viewer.data.toString(), "export default 'viewer';");
  assert.equal((await get("/chunks/../../server/main.ts")).status, 404);
  assert.equal((await get("/chunks/model-preview.js.map")).status, 404);
  assert.equal((await get("/../server/main.ts")).status, 404);
});
