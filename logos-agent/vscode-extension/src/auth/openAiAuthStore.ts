import { randomUUID } from "node:crypto";
import type { SecretStore } from "../connectionSettings";
import { OAuthHttpError, loginOpenAiChatGPT, refreshOpenAiCredential, type ChatGptLoginInteraction, type OpenAiOAuthEndpoints } from "./openAiChatGpt";
import { isOAuthCredential, type OAuthCredential } from "./oauthCredential";

const SECRET_KEY = "logos.openAiOAuth";
const DEVICE_ID_KEY = "logos.openai.deviceId";

export interface GlobalStateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** ChatGPT OAuth credentials in SecretStorage plus a stable per-installation device id. */
export class OpenAiAuthStore {
  constructor(
    private readonly secrets: SecretStore,
    private readonly state: GlobalStateStore,
    private readonly endpoints?: OpenAiOAuthEndpoints,
  ) {}

  async hasCredential(): Promise<boolean> {
    return Boolean(await this.credential());
  }

  async currentAccessToken(): Promise<string | undefined> {
    const credential = await this.credential();
    if (!credential) return undefined;
    if (Date.now() < credential.expires) return credential.access;
    return (await this.refresh(credential)).access;
  }

  async login(interaction: ChatGptLoginInteraction): Promise<void> {
    const credential = await loginOpenAiChatGPT(await this.deviceId(), interaction, this.endpoints);
    await this.secrets.store(SECRET_KEY, JSON.stringify(credential));
  }

  async logout(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }

  private async credential(): Promise<OAuthCredential | undefined> {
    const stored = await this.secrets.get(SECRET_KEY);
    if (!stored) return undefined;
    try {
      const value: unknown = JSON.parse(stored);
      return isOAuthCredential(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
    try {
      const next = await refreshOpenAiCredential(credential, undefined, this.endpoints);
      await this.secrets.store(SECRET_KEY, JSON.stringify(next));
      return next;
    } catch (error) {
      if (error instanceof OAuthHttpError && (error.status === 400 || error.status === 401)) {
        await this.secrets.delete(SECRET_KEY);
        throw new Error("ChatGPT 登录已失效，请在 LOGOS 设置中重新登录。");
      }
      throw error;
    }
  }

  private async deviceId(): Promise<string> {
    const existing = this.state.get<string>(DEVICE_ID_KEY);
    if (typeof existing === "string" && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
    const created = randomUUID();
    await this.state.update(DEVICE_ID_KEY, created);
    return created;
  }
}
