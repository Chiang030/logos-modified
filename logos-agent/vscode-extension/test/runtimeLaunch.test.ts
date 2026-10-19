import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MINIMUM_NODE_VERSION,
  compareVersions,
  parseNodeVersion,
  resolveLaunchSpec,
  verifyNodeRuntime,
} from "../src/runtimeLaunch";

describe("runtime launch", () => {
  it("uses the core bundled with the extension", () => {
    const extensionRoot = resolve("extension");
    const spec = resolveLaunchSpec({
      extensionRoot,
      workspaceRoot: resolve("workspace"),
      pathExists: () => true,
    });
    expect(spec).toEqual({
      command: join(extensionRoot, "vendor", "node", "node.exe"),
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

  it("parses and compares semantic Node.js versions", () => {
    expect(parseNodeVersion("v24.1.2\n")).toBe("24.1.2");
    expect(parseNodeVersion("not node")).toBeUndefined();
    expect(compareVersions("22.19.0", "22.19.0")).toBe(0);
    expect(compareVersions("23.0.0", "22.19.0")).toBeGreaterThan(0);
  });
});
