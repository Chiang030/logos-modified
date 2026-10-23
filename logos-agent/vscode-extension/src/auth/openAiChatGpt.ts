import { randomBytes } from "node:crypto";
import { authorizationResultFromCallback, startCallbackServer, type AuthorizationResult } from "./callbackServer";
import type { OAuthCredential } from "./oauthCredential";
import { generatePKCE } from "./pkce";

// Ported from vendor/pi/packages/ai/src/auth/oauth/openai-chatgpt.ts ("Sign in with ChatGPT",
// OpenAI's agent token sharing). The runtime copy is frozen inside the packaged vsix, so the
// extension host carries its own adaptation with a webview-driven interaction surface.

const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME_HINT = "LOGOS";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE = "https://api.openai.com/v1";
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
// Refresh well before the real expiry so a request never starts with a token about to expire.
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;

export interface OpenAiOAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
}

export const OPENAI_OAUTH_ENDPOINTS: OpenAiOAuthEndpoints = {
  authorizeUrl: "https://auth.openai.com/api/accounts/authorize",
  tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
  redirectUri: "http://127.0.0.1:1455/auth/callback",
};

export type ChatGptLoginEvent = { type: "url"; url: string } | { type: "exchanging" };

/** Browser-login interaction driven by the webview through the extension host. */
export interface ChatGptLoginInteraction {
  signal: AbortSignal;
  openExternal(url: string): PromiseLike<boolean>;
  notify(event: ChatGptLoginEvent): void;
  /** User-pasted final redirect URL; rejects on cancel. Loser of the race is discarded. */
  manualCallbackUrl(): Promise<string>;
}

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  scope?: unknown;
};

/** Token endpoint rejection carrying the HTTP status, so callers can tell revoked from transient. */
export class OAuthHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function randomValue(): string {
  return randomBytes(32).toString("base64url");
}

function agentHostId(deviceId: string): string {
  if (!UUID_PATTERN.test(deviceId)) {
    throw new Error("ChatGPT 登录需要本安装的设备 ID（UUID）。");
  }
  return `urn:uuid:${deviceId.toLowerCase()}`;
}

export function authorizationResultFromManualInput(input: string, expectedState: string, redirectUri: URL): AuthorizationResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("请粘贴浏览器地址栏中的完整回调 URL。");
  }
  if (url.origin !== redirectUri.origin || url.pathname !== redirectUri.pathname) {
    throw new Error(`回调 URL 必须以 ${redirectUri.origin}${redirectUri.pathname} 开头。`);
  }
  if (url.searchParams.get("error")) throw new Error(`ChatGPT 授权失败：${url.searchParams.get("error")}`);
  return authorizationResultFromCallback(url, expectedState);
}

function buildAuthorizeUrl(state: string, challenge: string, nonce: string, hostId: string, endpoints: OpenAiOAuthEndpoints): URL {
  const authorizationUrl = new URL(endpoints.authorizeUrl);
  authorizationUrl.search = new URLSearchParams({
    client_id: DYNAMIC_CLIENT_ID,
    agent_name_hint: AGENT_NAME_HINT,
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: endpoints.redirectUri,
    resource: RESOURCE,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce,
  }).toString();
  return authorizationUrl;
}

async function requestToken(tokenUrl: string, body: URLSearchParams, signal: AbortSignal): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new Error("登录已取消。");
    throw new Error(`无法连接 OpenAI 登录服务（${error instanceof Error ? error.message : String(error)}），请检查网络后重试。`);
  }
  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw new OAuthHttpError(`OpenAI 登录服务返回错误（HTTP ${response.status}）：${responseBody || response.statusText}`, response.status);
  }
  const data: unknown = await response.json().catch(() => {
    throw new Error("OpenAI 登录服务没有返回有效 JSON。");
  });
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("OpenAI 登录服务的响应格式不受支持。");
  }
  return data as TokenResponse;
}

function requireTokenString(value: unknown, field: "access_token" | "refresh_token" | "scope"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`OpenAI 登录服务的 token 响应缺少有效的 ${field}。`);
  }
  return value;
}

function credentialFromTokenResponse(token: TokenResponse, clientId: string): OAuthCredential {
  const access = requireTokenString(token.access_token, "access_token");
  const refresh = requireTokenString(token.refresh_token, "refresh_token");
  const scope = requireTokenString(token.scope, "scope");
  if (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new Error("OpenAI 登录服务的 token 响应缺少有效的 expires_in。");
  }
  const scopes = scope.trim().split(/\s+/).filter(Boolean);
  if (!scopes.includes(DIRECT_TOKEN_SCOPE)) {
    throw new Error(`OpenAI 授权未包含 ${DIRECT_TOKEN_SCOPE} 权限。`);
  }
  return { type: "oauth", access, refresh, expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS, clientId, scopes };
}

async function exchangeAuthorizationCode(result: AuthorizationResult, verifier: string, endpoints: OpenAiOAuthEndpoints, signal: AbortSignal): Promise<OAuthCredential> {
  const token = await requestToken(endpoints.tokenUrl, new URLSearchParams({
    grant_type: "authorization_code",
    client_id: result.clientId,
    code: result.code,
    code_verifier: verifier,
    redirect_uri: endpoints.redirectUri,
    resource: RESOURCE,
  }), signal);
  // The ID token is not used to identify the user; keep the presence check as part of the contract.
  if (typeof token.id_token !== "string" || token.id_token.trim().length === 0) {
    throw new Error("OpenAI 登录服务的 token 响应缺少 ID token。");
  }
  return credentialFromTokenResponse(token, result.clientId);
}

export async function refreshOpenAiCredential(credential: OAuthCredential, signal?: AbortSignal, endpoints: OpenAiOAuthEndpoints = OPENAI_OAUTH_ENDPOINTS): Promise<OAuthCredential> {
  const clientId = credential.clientId;
  if (!clientId.trim()) throw new Error("已保存的 ChatGPT 凭据缺少 client ID，请重新登录。");
  const token = await requestToken(endpoints.tokenUrl, new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: credential.refresh,
    resource: RESOURCE,
  }), signal ?? new AbortController().signal);
  return credentialFromTokenResponse(token, clientId);
}

/** Run the full browser login: loopback callback raced against a pasted callback URL. */
export async function loginOpenAiChatGPT(deviceId: string, interaction: ChatGptLoginInteraction, endpoints: OpenAiOAuthEndpoints = OPENAI_OAUTH_ENDPOINTS): Promise<OAuthCredential> {
  const hostId = agentHostId(deviceId);
  const { verifier, challenge } = await generatePKCE();
  const state = randomValue();
  const nonce = randomValue();
  const redirectUri = new URL(endpoints.redirectUri);
  // Without this server, the browser's callback would reach whatever else holds the port
  // (another pending login or the Codex CLI), which rejects it as a state mismatch.
  const callback = await startCallbackServer(state, redirectUri).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
    const msg = `端口 ${redirectUri.port} 被占用，可能被 Codex CLI 或其他未完成的登录占用，请先完成或取消后重试。`;
    throw new Error(msg);
  });

  const authorizationUrl = buildAuthorizeUrl(state, challenge, nonce, hostId, endpoints);
  interaction.notify({ type: "url", url: authorizationUrl.toString() });
  await interaction.openExternal(authorizationUrl.toString());

  const manualCode = interaction.manualCallbackUrl().then((input) => authorizationResultFromManualInput(input, state, redirectUri));
  manualCode.catch(() => undefined); // Loser of the race is discarded silently.
  try {
    const result = await Promise.race([callback.result, manualCode]);
    interaction.notify({ type: "exchanging" });
    return await exchangeAuthorizationCode(result, verifier, endpoints, interaction.signal);
  } catch (error) {
    if (interaction.signal.aborted) throw new Error("登录已取消。");
    throw error;
  } finally {
    callback.server.close();
    // close() only stops accepting new connections. Browsers open spare connections ahead of
    // time, and one that has not sent a request yet stays open and attached to this server,
    // so a later login could see its callback rejected as a state mismatch over such a socket.
    callback.server.closeAllConnections();
  }
}
