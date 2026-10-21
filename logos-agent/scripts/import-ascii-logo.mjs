import { readFile, writeFile } from "node:fs/promises";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/import-ascii-logo.mjs <converted-ascii.txt>");
  process.exit(1);
}

const rows = (await readFile(input, "utf8")).replaceAll("\r", "").split("\n").filter(Boolean);
const background = rows.flatMap((row) => [...row]).reduce((counts, char) => {
  counts.set(char, (counts.get(char) ?? 0) + 1);
  return counts;
}, new Map());
const backgroundChar = [...background].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "%";

const active = rows.map((row) => [...row].filter((char) => char !== backgroundChar).length > 10);
const blocks = [];
for (let start = 0; start < active.length;) {
  if (!active[start]) { start++; continue; }
  let end = start;
  while (end + 1 < active.length && active[end + 1]) end++;
  blocks.push([start, end]);
  start = end + 1;
}
if (blocks.length < 2) throw new Error("Expected at least two artwork blocks in the converted image");

const [start, originalEnd] = blocks[1];
// The converter cannot resolve the tiny subtitle in the source image. Replace
// its final two raster rows with readable terminal text.
const end = Math.max(start, originalEnd - 2);
const sourceRamp = "%@#*+=-:. ";
const targetRamp = " .:-=+*#%@";
const invert = new Map([...sourceRamp].map((char, index) => [char, targetRamp[index]]));
let artwork = rows.slice(start, end + 1).map((row) => [...row].map((char) => invert.get(char) ?? char).join(""));

const left = Math.min(...artwork.map((row) => row.search(/\S/)).filter((value) => value >= 0));
const right = Math.max(...artwork.map((row) => row.search(/\s*$/)));
artwork = artwork.map((row) => row.slice(left, right).replace(/\s+$/, ""));
const width = Math.max(...artwork.map((row) => row.length));
const subtitle = "AIRCRAFT DESIGN & SIMULATION AGENT";
artwork.push("", " ".repeat(Math.max(0, Math.floor((width - subtitle.length) / 2))) + subtitle);

const moduleText = `// Generated from the user-supplied image conversion.\nexport const IMAGE_ASCII = ${JSON.stringify(artwork, null, 2)};\n`;
await writeFile(new URL("../pi-domain/src/ui/logo-raster.mjs", import.meta.url), moduleText);
await writeFile(new URL("../previews/logos-image-ascii.txt", import.meta.url), artwork.join("\n") + "\n");
console.log(`Imported middle artwork block (${artwork.length} rows, ${width} columns)`);
