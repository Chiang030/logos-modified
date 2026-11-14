import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

execFileSync(process.execPath, ["node_modules/tailwindcss/lib/cli.js", "-c", "tailwind.config.cjs", "-i", "webview-ui/src/tailwind.css", "-o", "dist/webview-tailwind.css", "--minify"], { cwd: process.cwd(), windowsHide: true, stdio: "inherit" });

const webview = await build({
  entryPoints: ["webview-ui/src/main.tsx"],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: "dist/webview.js",
  sourcemap: false,
  minify: false,
  metafile: true,
  loader: { ".tsx": "tsx", ".png": "dataurl", ".ttf": "dataurl" },
});
// esbuild writes imported component styles beside webview.js; do not let that
// replace the Tailwind shell generated above, including after incremental builds.
const componentCss = Object.keys(webview.metafile.outputs).includes("dist/webview.css")
  ? await readFile("dist/webview.css", "utf8") : "";
await writeFile("dist/webview.css", (await readFile("dist/webview-tailwind.css", "utf8")) + "\n" + componentCss);

