import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { LogosWebviewProvider } from "../src/webviewBridge";
import { SessionStore } from "../src/sessionStore";
import type { LocalRuntime, RuntimeEvent } from "../src/localRuntime";
import type { ConnectionSettingsStore } from "../src/connectionSettings";
import type { OpenAiAuthStore } from "../src/auth/openAiAuthStore";
import type { ExtensionToWebviewMessage } from "../src/shared/protocol";

vi.mock("vscode", () => ({
  Uri: { joinPath: (_base: unknown, ...parts: string[]) => parts.join("/") },
  workspace: { getConfiguration: () => ({ get: () => true }) },
}));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "logos-bridge-")); directories.push(path);
  const store = new SessionStore(path);
  const sent: ExtensionToWebviewMessage[] = [];
  let emit: (event: RuntimeEvent) => void = () => undefined;
  let receive: (value: unknown) => void = () => undefined;
  const runtime = {
    currentStatus: "ready", isRunning: true, state: { sessionId: "saved", sessionFile: "/saved.jsonl", isStreaming: false },
    onDidEvent: (listener: typeof emit) => { emit = listener; return { dispose() {} }; },
    start: vi.fn(async () => undefined), newSession: vi.fn(async () => undefined), switchSession: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined), abort: vi.fn(async () => undefined),
    getRuntimeConfig: vi.fn(async () => ({ models: [], thinkingLevels: [] })),
    snapshot: vi.fn(async () => ({ type: "logos/session_restore", messages: [{ role: "user", content: "Remember project A" }], state: runtime.state })),
  };
  const provider = new LogosWebviewProvider({ extensionUri: "test" } as unknown as vscode.ExtensionContext,
    runtime as unknown as LocalRuntime, store,
    { view: async () => ({}), load: async () => ({ activeConnectionId: "connection" }) } as unknown as ConnectionSettingsStore, {} as OpenAiAuthStore);
  const view = { webview: { cspSource: "vscode-resource:", asWebviewUri: (value: string) => value,
    postMessage: (message: ExtensionToWebviewMessage) => { sent.push(message); },
    onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose() {} }; },
  }, onDidDispose() {} };
  provider.resolveWebviewView(view as unknown as vscode.WebviewView);
  const send = async (value: unknown) => { receive(value); await vi.waitFor(() => expect(sent.at(-1)?.type).not.toBe("session/loading")); };
  return { runtime, store, sent, emit: (event: RuntimeEvent) => emit(event), receive: (value: unknown) => receive(value), provider, send };
}

describe("chat lifecycle", () => {
  it("replays persisted context every time an already running runtime gets a new view", async () => {
    const f = await fixture(); f.receive({ type: "webview/ready" });
    await vi.waitFor(() => expect(f.sent.some((message) => message.type === "session/restore")).toBe(true));
    f.sent.length = 0; f.receive({ type: "webview/ready" });
    await vi.waitFor(() => expect(f.sent.some((message) => message.type === "session/restore")).toBe(true));
    expect(f.sent).toContainEqual(expect.objectContaining({ type: "session/restore", messages: [expect.objectContaining({ text: "Remember project A" })] }));
  });
  it("replays an unfinished response on reopen without losing streamed text", async () => {
    const f = await fixture(); f.receive({ type: "webview/ready" });
    await vi.waitFor(() => expect(f.sent.some((message) => message.type === "session/restore")).toBe(true));
    f.emit({ type: "record", record: { type: "message_start", message: { role: "assistant" } } });
    f.emit({ type: "record", record: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial response" } } });
    f.sent.length = 0; f.receive({ type: "webview/ready" });
    await vi.waitFor(() => expect(f.sent).toContainEqual(expect.objectContaining({ type: "message/text_delta", delta: "Partial response" })));
  });
  it("does not erase the current view or active session when switching fails", async () => {
    const f = await fixture(); await f.store.save({ sessionId: "other", sessionFile: "/other.jsonl" }); await f.store.save({ sessionId: "saved", sessionFile: "/saved.jsonl" });
    f.runtime.switchSession.mockRejectedValue(new Error("missing file")); f.receive({ type: "session/select", sessionId: "other" });
    await vi.waitFor(() => expect(f.sent.some((message) => message.type === "runtime/error")).toBe(true));
    expect(f.sent.some((message) => message.type === "session/reset" || message.type === "session/restore")).toBe(false);
    expect((await f.store.load())?.sessionId).toBe("saved");
  });
  it("surfaces model error messages even with empty assistant content and preserves failure at settlement", async () => {
    const f = await fixture();
    f.emit({ type: "record", record: { type: "agent_start" } });
    f.emit({ type: "record", record: { type: "message_start", message: { role: "assistant" } } });
    f.emit({ type: "record", record: { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "HTTP 401 Bearer secret" } } });
    f.emit({ type: "record", record: { type: "agent_settled", aborted: false } });
    expect(f.sent).toContainEqual(expect.objectContaining({ type: "message/completed", isError: true, text: "HTTP 401 Bearer [redacted]" }));
    expect(f.sent.filter((message) => message.type === "run/settled").at(-1)).toMatchObject({ outcome: "failed" });
  });
  it("reports unexpected exits but ignores ordinary stderr", async () => {
    const f = await fixture(); f.emit({ type: "stderr", text: "ordinary debug output" }); expect(f.sent).toHaveLength(0);
    f.emit({ type: "status", status: "error", detail: "LOGOS exited (1)" });
    expect(f.sent).toContainEqual(expect.objectContaining({ type: "run/settled", outcome: "interrupted" }));
  });
});
