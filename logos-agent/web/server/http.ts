import type { IncomingMessage, ServerResponse } from "node:http";
import type { FileHandle } from "node:fs/promises";
import { extname, basename } from "node:path";
import { HttpError } from "./errors.ts";

export function json(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}
export async function body(request: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value); size += chunk.length;
    if (size > limit) throw new HttpError(413, "请求过大");
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, "请求 JSON 无效"); }
}
export function failure(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.destroy(); return; }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (["ENOENT", "EACCES", "ENOTDIR", "ELOOP"].includes(code ?? "")) { json(response, { error: "文件不存在或不可访问" }, 404); return; }
  if (error instanceof HttpError) { json(response, { error: error.message }, error.status); return; }
  console.error("LOGOS Web request failed", error instanceof Error ? error.name : "unknown");
  json(response, { error: "请求处理失败，请稍后重试" }, 500);
}
export async function sendFile(request: IncomingMessage, response: ServerResponse, file: FileHandle, name: string, download: boolean): Promise<void> {
  const stat = await file.stat();
  const types: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf",
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
    ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".stl": "model/stl", ".obj": "text/plain", ".ply": "application/octet-stream",
  };
  const type = types[extname(name).toLowerCase()];
  let start = 0, end = stat.size - 1, status = 200;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    }
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
      await file.close(); response.writeHead(416, { "Content-Range": "bytes */" + stat.size, "Accept-Ranges": "bytes" }); response.end(); return;
    }
    status = 206;
  }
  response.writeHead(status, {
    "Content-Type": type ?? "application/octet-stream", "Content-Length": Math.max(0, end - start + 1),
    "Content-Disposition": (download || !type ? "attachment" : "inline") + "; filename*=UTF-8''" + encodeURIComponent(basename(name)),
    "Cache-Control": "no-store", "Accept-Ranges": "bytes",
    ...(status === 206 ? { "Content-Range": "bytes " + start + "-" + end + "/" + stat.size } : {}),
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
  if (!stat.size) { await file.close(); response.end(); return; }
  const stream = file.createReadStream({ start, end, autoClose: true });
  response.on("close", () => stream.destroy());
  stream.on("error", () => response.destroy()); stream.pipe(response);
}
