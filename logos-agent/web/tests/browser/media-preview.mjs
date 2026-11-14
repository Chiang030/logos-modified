// Run with a Playwright Page and a built web origin. All API traffic is mocked.
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

export default async function verifyMediaPreview(page, origin, screenshotPath) {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const recording = await readFile(new URL("../fixtures/preview.webm", import.meta.url));
  const positions = new Float32Array([-1,-1,0, 1,-1,0, 0,1,0, 0,0,1.5]);
  const indices = new Uint16Array([0,1,2, 0,3,1, 1,3,2, 2,3,0]);
  const uv = new Float32Array([0,0, 1,0, 0.5,1, 0.5,0.5]);
  const geometry = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer), Buffer.from(uv.buffer)]);
  const texture = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext("2d"); context.fillStyle = "#78b9d0"; context.fillRect(0, 0, 1, 1);
    return canvas.toDataURL("image/png").split(",")[1];
  }), "base64");
  const document = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 2 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: true }],
    textures: [{ source: 0 }], images: [{ uri: "paint.png" }],
    buffers: [{ uri: "model%20buffer.bin", byteLength: geometry.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }, { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength }, { buffer: 0, byteOffset: positions.byteLength + indices.byteLength, byteLength: uv.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [-1,-1,0], max: [1,1,1.5] }, { bufferView: 1, componentType: 5123, count: indices.length, type: "SCALAR" }, { bufferView: 2, componentType: 5126, count: 4, type: "VEC2" }],
  };
  const binaryDocument = structuredClone(document); delete binaryDocument.buffers[0].uri;
  let json = Buffer.from(JSON.stringify(binaryDocument)); json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const glb = Buffer.alloc(28 + json.length + geometry.length);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(json.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); json.copy(glb, 20);
  glb.writeUInt32LE(geometry.length, 20 + json.length); glb.writeUInt32LE(0x004e4942, 24 + json.length); geometry.copy(glb, 28 + json.length);
  const stl = "solid tetra\n" + Array.from({ length: 4 }, (_, face) => "facet normal 0 0 1\nouter loop\n" + [...indices.slice(face * 3, face * 3 + 3)].map(i => "vertex " + [...positions.slice(i * 3, i * 3 + 3)].join(" ")).join("\n") + "\nendloop\nendfacet\n").join("") + "endsolid tetra";
  const obj = "v -1 -1 0\nv 1 -1 0\nv 0 1 0\nv 0 0 1.5\nf 1 2 3\nf 1 4 2\nf 2 4 3\nf 3 4 1";
  const ply = "ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 4\nproperty list uchar int vertex_indices\nend_header\n-1 -1 0\n1 -1 0\n0 1 0\n0 0 1.5\n3 0 1 2\n3 0 3 1\n3 1 3 2\n3 2 3 0\n";
  const wav = Buffer.alloc(44 + 16000); wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(16000, 40);
  const files = new Map(Object.entries({ "movie.webm": Buffer.from(recording), "sound.wav": wav, "part.STL": Buffer.from(stl), "part.obj": Buffer.from(obj), "part.ply": Buffer.from(ply), "part.glb": glb, "paint.png": texture,
    "part.gltf": Buffer.from(JSON.stringify(document)), "model buffer.bin": geometry, "broken.stl": Buffer.from("broken"), "unsafe.gltf": Buffer.from(JSON.stringify({ ...document, buffers: [{ uri: "../../secret.bin", byteLength: 72 }] })), "notes.txt": Buffer.from("text still works"), "part.step": Buffer.from("STEP") }));
  const reads = [], previews = [], chunks = [], errors = [], mutations = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/chunks/model-preview-")) chunks.push(request.url()); });
  let retry = false;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") mutations.push(url.pathname);
    let data = {};
    if (url.pathname === "/api/bootstrap") data = { user: { id: "media-fixture", name: "Media Test", admin: false }, csrf: "fixture", previewEnabled: false, version: "0.3.15", executionReady: true };
    else if (url.pathname === "/api/projects") data = { projects: [{ id: "media-project", name: "Media Project", directory: "media" }] };
    else if (url.pathname === "/api/files") data = { entries: [...files.keys()].filter(name => !name.endsWith(".bin")).map(name => ({ name, directory: false, size: files.get(name).length, modified: 0 })) };
    else if (url.pathname === "/api/models") data = { models: [], ready: true };
    else if (url.pathname === "/api/sessions") data = { sessions: [] };
    else if (url.pathname === "/api/runs") data = { runs: [], ready: true };
    else if (url.pathname === "/api/events") data = { events: [] };
    else if (url.pathname === "/api/preview") { previews.push(url.searchParams.get("path")); data = { text: "text still works", truncated: false }; }
    else if (url.pathname === "/api/file") {
      const path = url.searchParams.get("path"); reads.push({ path, project: url.searchParams.get("project") });
      const content = path === "broken.stl" && retry ? Buffer.from(stl) : files.get(path);
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), content.length - 1) : (content?.length ?? 0) - 1;
      await route.fulfill({ status: !content ? 404 : range ? 206 : 200, contentType: path.endsWith(".webm") ? "video/webm" : path.endsWith(".wav") ? "audio/wav" : "application/octet-stream",
        headers: { "Accept-Ranges": "bytes", ...(range && content ? { "Content-Range": `bytes ${start}-${end}/${content.length}` } : {}) }, body: content?.subarray(start, end + 1) ?? "not found" }); return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  try {
    await page.goto(origin); await page.locator(".project-switcher").getByRole("button", { name: "Media Project", exact: false }).click();
    const open = async name => { await page.locator(".file-list").getByRole("button", { name, exact: false }).click(); await page.locator(".preview-panel").waitFor(); };
    await open("movie.webm"); check(chunks.length === 0, "3D viewer loaded before a model was selected");
    await page.waitForFunction(() => document.querySelector("video")?.readyState >= 1).catch(async error => {
      throw new Error(error.message + " " + JSON.stringify({ reads, bytes: recording.length, state: await page.locator("video").evaluate(video => ({ ready: video.readyState, network: video.networkState, error: video.error?.message, src: video.currentSrc, html: video.outerHTML })) }));
    });
    const played = await page.locator("video").evaluate(async video => { await video.play(); await new Promise(resolve => setTimeout(resolve, 350)); video.pause(); return video.currentTime; });
    check(played > 0, "Video did not play");
    await page.locator("video").evaluate(video => new Promise(resolve => { video.addEventListener("seeked", resolve, { once: true }); video.currentTime = 0.7; }));
    check(await page.locator("video").evaluate(video => video.currentTime) > 0.65, "Video seek failed: " + await page.locator("video").evaluate(video => JSON.stringify({ time: video.currentTime, duration: video.duration, ranges: Array.from({ length: video.seekable.length }, (_, i) => [video.seekable.start(i), video.seekable.end(i)]) })));
    await open("sound.wav"); await page.waitForFunction(() => document.querySelector("audio")?.readyState >= 1);
    check(await page.locator("video").count() === 0, "Previous video remains mounted");
    for (const name of ["part.STL", "part.obj", "part.ply", "part.glb", "part.gltf"]) {
      await open(name); await page.getByRole("button", { name: "复位视角", exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector(".model-actions button")?.disabled);
      check(await page.locator(".model-viewport canvas").count() === 1, "Model did not render: " + name);
      const box = await page.locator(".model-viewport canvas").boundingBox();
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 5 }); await page.mouse.up();
      await page.mouse.wheel(0, 120); await page.getByRole("button", { name: "复位视角", exact: true }).click();
    }
    check(chunks.length > 0, "3D chunk was not loaded"); check(reads.some(read => read.path === "model buffer.bin"), "glTF sidecar was not read");
    check(reads.some(read => read.path === "paint.png"), "glTF texture was not read");
    if (screenshotPath) await page.screenshot({ path: screenshotPath });
    await open("unsafe.gltf"); await page.getByRole("alert").filter({ hasText: "超出项目目录" }).waitFor();
    check(!reads.some(read => read.path?.includes("secret")), "Unsafe sidecar was requested");
    await open("broken.stl"); await page.getByRole("alert").filter({ hasText: "无法预览模型" }).waitFor();
    retry = true; await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".model-actions button")?.disabled);
    await page.getByRole("button", { name: "关闭文件预览", exact: true }).click(); check(await page.locator("canvas").count() === 0, "Canvas persists after closing");
    await open("part.step"); await page.getByRole("button", { name: "生成 3D 预览", exact: true }).waitFor();
    check(previews.length === 0, "Binary media was sent to text preview");
    await open("notes.txt"); await page.getByText("text still works", { exact: true }).waitFor();
    check(reads.every(read => read.project === "media-project"), "A resource lost its project scope");
    check(errors.length === 0, "Unhandled browser errors: " + errors.join("; ")); check(mutations.length === 0, "Preview mutated server data");
    return { passed: true, videoPlayed: true, videoSeeked: true, modelFormats: 5, sidecars: true, rejectedTraversal: true, retry: true, chunks: chunks.length };
  } finally { await page.unrouteAll({ behavior: "wait" }); }
}
