// Offline harness for the observability extension's content-capture modes.
//
// Drives the Controller with synthetic events and captures the spans the
// runtime would export, WITHOUT touching Langfuse or the network: the OTLP
// exporter is replaced by an in-memory transport installed after
// LangfuseSpanProcessor, so what you see is exactly what would be POSTed.
//
// Usage (from logos-agent/pi-domain, deps via npm ci):
//   node tests/observability/repro-content-modes.mjs full       # content capture on
//   node tests/observability/repro-content-modes.mjs metadata   # content capture off
//
// Expected: under `full`, every span type carries langfuse.observation.input /
// .output attributes (root=userRequest, tool=args+result, generation=context
// +assistant view); under `metadata` those attributes are absent everywhere
// (the Langfuse UI then renders Input/Output as 'undefined' for missing fields).
// Trace identity files go to a temp dir and are deleted with it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../../src/observability/config.mjs";
import { createRuntime } from "../../src/observability/exporter.mjs";
import { Controller } from "../../src/observability/controller.mjs";

const MODE = process.argv[2] ?? "full";
if (!["full", "metadata"].includes(MODE)) {
  console.error("usage: repro-content-modes.mjs <full|metadata>");
  process.exit(2);
}

const captured = [];
const transport = {
  export(spans, callback) { captured.push(...spans); callback({ code: 0 }); },
  shutdown() { return Promise.resolve(); },
};
const evidenceDir = mkdtempSync(join(tmpdir(), "obs-repro-"));
const env = {
  LOGOS_OBSERVABILITY: "1",
  LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test",
  LANGFUSE_BASE_URL: "http://localhost:9999", // loopback http is allowed by createRuntime
  LOGOS_OBSERVABILITY_CONTENT: MODE,
  LOGOS_BENCHMARK_RUN_ID: "repro", LOGOS_BENCHMARK_CASE_ID: "REPRO",
  LOGOS_BENCHMARK_EVIDENCE_DIR: evidenceDir,
};

const config = readConfig(env);
const runtime = createRuntime(config, transport);
const controller = new Controller(runtime, config);
const ctx = { sessionManager: { getSessionId: () => "sess-repro" } };
const h = (event) => controller.handle(event, ctx);
const assistant = { role: "assistant", model: "deepseek-flash", provider: "deepseek", stopReason: "end_turn",
  content: [{ type: "text", text: "已完成求解" }], usage: { input_tokens: 100, output_tokens: 50 } };

await h({ type: "session_start" });
await h({ type: "input", source: "benchmark" });
await h({ type: "before_agent_start", prompt: "请求解 VM002 双悬臂梁静力分析（任务全文……）" });
await h({ type: "agent_start" });
await h({ type: "turn_start", turnIndex: 0 });
await h({ type: "context_with_system", messages: [
  { role: "system", content: "你是仿真 agent" },
  { role: "user", content: [{ type: "text", text: "任务要求：建模、求解、交付报告" }] },
] });
await h({ type: "before_provider_request", payload: { model: "deepseek-flash", temperature: 0.2 } });
await h({ type: "after_provider_response", status: 200, headers: { "x-request-id": "req-1" } });
await h({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls -la /workspace" } });
await h({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash",
  result: { content: [{ type: "text", text: "total 4\nbase refined" }] }, isError: false, durationMs: 12 });
await h({ type: "message_end", message: assistant, messageEntryId: "e1" });
await h({ type: "turn_end", message: assistant, outcome: "completed", messageEntryId: "e1" });
await h({ type: "agent_end" });
await h({ type: "agent_settled", aborted: false });
await h({ type: "session_shutdown" });
await new Promise((resolve) => setTimeout(resolve, 600));
await runtime.flush();

let missing = 0;
console.log(`\n===== MODE=${MODE} content=${config.content} captured=${captured.length} =====`);
for (const span of captured) {
  const attrs = span.attributes ?? {};
  const has = { input: "langfuse.observation.input" in attrs, output: "langfuse.observation.output" in attrs };
  if (config.content && (!has.input || !has.output)) missing++;
  if (!config.content && (has.input || has.output)) missing++;
  const brief = (key) => {
    const value = attrs[`langfuse.observation.${key}`];
    return typeof value === "string" && value.length > 160 ? value.slice(0, 160) + "…" : value;
  };
  console.log(`· ${span.name} [${attrs["langfuse.observation.type"]}] input=${has.input} output=${has.output}`);
  if (has.input) console.log(`    in : ${brief("input")}`);
  if (has.output) console.log(`    out: ${brief("output")}`);
}
rmSync(evidenceDir, { recursive: true, force: true });
console.log(`\n${missing === 0 ? "PASS" : "FAIL"}: ${missing} span(s) deviate from mode=${MODE}`);
process.exit(missing === 0 ? 0 : 1);
