import test from "node:test";
import assert from "node:assert/strict";
import { gltfDocument, modelFile, modelResourcePath, modelResources } from "../../ui/model-assets.ts";

test("glTF resources resolve relative filenames and reject external or out-of-project reads", () => {
  assert.equal(modelResourcePath("models/part.gltf", "../textures/paint%20%E7%BA%A2.png"), "textures/paint 红.png");
  assert.equal(modelResourcePath("models/part.gltf", "./part.bin"), "models/part.bin");
  for (const uri of ["../../secret", "%2e%2e/%2e%2e/secret", "https://example.test/image.png", "//host/path", "/etc/passwd", "C:/secret", "file:///secret", "blob:unknown", "data:text/html,hi", "..\\secret", "a?project=other", "%00bad"]) {
    assert.throws(() => modelResourcePath("models/part.gltf", uri), Error, uri);
  }
  assert.throws(() => gltfDocument(new ArrayBuffer(4), true), /GLB/);
});

test("model fetches enforce combined size limits even without Content-Length", async t => {
  const controller = new AbortController(), requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    requests.push(url); assert.equal(options.signal, controller.signal); assert.equal(options.credentials, "same-origin");
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const budget = { bytes: 64 * 1024 * 1024 - 2 };
  await assert.rejects(modelFile("model.stl", "project-a", controller.signal, budget), /64 MiB/);
  assert.match(requests[0], /project=project-a/);
});

test("glTF sidecars use project-scoped reads and object URLs, with no external fetching", async t => {
  const urls: string[] = [], requests: string[] = [], controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (url: string) => { requests.push(url); return new Response(new Uint8Array([1, 2, 3])); });
  try {
    const resources = await modelResources({ buffers: [{ uri: "part.bin" }], images: [{ uri: "../paint.png" }, { uri: "../paint.png" }] }, "models/part.gltf", "project-a", controller.signal, { bytes: 0 }, urls);
    assert.equal(requests.length, 2); assert.equal(urls.length, 2);
    assert.match(resources.get("part.bin")!, /^blob:/); assert.match(requests[0], /path=models%2Fpart.bin&project=project-a/);
    assert.match(requests[1], /path=paint.png&project=project-a/);
    await assert.rejects(modelResources({ images: [{ uri: "https://example.test/tracker" }] }, "part.gltf", "project-a", controller.signal, { bytes: 0 }, urls), /相对路径/);
    assert.equal(requests.length, 2);
  } finally { for (const url of urls) URL.revokeObjectURL(url); }
});
