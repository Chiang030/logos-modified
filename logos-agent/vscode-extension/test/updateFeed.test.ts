import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAuthHeaders,
  parseTagVersion,
  resolveCodeCli,
  selectUpdate,
  shouldAutoCheck,
  type ReleaseInfo,
} from "../src/updateFeed";

function release(overrides: Partial<ReleaseInfo> & Pick<ReleaseInfo, "tag_name">): ReleaseInfo {
  return { html_url: `https://example.com/releases/${overrides.tag_name}`, ...overrides };
}

function asset(name: string) {
  return { id: name.length, name, url: `https://example.com/assets/${name}` };
}

describe("update checker", () => {
  it("parses release tag versions with and without prefixes", () => {
    expect(parseTagVersion("v0.2.0")).toBe("0.2.0");
    expect(parseTagVersion("vscode-v0.2.1")).toBe("0.2.1");
    expect(parseTagVersion("0.1.7")).toBe("0.1.7");
    expect(parseTagVersion(" V1.2 ")).toBe("1.2");
    expect(parseTagVersion("server-1.0")).toBeUndefined();
    expect(parseTagVersion("latest")).toBeUndefined();
    expect(parseTagVersion("")).toBeUndefined();
  });

  it("prefers the platform-specific asset over the universal one", () => {
    const platform = asset("logos-vscode-0.2.0-win32-x64.vsix");
    const universal = asset("logos-vscode-0.2.0.vsix");
    const update = selectUpdate([release({ tag_name: "v0.2.0", assets: [universal, platform] })], "0.1.7", "win32", "x64");
    expect(update?.version).toBe("0.2.0");
    expect(update?.asset.name).toBe("logos-vscode-0.2.0-win32-x64.vsix");
  });

  it("accepts vsce's default platform-first asset naming", () => {
    const update = selectUpdate(
      [release({ tag_name: "v0.2.0", assets: [asset("logos-vscode-win32-x64-0.2.0.vsix")] })],
      "0.1.7", "win32", "x64");
    expect(update?.asset.name).toBe("logos-vscode-win32-x64-0.2.0.vsix");
  });

  it("selects the matching Linux build and ignores Windows-only releases on Linux", () => {
    const linux = asset("logos-vscode-linux-x64-0.3.0.vsix");
    const windows = asset("logos-vscode-win32-x64-0.3.0.vsix");
    const update = selectUpdate([release({ tag_name: "v0.3.0", assets: [windows, linux] })], "0.2.2", "linux", "x64");
    expect(update?.asset.name).toBe("logos-vscode-linux-x64-0.3.0.vsix");
    expect(selectUpdate([release({ tag_name: "v0.3.0", assets: [windows] })], "0.2.2", "linux", "arm64")).toBeUndefined();
  });

  it("falls back to the universal asset when no platform asset exists", () => {
    const universal = asset("logos-vscode-0.2.0.vsix");
    const update = selectUpdate([release({ tag_name: "v0.2.0", assets: [universal] })], "0.1.7", "linux", "arm64");
    expect(update?.asset.name).toBe("logos-vscode-0.2.0.vsix");
  });

  it("ignores releases without VSIX assets, drafts, and non-newer versions", () => {
    const releases: ReleaseInfo[] = [
      release({ tag_name: "v0.3.0", draft: true, assets: [asset("logos-vscode-0.3.0.vsix")] }),
      release({ tag_name: "v0.2.0", assets: [asset("logos-server-v0.2.0.tar.gz")] }),
      release({ tag_name: "v0.1.7", assets: [asset("logos-vscode-0.1.7.vsix")] }),
      release({ tag_name: "v0.1.0", assets: [asset("logos-vscode-0.1.0.vsix")] }),
    ];
    expect(selectUpdate(releases, "0.1.7", "win32", "x64")).toBeUndefined();
  });

  it("picks the newest eligible release across the feed", () => {
    const releases: ReleaseInfo[] = [
      release({ tag_name: "vscode-v0.2.1", assets: [asset("logos-vscode-0.2.1-win32-x64.vsix")] }),
      release({ tag_name: "v0.2.0", assets: [asset("logos-vscode-0.2.0-win32-x64.vsix")] }),
    ];
    const update = selectUpdate(releases, "0.2.0", "win32", "x64");
    expect(update?.version).toBe("0.2.1");
    expect(update?.asset.name).toBe("logos-vscode-0.2.1-win32-x64.vsix");
  });

  it("resolves the code CLI per platform", () => {
    const win = resolveCodeCli(resolve("/app/Code.exe"), "win32");
    expect(win.command).toBe("cmd.exe");
    expect(win.prefixArgs).toEqual(["/c", resolve("/app/bin/code.cmd")]);

    const mac = resolveCodeCli(resolve("/VS Code.app/Contents/MacOS/Electron"), "darwin");
    expect(mac.command).toBe(resolve("/VS Code.app/Contents/Resources/app/bin/code"));
    expect(mac.prefixArgs).toEqual([]);

    const linux = resolveCodeCli(resolve("/usr/share/code/code"), "linux");
    expect(linux.command).toBe(resolve("/usr/share/code/bin/code"));
  });

  it("throttles automatic checks to one per day", () => {
    const now = 1_000_000_000_000;
    expect(shouldAutoCheck(undefined, now)).toBe(true);
    expect(shouldAutoCheck(now - 23 * 60 * 60 * 1000, now)).toBe(false);
    expect(shouldAutoCheck(now - 24 * 60 * 60 * 1000, now)).toBe(true);
  });

  it("builds auth headers with token and accept type", () => {
    expect(buildAuthHeaders(undefined)).toEqual({ Accept: "application/vnd.github+json" });
    expect(buildAuthHeaders("token123")).toEqual({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer token123",
    });
    expect(buildAuthHeaders("token123", "application/octet-stream")).toEqual({
      Accept: "application/octet-stream",
      Authorization: "Bearer token123",
    });
  });
});
