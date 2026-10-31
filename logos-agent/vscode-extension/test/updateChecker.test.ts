import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { registerUpdateChecks } from "../src/updateChecker";
import { DEFAULT_FEED_URL } from "../src/updateFeed";

const mocks = vi.hoisted(() => ({
  commands: new Map<string, () => unknown>(), config: {} as Record<string, unknown>,
  changes: undefined as undefined | ((event: { affectsConfiguration: (key: string) => boolean }) => void),
  log: vi.fn(), show: vi.fn(), status: { text: "", tooltip: "", command: "", show: vi.fn(), dispose: vi.fn() },
  execute: vi.fn(), info: vi.fn(), error: vi.fn(), auth: vi.fn(), fetch: vi.fn(),
}));
vi.mock("vscode", () => ({
  Disposable: { from: (...items: Array<{ dispose(): void }>) => ({ dispose: () => items.forEach((item) => item.dispose()) }) },
  StatusBarAlignment: { Right: 2 }, ProgressLocation: { Notification: 15 },
  Uri: { file: (path: string) => ({ fsPath: path }), parse: (value: string) => value },
  commands: { registerCommand: (name: string, fn: () => unknown) => { mocks.commands.set(name, fn); return { dispose() {} }; }, executeCommand: mocks.execute },
  window: { createOutputChannel: () => ({ appendLine: mocks.log, show: mocks.show, dispose() {} }),
    createStatusBarItem: () => mocks.status, showInformationMessage: mocks.info, showErrorMessage: mocks.error,
    withProgress: (_options: unknown, run: (progress: { report: () => void }) => Promise<void>) => run({ report() {} }) },
  workspace: { getConfiguration: () => ({ get: (name: string, fallback?: unknown) => mocks.config[name] ?? fallback }),
    onDidChangeConfiguration: (listener: typeof mocks.changes) => { mocks.changes = listener; return { dispose() {} }; } },
  authentication: { getSession: mocks.auth }, env: { openExternal: vi.fn() },
}));

const instances: Array<{ dispose(): void }> = [];
const directories: string[] = [];
const stateKey = "logos.update.lastSuccessfulCheck.v2";
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const asset = { id: 1, name: `logos-vscode-${process.platform}-${process.arch}-0.3.9.vsix`,
  url: "https://api.github.com/assets/1", browser_download_url: "https://github.com/release/asset.vsix",
  size: zip.length, digest: `sha256:${createHash("sha256").update(zip).digest("hex")}` };

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.commands.clear(); mocks.config = {}; mocks.changes = undefined;
  mocks.info.mockResolvedValue(undefined); mocks.error.mockResolvedValue(undefined); mocks.auth.mockResolvedValue(undefined);
  mocks.fetch.mockReset(); vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(async () => {
  instances.splice(0).forEach((item) => item.dispose()); vi.useRealTimers(); vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function setup(initial: Record<string, unknown> = {}) {
  const path = await mkdtemp(join(tmpdir(), "logos-update-")); directories.push(path);
  const state = new Map(Object.entries(initial));
  const context = { globalStorageUri: { fsPath: path }, extension: { packageJSON: { version: "0.3.8" } },
    globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } },
    secrets: { get: async () => undefined } } as unknown as vscode.ExtensionContext;
  instances.push(registerUpdateChecks(context));
  return state;
}
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.waitFor(() => expect(mocks.status.text).not.toMatch(/正在检查|正在下载|正在安装/));
}

describe("update lifecycle", () => {
  it("does not mark a failed feed as checked and retries automatically", async () => {
    const state = await setup({ "logos.update.lastCheck": Date.now() });
    mocks.fetch.mockRejectedValueOnce(new Error("connection refused"));
    await tick(2000);
    expect(state.get(stateKey)).toBeUndefined();
    expect(mocks.status.text).toContain("更新失败");
    expect(mocks.log.mock.calls.flat().join(" ")).toContain("connection refused");
    mocks.fetch.mockResolvedValueOnce(new Response("[]"));
    await tick(6 * 60_000);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(state.get(stateKey)).toEqual(expect.objectContaining({ version: "0.3.8", feedUrl: DEFAULT_FEED_URL }));
    expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("checks again while the window remains open and skips prereleases", async () => {
    mocks.config["update.autoInstall"] = false;
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify([{ tag_name: "v0.3.9", prerelease: true, assets: [asset] }])));
    await setup(); await tick(2000);
    const firstCount = mocks.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(mocks.fetch).toHaveBeenCalledTimes(firstCount);
    await tick(6 * 60_000);
    expect(mocks.fetch.mock.calls.length).toBeGreaterThan(firstCount);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("downloads, verifies and installs into the current VS Code without waiting for reload", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify([{ tag_name: "v0.3.9", assets: [asset] }])))
      .mockResolvedValueOnce(new Response(zip));
    mocks.execute.mockImplementation(async (command, uri) => {
      expect(command).toBe("workbench.extensions.installExtension");
      expect(await readFile(uri.fsPath)).toEqual(zip);
    });
    mocks.info.mockImplementation(() => new Promise(() => {}));
    const state = await setup(); await tick(2000);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[1][0]).toBe(asset.browser_download_url);
    expect(mocks.status.text).toContain("等待重载");
    expect(state.get(stateKey)).toBeDefined();
    await tick(65 * 60_000);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it("rejects corrupt downloads and retries installation failures without claiming success", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify([{ tag_name: "v0.3.9", assets: [asset] }])))
      .mockResolvedValueOnce(new Response(Buffer.from([0x50, 0x4b, 3, 4, 9, 9, 9, 9])));
    const state = await setup(); await tick(2000);
    expect(mocks.execute).not.toHaveBeenCalled(); expect(state.get(stateKey)).toBeUndefined();
    expect(mocks.log.mock.calls.flat().join(" ")).toContain("SHA-256");
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify([{ tag_name: "v0.3.9", assets: [asset] }])))
      .mockResolvedValueOnce(new Response(zip));
    mocks.execute.mockRejectedValueOnce(new Error("installation rejected"));
    await tick(5 * 60_000);
    expect(state.get(stateKey)).toBeUndefined(); expect(mocks.status.text).toContain("更新失败");
  });
  it("restarts an interrupted download and installs only the verified complete file", async () => {
    const interrupted = new ReadableStream({ start(controller) { controller.error(new Error("connection reset")); } });
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify([{ tag_name: "v0.3.9", assets: [asset] }])))
      .mockResolvedValueOnce(new Response(interrupted)).mockResolvedValueOnce(new Response(zip));
    mocks.execute.mockResolvedValue(undefined);
    await setup(); await tick(5000);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.log.mock.calls.flat().join(" ")).toContain("下载连接中断");
  });
  it("honors disabling automatic checks, but manual checks bypass it without requiring login", async () => {
    mocks.config["update.autoCheck"] = false;
    mocks.fetch.mockResolvedValue(new Response("[]"));
    await setup(); await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.fetch).not.toHaveBeenCalled();
    await mocks.commands.get("logos.checkUpdate")!();
    expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("uses a corrected feed immediately without inheriting its old successful-check throttle", async () => {
    mocks.config["update.feedUrl"] = "http://127.0.0.1:4890/api";
    mocks.fetch.mockImplementation(async () => new Response("[]"));
    const state = await setup(); await tick(2000);
    mocks.config["update.feedUrl"] = DEFAULT_FEED_URL;
    mocks.changes!({ affectsConfiguration: () => true });
    await vi.waitFor(() => expect(state.get(stateKey)).toEqual(expect.objectContaining({ feedUrl: DEFAULT_FEED_URL })));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls[1][0]).toBe(`${DEFAULT_FEED_URL}/releases?per_page=30`);
  });
  it("shares a pending check with manual callers instead of starting duplicate downloads", async () => {
    let resolve!: (value: Response) => void;
    mocks.fetch.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    await setup(); await vi.advanceTimersByTimeAsync(2000);
    const first = mocks.commands.get("logos.checkUpdate")!();
    const second = mocks.commands.get("logos.checkUpdate")!();
    resolve(new Response("[]")); await Promise.all([first, second]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
