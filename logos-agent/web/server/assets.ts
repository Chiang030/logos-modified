import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HttpError } from "./errors.ts";

const names: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
};
function acceptsGzip(header = ""): boolean {
  const encodings = header.toLowerCase().split(",").map(part => part.trim().split(";").map(value => value.trim()));
  const entry = encodings.find(([name]) => name === "gzip") ?? encodings.find(([name]) => name === "*");
  if (!entry) return false;
  const quality = entry.slice(1).find(value => value.startsWith("q="));
  return quality === undefined || Number(quality.slice(2)) > 0;
}
async function content(path: string, compressed: boolean): Promise<{ data: Buffer; gzip: boolean }> {
  if (compressed) {
    try { return { data: await readFile(path + ".gz"), gzip: true }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { data: await readFile(path), gzip: false };
}
/** Serve precompressed public application assets with representation-specific validators. */
export async function asset(root: string, pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "请求方法不支持");
  const entry = names[pathname] ?? (/^\/chunks\/[a-zA-Z0-9_-]+\.js$/.test(pathname) ? [pathname.slice(1), "text/javascript; charset=utf-8"] : undefined);
  if (!entry) throw new HttpError(404, "页面不存在");
  const { data, gzip } = await content(resolve(root, entry[0]), acceptsGzip(request.headers["accept-encoding"]));
  const etag = '"' + createHash("sha256").update(data).digest("hex") + '"';
  const headers = { "Content-Type": entry[1], "Cache-Control": "no-cache", Vary: "Accept-Encoding", ETag: etag,
    ...(gzip ? { "Content-Encoding": "gzip" } : {}) };
  const validators = request.headers["if-none-match"]?.split(",").map(value => value.trim().replace(/^W\//, ""));
  if (validators?.some(value => value === etag || value === "*")) { response.writeHead(304, headers); response.end(); return; }
  response.writeHead(200, { ...headers, "Content-Length": data.length });
  response.end(request.method === "HEAD" ? undefined : data);
}
