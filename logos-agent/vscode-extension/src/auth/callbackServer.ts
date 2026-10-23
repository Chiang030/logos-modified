import { createServer, type Server, type ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauthPage";

export interface AuthorizationResult {
  code: string;
  clientId: string;
}

export interface CallbackServer {
  server: Server;
  result: Promise<AuthorizationResult>;
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

export function authorizationResultFromCallback(url: URL, expectedState: string): AuthorizationResult {
  const code = url.searchParams.get("code");
  if (!code) throw new Error("缺少授权码（code）。");
  const state = url.searchParams.get("state");
  if (!state) throw new Error("缺少 OAuth state。");
  if (state !== expectedState) throw new Error("OAuth state 不匹配。");
  const clientId = url.searchParams.get("client_id")?.trim();
  if (!clientId) throw new Error("OpenAI 回调中没有返回已注册的 client ID。");
  return { code, clientId };
}

/**
 * Loopback HTTP server that receives the browser's OAuth callback on `redirectUri`.
 * Resolves with the authorization result, or rejects when the browser reports an error.
 */
export function startCallbackServer(expectedState: string, redirectUri: URL): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let resolveResult!: (result: AuthorizationResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<AuthorizationResult>((resolveAuthorization, rejectAuthorization) => {
      resolveResult = resolveAuthorization;
      rejectResult = rejectAuthorization;
    });

    const server = createServer((request, response) => {
      try {
        const url = new URL(request.url || "", redirectUri);
        if (url.pathname !== redirectUri.pathname) {
          sendHtml(response, 404, oauthErrorHtml("回调路由不存在。"));
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          sendHtml(response, 400, oauthErrorHtml("ChatGPT 未完成连接。", `Error: ${error}`));
          rejectResult(new Error(`ChatGPT 授权失败：${error}`));
          return;
        }
        try {
          const authorizationResult = authorizationResultFromCallback(url, expectedState);
          sendHtml(response, 200, oauthSuccessHtml("ChatGPT 登录完成，可以关闭此窗口。"));
          resolveResult(authorizationResult);
        } catch (error) {
          const message = error instanceof Error ? error.message : "无效的回调。";
          sendHtml(response, 400, oauthErrorHtml(message));
        }
      } catch {
        sendHtml(response, 500, oauthErrorHtml("处理回调时发生内部错误。"));
      }
    });

    server.once("error", reject);
    server.listen(Number(redirectUri.port), redirectUri.hostname, () => {
      server.removeListener("error", reject);
      server.on("error", rejectResult);
      resolve({ server, result });
    });
  });
}
