import { isRecord } from "../shared/protocol";

/** ChatGPT OAuth token bundle persisted as JSON in VS Code SecretStorage. */
export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  /** Epoch millis, already reduced by the expiry margin at issuance time. */
  expires: number;
  clientId: string;
  scopes: string[];
}

export function isOAuthCredential(value: unknown): value is OAuthCredential {
  return isRecord(value) && value.type === "oauth"
    && typeof value.access === "string" && value.access.length > 0
    && typeof value.refresh === "string" && value.refresh.length > 0
    && typeof value.expires === "number" && Number.isFinite(value.expires)
    && typeof value.clientId === "string" && value.clientId.length > 0
    && Array.isArray(value.scopes) && value.scopes.every((scope) => typeof scope === "string");
}
