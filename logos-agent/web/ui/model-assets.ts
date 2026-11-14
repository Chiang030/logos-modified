import { query } from "./api.ts";

const limit = 64 * 1024 * 1024;

/** Resolve glTF sidecars within the selected project, including encoded filenames. */
export function modelResourcePath(model: string, uri: string): string {
  const decoded = decodeURIComponent(uri);
  if (/^[a-z][a-z\d+.-]*:|^[\/\\]|[\\\u0000-\u001f?#]/i.test(decoded)) throw new Error("模型附属文件必须使用项目内的相对路径");
  const parts = model.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (part === "..") { if (!parts.length) throw new Error("模型附属文件超出项目目录"); parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  if (!parts.length) throw new Error("模型附属文件路径无效");
  return parts.join("/");
}

/** Bound the combined model and sidecar download before parsing or allocating a scene. */
export async function modelFile(path: string, project: string, signal: AbortSignal, budget: { bytes: number }): Promise<ArrayBuffer> {
  const response = await fetch("/api/file?" + query(path, project), { credentials: "same-origin", signal });
  if (!response.ok) throw new Error("无法读取模型或附属文件（HTTP " + response.status + "）：" + path);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("模型文件内容为空");
  const chunks: Uint8Array[] = [];
  try {
    if (Number(response.headers.get("content-length")) + budget.bytes > limit) throw new Error("模型及附属文件超过 64 MiB，请简化模型后预览");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.bytes += value.byteLength;
      if (budget.bytes > limit) throw new Error("模型及附属文件超过 64 MiB，请简化模型后预览");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return new Blob(chunks as BlobPart[]).arrayBuffer();
}

interface GltfDocument { buffers?: { uri?: string }[]; images?: { uri?: string }[]; }

/** Read the JSON chunk of either glTF JSON or a GLB 2 container. */
export function gltfDocument(data: ArrayBuffer, binary: boolean): GltfDocument {
  if (!binary) return JSON.parse(new TextDecoder().decode(data)) as GltfDocument;
  const view = new DataView(data);
  if (data.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(16, true) !== 0x4e4f534a) throw new Error("GLB 文件头无效，请导出 glTF 2.0 模型");
  const length = view.getUint32(12, true);
  if (length > data.byteLength - 20) throw new Error("GLB 文件不完整");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, length))) as GltfDocument;
}

/** Prefetch sidecars so every model request shares cancellation and a size budget. */
export async function modelResources(document: GltfDocument, path: string, project: string, signal: AbortSignal, budget: { bytes: number }, urls: string[]): Promise<Map<string, string>> {
  const uris = [...new Set([...(document.buffers ?? []), ...(document.images ?? [])].map(entry => entry.uri).filter((uri): uri is string => uri !== undefined))];
  if (uris.length > 256) throw new Error("模型附属文件过多，请合并为 GLB 后预览");
  const resources = new Map<string, string>();
  for (const uri of uris) {
    if (/^data:(application\/(octet-stream|gltf-buffer)|image\/(png|jpeg|webp));base64,/i.test(uri)) { resources.set(uri, uri); continue; }
    const relative = modelResourcePath(path, uri);
    const data = await modelFile(relative, project, signal, budget);
    signal.throwIfAborted();
    const type = /\.png$/i.test(relative) ? "image/png" : /\.jpe?g$/i.test(relative) ? "image/jpeg" : /\.webp$/i.test(relative) ? "image/webp" : "application/octet-stream";
    const url = URL.createObjectURL(new Blob([data], { type }));
    urls.push(url); resources.set(uri, url);
  }
  return resources;
}
