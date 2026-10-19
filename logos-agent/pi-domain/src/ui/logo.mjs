import { IMAGE_ASCII } from "./logo-raster.mjs";

/** Character-only LOGOS mark, traced from the supplied paper-plane photograph. */
export const DURATION_MS = 3000;
export const FRAME_MS = 33;

const RESET = "\x1b[0m";
const PALETTE = {
  ring: [55, 128, 162],
  blue: [90, 187, 235],
  white: [238, 245, 249],
  gold: [222, 168, 91],
  star: [255, 216, 133],
  trail: [137, 114, 76],
  label: [130, 151, 171],
};
const WORDMARK_STYLES = ["image", "split", "orbit", "wing", "flow"];
const LETTER_STARTS = [0, 17, 37, 57, 77];
const WING_CONTOURS = {
  L: [[0, 0], [5, 0], [5, 21], [15, 21], [12, 26], [0, 26]],
  O: [[4, 0], [13, 0], [17, 5], [17, 22], [13, 26], [4, 26], [0, 21], [0, 4]],
  S: [[4, 0], [16, 0], [13, 5], [5, 5], [5, 10], [12, 10], [16, 14], [16, 22],
    [12, 26], [0, 26], [3, 21], [11, 21], [11, 16], [4, 16], [0, 12], [0, 4]],
};
const SUBTITLE = "AIRCRAFT DESIGN & SIMULATION AGENT";
const CENTER = [0.51, 0.53];
const RADIUS = 0.355;
const START_ANGLE = Math.PI * 0.76;
const TIP = [0.79, 0.075];
const LEFT = [0.105, 0.55];
const FOLD = [0.485, 0.535];
const BOTTOM = [0.67, 0.925];
// Braille gives each terminal cell a 2 x 4 grid, keeping the ring round at 1:2 cells.
const DOTS = [[0, 0, 1], [0, 1, 2], [0, 2, 4], [1, 0, 8],
  [1, 1, 16], [1, 2, 32], [0, 3, 64], [1, 3, 128]];

/** Explicit terminal preferences apply to both the preview and Pi header. */
export function logoOptions(env = process.env) {
  const plain = Object.hasOwn(env, "NO_COLOR") || env.TERM === "dumb";
  return {
    color: !plain,
    animate: !plain && env.LOGOS_NO_ANIMATION !== "1",
    ascii: env.LOGOS_ASCII === "1" || env.TERM === "dumb",
    wordmark: WORDMARK_STYLES.includes(env.LOGOS_WORDMARK) ? env.LOGOS_WORDMARK : "image",
  };
}

function triangle(x, y, a, b, c) {
  const cross = (p, q) => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
  const signs = [cross(a, b), cross(b, c), cross(c, a)];
  return !(signs.some((v) => v < 0) && signs.some((v) => v > 0));
}

function segmentDistance(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(x - a[0], y - a[1]);
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

/** A sample is a semantic ink, not an image pixel or terminal control sequence. */
function sample(x, y, angle) {
  const sx = CENTER[0] + RADIUS * Math.cos(angle);
  const sy = CENTER[1] + RADIUS * Math.sin(angle);
  const dx = Math.abs(x - sx), dy = Math.abs(y - sy);
  // Concave four-point star. Clear the ring locally so its silhouette stays distinct.
  if (Math.sqrt(dx / 0.071) + Math.sqrt(dy / 0.074) <= 1) return "star";
  if (Math.hypot(dx, dy) < 0.058) return null;

  if (triangle(x, y, LEFT, TIP, BOTTOM)) {
    if (segmentDistance(x, y, TIP, FOLD) < 0.008) return null;
    if (triangle(x, y, LEFT, TIP, FOLD)) return "blue";
    if (triangle(x, y, TIP, BOTTOM, FOLD)) return "gold";
    if (triangle(x, y, LEFT, FOLD, BOTTOM)) return "white";
    return null;
  }

  const r = Math.hypot(x - CENTER[0], y - CENTER[1]);
  if (Math.abs(r - RADIUS) < 0.0085) return "ring";
  for (let i = 1; i <= 3; i++) {
    const behind = angle - i * 0.14;
    const tx = CENTER[0] + RADIUS * Math.cos(behind);
    const ty = CENTER[1] + RADIUS * Math.sin(behind);
    if (Math.hypot(x - tx, y - ty) < 0.013 - i * 0.002) return "trail";
  }
  return null;
}

function encode(cells, color) {
  let result = "", current = "";
  for (const [glyph, ink] of cells) {
    if (color && ink && ink !== current) {
      const rgb = PALETTE[ink] ?? ink;
      result += `\x1b[38;2;${rgb.join(";")}m`;
      current = ink;
    }
    result += glyph;
  }
  return result + (color && current ? RESET : "");
}

/** Smoothly accelerate then coast; positive speed and matching seam derivatives. */
export function orbitAngle(elapsedMs) {
  const phase = ((elapsedMs % DURATION_MS) / DURATION_MS) * Math.PI * 2;
  return START_ANGLE + phase - 0.72 * Math.sin(phase);
}

function iconRows(columns, elapsedMs, color, ascii) {
  const height = columns / 2;
  const angle = orbitAngle(elapsedMs);
  return Array.from({ length: height }, (_, row) => {
    const cells = Array.from({ length: columns }, (_, col) => {
      let bits = 0;
      const hits = {};
      for (const [dx, dy, bit] of DOTS) {
        // Fixed bounds include the complete orbit and star at every phase,
        // avoiding invisible padding without shifting the icon during animation.
        const x = 0.08 + (col * 2 + dx + 0.5) / (columns * 2) * 0.86;
        const y = 0.06 + (row * 4 + dy + 0.5) / (height * 4) * 0.90;
        const ink = sample(x, y, angle);
        if (ink) { bits |= bit; hits[ink] = (hits[ink] ?? 0) + 1; }
      }
      const ink = hits.star ? "star" : Object.keys(hits).sort((a, b) => hits[b] - hits[a])[0];
      const count = Object.values(hits).reduce((a, b) => a + b, 0);
      const glyph = !bits ? " " : ascii ? (ink === "star" ? "*" : " .:-=+*#@"[count]) : String.fromCharCode(0x2800 + bits);
      return [glyph, ink];
    });
    return encode(cells, color);
  });
}

function polygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function curve(a, b, c, d) {
  return Array.from({ length: 17 }, (_, i) => {
    const t = i / 16, u = 1 - t;
    return [0, 1].map((axis) => u ** 3 * a[axis] + 3 * u ** 2 * t * b[axis]
      + 3 * u * t ** 2 * c[axis] + t ** 3 * d[axis]);
  });
}

// The baseline of L flows into the first O. O, G and S share the same soft turns.
const ORBIT_L = [[2, 2], [2, 18], ...curve([2, 18], [2, 24], [5, 25], [10, 25]), [25, 25]];
const ORBIT_S = [
  [14, 3], [7, 3], ...curve([7, 3], [-1, 3], [-1, 13], [7, 13]),
  ...curve([7, 13], [17, 13], [17, 25], [7, 25]), [0, 25],
];

function pathDistance(x, y, path) {
  let nearest = Infinity;
  for (let i = 1; i < path.length; i++) nearest = Math.min(nearest, segmentDistance(x, y, path[i - 1], path[i]));
  return nearest;
}

function ringDistance(x, y) {
  // Capsule shaped orbital ports: identical geometry for both O's and the G body.
  const cy = Math.max(9, Math.min(18, y));
  return Math.abs(Math.hypot(x - 8, y - cy) - 7);
}

function orbitSample(x, y, index) {
  if (index === 0) return pathDistance(x, y, ORBIT_L) <= 1.8 ? "body" : null;
  if (index === 4) return pathDistance(x, y, ORBIT_S) <= 1.8 ? "body" : null;
  if (index === 2) {
    // A launch vector occupies G's open counter; it remains a G at monochrome size.
    if (polygon(x, y, [[7, 14], [18, 14], [18, 19], [14, 23], [14, 17], [7, 17]])) return "gold";
    if (x > 9 && y > 6 && y < 17) return null;
  }
  if (ringDistance(x, y) > 1.8) return null;
  // A cut and a short gold arc locate each O on the same visual orbit as the icon.
  if (index !== 2 && x > 11 && y < 9) return y > 5.5 ? null : "gold";
  return "body";
}

function wingSample(x, y, index) {
  const letter = "LOGOS"[index];
  if (!polygon(x, y, WING_CONTOURS[letter === "G" ? "O" : letter])) return null;
  if (index === 1 || index === 2 || index === 3) {
    // A swept wing, cut out of the letter rather than pasted over the wordmark.
    if (polygon(x, y, [[5, 5], [13, 3], [11, 21], [5, 22]])) {
      if (index === 2 && y >= 13 && y <= 17 && x >= 8) return "gold";
      return null;
    }
    if (index === 2 && x >= 11 && y > 5 && y < 13) return null;
  }
  if (index === 2 && y >= 13 && y <= 17 && x >= 8) return "gold";
  if (index !== 0 && Math.abs(y - (8 + x * 0.42)) < 0.7) return null;
  return "body";
}

function flowSample(x, y, index) {
  const distance = index === 0 ? pathDistance(x, y, ORBIT_L)
    : index === 4 ? pathDistance(x, y, ORBIT_S) : ringDistance(x, y);
  if (index === 2) {
    if (x >= 8 && x <= 17 && Math.abs(y - 15.5) < 1) return "gold";
    if (x > 9 && y > 6 && y < 15) return null;
  }
  // Paired contours read as streamlines with deliberate, continuous negative space.
  return Math.abs(distance - 1.65) < 0.65 ? "body" : null;
}

function splitSample(x, y, index) {
  // Undo the forward rake before testing the glyph. The upper edges move
  // farther right, matching the heavy italic construction in the artwork.
  const sourceX = x - (28 - y) * 0.22;
  let ink = null;
  if (index === 0) {
    ink = polygon(sourceX, y, [[1, 0], [8, 0], [5, 22], [17, 22], [15, 28], [-2, 28]]) ? "body" : null;
  } else if (index === 1 || index === 3) {
    const outer = ((sourceX - 8.5) / 9) ** 2 + ((y - 14) / 14) ** 2 <= 1;
    const inner = ((sourceX - 8.5) / 4.1) ** 2 + ((y - 14) / 7.2) ** 2 < 1;
    ink = outer && !inner ? "body" : null;
  } else if (index === 2) {
    const outer = ((sourceX - 8.5) / 9) ** 2 + ((y - 14) / 14) ** 2 <= 1;
    const inner = ((sourceX - 8.5) / 4.1) ** 2 + ((y - 14) / 7.2) ** 2 < 1;
    const ring = outer && !inner && !(sourceX > 9 && y > 7 && y < 15);
    const bar = sourceX >= 8 && sourceX <= 18 && y >= 14.5 && y <= 19;
    ink = bar ? "gold" : ring ? "body" : null;
  } else {
    const stroke = 5.2;
    const pieces = [
      segmentDistance(sourceX, y, [4, 2.6], [17, 2.6]),
      segmentDistance(sourceX, y, [3, 3], [1.5, 12]),
      segmentDistance(sourceX, y, [2, 12], [14, 16]),
      segmentDistance(sourceX, y, [14, 16], [13, 25]),
      segmentDistance(sourceX, y, [13, 25], [0, 25]),
    ];
    ink = Math.min(...pieces) <= stroke / 2 ? "body" : null;
  }
  if (!ink) return null;
  const globalX = LETTER_STARTS[index] + x;
  if (Math.abs(y - (19.5 - 0.115 * globalX)) < 0.72) return null;
  return ink;
}

// The reference wordmark is split by one continuous rising seam.  Keeping
// this as a separate rule lets every wordmark study share the same white/blue
// palette while retaining its own silhouette and negative space.
function wordmarkColor(ink, x, y) {
  if (ink !== "body") return ink;
  const seam = 20 - 0.15 * x;
  return y <= seam ? "white" : "blue";
}

function letterSample(x, y, style) {
  x -= 2; y -= 2;
  if (y < 0 || y > 28) return null;
  for (let index = 0; index < 5; index++) {
    const local = x - LETTER_STARTS[index];
    if (local < -2 || local > (index === 0 && style !== "wing" ? 26 : 18)) continue;
    const ink = style === "split" ? splitSample(local, y, index)
      : style === "wing" ? wingSample(local, y, index)
      : style === "flow" ? flowSample(local, y, index) : orbitSample(local, y, index);
    if (ink) return ink;
  }
  return null;
}

const wordmarkCache = new Map();

// A fixed 48 x 8 cell canvas. No width-dependent stretching, shearing or font swaps.
export function renderWordmark({ color = true, ascii = false, wordmark = "split" } = {}) {
  wordmark = WORDMARK_STYLES.includes(wordmark) ? wordmark : "split";
  const key = `${wordmark}:${Boolean(color)}:${Boolean(ascii)}`;
  if (wordmarkCache.has(key)) return wordmarkCache.get(key).slice();
  const rows = wordmark === "image" ? renderImageWordmark(color, ascii)
    : Array.from({ length: 8 }, (_, row) => encode(Array.from({ length: 48 }, (_, col) => {
    let bits = 0, count = 0;
    const inkCounts = {};
    for (const [dx, dy, bit] of DOTS) {
      const x = col * 2 + dx + 0.5;
      const y = row * 4 + dy + 0.5;
      const ink = wordmarkColor(letterSample(x, y, wordmark), x, y);
      if (ink) { bits |= bit; count++; inkCounts[ink] = (inkCounts[ink] ?? 0) + 1; }
    }
    const glyph = !bits ? " " : ascii ? " .:-=+*#@"[count] : String.fromCharCode(0x2800 + bits);
    const ink = Object.keys(inkCounts).sort((a, b) => inkCounts[b] - inkCounts[a])[0] ?? null;
    return [glyph, ink ?? [Math.round(118 + col), Math.round(202 + col / 3), 229]];
  }), color));
  wordmarkCache.set(key, rows);
  return rows.slice();
}

function subtitleRows(width, color) {
  const lines = [""];
  for (const word of SUBTITLE.split(" ")) {
    if (lines.at(-1).length + word.length + 1 > width && lines.at(-1)) lines.push("");
    for (let i = 0; i < word.length; i += width) {
      if (i) lines.push("");
      lines[lines.length - 1] += (lines.at(-1) ? " " : "") + word.slice(i, i + width);
    }
  }
  return lines.map((line) => encode([[line, "label"]], color));
}

const ASCII_DENSITY = " .:-=+*#%@";

// Crop only the lettering from the supplied conversion; the emblem is rendered
// independently so its existing orbit animation is never baked into this raster.
const IMAGE_WORDMARK = IMAGE_ASCII.slice(3, 17).map((line) => line.slice(41, 148).padEnd(107));

function renderImageWordmark(color, ascii) {
  return Array.from({ length: 8 }, (_, row) => encode(Array.from({ length: 48 }, (_, col) => {
    let bits = 0, density = 0;
    const inks = {};
    for (const [dx, dy, bit] of DOTS) {
      const x = Math.min(106, Math.floor((col * 2 + dx + 0.5) * 107 / 96));
      const y = Math.min(13, Math.floor((row * 4 + dy + 0.5) * 14 / 32));
      const level = ASCII_DENSITY.indexOf(IMAGE_WORDMARK[y][x]);
      if (level < 3) continue;
      bits |= bit;
      density++;
      const ink = x >= 53 && x <= 65 && y >= 5 && y <= 6 ? "gold"
        : IMAGE_WORDMARK[y][x] === "*" || IMAGE_WORDMARK[y][x] === "+" ? "blue" : "white";
      inks[ink] = (inks[ink] ?? 0) + 1;
    }
    const glyph = !bits ? " " : ascii ? " .:-=+*#@"[density] : String.fromCharCode(0x2800 + bits);
    const ink = Object.keys(inks).sort((a, b) => inks[b] - inks[a])[0];
    return [glyph, ink];
  }), color));
}

/** Preserve the wordmark's proportions; narrow terminals stack the two elements. */
export function renderLogo({ width = 100, elapsedMs = 0, color = true, ascii = false, wordmark = "image" } = {}) {
  width = Math.max(0, Math.floor(width));
  if (!Number.isFinite(width) || width < 6) return ["LOGOS".slice(0, width || 0)];
  // The supplied lockup keeps the emblem compact beside the long wordmark.
  const columns = width >= 75 ? 16 : Math.min(16, Math.floor((width - 2) / 2) * 2);
  const mark = iconRows(columns, elapsedMs, color, ascii);
  const words = width >= 49 ? renderWordmark({ color, ascii, wordmark }) : [encode([["LOGOS", "blue"]], color)];
  // Remove empty raster margins without changing the letter canvas itself.
  const hasInk = (line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim().length > 0;
  while (words.length && !hasInk(words[0])) words.shift();
  while (words.length && !hasInk(words.at(-1))) words.pop();
  const sideBySide = width >= 75;
  const gap = " ";
  const labelWidth = sideBySide || width >= 49 ? 48 : width - 1;
  const labels = subtitleRows(labelWidth, color).map((line) => {
    const length = line.replace(/\x1b\[[0-9;]*m/g, "").length;
    return " ".repeat(Math.max(0, Math.floor((labelWidth - length) / 2))) + line;
  });
  const right = [...words, ...labels];
  const top = Math.floor((mark.length - right.length) / 2);
  const lines = sideBySide
    ? mark.map((line, row) => " " + line + gap + (right[row - top] ?? ""))
    : [...mark, "", ...right].map((line) => " " + line);
  return ["", ...lines, ""];
}

/** Orbit without taking input focus. Disposal stops all future repaint requests. */
export function createLogoComponent(requestRender, options = logoOptions()) {
  const started = performance.now();
  let timer;
  let elapsedMs = 0;
  const component = {
    render: (width) => renderLogo({ ...options, width, elapsedMs }),
    invalidate() {},
    dispose() { clearInterval(timer); },
  };
  if (options.animate) {
    timer = setInterval(() => {
      elapsedMs = performance.now() - started;
      requestRender();
    }, FRAME_MS);
    timer.unref?.();
  }
  return component;
}
