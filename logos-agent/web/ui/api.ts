export interface User { id: string; name: string; admin: boolean; }
export interface Project { id: string; name: string; directory: string; }
export interface Conversation { id: string; title: string; project: string; }
export interface Entry { name: string; directory: boolean; size: number; modified: number; }
export interface Bootstrap { user: User | null; csrf?: string; feishuReady: boolean; identityLabel?: string; previewEnabled: boolean; version: string; executionReady: boolean; executionReason: string; }
let csrf = "";
export function setCsrf(value: string): void { csrf = value; }
export async function api<T>(path: string, value?: unknown, method = value === undefined ? "GET" : "POST"): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", headers: { ...(value === undefined ? {} : { "Content-Type": "application/json" }), "X-CSRF-Token": csrf }, body: value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "请求失败");
  return result as T;
}
export async function upload(path: string, file: File): Promise<void> {
  const response = await fetch("/api/upload?path=" + encodeURIComponent(path), { method: "PUT", credentials: "same-origin", headers: { "X-CSRF-Token": csrf }, body: file });
  if (!response.ok) throw new Error((await response.json()).error ?? "上传失败");
}
export function query(path: string, project?: string): string { return new URLSearchParams({ path, ...(project ? { project } : {}) }).toString(); }
