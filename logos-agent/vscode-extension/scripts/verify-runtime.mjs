import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedCommit = "abe508e1b89912adde45528136c3221eb69acdd7";
const extensionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDirectory = join(extensionDirectory, "runtime", "vendor", "pi");
const manifest = JSON.parse(await readFile(join(runtimeDirectory, "runtime-manifest.json"), "utf8"));

if (manifest.platform !== "win32-x64") throw new Error(`Unexpected runtime platform: ${manifest.platform}`);
if (manifest.pi?.commit !== expectedCommit) throw new Error(`Unexpected Pi commit: ${manifest.pi?.commit}`);

const required = [
  "cli.js",
  "dist/bundle/cli.js",
  "dist/bundle/cli-runtime.js",
  "dist/bundle/rpc-entry.js",
  "node_modules/@earendil-works/chord/package.json",
  "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
  "node_modules/jiti/package.json",
  "node_modules/quickjs-wasi/quickjs.wasm",
  "node_modules/esbuild/lib/main.js",
  "node_modules/@esbuild/win32-x64/esbuild.exe",
  "THIRD_PARTY_NOTICES.txt",
  "PI_LICENSE",
];
for (const path of required) await access(join(runtimeDirectory, ...path.split("/")));

const actualFiles = await walk(runtimeDirectory);
const forbidden = actualFiles.filter((path) => {
  const normalized = relative(runtimeDirectory, path).replaceAll("\\", "/").toLowerCase();
  return normalized.split("/").some((part) => part === ".env" || part === ".git" || part === ".npmrc");
});
if (forbidden.length > 0) throw new Error(`Forbidden runtime files: ${forbidden.join(", ")}`);

for (const file of manifest.files) {
  const data = await readFile(join(runtimeDirectory, ...file.path.split("/")));
  const hash = createHash("sha256").update(data).digest("hex");
  if (data.byteLength !== file.bytes || hash !== file.sha256) {
    throw new Error(`Runtime integrity check failed: ${file.path}`);
  }
}

const listed = new Set(manifest.files.map((file) => file.path));
const unlisted = actualFiles
  .map((path) => relative(runtimeDirectory, path).replaceAll("\\", "/"))
  .filter((path) => path !== "runtime-manifest.json" && !listed.has(path));
if (unlisted.length > 0) throw new Error(`Unlisted runtime files: ${unlisted.join(", ")}`);

const bytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
console.log(`Verified ${manifest.files.length} runtime files (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);

async function walk(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}


const payloadRoot = join(extensionDirectory, "runtime");
const payload = JSON.parse(await readFile(join(payloadRoot, "payload-manifest.json"), "utf8"));
for (const file of payload.files) {
  if (file.path.split("/").some((part) => [".env", ".git", ".venv", "auth.json", "connection.json"].includes(part))) throw new Error(`Private file in payload: ${file.path}`);
  const data = await readFile(join(payloadRoot, file.path));
  if (createHash("sha256").update(data).digest("hex") !== file.sha256) throw new Error(`Payload mismatch: ${file.path}`);
}
for (const path of [
  "vendor/node/node.exe",
  "logos-agent/pi-domain/prompts/system.md",
  "logos-agent/pi-domain/prompts/append.md",
  "logos-agent/pi-domain/extensions/index.mjs",
  "logos-agent/pi-domain/skills/logos-simulation-workflow/SKILL.md",
  "logos-agent/pi-domain/skills/gmsh/SKILL.md",
  "logos-agent/pi-domain/skills/kicad/SKILL.md",
]) await access(join(payloadRoot, path));
console.log(`Verified complete LOGOS payload: ${payload.files.length} files, Node ${payload.node}`);
