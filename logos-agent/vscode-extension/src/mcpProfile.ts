import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

const MCP_FILE = "mcp.json";
const DIAGNOSTICS_FILE = "mcp-warnings.json";
const REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const STRUCTURAL_KEYS = [
  "command", "args", "url", "type", "timeout", "enabled", "exposure", "toolExposure", "description", "codemode",
] as const;

type JsonRecord = Record<string, unknown>;

export interface McpProfileResult {
  warnings: string[];
  referencedEnvironment: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectReferences(value: unknown, references: Set<string>): void {
  if (typeof value === "string") {
    REFERENCE_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(REFERENCE_PATTERN)) references.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectReferences(item, references);
  }
}

function copyReferencedValues(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  REFERENCE_PATTERN.lastIndex = 0;
  return REFERENCE_PATTERN.test(value) ? value : undefined;
}

function sanitizeSensitiveMap(value: unknown): { value?: JsonRecord; removed: boolean } {
  if (!isRecord(value)) return { removed: value !== undefined };
  const result: JsonRecord = {};
  let removed = false;
  for (const [name, item] of Object.entries(value)) {
    const copied = copyReferencedValues(item);
    if (copied === undefined) removed = true;
    else result[name] = copied;
  }
  return { value: Object.keys(result).length > 0 ? result : undefined, removed };
}

function sanitizeServer(name: string, value: unknown, warnings: string[]): JsonRecord | undefined {
  if (!isRecord(value)) {
    warnings.push(`MCP server "${name}" was ignored because its entry is not an object.`);
    return undefined;
  }
  const result: JsonRecord = {};
  for (const key of STRUCTURAL_KEYS) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  const env = sanitizeSensitiveMap(value.env);
  const headers = sanitizeSensitiveMap(value.headers);
  if (env.value) result.env = env.value;
  if (headers.value) result.headers = headers.value;
  if (env.removed || headers.removed) {
    warnings.push(`MCP server "${name}" had literal env or header values removed; use \${NAME} references.`);
  }
  if (isRecord(value.auth) && typeof value.auth.provider === "string") {
    result.auth = { provider: value.auth.provider };
    if (Object.keys(value.auth).some((key) => key !== "provider")) {
      warnings.push(`MCP server "${name}" had OAuth secret fields removed.`);
    }
  } else if (value.auth !== undefined) {
    warnings.push(`MCP server "${name}" had an invalid auth block removed.`);
  }
  return result;
}

export function resolveMcpConfigPath(source: NodeJS.ProcessEnv, home = homedir()): string {
  const agentDirectory = source.PI_CODING_AGENT_DIR?.trim();
  return join(agentDirectory || join(home, ".pi", "agent"), MCP_FILE);
}

export function sanitizeMcpConfig(input: unknown): { config: JsonRecord; warnings: string[]; referencedEnvironment: string[] } {
  const warnings: string[] = [];
  const references = new Set<string>();
  if (!isRecord(input)) {
    return { config: { mcpServers: {} }, warnings: ["MCP configuration must be a JSON object."], referencedEnvironment: [] };
  }
  if (input.mcpServers !== undefined && !isRecord(input.mcpServers)) {
    return { config: { mcpServers: {} }, warnings: ["MCP configuration mcpServers must be an object."], referencedEnvironment: [] };
  }
  const servers: JsonRecord = {};
  for (const [name, value] of Object.entries(input.mcpServers ?? {})) {
    const server = sanitizeServer(name, value, warnings);
    if (server) {
      servers[name] = server;
      collectReferences(server, references);
    }
  }
  const config: JsonRecord = { mcpServers: servers };
  if (typeof input.autoEnableCodemode === "boolean") config.autoEnableCodemode = input.autoEnableCodemode;
  else if (input.autoEnableCodemode !== undefined) warnings.push("MCP configuration autoEnableCodemode must be a boolean and was ignored.");
  return { config, warnings, referencedEnvironment: [...references].sort() };
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode });
  try {
    await rename(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    await rm(path, { force: true });
    await rename(temporary, path);
  }
  await chmod(path, mode);
}

export async function readMcpWarnings(profile: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(join(profile, DIAGNOSTICS_FILE), "utf8"));
    return isRecord(value) && Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function prepareMcpProfile(
  profile: string,
  source: NodeJS.ProcessEnv,
  runtimeEnvironment: NodeJS.ProcessEnv,
  home = homedir(),
): Promise<McpProfileResult> {
  const sourcePath = resolveMcpConfigPath(source, home);
  const profilePath = join(profile, MCP_FILE);
  const diagnosticsPath = join(profile, DIAGNOSTICS_FILE);
  await mkdir(profile, { recursive: true });
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(sourcePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      const warnings = [`Unable to read MCP configuration ${sourcePath}: ${message}`];
      await rm(profilePath, { force: true });
      await writeAtomic(diagnosticsPath, JSON.stringify({ warnings }, null, 2), 0o600);
      return { warnings, referencedEnvironment: [] };
    }
    await rm(profilePath, { force: true });
    await rm(diagnosticsPath, { force: true });
    return { warnings: [], referencedEnvironment: [] };
  }
  const sanitized = sanitizeMcpConfig(parsed);
  for (const name of sanitized.referencedEnvironment) {
    if (source[name] === undefined) sanitized.warnings.push(`MCP environment variable ${name} is not set.`);
    else runtimeEnvironment[name] = source[name];
  }
  await writeAtomic(profilePath, `${JSON.stringify(sanitized.config, null, 2)}\n`, 0o600);
  if (sanitized.warnings.length > 0) {
    await writeAtomic(diagnosticsPath, JSON.stringify({ warnings: sanitized.warnings }, null, 2), 0o600);
  } else {
    await rm(diagnosticsPath, { force: true });
  }
  return sanitized;
}
