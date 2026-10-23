import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAiAuthStore } from "../src/auth/openAiAuthStore";
import type { OAuthCredential } from "../src/auth/oauthCredential";
import type { OpenAiOAuthEndpoints } from "../src/auth/openAiChatGpt";

const SECRET_KEY = "logos.openAiOAuth";
const DEVICE_ID_KEY = "logos.openai.deviceId";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }))); });

function harness(endpoints?: OpenAiOAuthEndpoints) {
  const secrets = new Map<string, string>();
  const state = new Map<string, unknown>();
  const storeFor = (storeEndpoints?: OpenAiOAuthEndpoints) => new OpenAiAuthStore(
    { get: async (key) => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async (key) => { secrets.delete(key); } },
    { get: <T,>(key: string) => state.get(key) as T | undefined, update: async (key: string, value: unknown) => { state.set(key, value); } },
    storeEndpoints,
  );
  return { secrets, state, store: storeFor(endpoints), storeFor };
}

function credential(overrides: Partial<OAuthCredential>): OAuthCredential {
  return { type: "oauth", access: "access-1", refresh: "refresh-1", expires: Date.now() + 3600_000, clientId: "ci", scopes: SCOPE.split(" "), ...overrides };
}

async function startTokens(responses: Array<Record<string, unknown>>): Promise<{ endpoints: OpenAiOAuthEndpoints }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const payload = responses.shift() ?? { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, id_token: "id-token", scope: SCOPE };
      response.statusCode = (payload.httpStatus as number | undefined) ?? 200;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(payload));
    });
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve(address.port);
  }));
  servers.push(server);
  return { endpoints: { authorizeUrl: "https://auth.example.test/authorize", tokenUrl: `http://127.0.0.1:${port}/token`, redirectUri: "http://127.0.0.1:1/auth/callback" } };
}

describe("OpenAI auth store", () => {
  it("returns the cached access token before expiry", async () => {
    const { secrets, store } = harness();
    secrets.set(SECRET_KEY, JSON.stringify(credential({})));
    expect(await store.hasCredential()).toBe(true);
    expect(await store.currentAccessToken()).toBe("access-1");
  });
  it("refreshes an expired credential and persists the rotation", async () => {
    const base = harness();
    base.secrets.set(SECRET_KEY, JSON.stringify(credential({ expires: Date.now() - 1000 })));
    const { endpoints } = await startTokens([]);
    const store = base.storeFor(endpoints);
    expect(await store.currentAccessToken()).toBe("access-2");
    expect(JSON.parse(base.secrets.get(SECRET_KEY) ?? "{}").refresh).toBe("refresh-2");
  });
  it("drops the credential and asks for a fresh login when the grant is revoked", async () => {
    const base = harness();
    base.secrets.set(SECRET_KEY, JSON.stringify(credential({ expires: Date.now() - 1000 })));
    const { endpoints } = await startTokens([{ httpStatus: 400, error: "invalid_grant" }]);
    const store = base.storeFor(endpoints);
    await expect(store.currentAccessToken()).rejects.toThrow("ChatGPT 登录已失效");
    expect(base.secrets.has(SECRET_KEY)).toBe(false);
    expect(await store.hasCredential()).toBe(false);
  });
  it("keeps the credential on transient network failures", async () => {
    const base = harness();
    base.secrets.set(SECRET_KEY, JSON.stringify(credential({ expires: Date.now() - 1000 })));
    const store = base.storeFor({ authorizeUrl: "https://auth.example.test/authorize", tokenUrl: "http://127.0.0.1:9/token", redirectUri: "http://127.0.0.1:1/auth/callback" });
    await expect(store.currentAccessToken()).rejects.toThrow("无法连接");
    expect(base.secrets.has(SECRET_KEY)).toBe(true);
  });
  it("logs out by deleting only the OAuth secret", async () => {
    const { secrets, state, store } = harness();
    secrets.set(SECRET_KEY, JSON.stringify(credential({})));
    state.set(DEVICE_ID_KEY, randomUUID());
    await store.logout();
    expect(secrets.has(SECRET_KEY)).toBe(false);
    expect(state.has(DEVICE_ID_KEY)).toBe(true);
  });
});
