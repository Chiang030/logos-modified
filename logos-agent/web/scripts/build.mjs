import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

await mkdir("dist", { recursive: true });
await build({entryPoints:["server/openai-auth-adapter.ts"],bundle:true,outfile:"dist/openai-auth.mjs",platform:"node",format:"esm",inject:["server/openai-fetch.ts"]});
execFileSync(process.execPath, ["../vscode-extension/node_modules/tailwindcss/lib/cli.js",
  "-c", "tailwind.config.cjs", "-i", "ui/styles.css", "-o", "dist/app.css", "--minify"], { stdio: "inherit" });
await build({ entryPoints: ["ui/main.tsx"], bundle: true, outfile: "dist/app.js", platform: "browser", format: "iife",
  loader: { ".png": "dataurl" }, alias: { react: resolve("node_modules/react"), "react-dom": resolve("node_modules/react-dom") } });
await copyFile("ui/index.html", "dist/index.html");

await build({entryPoints:["worker/main.ts"],bundle:true,outfile:"dist/worker.mjs",platform:"node",format:"esm",packages:"external"});
