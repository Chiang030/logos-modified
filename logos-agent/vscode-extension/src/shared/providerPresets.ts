import type { ApiProtocol } from "./protocol";

export type ProviderId = "deepseek" | "zhipu" | "openai-chatgpt" | "custom";
export type ProviderAuthMode = "apiKey" | "chatgpt-oauth";

export interface ProviderPreset {
  readonly id: Exclude<ProviderId, "custom">;
  readonly label: string;
  readonly baseUrl: string;
  readonly api: ApiProtocol;
  readonly authMode: ProviderAuthMode;
  readonly fallbackModels: readonly string[];
}

export const DEFAULT_PROVIDER_ID: ProviderId = "deepseek";

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "deepseek", label: "DeepSeek（默认）", baseUrl: "https://api.deepseek.com", api: "openai-completions", authMode: "apiKey",
    fallbackModels: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", api: "openai-completions", authMode: "apiKey",
    fallbackModels: ["glm-4.6", "glm-4.5-air"] },
  { id: "openai-chatgpt", label: "OpenAI（ChatGPT 登录）", baseUrl: "https://api.openai.com/v1", api: "openai-responses", authMode: "chatgpt-oauth",
    fallbackModels: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5-pro", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini",
      "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-daybreak-blue-latest"] },
];

export function isProviderId(value: unknown): value is ProviderId {
  return ["deepseek", "zhipu", "openai-chatgpt", "custom"].includes(String(value));
}

export function presetById(id: ProviderId): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function presetForBaseUrl(baseUrl: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.baseUrl === baseUrl);
}

/**
 * Derive the provider from the base URL. `api.openai.com/v1` is also a valid API-key
 * endpoint, so it never derives to `openai-chatgpt`: that id is sticky and only kept
 * while the stored selection is `openai-chatgpt` and the URL still matches the preset.
 * A drifted or hand-edited URL therefore always resolves to `custom`.
 */
export function resolveProviderId(baseUrl: string, stored: ProviderId): ProviderId {
  if (stored === "openai-chatgpt") {
    return baseUrl === presetById("openai-chatgpt")?.baseUrl ? "openai-chatgpt" : "custom";
  }
  const preset = presetForBaseUrl(baseUrl);
  return preset && preset.authMode === "apiKey" ? preset.id : "custom";
}
