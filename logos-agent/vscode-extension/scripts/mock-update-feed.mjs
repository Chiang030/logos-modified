// Serves a GitHub-shaped releases feed plus one local VSIX asset, for testing the
// in-extension updater without touching the real release channel.
// Usage: node scripts/mock-update-feed.mjs --version 0.2.1 --asset logos-vscode-0.2.1-win32-x64.vsix [--port 4890]
// Then set logos.update.feedUrl to http://127.0.0.1:<port>/api and run LOGOS: Check for Updates.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const version = args.version ?? "0.2.1";
const assetPath = args.asset;
const port = Number(args.port ?? 4890);
if (!assetPath) {
  console.error("Usage: node scripts/mock-update-feed.mjs --version <version> --asset <vsix-path> [--port 4890]");
  process.exit(1);
}

const assetName = basename(assetPath);
const assetData = await readFile(assetPath);
const releases = [{
  tag_name: `vscode-v${version}`,
  html_url: `http://127.0.0.1:${port}/releases/vscode-v${version}`,
  draft: false,
  assets: [{ id: 1, name: assetName, url: `http://127.0.0.1:${port}/download/${encodeURIComponent(assetName)}` }],
}];

createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/api/releases") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(releases));
  } else if (url.pathname === `/download/${encodeURIComponent(assetName)}`) {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": assetData.byteLength });
    response.end(assetData);
  } else {
    response.writeHead(404);
    response.end("not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Mock update feed listening on http://127.0.0.1:${port}`);
  console.log(`Set logos.update.feedUrl = http://127.0.0.1:${port}/api (serves v${version}, asset ${assetName})`);
});

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (!key || index + 1 >= argv.length) throw new Error(`Malformed arguments: ${argv.join(" ")}`);
    parsed[key] = argv[index + 1];
  }
  return parsed;
}
