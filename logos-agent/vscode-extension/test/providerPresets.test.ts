import { describe, expect, it } from "vitest";
import { normalizeBaseUrl } from "../src/connectionSettings";
import { DEFAULT_PROVIDER_ID, PROVIDER_PRESETS, isProviderId, presetById, presetForBaseUrl, resolveProviderId } from "../src/shared/providerPresets";

describe("provider presets", () => {
  it("keeps preset invariants", () => {
    expect(new Set(PROVIDER_PRESETS.map((preset) => preset.id)).size).toBe(PROVIDER_PRESETS.length);
    for (const preset of PROVIDER_PRESETS) {
      expect(normalizeBaseUrl(preset.baseUrl)).toBe(preset.baseUrl);
      expect(preset.fallbackModels.length).toBeGreaterThan(0);
      expect(preset.label.length).toBeGreaterThan(0);
    }
    expect(presetById(DEFAULT_PROVIDER_ID)?.id).toBe(DEFAULT_PROVIDER_ID);
  });

  it("matches presets by exact base URL only", () => {
    expect(presetForBaseUrl("https://api.deepseek.com")?.id).toBe("deepseek");
    expect(presetForBaseUrl("https://open.bigmodel.cn/api/coding/paas/v4")?.id).toBe("zhipu");
    expect(presetForBaseUrl("https://api.openai.com/v1")?.id).toBe("openai-chatgpt");
    expect(presetForBaseUrl("https://api.deepseek.com/")).toBeUndefined();
    expect(presetForBaseUrl("https://api.deepseek.com/v1")).toBeUndefined();
    expect(presetForBaseUrl("")).toBeUndefined();
  });

  it("derives provider ids for saved legacy configs and drift", () => {
    expect(resolveProviderId("https://api.deepseek.com", "custom")).toBe("deepseek");
    expect(resolveProviderId("https://open.bigmodel.cn/api/coding/paas/v4", "custom")).toBe("zhipu");
    // api.openai.com is also a valid API-key endpoint, so the URL alone never derives to the OAuth preset.
    expect(resolveProviderId("https://api.openai.com/v1", "custom")).toBe("custom");
    expect(resolveProviderId("https://api.openai.com/v1", "openai-chatgpt")).toBe("openai-chatgpt");
    expect(resolveProviderId("https://api.deepseek.com", "openai-chatgpt")).toBe("custom");
    expect(resolveProviderId("https://example.com/v1", "deepseek")).toBe("custom");
    expect(resolveProviderId("", "custom")).toBe("custom");
  });

  it("validates provider ids", () => {
    expect(isProviderId("deepseek")).toBe(true);
    expect(isProviderId("custom")).toBe(true);
    expect(isProviderId("openai")).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
  });
});
