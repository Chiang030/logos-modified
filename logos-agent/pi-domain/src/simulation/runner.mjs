import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ACTIONS = ["help", "doctor", "discover", "probe", "verify", "check", "launch", "attach", "connect", "exec", "inspect", "detach", "disconnect", "run"];

export async function runSimulation(params, { cwd, signal, command, timeoutMs = 60000 } = {}) {
  if (!ACTIONS.includes(params.action)) throw new Error("Unsupported simulation action");
  const python = fileURLToPath(new URL(process.platform === "win32" ? "../../../integrations/.venv/Scripts/python.exe" : "../../../integrations/.venv/bin/python", import.meta.url));
  const configured = command ?? (process.env.LOGOS_SIM_COMMAND ? JSON.parse(process.env.LOGOS_SIM_COMMAND)
    : existsSync(python) ? [python, "-m", "sim"] : ["sim"]);
  if (!Array.isArray(configured) || !configured.length || configured.some((v) => typeof v !== "string" || !v)) {
    throw new Error("LOGOS_SIM_COMMAND must be a JSON array of executable and fixed arguments");
  }
  const operationId = randomUUID();
  const directory = join(cwd, ".logos", "simulation", "operations", operationId);
  await mkdir(directory, { recursive: true });
  const argv = [...configured.slice(1)];
  if (!command) argv.push("--json", "--no-interactive");
  if (params.host) argv.push("--host", params.host);
  if (params.port) argv.push("--port", String(params.port));
  if (params.session) argv.push("--session", params.session);
  argv.push(...(params.action === "help" ? ["--help"] : [params.action]));
  argv.push(...(params.args ?? []));
  const limit = params.timeout_ms ?? timeoutMs;
  let stdout = "", stderr = "", stopReason, processError, truncated = false;
  const cap = 1024 * 1024;
  const capture = (current, chunk) => {
    const next = current + chunk.toString();
    if (next.length > cap) truncated = true;
    return next.slice(0, cap);
  };
  const status = await new Promise((resolve) => {
    if (signal?.aborted) { stopReason = "Cancelled"; resolve({ code: null, signal: null }); return; }
    const child = spawn(configured[0], argv, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = (reason) => { stopReason ??= reason; child.kill("SIGKILL"); };
    const abort = () => stop("Cancelled");
    const timer = setTimeout(() => stop("Timeout"), limit);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = capture(stderr, chunk); });
    child.on("error", (error) => { processError = error; });
    child.on("close", (code, killedSignal) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      resolve({ code, signal: killedSignal });
    });
  });
  let payload = null;
  try { payload = JSON.parse(stdout); } catch { /* Unstructured CLI output is not script evidence. */ }
  const transportOk = !processError && !stopReason && (typeof payload?.transport_ok === "boolean"
    ? payload.transport_ok : status.code === 0 && payload?.ok !== false);
  // Never infer script success from CLI exit status or transport success.
  const scriptOk = typeof payload?.script_ok === "boolean" ? payload.script_ok
    : typeof payload?.data?.script_ok === "boolean" ? payload.data.script_ok : null;
  let error = stopReason ? { type: stopReason, message: "The CLI client was stopped; remote operation state must be inspected before retrying." }
    : processError ? { type: processError.code ?? "ProcessError", message: processError.message }
      : payload?.error ?? payload?.data?.error ?? (status.code !== 0 ? { type: "CliError", message: stderr || `CLI exited with ${status.code}` } : null);
  if (typeof error === "string") error = { type: scriptOk === false ? "ScriptError" : "CliError", message: error };
  const result = {
    operation_id: operationId, stage: params.action, backend: "sim_cli", command: configured[0],
    transport_ok: transportOk, script_ok: scriptOk, acceptance: "not_evaluated",
    error, exit_code: status.code, signal: status.signal, output_truncated: truncated,
    stdout, stderr, payload, artifacts: [join(directory, "stdout.txt"), join(directory, "stderr.txt"), join(directory, "result.json")],
    remote_state: stopReason ? "unknown" : "not_inferred",
  };
  await Promise.all([writeFile(result.artifacts[0], stdout), writeFile(result.artifacts[1], stderr), writeFile(result.artifacts[2], JSON.stringify(result, null, 2))]);
  return result;
}
