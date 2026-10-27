import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareMcpProfile, resolveMcpConfigPath, sanitizeMcpConfig } from "../src/mcpProfile";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `logos-${prefix}-`));
  directories.push(path);
  return path;
}

describe("MCP profile preparation", () => {
  it("resolves the configured Pi agent directory before the default home", () => {
    expect(resolveMcpConfigPath({ PI_CODING_AGENT_DIR: "C:\\pi-agent" }, "C:\\Users\\test")).toBe(join("C:\\pi-agent", "mcp.json"));
    expect(resolveMcpConfigPath({}, "C:\\Users\\test")).toBe(join("C:\\Users\\test", ".pi", "agent", "mcp.json"));
  });

  it("keeps SolidCraft structure and removes literal secrets", () => {
    const result = sanitizeMcpConfig({
      autoEnableCodemode: false,
      mcpServers: {
        solidcraft: {
          command: "solidcraft-cli",
          args: ["mcp", "--allow-path", "~/projects"],
          timeout: 1800,
          exposure: "deferred",
          description: "CAD",
        },
        remote: {
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer ${MCP_TOKEN}", "X-Api-Key": "literal-secret" },
          env: { MCP_TOKEN: "${MCP_TOKEN}", MODE: "safe" },
          auth: { provider: "oauth", clientSecret: "literal-secret" },
        },
      },
    });
    expect(result.config).toMatchObject({
      autoEnableCodemode: false,
      mcpServers: {
        solidcraft: { command: "solidcraft-cli", args: ["mcp", "--allow-path", "~/projects"], timeout: 1800, exposure: "deferred" },
        remote: { headers: { Authorization: "Bearer ${MCP_TOKEN}" }, env: { MCP_TOKEN: "${MCP_TOKEN}" }, auth: { provider: "oauth" } },
      },
    });
    expect(JSON.stringify(result.config)).not.toContain("literal-secret");
    expect(result.referencedEnvironment).toEqual(["MCP_TOKEN"]);
    expect(result.warnings).toHaveLength(2);
  });

  it("writes a sanitized profile without changing the source config", async () => {
    const sourceDirectory = await directory("mcp-source");
    const profile = await directory("mcp-profile");
    const sourcePath = join(sourceDirectory, "mcp.json");
    const source = JSON.stringify({ mcpServers: { solidcraft: { command: "solidcraft-cli", args: ["mcp"] } } }, null, 2);
    await writeFile(sourcePath, source, "utf8");
    const environment: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: sourceDirectory, MCP_TOKEN: "secret-value" };
    const runtimeEnvironment: NodeJS.ProcessEnv = {};
    const result = await prepareMcpProfile(profile, environment, runtimeEnvironment);
    expect(result.warnings).toEqual([]);
    expect(runtimeEnvironment).toEqual({});
    expect(JSON.parse(await readFile(join(profile, "mcp.json"), "utf8"))).toEqual(JSON.parse(source));
    expect(await readFile(sourcePath, "utf8")).toBe(source);
  });

  it("injects referenced environment values without persisting them", async () => {
    const sourceDirectory = await directory("mcp-env-source");
    const profile = await directory("mcp-env-profile");
    await writeFile(join(sourceDirectory, "mcp.json"), JSON.stringify({
      mcpServers: { remote: { url: "https://example.test/mcp", headers: { Authorization: "Bearer ${MCP_TOKEN}" } } },
    }), "utf8");
    const runtimeEnvironment: NodeJS.ProcessEnv = {};
    await prepareMcpProfile(profile, { PI_CODING_AGENT_DIR: sourceDirectory, MCP_TOKEN: "secret-value" }, runtimeEnvironment);
    expect(runtimeEnvironment.MCP_TOKEN).toBe("secret-value");
    expect(await readFile(join(profile, "mcp.json"), "utf8")).not.toContain("secret-value");
  });

  it("continues without a profile when the source config is absent", async () => {
    const profile = await directory("mcp-missing");
    const result = await prepareMcpProfile(profile, { PI_CODING_AGENT_DIR: join(profile, "missing") }, {});
    expect(result).toEqual({ warnings: [], referencedEnvironment: [] });
  });

  it("keeps runtime startup non-fatal for malformed source JSON", async () => {
    const sourceDirectory = await directory("mcp-invalid-source");
    const profile = await directory("mcp-invalid-profile");
    await writeFile(join(sourceDirectory, "mcp.json"), "{ invalid", "utf8");
    const result = await prepareMcpProfile(profile, { PI_CODING_AGENT_DIR: sourceDirectory }, {});
    expect(result.warnings[0]).toContain("Unable to read MCP configuration");
    expect(await readFile(join(profile, "mcp-warnings.json"), "utf8")).toContain("Unable to read MCP configuration");
  });
});
