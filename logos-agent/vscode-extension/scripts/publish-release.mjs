// Uploads a packaged VSIX as a release asset on GitHub. Requires GITHUB_TOKEN
// with Contents read+write access to the target repository (fine-grained PAT).
// Usage: node scripts/publish-release.mjs --tag v0.2.0 [--repo Lead-Intelligent/logos] --asset logos-vscode-0.2.0-win32-x64.vsix
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const repo = args.repo ?? "Lead-Intelligent/logos";
const tag = args.tag;
const assetPath = args.asset;
const token = process.env.GITHUB_TOKEN;

if (!tag || !assetPath) {
  console.error("Usage: node scripts/publish-release.mjs --tag <tag> [--repo <owner/name>] --asset <vsix-path>");
  process.exit(1);
}
if (!token) throw new Error("GITHUB_TOKEN is not set. Create a fine-grained PAT with Contents read+write on the repository.");

const assetName = basename(assetPath);
const data = await readFile(assetPath);
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

let release = await api(`/repos/${repo}/releases/tags/${tag}`, { allow404: true });
if (!release) {
  console.log(`No release for ${tag}; creating one.`);
  release = await api(`/repos/${repo}/releases`, { method: "POST", expect: 201, body: { tag_name: tag, name: tag } });
}

const existing = release.assets?.find((asset) => asset.name === assetName);
if (existing) {
  console.log(`Replacing existing asset ${assetName}.`);
  await api(`/repos/${repo}/releases/assets/${existing.id}`, { method: "DELETE", expect: 204 });
}

const upload = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/octet-stream" },
  body: data,
  signal: AbortSignal.timeout(600_000),
});
if (!upload.ok) throw new Error(`Asset upload failed: HTTP ${upload.status} ${(await upload.text()).slice(0, 300)}`);
const uploaded = await upload.json();
console.log(`Uploaded ${uploaded.name} (${(data.byteLength / 1024 / 1024).toFixed(1)} MiB) → ${release.html_url}`);

async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method ?? "GET",
    headers: { ...headers, ...(options.body ? { "Content-Type": "application/json" } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (options.allow404 && response.status === 404 && !(options.method && options.method !== "GET")) return undefined;
  if (response.status !== (options.expect ?? 200)) {
    throw new Error(`GitHub API ${path} → HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.status === 204 ? undefined : response.json();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (!key || index + 1 >= argv.length) throw new Error(`Malformed arguments: ${argv.join(" ")}`);
    parsed[key] = argv[index + 1];
  }
  return parsed;
}
