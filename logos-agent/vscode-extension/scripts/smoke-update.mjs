// Exercise the real updater inside an isolated VS Code extension host.
// Usage: node scripts/smoke-update.mjs --code <Code.exe> --asset <existing VSIX>
// Add --live to download the same release through the actual public update feed.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const live = args.includes("--live");
const option = (name) => args[args.indexOf(name) + 1];
if (!args.includes("--code") || !args.includes("--asset")) throw new Error("Supply --code and --asset.");
const assetPath = resolve(option("--asset"));
const match = assetPath.match(/logos-vscode-(win32|linux|darwin)-(x64|arm64)-(\d+\.\d+\.\d+)\.vsix$/);
if (!match || match[1] !== process.platform || match[2] !== process.arch) throw new Error("Use a VSIX for the host platform.");
const version = match[3];
const bytes = await readFile(assetPath);
const root = await mkdtemp(join(tmpdir(), "logos-update-smoke-"));
const extension = join(root, "harness");
const data = join(root, "data");
const extensions = join(root, "extensions");
await mkdir(extension); await mkdir(join(data, "User"), { recursive: true }); await mkdir(extensions);
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  if (request.url === "/asset.vsix") {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length }); response.end(bytes);
  } else if (request.url === "/api/releases?per_page=30") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify([{ tag_name: `v${version}`, assets: [{ id: 1,
      name: `logos-vscode-${process.platform}-${process.arch}-${version}.vsix`,
      url: `http://127.0.0.1:${server.address().port}/asset.vsix`, size: bytes.length,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }] }]));
  } else { response.writeHead(404); response.end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
try {
  const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  await writeFile(join(extension, "package.json"), JSON.stringify({ name: "logos-update-smoke", publisher: "logos-test",
    version: "0.3.8", engines: source.engines, main: "main.cjs", activationEvents: ["onStartupFinished"],
    contributes: { configuration: source.contributes.configuration } }));
  await writeFile(join(data, "User", "settings.json"), JSON.stringify({
    "logos.update.feedUrl": live ? source.contributes.configuration.properties["logos.update.feedUrl"].default
      : `http://127.0.0.1:${server.address().port}/api`, "logos.update.autoCheck": true,
    "logos.update.autoInstall": true, "extensions.autoUpdate": false, "update.mode": "none",
    "security.workspace.trust.enabled": false, "workbench.startupEditor": "none",
  }));
  const entry = `import * as vscode from "vscode";
import { registerUpdateChecks } from ${JSON.stringify(fileURLToPath(new URL("../src/updateChecker.ts", import.meta.url)))};
export function activate(context) {
  context.subscriptions.push(registerUpdateChecks(context));
  context.subscriptions.push(vscode.commands.registerCommand('logos.smoke.result', () => context.globalState.get('logos.update.lastSuccessfulCheck.v2')));
}`;
  await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "cjs",
    external: ["vscode"], outfile: join(extension, "main.cjs") });
  await writeFile(join(extension, "tests.cjs"), `const vscode=require('vscode'); const fs=require('node:fs/promises');
exports.run=async()=>{
  await vscode.extensions.getExtension('logos-test.logos-update-smoke').activate();
  const deadline=Date.now()+${live ? 600_000 : 120_000}; let result;
  while(Date.now()<deadline){ result=await vscode.commands.executeCommand('logos.smoke.result'); if(result)break; await new Promise(r=>setTimeout(r,250)); }
  if(!result)throw new Error('Automatic update did not finish; inspect LOGOS Updates in the isolated logs');
  await fs.writeFile(${JSON.stringify(join(root, "result.json"))},JSON.stringify(result));
};`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = spawn(resolve(option("--code")), ["--user-data-dir", data, "--extensions-dir", extensions,
    "--extensionDevelopmentPath", extension, "--extensionTestsPath", join(extension, "tests.cjs"),
    "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const logs = []; code.stdout.on("data", (chunk) => logs.push(chunk.toString())); code.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  console.log(`Running ${live ? "public GitHub" : "local fixture"} update smoke; isolated profile: ${root}`);
  const timeout = setTimeout(() => code.kill(), live ? 630_000 : 150_000);
  let exitCode;
  try { exitCode = await new Promise((done, reject) => { code.on("error", reject); code.on("exit", done); }); }
  finally { clearTimeout(timeout); await writeFile(join(root, "host.log"), logs.join("")); }
  if (exitCode !== 0) throw new Error(`VS Code smoke failed (${exitCode}); logs: ${root}`);
  await readFile(join(root, "result.json"));
  const installed = JSON.parse(await readFile(join(extensions, "extensions.json"), "utf8"));
  if (!installed.some((item) => item.identifier.id === "logos.logos-vscode" && item.version === version)) {
    throw new Error(`Updater did not install LOGOS ${version} in the isolated profile: ${root}`);
  }
  if (!live && (!requests.includes("/api/releases?per_page=30") || !requests.includes("/asset.vsix"))) throw new Error("Update network flow was not exercised.");
  console.log(`Automatic update smoke passed (${live ? "public GitHub" : "local fixture"}): startup check, HTTP download, SHA-256 verification and real VS Code installation of LOGOS ${version}. Evidence: ${root}`);
} finally { await new Promise((done) => server.close(done)); }
