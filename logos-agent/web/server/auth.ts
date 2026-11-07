import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HttpError } from "./errors.ts";
import type { Store, User } from "./store.ts";

export interface Config {
  host: string; port: number; publicUrl: string; data: string; preview: boolean;
  appId: string; appSecret: string; tenant: string; admins: string[]; uploadLimit: number;
}
export function ready(config: Config): boolean { return Boolean(config.appId && config.appSecret && config.tenant); }
export function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries((request.headers.cookie ?? "").split(";").map((s) => s.trim().split("=")).filter((p) => p.length === 2));
}
export function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function cookie(config: Config, name: string, value: string, age: number): string {
  return name + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + age + (config.publicUrl.startsWith("https:") ? "; Secure" : "");
}
export function beginLogin(config: Config, store: Store): { location: string; cookie: string } {
  if (!ready(config)) throw new HttpError(503, "飞书应用尚未配置");
  const state = randomBytes(32).toString("hex"); store.saveState(state);
  const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  url.search = new URLSearchParams({ client_id: config.appId, redirect_uri: config.publicUrl + "/auth/feishu/callback", state }).toString();
  return { location: url.href, cookie: cookie(config, "logos_oauth", state, 600) };
}
type Exchange = typeof fetch;
export async function completeLogin(config: Config, store: Store, code: string, exchange: Exchange = fetch): Promise<User> {
  const response = await exchange("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ grant_type: "authorization_code", client_id: config.appId, client_secret: config.appSecret, code, redirect_uri: config.publicUrl + "/auth/feishu/callback" }),
  });
  const token = await response.json() as { code?: number; access_token?: string };
  if (!response.ok || token.code || !token.access_token) throw new HttpError(502, "飞书授权交换失败，请重新登录");
  const profileResponse = await exchange("https://open.feishu.cn/open-apis/authen/v1/user_info", {
    headers: { Authorization: "Bearer " + token.access_token }, signal: AbortSignal.timeout(15_000),
  });
  const profile = await profileResponse.json() as { code?: number; data?: { tenant_key?: string; open_id?: string; name?: string } };
  const data = profile.data;
  if (!profileResponse.ok || profile.code || !data?.open_id || !data.name || data.tenant_key !== config.tenant) {
    throw new HttpError(403, "此飞书账号不属于允许的企业");
  }
  return store.user(config.appId + ":" + config.tenant + ":" + data.open_id, data.name, config.admins.includes(data.open_id));
}
