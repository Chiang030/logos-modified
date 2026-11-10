import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import type { OAuthCredential } from "../../vscode-extension/src/auth/oauthCredential.ts";
import type { Models } from "./models.ts";
import { HttpError } from "./errors.ts";
import { openAiFetch } from "./openai-fetch.ts";

interface Interaction {
  signal: AbortSignal;
  openExternal(url: string): PromiseLike<boolean>;
  notify(event: { type: "url"; url: string } | { type: "exchanging" }): void;
  manualCallbackUrl(): Promise<string>;
}
export interface OpenAiDriver {
  loginOpenAiChatGPT(deviceId: string, interaction: Interaction): Promise<OAuthCredential>;
  refreshOpenAiCredential(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;
  authorizationResultFromManualInput(input: string, state: string, redirect: URL): unknown;
}
interface Pending {
  id: string; owner: string; expires: number; state: string; phase: string; message?: string; url?: string;
  resolve(value: string): void; reject(error: Error): void; controller: AbortController; timer: ReturnType<typeof setTimeout>; completion: Promise<void>;
}
interface AccountRow { secret: string; revision: number; lock_owner: string; lock_until: number; device: string; }

let driver: Promise<OpenAiDriver> | undefined;
function loadDriver(): Promise<OpenAiDriver> {
  return driver ??= import(new URL("../dist/openai-auth.mjs", import.meta.url).href) as Promise<OpenAiDriver>;
}
function safeError(error: unknown): string {
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  return typeof status === "number" ? `OpenAI 授权服务返回 HTTP ${status}，请重新授权或检查账号权限` : "无法完成 OpenAI 授权，请检查服务器网络后重试";
}

/** One encrypted administrator account, with database leases for token rotation across services. */
export class OpenAiAccount {
  private readonly pending = new Map<string, Pending>();
  private readonly models: Models;
  private readonly getDriver: () => Promise<OpenAiDriver>;
  constructor(models: Models, getDriver: () => Promise<OpenAiDriver> = loadDriver) {
    this.models = models; this.getDriver = getDriver;
    models.store.db.exec(`CREATE TABLE IF NOT EXISTS openai_account(
      id INTEGER PRIMARY KEY CHECK(id=1),secret TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0,
      lock_owner TEXT NOT NULL DEFAULT '',lock_until INTEGER NOT NULL DEFAULT 0,device TEXT NOT NULL);`);
    models.store.db.prepare("INSERT OR IGNORE INTO openai_account(id,device) VALUES(1,?)").run(randomUUID());
  }
  status(): { connected: boolean; expires?: number; expired?: boolean } {
    const credential = this.credential();
    return credential ? { connected: true, expires: credential.expires, expired: credential.expires <= Date.now() } : { connected: false };
  }
  private row(): AccountRow { return this.models.store.db.prepare("SELECT * FROM openai_account WHERE id=1").get() as unknown as AccountRow; }
  private credential(row = this.row()): OAuthCredential | undefined {
    return row.secret ? JSON.parse(this.models.decodeSecret(row.secret)) as OAuthCredential : undefined;
  }
  private save(credential: OAuthCredential): void {
    this.models.store.db.prepare("UPDATE openai_account SET secret=?,revision=revision+1,lock_owner='',lock_until=0 WHERE id=1")
      .run(this.models.encodeSecret(JSON.stringify(credential)));
  }
  logout(): void {
    for (const attempt of this.pending.values()) this.stop(attempt);
    this.models.store.db.prepare("UPDATE openai_account SET secret='',revision=revision+1,lock_owner='',lock_until=0 WHERE id=1").run();
  }
  async listModels(): Promise<string[]> {
    const token = await this.accessToken();
    const response = await openAiFetch("https://api.openai.com/v1/models", { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, "OpenAI 模型列表返回 HTTP " + response.status); }
    const data = await response.json() as { data?: { id?: unknown }[] };
    const catalog = JSON.parse(await readFile(new URL("../../../vendor/pi/packages/ai/src/providers/data/openai.json", import.meta.url), "utf8")) as Record<string, Record<string, { id: string; type: string }>>;
    const supported = new Set(Object.values(catalog["openai-responses"] ?? {}).filter(model => model.type === "chat").map(model => model.id));
    return (data.data ?? []).map(model => model.id).filter((id): id is string => typeof id === "string" && supported.has(id)).slice(0,100);
  }
  async accessToken(): Promise<string> {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const row = this.row(), credential = this.credential(row);
      if (!credential) throw new HttpError(409, "管理员尚未登录 ChatGPT，或授权已失效，请到管理后台重新登录");
      if (credential.expires > Date.now()) return credential.access;
      const owner = randomUUID();
      const claimed = this.models.store.db.prepare("UPDATE openai_account SET lock_owner=?,lock_until=? WHERE id=1 AND revision=? AND lock_until<?")
        .run(owner, Date.now() + 35_000, row.revision, Date.now());
      if (!claimed.changes) { await delay(100); continue; }
      try {
        const refreshed = await (await this.getDriver()).refreshOpenAiCredential(credential, AbortSignal.timeout(30_000));
        const saved = this.models.store.db.prepare("UPDATE openai_account SET secret=?,revision=revision+1,lock_owner='',lock_until=0 WHERE id=1 AND revision=? AND lock_owner=?")
          .run(this.models.encodeSecret(JSON.stringify(refreshed)), row.revision, owner);
        if (saved.changes) return refreshed.access;
      } catch (error) {
        const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
        if (status === 400 || status === 401) {
          this.models.store.db.prepare("UPDATE openai_account SET secret='',revision=revision+1 WHERE id=1 AND revision=? AND lock_owner=?").run(row.revision, owner);
        }
        throw new HttpError(502, safeError(error));
      } finally {
        this.models.store.db.prepare("UPDATE openai_account SET lock_owner='',lock_until=0 WHERE id=1 AND lock_owner=?").run(owner);
      }
    }
    throw new HttpError(503, "ChatGPT 凭据正在刷新，请稍后重试");
  }
  async begin(owner: string): Promise<unknown> {
    for (const attempt of this.pending.values()) {
      if (attempt.owner === owner || attempt.expires <= Date.now()) { this.stop(attempt); await attempt.completion; }
      else if (["starting", "waiting", "exchanging"].includes(attempt.phase)) throw new HttpError(409, "另一位管理员正在授权，请稍后重试");
    }
    const auth = await this.getDriver();
    let resolve!: (value: string) => void, reject!: (error: Error) => void;
    const manual = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    manual.catch(() => undefined);
    let ready!: () => void;
    const available = new Promise<void>(yes => { ready = yes; });
    const attempt: Pending = { id: randomUUID(), owner, expires: Date.now() + 10 * 60_000, state: "", phase: "starting", resolve, reject,
      controller: new AbortController(), timer: setTimeout(() => undefined, 0), completion: Promise.resolve() };
    attempt.timer = setTimeout(() => this.stop(attempt), 10 * 60_000); attempt.timer.unref();
    this.pending.set(attempt.id, attempt);
    attempt.completion = auth.loginOpenAiChatGPT(this.row().device, {
      signal: attempt.controller.signal, openExternal: async () => true, manualCallbackUrl: () => manual,
      notify: event => {
        if (event.type === "url") { attempt.url = event.url; attempt.state = new URL(event.url).searchParams.get("state") ?? ""; attempt.phase = "waiting"; ready(); }
        else attempt.phase = "exchanging";
      },
    }).then(credential => {
      if (attempt.controller.signal.aborted || !this.pending.has(attempt.id)) return;
      this.save(credential); attempt.phase = "completed";
    }).catch(error => { if (attempt.phase !== "cancelled") { attempt.phase = "failed"; attempt.message = safeError(error); } })
      .finally(() => { clearTimeout(attempt.timer); attempt.timer = setTimeout(() => this.pending.delete(attempt.id), 10 * 60_000); attempt.timer.unref(); ready(); });
    await available;
    return this.progress(owner, attempt.id);
  }
  progress(owner: string, id: string): unknown {
    const attempt = this.attempt(owner, id);
    return { id, phase: attempt.phase, url: attempt.url, expires: attempt.expires, message: attempt.message, ...this.status() };
  }
  async complete(owner: string, id: string, callback: string): Promise<unknown> {
    const attempt = this.attempt(owner, id);
    if (attempt.phase !== "waiting") throw new HttpError(409, "此授权请求已处理，请重新发起登录");
    try { (await this.getDriver()).authorizationResultFromManualInput(callback, attempt.state, new URL("http://127.0.0.1:1455/auth/callback")); }
    catch { throw new HttpError(400, "授权回调地址无效或不属于当前登录，请从本次授权页面复制完整地址"); }
    attempt.phase = "exchanging"; attempt.resolve(callback);
    await attempt.completion;
    return this.progress(owner, id);
  }
  cancel(owner: string, id: string): void { this.stop(this.attempt(owner, id)); }
  private attempt(owner: string, id: string): Pending {
    const attempt = this.pending.get(id);
    if (!attempt || attempt.owner !== owner) throw new HttpError(404, "授权请求不存在");
    if (Date.now() > attempt.expires) { this.stop(attempt); throw new HttpError(410, "授权请求已过期，请重新登录"); }
    return attempt;
  }
  private stop(attempt: Pending): void {
    attempt.phase = "cancelled"; attempt.controller.abort(); attempt.reject(new Error("Cancelled"));
    clearTimeout(attempt.timer); this.pending.delete(attempt.id);
  }
}
