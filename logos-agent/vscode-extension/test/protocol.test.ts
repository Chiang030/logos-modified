import { describe, expect, it } from "vitest";
import { isWebviewToExtensionMessage } from "../src/shared/protocol";

describe("Webview protocol validation", () => {
  it("accepts supported commands", () => {
    expect(isWebviewToExtensionMessage({ type: "chat/send", text: "inspect the workspace" })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: "runtime/restart" })).toBe(true);
    expect(isWebviewToExtensionMessage({ type: "session/select", sessionId: "session-1" })).toBe(true);
  });

  it("rejects malformed or unknown commands", () => {
    expect(isWebviewToExtensionMessage({ type: "chat/send", text: "" })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: "chat/send", text: 42 })).toBe(false);
    expect(isWebviewToExtensionMessage({ type: "executeShell", command: "whoami" })).toBe(false);
  });
});
