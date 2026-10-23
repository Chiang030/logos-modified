import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparePilotTelemetry } from "../src/pilotTelemetry";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const runtime = { args: ["--no-extensions", "-e", "logos.mjs"], env: { PI_CODING_AGENT_DIR: "isolated-profile", LOGOS_VSCODE_API_KEY: "model-key" } };

describe("Pilot telemetry opt-in", () => {
  it("keeps telemetry disabled by default", async () => {
    const result = await preparePilotTelemetry(runtime, { enabled: false, dataDirectory: "" });
    expect(result.args).toEqual(runtime.args);
    expect(result.env).toEqual(runtime.env);
    expect(result.detail).toContain("disabled");
  });

  it("keeps LOGOS usable when Pilot is absent or the path is relative", async () => {
    for (const dataDirectory of ["relative-pilot", join(tmpdir(), "missing-pilot", "not-installed")]) {
      const result = await preparePilotTelemetry(runtime, { enabled: true, dataDirectory });
      expect(result.args).toEqual(runtime.args);
      expect(result.env).toEqual(runtime.env);
      expect(result.detail).toContain("unavailable");
    }
  });

  it("loads only the Pilot extension while preserving the isolated profile and credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "logos pilot 中文 "));
    directories.push(directory);
    const extension = join(directory, "plugins", "pi-coding-agent", "index.mjs");
    for (const path of [extension, join(directory, "plugins", "shared", "resource-context.mjs"), join(directory, "config.json")]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "{}");
    }
    const result = await preparePilotTelemetry(runtime, { enabled: true, dataDirectory: directory });
    expect(result.args).toEqual([...runtime.args, "-e", extension]);
    expect(result.env).toEqual({ ...runtime.env, LOONGSUITE_PILOT_DATA_DIR: directory });
    expect(runtime.env).not.toHaveProperty("LOONGSUITE_PILOT_DATA_DIR");
    expect(result.detail).not.toContain("model-key");
    await rm(extension);
    expect((await preparePilotTelemetry(runtime, { enabled: true, dataDirectory: directory })).detail).toContain("unavailable");
  });
});
