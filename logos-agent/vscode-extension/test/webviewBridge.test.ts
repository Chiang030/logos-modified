import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { LogosWebviewProvider } from "../src/webviewBridge";
import { SessionStore } from "../src/sessionStore";
import { UsageStore } from "../src/usageStore";
import { MEMBERS } from "../src/shared/members";
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
  const usage = new UsageStore(path);
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
  const provider = new LogosWebviewProvider({ extensionUri: "test", extension: { packageJSON: { version: "1.2.3" } } } as unknown as vscode.ExtensionContext,
    runtime as unknown as LocalRuntime, store,
    { view: async () => ({}), load: async () => ({ activeConnectionId: "connection" }) } as unknown as ConnectionSettingsStore, {} as OpenAiAuthStore, usage);
  const view = { webview: { cspSource: "vscode-resource:", asWebviewUri: (value: string) => value,
    postMessage: (message: ExtensionToWebviewMessage) => { sent.push(message); },
    onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose() {} }; },
  }, onDidDispose() {} };
  provider.resolveWebviewView(view as unknown as vscode.WebviewView);
  const send = async (value: unknown) => { receive(value); await vi.waitFor(() => expect(sent.at(-1)?.type).not.toBe("session/loading")); };
  return { runtime, store, usage, sent, emit: (event: RuntimeEvent) => emit(event), receive: (value: unknown) => receive(value), provider, send };
}

describe("chat lifecycle", () => {
  it("requires a selected member before starting a prompt", async () => {
    const f = await fixture(); f.receive({ type: "chat/send", text: "Hello" });
    await vi.waitFor(() => expect(f.sent).toContainEqual(expect.objectContaining({ type: "identity/required" })));
    expect(f.runtime.prompt).not.toHaveBeenCalled();
    expect(f.runtime.start).not.toHaveBeenCalled();
  });

  it("binds new conversations and preserves the owner when another member views history", async () => {
    const f = await fixture(); await f.usage.select(MEMBERS[0].id);
    f.runtime.snapshot.mockResolvedValueOnce({ type: "logos/session_restore", messages: [], state: f.runtime.state });
    f.receive({ type: "chat/send", text: "Hello" });
    await vi.waitFor(() => expect(f.runtime.prompt).toHaveBeenCalledWith("Hello"));
    expect(await f.usage.owner("saved")).toEqual(MEMBERS[0]);
    expect(f.sent).toContainEqual(expect.objectContaining({ type: "message/user", userName: MEMBERS[0].name }));
    await f.usage.select(MEMBERS[1].id);
    f.emit({ type: "record", record: await f.runtime.snapshot() });
    await vi.waitFor(() => expect(f.sent).toContainEqual(expect.objectContaining({ type: "session/restore",
      messages: [expect.objectContaining({ userName: MEMBERS[0].name })] })));
    f.receive({ type: "chat/send", text: "Wrong owner" });
    await vi.waitFor(() => expect(f.sent).toContainEqual(expect.objectContaining({ type: "runtime/error", message: expect.stringContaining("请新建会话") })));
    expect(f.runtime.prompt).toHaveBeenCalledTimes(1);
  });

  it("does not assign legacy conversations to the newly selected user", async () => {
    const f = await fixture(); await f.usage.select(MEMBERS[0].id);
    f.receive({ type: "chat/send", text: "Continue" });
    await vi.waitFor(() => expect(f.sent).toContainEqual(expect.objectContaining({ type: "runtime/error", message: expect.stringContaining("历史会话") })));
    expect(f.runtime.prompt).not.toHaveBeenCalled();
    expect(await f.usage.owner("saved")).toBeUndefined();
  });

  it("counts live usage once and keeps it attributed to the session owner", async () => {
    const f = await fixture(); await f.usage.bind("saved", MEMBERS[0]); await f.usage.select(MEMBERS[1].id);
    const message = { role: "assistant", provider: "test-api", model: "test-model", timestamp: 123, content: [],
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }, stopReason: "toolUse" };
    f.emit({ type: "record", record: { type: "message_end", message } });
    f.emit({ type: "record", record: { type: "message_end", message } });
    await vi.waitFor(async () => expect((await f.usage.view()).summaries[0]).toMatchObject({ responses: 1, total: 18 }));
    expect((await f.usage.view()).summaries[1].responses).toBe(0);
  });

  it("recovers saved response usage without double counting when reopened", async () => {
    const f = await fixture(); await f.usage.bind("saved", MEMBERS[0]);
    const message = { role: "assistant", provider: "test-api", model: "test-model", timestamp: 123, content: [],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" };
    const record = { type: "logos/session_restore", messages: [message], state: f.runtime.state };
    f.emit({ type: "record", record });
    await vi.waitFor(async () => expect((await f.usage.view()).summaries[0].responses).toBe(1));
    f.emit({ type: "record", record });
    await vi.waitFor(async () => expect((await f.usage.view()).summaries[0].responses).toBe(1));
    expect((await f.usage.view()).summaries[0].total).toBe(15);
  });

  it("rejects member changes during a running task", async () => {
    const f = await fixture(); await f.usage.select(MEMBERS[0].id); f.runtime.currentStatus = "running";
    f.receive({ type: "identity/select", memberId: MEMBERS[1].id });
    await vi.waitFor(() => expect(f.sent).toContainEqual(expect.objectContaining({ type: "identity/error" })));
    expect(await f.usage.selected()).toEqual(MEMBERS[0]);
  });

  it("replays persisted context every time an already running runtime gets a new view", async () => {
    const f = await fixture(); f.receive({ type: "webview/ready" });
    await vi.waitFor(() => expect(f.sent.some((message) => message.type === "session/restore")).toBe(true));
    expect(f.sent).toContainEqual({ type: "extension/info", version: "1.2.3" });
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
  it("keeps a billing failure busy until the runtime stops, with one actionable error reply", async () => {
    const f = await fixture();
    const errorMessage = '429: {"code":"1113","message":"余额不足或无可用资源包,请充值。"}';
    f.emit({ type: "record", record: { type: "agent_start" } });
    f.emit({ type: "record", record: { type: "message_start", message: { role: "assistant" } } });
    f.emit({ type: "record", record: { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage } } });
    expect(f.sent.filter((message) => message.type === "message/completed")).toEqual([
      expect.objectContaining({ isError: true, text: expect.stringContaining("已停止自动重试") }),
    ]);
    expect(f.sent).toContainEqual(expect.objectContaining({ type: "runtime/error", fatal: false }));
    expect(f.sent.some((message) => message.type === "run/settled")).toBe(false);
    f.emit({ type: "record", record: { type: "auto_retry_start", errorMessage } });
    f.emit({ type: "record", record: { type: "auto_retry_end", success: false, finalError: "Retry cancelled" } });
    f.emit({ type: "record", record: { type: "agent_settled", aborted: false } });
    expect(f.sent.filter((message) => message.type === "run/settled")).toEqual([{ type: "run/settled", aborted: false, outcome: "failed" }]);
    expect(f.sent.filter((message) => message.type === "message/completed")).toHaveLength(1);
  });
});
