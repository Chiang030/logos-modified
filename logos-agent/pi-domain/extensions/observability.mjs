import { readConfig } from "../src/observability/config.mjs";

/** Disabled path loads neither OTel nor Langfuse. Every handler remains observational. */
export async function registerObservability(pi, options = {}) {
  const config = options.config ?? readConfig();
  if (!config.enabled) return null;
  try {
    const [{ getRuntime }, { Controller, EVENTS }] = await Promise.all([
      import("../src/observability/exporter.mjs"), import("../src/observability/controller.mjs"),
    ]);
    const runtime = options.runtime ?? getRuntime(config);
    if (!runtime) return null;
    const controller = new Controller(runtime, config);
    let timer;
    controller.dispose = () => { clearInterval(timer); timer = undefined; controller.finish("extension_disposed"); };
    let reported = false;
    for (const type of EVENTS) pi.on(type, async (event, ctx) => {
      try {
        if (type === "session_start" && !timer) {
          timer = setInterval(() => { try { controller.expire(); } catch { /* Passive watchdog. */ } }, 60000);
          timer.unref();
        }
        if (type === "session_shutdown") { clearInterval(timer); timer = undefined; }
        await controller.handle(event, ctx);
      }
      catch { if (!reported) { process.stderr.write("[logos-observability] telemetry error; agent continues\n"); reported = true; } }
      return undefined;
    });
    return controller;
  } catch {
    process.stderr.write("[logos-observability] unavailable; agent continues\n"); return null;
  }
}
