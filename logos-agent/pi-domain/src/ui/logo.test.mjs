import assert from "node:assert/strict";
import test from "node:test";
import { logoOptions, renderLogo, renderWordmark } from "./logo.mjs";

const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

test("default image lettering shares the existing animated emblem", () => {
  assert.equal(logoOptions({}).wordmark, "image");
  const first = renderLogo({ width: 100, color: false });
  const later = renderLogo({ width: 100, color: false, elapsedMs: 1500 });
  assert.deepEqual(first, renderLogo({ width: 100, color: false, elapsedMs: 3000 }));
  assert.notDeepEqual(first, later);
  assert.deepEqual(first.map((line) => line.slice(18)), later.map((line) => line.slice(18)));
});

test("image wordmark has a fixed character canvas and brand colors", () => {
  const rows = renderWordmark({ wordmark: "image" });
  assert.equal(rows.length, 8);
  assert.ok(rows.every((row) => plain(row).length === 48));
  const text = rows.join("\n");
  for (const rgb of ["238;245;249", "90;187;235", "222;168;91"]) {
    assert.ok(text.includes(`\x1b[38;2;${rgb}m`));
  }
  const ascii = renderWordmark({ wordmark: "image", color: false, ascii: true });
  assert.ok(ascii.every((row) => /^[ -~]*$/.test(row)));
});

test("compact lockup centers the subtitle directly below the lettering", () => {
  const rows = renderLogo({ width: 100, color: false });
  const subtitleIndex = rows.findIndex((row) => row.includes("AIRCRAFT DESIGN & SIMULATION AGENT"));
  assert.equal(rows[subtitleIndex].indexOf("AIRCRAFT"), 18 + 7);
  assert.ok(rows[subtitleIndex - 1].slice(18).trim().length > 0);
  assert.equal(rows.length, 10);
  assert.ok(rows[1].slice(1, 17).trim().length > 0);
  assert.ok(rows[1].slice(18).trim().length > 0);
  assert.equal(subtitleIndex, 8);
});

test("responsive logo fits narrow and wide terminals", () => {
  for (const width of [0, 5, 6, 20, 48, 49, 74, 75, 79, 100]) {
    const rows = renderLogo({ width, color: false });
    assert.ok(rows.every((row) => row.length <= width), `width ${width}`);
  }
});
