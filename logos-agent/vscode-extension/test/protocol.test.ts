import { describe, expect, it } from "vitest";
import { isWebviewToExtensionMessage } from "../src/shared/protocol";

describe("Webview protocol validation", () => {
  it("accepts supported commands", () => {
    expect(isWebviewToExtensionMessage({ type: "chat/send", text: "inspect the workspace" })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: "runtime/restart" })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: "session/select", sessionId: "session-1" })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: "model/select", provider: "openai", modelId: "gpt-4.1" })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: "thinking/select", level: "high" })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: "settings/save", systemPrompt: "s", appendPrompt: "a", skillsEnabled: true, skillPaths: [] })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: "connection/save", entry: { id: "conn-1", name: "n", baseUrl: "https://example.com/v1", api: "openai-completions", modelId: "m", modelIds: ["m"] }, apiKey: "k" })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: "connection/delete", connectionId: "conn-1" })).toBe(true);
  });

  it("rejects malformed or unknown commands", () => {
    expect(isWebviewToExtensionMessage({ type: "chat/send", text: "" })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: "chat/send", text: 42 })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: "model/select", provider: "", modelId: "gpt-4.1" })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: "thinking/select", level: "" })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: "executeShell", command: "whoami" })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: "settings/save", systemPrompt: 42 })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: "connection/save", entry: { id: "", name: "n", baseUrl: "https://example.com/v1", api: "openai-completions", modelId: "m", modelIds: [] } })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: "connection/delete", connectionId: "" })).toBe(false);
  });
});
