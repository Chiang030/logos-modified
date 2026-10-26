import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MINIMUM_NODE_VERSION,
  compareVersions,
  parseNodeVersion,
  resolveLaunchSpec,
  selectNodeRuntime,
  verifyNodeRuntime,
} from "../src/runtimeLaunch";

const missing = async () => { throw Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }); };

describe("runtime launch", () => {
  it("uses the core bundled with the extension, named per platform", () => {
    const extensionRoot = resolve("extension");
    const options = { extensionRoot, workspaceRoot: resolve("workspace"), pathExists: () => true } as const;
    expect(resolveLaunchSpec({ ...options, platform: "win32" })).toEqual({
      command: join(extensionRoot, "vendor", "node", "node.exe"),
      args: [join(extensionRoot, "vendor", "pi", "cli.js")],
      scriptPath: join(extensionRoot, "vendor", "pi", "cli.js"),
      bundled: true,
    });
    expect(resolveLaunchSpec({ ...options, platform: "linux" })).toEqual({
      command: join(extensionRoot, "vendor", "node", "node"),
      args: [join(extensionRoot, "vendor", "pi", "cli.js")],
      scriptPath: join(extensionRoot, "vendor", "pi", "cli.js"),
      bundled: true,
    });
  });

  it("resolves a configured development entry from the workspace", () => {
    const workspaceRoot = resolve("workspace");
    const spec = resolveLaunchSpec({
      extensionRoot: resolve("extension"),
      workspaceRoot,
      configuredPath: "dev/logos.mjs",
      pathExists: () => true,
    });
    expect(spec.scriptPath).toBe(join(workspaceRoot, "dev", "logos.mjs"));
    expect(spec.bundled).toBe(false);
  });

  it("accepts the minimum Node.js version", async () => {
    await expect(verifyNodeRuntime("node", async () => `v${MINIMUM_NODE_VERSION}\r\n`)).resolves.toEqual({
      command: "node",
      version: MINIMUM_NODE_VERSION,
    });
  });

  it("rejects missing and outdated Node.js installations", async () => {
    await expect(verifyNodeRuntime("node", async () => { throw new Error("ENOENT"); })).rejects.toMatchObject({ reason: "missing" });
    await expect(verifyNodeRuntime("node", async () => "v22.18.0")).rejects.toMatchObject({ reason: "unsupported" });
  });

  it("distinguishes an unexecutable runtime from a missing one", async () => {
    const eacces = Object.assign(new Error("spawn /x/node EACCES"), { code: "EACCES" });
    const failure = await verifyNodeRuntime("/x/node", async () => { throw eacces; }).catch((error) => error);
    expect(failure).toMatchObject({ reason: "unexecutable" });
    expect(failure.message).not.toContain("Install Node.js");
    const absent = await verifyNodeRuntime("node", missing).catch((error) => error);
    expect(absent).toMatchObject({ reason: "missing" });
    expect(absent.message).toContain("on PATH");
  });

  it("parses and compares semantic Node.js versions", () => {
    expect(parseNodeVersion("v24.1.2\n")).toBe("24.1.2");
    expect(parseNodeVersion("not node")).toBeUndefined();
    expect(compareVersions("22.19.0", "22.19.0")).toBe(0);
    expect(compareVersions("23.0.0", "22.19.0")).toBeGreaterThan(0);
  });
});

describe("node runtime selection", () => {
  const installed = resolve("installed");

  it("prefers the configured executable and treats its failure as a hard error", async () => {
    const selection = await selectNodeRuntime({
      extensionRoot: installed,
      configuredExecutable: "/nvm/node",
      probe: async (command) => command === "/nvm/node" ? "v22.23.4" : "v0.0.0",
    });
    expect(selection).toMatchObject({ source: "setting", command: "/nvm/node", version: "22.23.4" });
    await expect(selectNodeRuntime({ extensionRoot: installed, configuredExecutable: "/nvm/node", probe: missing })).rejects.toMatchObject({ reason: "missing" });
  });

  it("prefers a qualifying node on PATH over the bundled runtime", async () => {
    const selection = await selectNodeRuntime({
      extensionRoot: installed,
      probe: async () => "v22.23.4",
      platform: "linux",
      arch: "x64",
      readInstalledPlatform: async () => "linux-x64",
    });
    expect(selection).toMatchObject({ source: "path", command: "node" });
  });

  it("falls back to the bundled runtime when PATH node is missing or outdated", async () => {
    const options = {
      extensionRoot: installed,
      platform: "linux",
      arch: "x64",
      readInstalledPlatform: async () => "linux-x64",
    } as const;
    const pathProbe = async (command: string) => {
      if (command === "node") throw Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
      return "v22.23.4";
    };
    const afterMissing = await selectNodeRuntime({ ...options, probe: pathProbe });
    expect(afterMissing).toMatchObject({ source: "bundled", version: "22.23.4" });
    expect(afterMissing.command).toContain(join("vendor", "node", "node"));
    const outdatedProbe = async (command: string) => command === "node" ? "v22.18.0" : "v22.23.4";
    const afterOutdated = await selectNodeRuntime({ ...options, probe: outdatedProbe });
    expect(afterOutdated).toMatchObject({ source: "bundled" });
  });

  it("reports a platform mismatch instead of a generic spawn failure", async () => {
    await expect(selectNodeRuntime({
      extensionRoot: installed,
      probe: missing,
      platform: "linux",
      arch: "x64",
      readInstalledPlatform: async () => "win32-x64",
    })).rejects.toMatchObject({ reason: "platform" });
  });
});
