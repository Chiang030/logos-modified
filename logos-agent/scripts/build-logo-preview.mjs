import { readFile, mkdir, writeFile } from "node:fs/promises";
import { renderLogo, DURATION_MS } from "../pi-domain/src/ui/logo.mjs";

const directory = new URL("../previews/", import.meta.url);
await mkdir(directory, { recursive: true });
const raster = (await readFile(new URL("../pi-domain/src/ui/logo-raster.mjs", import.meta.url), "utf8"))
  .replace(/^export /gm, "");
const renderer = (await readFile(new URL("../pi-domain/src/ui/logo.mjs", import.meta.url), "utf8"))
  .replace(/^import .*logo-raster\.mjs";\r?\n/m, "")
  .replace(/^export /gm, "");
const template = await readFile(new URL("./logo-preview.template.html", import.meta.url), "utf8");
await writeFile(new URL("logos-orbit.html", directory), template.replace("/* LOGOS_RENDERER */", () => `${raster}\n${renderer}`));
await writeFile(new URL("logos-static.txt", directory), renderLogo({ width: 108, color: false }).join("\n") + "\n");
await writeFile(new URL("logos-ascii.txt", directory), renderLogo({ width: 108, color: false, ascii: true }).join("\n") + "\n");
await writeFile(new URL("logos-frames.json", directory), JSON.stringify({
  duration: DURATION_MS, columns: 108,
  frames: Array.from({ length: 160 }, (_, i) => renderLogo({ width: 108, elapsedMs: i * 50 })),
}));
console.log("Built previews/logos-orbit.html, logos-static.txt, logos-ascii.txt and logos-frames.json");
