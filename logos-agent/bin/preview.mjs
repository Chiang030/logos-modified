import { setTimeout as delay } from "node:timers/promises";
import { DURATION_MS, FRAME_MS, logoOptions, renderLogo } from "../pi-domain/src/ui/logo.mjs";

/** Preview uses no Pi dependencies or model credentials. */
export async function preview({ staticFrame = false, once = false } = {}) {
  const output = process.stdout;
  const options = logoOptions();
  const animate = output.isTTY && options.animate && !staticFrame;
  const render = (elapsedMs = 0) => renderLogo({ ...options,
    width: Math.max(1, (output.columns || 100) - 1), elapsedMs,
    color: Boolean(output.isTTY) && options.color });
  if (!animate) { output.write(render().join("\n") + "\n"); return; }

  let interrupted = false;
  let resized = true;
  let allocatedRows = 0;
  const interrupt = () => { interrupted = true; process.exitCode = 130; };
  const terminate = () => { interrupted = true; process.exitCode = 143; };
  const resize = () => { resized = true; };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  output.on("resize", resize);
  const started = performance.now();
  try {
    // The standalone preview owns this temporary screen; shell history stays intact.
    output.write("\x1b[?1049h\x1b[?25l");
    while (!interrupted) {
      const elapsedMs = performance.now() - started;
      const frame = render(once ? Math.min(elapsedMs, DURATION_MS) : elapsedMs)
        .slice(0, Math.max(1, (output.rows || 30) - 1));
      if (resized || allocatedRows !== frame.length) {
        // Allocate before anchoring so the initial frame cannot scroll its anchor.
        // Rebuild after resize because terminal reflow invalidates saved positions.
        output.write("\x1b[H\x1b[2J" + "\n".repeat(frame.length)
          + `\x1b[${frame.length}A\r\x1b[s`);
        allocatedRows = frame.length;
        resized = false;
      }
      output.write("\x1b[u" + frame.map((line) => `\x1b[2K${line}`).join("\r\n"));
      if (once && elapsedMs >= DURATION_MS) break;
      await delay(FRAME_MS);
    }
  } finally {
    try {
      output.write("\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?25h");
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      output.off("resize", resize);
    }
  }
  output.write(render().join("\n") + "\n");
}
