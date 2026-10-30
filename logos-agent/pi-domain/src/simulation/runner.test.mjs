import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSimulation, simulationToolResult } from "./runner.mjs";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "logos-simulation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
test("transport success does not hide nested script failure; operations have independent evidence", async (t) => {
  const cwd = await fixture(t);
  const command = [process.execPath, "-e", 'console.log(JSON.stringify({ok:true,data:{script_ok:false},error:{type:"ScriptError",message:"failed"}}))', "--"];
  const a = await runSimulation({ action: "exec" }, { cwd, command });
  const b = await runSimulation({ action: "exec" }, { cwd, command });
  assert.equal(a.transport_ok, true); assert.equal(a.script_ok, false);
  assert.equal(a.acceptance, "not_evaluated"); assert.equal(a.error.type, "ScriptError");
  assert.equal(simulationToolResult(a).isError, true);
  assert.notEqual(a.operation_id, b.operation_id); assert.notEqual(a.artifacts[2], b.artifacts[2]);
});
test("arguments are passed literally and plain success is not script evidence", async (t) => {
  const result = await runSimulation({ action: "check", args: ["a b", "$(echo bad)"] }, {
    cwd: await fixture(t), command: [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--"],
  });
  assert.deepEqual(result.payload, ["check", "a b", "$(echo bad)"]);
  assert.equal(result.script_ok, null);
  assert.equal(simulationToolResult(result).isError, false);
});
test("script failure CLI exit does not override explicit transport evidence", async (t) => {
  const result = await runSimulation({ action: "exec" }, {
    cwd: await fixture(t), command: [process.execPath, "-e", 'console.log(JSON.stringify({transport_ok:true,ok:false,data:{script_ok:false,error:"inner failure"}}));process.exitCode=1', "--"],
  });
  assert.equal(result.transport_ok, true); assert.equal(result.script_ok, false);
  assert.equal(result.error.type, "ScriptError");
});
test("missing executable, timeout and pre-cancellation return explicit failures", async (t) => {
  const cwd = await fixture(t);
  const missing = await runSimulation({ action: "doctor" }, { cwd, command: [join(cwd, "missing.exe")] });
  assert.equal(missing.transport_ok, false); assert.equal(missing.error.type, "ENOENT");
  assert.equal(simulationToolResult(missing).isError, true);
  const slow = await runSimulation({ action: "check", timeout_ms: 100 }, { cwd, command: [process.execPath, "-e", "setInterval(()=>{},1000)", "--"] });
  assert.equal(slow.error.type, "Timeout"); assert.equal(slow.remote_state, "unknown");
  const controller = new AbortController(); controller.abort();
  const cancelled = await runSimulation({ action: "exec" }, { cwd, signal: controller.signal });
  assert.equal(cancelled.error.type, "Cancelled");
});
