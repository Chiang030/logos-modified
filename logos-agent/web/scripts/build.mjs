import { build } from "esbuild";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { resolve, basename } from "node:path";

await mkdir("dist", { recursive: true });
await build({entryPoints:["server/openai-auth-adapter.ts"],bundle:true,outfile:"dist/openai-auth.mjs",platform:"node",format:"esm",inject:["server/openai-fetch.ts"]});
execFileSync(process.execPath, ["../vscode-extension/node_modules/tailwindcss/lib/cli.js",
  "-c", "tailwind.config.cjs", "-i", "ui/styles.css", "-o", "dist/tailwind.css", "--minify"], { stdio: "inherit" });
const browser = await build({ entryPoints: { app: "ui/main.tsx" }, bundle: true, outdir: "dist", chunkNames: "chunks/[name]-[hash]", platform: "browser", format: "esm", splitting: true, metafile: true, minify: true,
  plugins: [{ name: "web-logos", setup(builder) {
    builder.onLoad({ filter: /logos_(full_restored_transparent|vscode_icon_512x512)\.png$/ }, async ({ path }) => ({
      contents: await readFile(resolve("ui/assets", basename(path).replace(/\.png$/, ".webp"))), loader: "dataurl",
    }));
  } }],
  loader: { ".png": "dataurl" }, alias: { react: resolve("node_modules/react"), "react-dom": resolve("node_modules/react-dom") } });
// esbuild emits imported component CSS as app.css; preserve the Tailwind shell too.
const componentCss = Object.keys(browser.metafile.outputs).includes("dist/app.css") ? await readFile("dist/app.css", "utf8") : "";
await writeFile("dist/app.css", (await readFile("dist/tailwind.css", "utf8")) + "\n" + componentCss);
await copyFile("ui/index.html", "dist/index.html");
for (const path of [...Object.keys(browser.metafile.outputs), "dist/app.css", "dist/index.html"]) {
  await writeFile(path + ".gz", gzipSync(await readFile(path), { level: 9 }));
}

await build({entryPoints:["worker/main.ts"],bundle:true,outfile:"dist/worker.mjs",platform:"node",format:"esm",packages:"external"});
