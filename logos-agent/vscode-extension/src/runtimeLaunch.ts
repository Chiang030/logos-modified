import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const MINIMUM_NODE_VERSION = "22.19.0";

export interface LaunchSpec {
  command: string;
  args: string[];
  scriptPath: string;
  bundled: boolean;
}

export interface LaunchSpecOptions {
  extensionRoot: string;
  workspaceRoot: string;
  configuredPath?: string;
  pathExists?: (path: string) => boolean;
}

export interface NodeRuntimeInfo {
  command: string;
  version: string;
}

export type NodeVersionProbe = (command: string) => Promise<string>;

export class NodeRuntimeError extends Error {
  constructor(
    message: string,
    readonly reason: "missing" | "unsupported" | "invalid",
  ) {
    super(message);
    this.name = "NodeRuntimeError";
  }
}

export function resolveLaunchSpec(options: LaunchSpecOptions): LaunchSpec {
  const configured = options.configuredPath?.trim();
  const scriptPath = configured
    ? resolve(options.workspaceRoot, configured)
    : join(options.extensionRoot, "vendor", "pi", "cli.js");
  const pathExists = options.pathExists ?? existsSync;
  if (!pathExists(scriptPath)) {
    const message = configured
      ? `Configured LOGOS entry does not exist: ${scriptPath}`
      : `Bundled LOGOS core is incomplete: ${scriptPath}`;
    throw new Error(message);
  }
  if (!isAbsolute(scriptPath)) throw new Error(`LOGOS entry must be an absolute path: ${scriptPath}`);
  if (!scriptPath.endsWith(".mjs") && !scriptPath.endsWith(".js")) {
    throw new Error(`LOGOS entry must be a Node.js .mjs or .js file: ${scriptPath}`);
  }
  return { command: configured ? "node" : join(options.extensionRoot, "vendor", "node", "node.exe"), args: [scriptPath], scriptPath, bundled: !configured };
}

export async function verifyNodeRuntime(
  command = "node",
  probe: NodeVersionProbe = probeNodeVersion,
): Promise<NodeRuntimeInfo> {
  let output: string;
  try {
    output = await probe(command);
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
    throw new NodeRuntimeError(
      `Node.js ${MINIMUM_NODE_VERSION} or newer was not found on PATH${detail}. Install Node.js, then retry.`,
      "missing",
    );
  }
  const version = parseNodeVersion(output);
  if (!version) {
    throw new NodeRuntimeError(`Could not read the Node.js version from: ${output.trim() || "<empty output>"}`, "invalid");
  }
  if (compareVersions(version, MINIMUM_NODE_VERSION) < 0) {
    throw new NodeRuntimeError(
      `LOGOS requires Node.js ${MINIMUM_NODE_VERSION} or newer. PATH currently resolves to Node.js ${version}.`,
      "unsupported",
    );
  }
  return { command, version };
}

export function parseNodeVersion(output: string): string | undefined {
  const match = output.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : undefined;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function probeNodeVersion(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, ["--version"], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

