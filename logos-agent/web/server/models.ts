import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";
import { HttpError, text } from "./errors.ts";

export type Protocol = "openai-completions" | "openai-responses" | "anthropic-messages";
export interface Connection {
  id: string; name: string; baseUrl: string; protocol: Protocol; models: string[];
  enabled: boolean; contextWindow: number; maxTokens: number; reasoning: boolean; version: number; hasKey: boolean;
}
interface Row { id: string; name: string; base_url: string; protocol: Protocol; models: string; enabled: number; context_window: number; max_tokens: number; reasoning: number; version: number; secret: string; }
export class Models {
  readonly store: Store;
  private readonly key: Buffer;
  constructor(store: Store, stateDirectory: string) {
    this.store=store;
    mkdirSync(stateDirectory,{recursive:true,mode:0o700});
    const path = join(stateDirectory, "model-master.key");
    if (!existsSync(path)) {
      try { writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    chmodSync(path, 0o600); this.key = readFileSync(path);
    if (this.key.length !== 32) throw new Error("Invalid model encryption key");
    store.db.exec(`CREATE TABLE IF NOT EXISTS model_connections(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,base_url TEXT NOT NULL,protocol TEXT NOT NULL,
      models TEXT NOT NULL,enabled INTEGER NOT NULL,context_window INTEGER NOT NULL,max_tokens INTEGER NOT NULL,
      reasoning INTEGER NOT NULL,version INTEGER NOT NULL,secret TEXT NOT NULL);`);
  }
  list(): Connection[] { return (this.store.db.prepare("SELECT * FROM model_connections ORDER BY name").all() as unknown as Row[]).map(view); }
  get(id: string): Connection {
    const row = this.row(id);
    if (!row) throw new HttpError(404, "模型连接不存在");
    return view(row);
  }
  secret(id: string): string {
    const row = this.row(id); if (!row) throw new HttpError(404, "模型连接不存在");
    if (!row.secret) return "";
    const [iv, tag, data] = row.secret.split(".").map((v) => Buffer.from(v, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString();
  }
  save(input: Record<string, unknown>): Connection {
    const id = input.id ? text(input.id, "连接 ID", 80) : randomUUID(), old = this.row(id);
    const name = text(input.name, "连接名称", 80), baseUrl = endpoint(text(input.baseUrl, "API 地址", 2048));
    const protocol = input.protocol as Protocol;
    if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(protocol)) throw new HttpError(400, "不支持的模型协议");
    if (!Array.isArray(input.models) || !input.models.length || input.models.length > 100) throw new HttpError(400, "请填写 1–100 个模型 ID");
    const models = [...new Set(input.models.map((v) => text(v, "模型 ID", 200)))];
    const key = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (key.length > 8192 || /[\r\n]/.test(key)) throw new HttpError(400, "API Key 格式无效");
    if (old?.secret && old.base_url !== baseUrl && !key) throw new HttpError(400, "更换 API 地址时请重新填写密钥");
    if (!old && !key) throw new HttpError(400, "请填写 API Key");
    const context = integer(input.contextWindow, 128000, 1024, 4000000), maximum = integer(input.maxTokens, 8192, 128, 200000);
    if (maximum >= context) throw new HttpError(400, "最大输出必须小于上下文窗口");
    const secret = key ? this.encrypt(key) : old?.secret ?? "";
    this.store.db.prepare(`INSERT INTO model_connections VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,protocol=excluded.protocol,
      models=excluded.models,enabled=excluded.enabled,context_window=excluded.context_window,max_tokens=excluded.max_tokens,
      reasoning=excluded.reasoning,version=excluded.version,secret=excluded.secret`)
      .run(id,name,baseUrl,protocol,JSON.stringify(models),Number(input.enabled !== false),context,maximum,Number(input.reasoning === true),(old?.version ?? 0)+1,secret);
    return this.get(id);
  }
  private row(id: string): Row | undefined { return this.store.db.prepare("SELECT * FROM model_connections WHERE id=?").get(id) as unknown as Row | undefined; }
  private encrypt(value: string): string {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(value), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((v) => v.toString("base64")).join(".");
  }
}
function view(row: Row): Connection {
  return { id: row.id, name: row.name, baseUrl: row.base_url, protocol: row.protocol, models: JSON.parse(row.models),
    enabled: Boolean(row.enabled), contextWindow: row.context_window, maxTokens: row.max_tokens, reasoning: Boolean(row.reasoning), version: row.version, hasKey: Boolean(row.secret) };
}
export function endpoint(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new HttpError(400, "API 地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HttpError(400, "API 地址仅支持 HTTP/HTTPS，不能包含凭证或查询参数");
  return url.href.replace(/\/$/, "");
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new HttpError(400, "模型参数超出允许范围");
  return Number(value);
}
