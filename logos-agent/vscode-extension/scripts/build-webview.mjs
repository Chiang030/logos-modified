import { build } from "esbuild";
import { execFileSync } from "node:child_process";

execFileSync(process.execPath, ["node_modules/tailwindcss/lib/cli.js", "-c", "tailwind.config.cjs", "-i", "webview-ui/src/tailwind.css", "-o", "dist/webview.css", "--minify"], { cwd: process.cwd(), windowsHide: true, stdio: "inherit" });

await build({
  entryPoints: ["webview-ui/src/main.tsx"],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: "dist/webview.js",
  sourcemap: false,
  minify: false,
  loader: { ".tsx": "tsx", ".png": "dataurl", ".ttf": "dataurl" },
});

