import { dirname, join } from "node:path";
import { compareVersions } from "./runtimeLaunch";

// Public mirror feed: anonymous release checks and downloads, no GitHub auth needed.
// The private Lead-Intelligent/logos repository keeps the source releases; flip
// this constant back to it when private distribution is required again.
export const DEFAULT_FEED_URL = "https://api.github.com/repos/Chiang030/logos-modified";
const LEGACY_FEED_URL = "https://api.github.com/repos/Lead-Intelligent/logos";

const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ReleaseAsset {
  id: number;
  name: string;
  url: string;
}

export interface ReleaseInfo {
  tag_name: string;
  html_url?: string;
  draft?: boolean;
  assets?: ReleaseAsset[];
}

export interface UpdateInfo {
  version: string;
  asset: ReleaseAsset;
  releaseUrl: string;
}

export class UpdateFeedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpdateFeedError";
  }
}

export function parseTagVersion(tag: string): string | undefined {
  const stripped = tag.trim().toLowerCase().replace(/^vscode-/, "");
  const match = stripped.match(/^v?(\d+(?:\.\d+){0,2})$/);
  return match?.[1];
}

export function selectUpdate(releases: ReleaseInfo[], currentVersion: string, platform: string, arch: string): UpdateInfo | undefined {
  let best: UpdateInfo | undefined;
  for (const release of releases) {
    if (release.draft) continue;
    const version = parseTagVersion(release.tag_name);
    if (!version || compareVersions(version, currentVersion) <= 0) continue;
    const asset = pickAsset(release.assets ?? [], version, platform, arch);
    if (!asset) continue;
    if (!best || compareVersions(version, best.version) > 0) {
      best = { version, asset, releaseUrl: release.html_url ?? "" };
    }
  }
  return best;
}

function pickAsset(assets: ReleaseAsset[], version: string, platform: string, arch: string): ReleaseAsset | undefined {
  // Accept both `…-<version>-<platform>` and vsce's default `…-<platform>-<version>` naming.
  const platformNames = [
    `logos-vscode-${version}-${platform}-${arch}.vsix`,
    `logos-vscode-${platform}-${arch}-${version}.vsix`,
  ];
  const universalName = `logos-vscode-${version}.vsix`;
  return assets.find((asset) => platformNames.includes(asset.name)) ?? assets.find((asset) => asset.name === universalName);
}

export interface CodeCliSpec {
  command: string;
  prefixArgs: string[];
}

export function resolveCodeCli(execPath: string, platform: string = process.platform): CodeCliSpec {
  if (platform === "win32") {
    // Node cannot spawn .cmd files directly since CVE-2024-27980; route through cmd.exe.
    return { command: "cmd.exe", prefixArgs: ["/c", join(dirname(execPath), "bin", "code.cmd")] };
  }
  if (platform === "darwin") {
    return { command: join(dirname(execPath), "..", "Resources", "app", "bin", "code"), prefixArgs: [] };
  }
  return { command: join(dirname(execPath), "bin", "code"), prefixArgs: [] };
}

export function shouldAutoCheck(lastCheckMs: number | undefined, nowMs: number): boolean {
  return lastCheckMs === undefined || nowMs - lastCheckMs >= AUTO_CHECK_INTERVAL_MS;
}

export function resolveFeedUrl(configuredUrl: string | undefined): string {
  const feedUrl = configuredUrl?.trim();
  return !feedUrl || feedUrl === LEGACY_FEED_URL ? DEFAULT_FEED_URL : feedUrl;
}

export function buildAuthHeaders(token: string | undefined, accept = "application/vnd.github+json"): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
