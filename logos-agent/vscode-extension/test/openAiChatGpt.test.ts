import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { authorizationResultFromManualInput } from "../src/auth/openAiChatGpt";
import { authorizationResultFromCallback, startCallbackServer } from "../src/auth/callbackServer";
import { generatePKCE } from "../src/auth/pkce";
import { loginOpenAiChatGPT, refreshOpenAiCredential, type ChatGptLoginInteraction, type OpenAiOAuthEndpoints } from "../src/auth/openAiChatGpt";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }))); });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function listen(server: Server): Promise<void> {
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done()));
}

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  return address.port;
}

function tokenServer(responses: Array<Record<string, unknown>>): { server: Server; bodies: URLSearchParams[] } {
  const bodies: URLSearchParams[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(new URLSearchParams(Buffer.concat(chunks).toString()));
      const payload = responses.shift() ?? { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, id_token: "id-token",
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" };
      response.statusCode = (payload.httpStatus as number | undefined) ?? 200;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(payload));
    });
  });
  return { server, bodies };
}

function interaction(captured: { url?: string }): ChatGptLoginInteraction {
  return {
    signal: new AbortController().signal,
    openExternal: async () => true,
    notify: (event) => { if (event.type === "url") captured.url = event.url; },
    manualCallbackUrl: () => new Promise<string>(() => undefined),
  };
}

async function waitForUrl(captured: { url?: string }): Promise<string> {
  for (let attempt = 0; attempt < 100 && !captured.url; attempt++) await sleep(10);
  if (!captured.url) throw new Error("authorize URL was not notified");
  return captured.url;
}

describe("PKCE", () => {
  it("generates a verifier with a matching S256 challenge", async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });
});

describe("manual callback input", () => {
  const redirect = new URL("http://127.0.0.1:1455/auth/callback");
  it("accepts a well-formed callback URL", () => {
    expect(authorizationResultFromManualInput("http://127.0.0.1:1455/auth/callback?code=c&state=s&client_id=ci", "s", redirect)).toEqual({ code: "c", clientId: "ci" });
  });
  it("rejects foreign origins, broken input and error callbacks", () => {
    expect(() => authorizationResultFromManualInput("http://evil.example/auth/callback?code=c&state=s", "s", redirect)).toThrow("回调 URL");
    expect(() => authorizationResultFromManualInput("not a url", "s", redirect)).toThrow("回调 URL");
    expect(() => authorizationResultFromManualInput("http://127.0.0.1:1455/auth/callback?error=access_denied&state=s", "s", redirect)).toThrow("access_denied");
    expect(() => authorizationResultFromManualInput("http://127.0.0.1:1455/auth/callback?code=c&state=s", "s", redirect)).toThrow("client ID");
  });
});

describe("loopback callback server", () => {
  it("resolves on a matching callback and stays pending on state mismatch", async () => {
    const callback = await startCallbackServer("state-1", new URL("http://127.0.0.1:0/auth/callback"));
    servers.push(callback.server);
    const port = portOf(callback.server);
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/auth/callback?code=c&state=wrong&client_id=ci`)).status).toBe(400);
    expect(await Promise.race([callback.result.then(() => "resolved"), sleep(50).then(() => "pending")])).toBe("pending");
    expect((await fetch(`http://127.0.0.1:${port}/auth/callback?code=c&state=state-1&client_id=ci`)).status).toBe(200);
    expect(await callback.result).toEqual({ code: "c", clientId: "ci" });
  });
  it("validates the callback query", () => {
    expect(() => authorizationResultFromCallback(new URL("http://127.0.0.1:1455/auth/callback?state=s&client_id=ci"), "s")).toThrow("授权码");
    expect(() => authorizationResultFromCallback(new URL("http://127.0.0.1:1455/auth/callback?code=c&state=s"), "s")).toThrow("client ID");
  });
});

describe("ChatGPT login flow", () => {
  it("completes against local endpoints and returns a rotated-ready credential", async () => {
    const tokens = tokenServer([]);
    await listen(tokens.server);
    servers.push(tokens.server);
    const loopback = createServer();
    await listen(loopback);
    const loopbackPort = portOf(loopback);
    await new Promise<void>((done) => loopback.close(() => done()));
    const endpoints: OpenAiOAuthEndpoints = {
      authorizeUrl: "https://auth.example.test/authorize",
      tokenUrl: `http://127.0.0.1:${portOf(tokens.server)}/token`,
      redirectUri: `http://127.0.0.1:${loopbackPort}/auth/callback`,
    };
    const captured: { url?: string } = {};
    const login = loginOpenAiChatGPT(randomUUID(), interaction(captured), endpoints);
    const authorizeUrl = new URL(await waitForUrl(captured));
    expect(authorizeUrl.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorizeUrl.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(endpoints.redirectUri);
    const response = await fetch(`${endpoints.redirectUri}?code=auth-code&state=${authorizeUrl.searchParams.get("state")}&client_id=issued-client-id`);
    expect(response.status).toBe(200);
    const credential = await login;
    expect(credential).toMatchObject({ access: "access-1", refresh: "refresh-1", clientId: "issued-client-id" });
    expect(credential.expires).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
    expect(tokens.bodies[0].get("grant_type")).toBe("authorization_code");
    expect(tokens.bodies[0].get("code")).toBe("auth-code");
    expect(tokens.bodies[0].get("code_verifier")).toBeTruthy();
    expect(tokens.bodies[0].get("resource")).toBe("https://api.openai.com/v1");
  });
  it("rejects with a clear Chinese error when the callback port is occupied", async () => {
    const blocker = createServer();
    await listen(blocker);
    servers.push(blocker);
    const endpoints: OpenAiOAuthEndpoints = {
      authorizeUrl: "https://auth.example.test/authorize",
      tokenUrl: "http://127.0.0.1:9/token",
      redirectUri: `http://127.0.0.1:${portOf(blocker)}/auth/callback`,
    };
    await expect(loginOpenAiChatGPT(randomUUID(), interaction({}), endpoints)).rejects.toThrow("端口");
  });
  it("refreshes with the refresh-token grant and rotates tokens", async () => {
    const tokens = tokenServer([{ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, id_token: "id-token",
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" }]);
    await listen(tokens.server);
    servers.push(tokens.server);
    const next = await refreshOpenAiCredential({ type: "oauth", access: "access-1", refresh: "refresh-1", expires: 0, clientId: "ci", scopes: [] }, undefined,
      { authorizeUrl: "https://auth.example.test/authorize", tokenUrl: `http://127.0.0.1:${portOf(tokens.server)}/token`, redirectUri: "http://127.0.0.1:1/auth/callback" });
    expect(next).toMatchObject({ access: "access-2", refresh: "refresh-2", clientId: "ci" });
    expect(tokens.bodies[0].get("grant_type")).toBe("refresh_token");
    expect(tokens.bodies[0].get("refresh_token")).toBe("refresh-1");
  });
});
