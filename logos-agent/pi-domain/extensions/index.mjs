import { createLogoComponent, logoOptions } from "../src/ui/logo.mjs";
import { registerSimulationTool } from "./simulation.mjs";

/** Replace only Pi's welcome header; print, JSON and RPC output stay untouched. */
export default function logosExtension(pi) {
  registerSimulationTool(pi);
  let header;
  const stop = () => { header?.dispose(); header = undefined; };
  const show = (ctx) => {
    if (ctx.mode !== "tui") return;
    stop();
    ctx.ui.setHeader((tui) => {
      stop();
      header = createLogoComponent(() => tui.requestRender(), {
        ...logoOptions(),
        wordmark: "image",
      });
      return header;
    });
  };
  pi.on("session_start", (_event, ctx) => show(ctx));
  pi.on("session_shutdown", stop);
  pi.registerCommand("logos", {
    description: "Replay the LOGOS welcome animation",
    handler: async (_args, ctx) => show(ctx),
  });
}
