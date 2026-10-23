import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

interface PilotOptions {
  enabled: boolean;
  dataDirectory: string;
}

interface PreparedRuntime {
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Attach the installed Pilot extension explicitly to LOGOS's isolated Pi process. */
export async function preparePilotTelemetry(runtime: PreparedRuntime, options: PilotOptions): Promise<PreparedRuntime & { detail: string }> {
  if (!options.enabled) return { ...runtime, detail: "LoongSuite Pilot tracing is disabled." };
  const directory = options.dataDirectory.trim() || join(homedir(), ".loongsuite-pilot");
  const extension = join(directory, "plugins", "pi-coding-agent", "index.mjs");
  const files = [extension, join(directory, "plugins", "shared", "resource-context.mjs"), join(directory, "config.json")];
  if (!isAbsolute(directory) || !await filesExist(files)) {
    return { ...runtime, detail: "LoongSuite Pilot tracing unavailable: install Pilot or correct logos.observability.pilotDataDirectory, then restart LOGOS." };
  }
  return {
    args: [...runtime.args, "-e", extension],
    env: { ...runtime.env, LOONGSUITE_PILOT_DATA_DIR: directory },
    detail: `LoongSuite Pilot extension enabled: ${extension}. Check Pilot status/info for export health.`,
  };
}

async function filesExist(paths: string[]): Promise<boolean> {
  try { return (await Promise.all(paths.map((path) => stat(path)))).every((entry) => entry.isFile()); }
  catch { return false; }
}
