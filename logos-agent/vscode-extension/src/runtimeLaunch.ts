import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
  platform?: NodeJS.Platform;
}

export interface NodeRuntimeInfo {
  command: string;
  version: string;
}

export type NodeVersionProbe = (command: string) => Promise<string>;

export class NodeRuntimeError extends Error {
  constructor(
    message: string,
    readonly reason: "missing" | "unsupported" | "invalid" | "unexecutable" | "platform",
  ) {
    super(message);
    this.name = "NodeRuntimeError";
  }
}

/** Path of the bundled Node.js executable for a platform (`node.exe` only on Windows). */
export function bundledNodeCommand(extensionRoot: string, platform: NodeJS.Platform = process.platform): string {
  return join(extensionRoot, "vendor", "node", platform === "win32" ? "node.exe" : "node");
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
  return { command: configured ? "node" : bundledNodeCommand(options.extensionRoot, options.platform ?? process.platform), args: [scriptPath], scriptPath, bundled: !configured };
}

export async function verifyNodeRuntime(
  command = "node",
  probe: NodeVersionProbe = probeNodeVersion,
): Promise<NodeRuntimeInfo> {
  let output: string;
  try {
    output = await probe(command);
  } catch (error) {
    throw probeFailure(command, error);
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

/** Distinguish "not installed" from "cannot execute" so the guidance matches the failure. */
function probeFailure(command: string, error: unknown): NodeRuntimeError {
  const detail = error instanceof Error && error.message ? error.message : String(error);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === "EACCES" || /\bEACCES\b/.test(detail)) {
    const msg = `Node.js runtime at ${command} could not be executed (${detail}). It may lack execute permission or be built for another platform.`;
    return new NodeRuntimeError(msg, "unexecutable");
  }
  const location = isAbsolute(command) ? ` at ${command}` : " on PATH";
  const msg = `Node.js ${MINIMUM_NODE_VERSION} or newer was not found${location} (${detail}). Install Node.js, then retry.`;
  return new NodeRuntimeError(msg, "missing");
}

export interface NodeSelectionOptions {
  extensionRoot: string;
  configuredExecutable?: string;
  probe?: NodeVersionProbe;
  platform?: NodeJS.Platform;
  arch?: string;
  readInstalledPlatform?: (root: string) => Promise<string | undefined>;
}

export interface NodeSelection {
  command: string;
  version: string;
  source: "setting" | "path" | "bundled";
}

/**
 * Pick the Node.js executable for the LOGOS runtime. The `logos.nodeExecutable`
 * setting wins (a failing one is a hard error), then a qualifying `node` on
 * PATH, then the bundled runtime for the installed payload's platform.
 */
export async function selectNodeRuntime(options: NodeSelectionOptions): Promise<NodeSelection> {
  const configured = options.configuredExecutable?.trim();
  if (configured) {
    const info = await verifyNodeRuntime(configured, options.probe);
    return { ...info, source: "setting" };
  }
  try {
    const info = await verifyNodeRuntime("node", options.probe);
    return { ...info, source: "path" };
  } catch (pathError) {
    if (!(pathError instanceof NodeRuntimeError)) throw pathError;
    return selectBundledNode(options, pathError);
  }
}

async function selectBundledNode(options: NodeSelectionOptions, pathError: NodeRuntimeError): Promise<NodeSelection> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const readInstalled = options.readInstalledPlatform ?? readPayloadPlatform;
  const installedPlatform = await readInstalled(options.extensionRoot);
  if (installedPlatform && installedPlatform !== `${platform}-${arch}`) {
    const msg = `This LOGOS package was built for ${installedPlatform}; it cannot run on ${platform}-${arch}. Install the LOGOS build for this machine.`;
    throw new NodeRuntimeError(msg, "platform");
  }
  const command = bundledNodeCommand(options.extensionRoot, platform);
  try {
    const info = await verifyNodeRuntime(command, options.probe);
    return { ...info, source: "bundled" };
  } catch (bundledError) {
    if (!(bundledError instanceof NodeRuntimeError)) throw bundledError;
    const msg = `${bundledError.message} (Node.js on PATH was also unusable: ${pathError.message})`;
    throw new NodeRuntimeError(msg, bundledError.reason);
  }
}

async function readPayloadPlatform(root: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "payload-manifest.json"), "utf8")) as { platform?: unknown };
    return typeof manifest.platform === "string" ? manifest.platform : undefined;
  } catch {
    return undefined; // Payload manifests before v0.3.0 carry no platform; skip the check.
  }
}

