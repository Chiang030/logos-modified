import { build } from "esbuild";

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

await build({
  entryPoints: ["webview-ui/src/styles.css"],
  bundle: true,
  outfile: "dist/webview.css",
  minify: false,
  loader: { ".ttf": "dataurl" },
});
