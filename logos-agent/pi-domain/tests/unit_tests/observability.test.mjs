import test from "node:test";
const component = (span) => JSON.parse(span.attributes["langfuse.observation.metadata.component"] ?? "null") ?? span.name;
import assert from "node:assert/strict";
import { trace, ROOT_CONTEXT } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { readConfig } from "../../src/observability/config.mjs";
import { createRuntime, getRuntime, SOURCE } from "../../src/observability/exporter.mjs";
import { Controller } from "../../src/observability/controller.mjs";
import { normalizeUsage } from "../../src/observability/usage.mjs";
import { snapshot } from "../../src/observability/sanitize.mjs";
import { BoundedExporter } from "../../src/observability/queue.mjs";
import { registerObservability } from "../../extensions/observability.mjs";
import { assistantView, contextView } from "../../src/observability/display.mjs";

const model = { id: "fixture", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } };
const usage = { input: 100, output: 80, cacheRead: 200, cacheWrite: 60, cacheWrite1h: 20,
  reasoning: 30, totalTokens: 440, cost: { input: 0.0001, output: 0.00016, cacheRead: 0.00002, cacheWrite: 0.000075, total: 0.000355 } };
const message = (stopReason = "stop") => ({ role: "assistant", model: "fixture", provider: "fixture",
  timestamp: Date.now(), content: [{ type: "text", text: "done" }], stopReason, usage });
const metadata = (span, key) => JSON.parse(span.attributes[`langfuse.observation.metadata.${key}`] ?? "null");
function harness(t, overrides = {}) {
  const config = { ...readConfig({}), enabled: true, ...overrides };
  const transport = new InMemorySpanExporter(); const runtime = createRuntime(config, transport);
  let time = Date.now(), id = "session-a";
  const controller = new Controller(runtime, config, () => time);
  const ctx = { sessionManager: { getSessionId: () => id }, model };
  const emit = (type, rest = {}) => controller.handle({ type, ...rest }, ctx);
  emit("session_start");
  t.after(async () => { controller.finish("cleanup"); await runtime.shutdown(); });
  return { config, runtime, transport, controller, ctx, emit, tick: (ms) => { time += ms; },
    session: (value) => { id = value; emit("session_start"); },
    start() { emit("agent_start"); emit("turn_start", { turnIndex: 0 }); },
    generation(m = message()) {
      emit("context_with_system", { messages: [{ role: "user", content: "synthetic" }] });
      emit("message_start", { message: m }); emit("message_end", { message: m });
    },
    async spans() { await runtime.flush(); return transport.getFinishedSpans(); },
  };
}

test("late tool ancestry is marked incomplete and provider parameters stay bounded", async (t) => {
  const h = harness(t); h.start();
  h.emit("context_with_system", { messages: [] });
  h.emit("before_provider_request", { payload: { reasoning_effort: "secret=hidden " + "x".repeat(100000) } });
  h.emit("message_end", { message: message() });
  h.emit("tool_execution_start", { toolCallId: "child", parentToolCallId: "parent", toolName: "child" });
  h.emit("tool_execution_start", { toolCallId: "parent", parentToolCallId: "grandparent", toolName: "parent" });
  h.emit("agent_settled", { aborted: true });
  const spans = await h.spans();
  assert.equal(metadata(spans.find((s) => component(s) === "pi.tool.parent"), "relationshipIncomplete"), true);
  const params = spans.find((s) => component(s) === "pi.generation").attributes["langfuse.observation.model.parameters"];
  assert.ok(params && Buffer.byteLength(params) <= 2048);
  assert.ok(!params.includes("hidden"));
  let getterCalls = 0;
  snapshot({ data: "text", get type() { getterCalls++; return "image"; } });
  assert.equal(getterCalls, 0);
});

test("final boundary usage wins over streaming usage; end events count once", async (t) => {
  const h = harness(t); h.start();
  h.generation({ ...message(), usage: { ...usage, input: 999 } });
  h.emit("message_end", { message: message() });
  h.emit("turn_end", { message: message(), messageEntryId: "entry-1" });
  h.emit("turn_end", { message: message(), messageEntryId: "entry-1" });
  h.emit("agent_end"); h.emit("agent_settled", { aborted: false });
  const spans = await h.spans(); const gs = spans.filter((s) => component(s) === "pi.generation");
  assert.equal(gs.length, 1);
  assert.deepEqual(JSON.parse(gs[0].attributes["langfuse.observation.usage_details"]), { input: 100, input_cache_read: 200, input_cache_write: 60, output: 80 });
  assert.equal(h.controller.state.open.size, 0);
});

test("missing context/start and missing terminal callbacks are closed honestly", async (t) => {
  const h = harness(t); h.start();
  h.emit("message_end", { message: message("error") });
  h.emit("agent_settled", { aborted: false });
  const g = (await h.spans()).find((s) => component(s) === "pi.generation");
  assert.equal(metadata(g, "missingContext"), true);
  assert.equal(metadata(g, "closeReason"), "error");
  h.start(); h.emit("context_with_system", { messages: [] });
  h.emit("session_shutdown"); await h.spans();
  assert.equal(h.controller.state.open.size, 0);
});

test("automatic continuation keeps one trace with independent run and turn identities", async (t) => {
  const h = harness(t); h.start(); h.generation(message("error"));
  h.emit("turn_end", { message: message("error") }); h.emit("agent_end");
  assert.ok(h.controller.state.activity);
  h.start(); h.generation(); h.emit("turn_end", { message: message() });
  h.emit("agent_end"); h.emit("agent_settled", { aborted: false });
  const spans = await h.spans();
  assert.equal(spans.filter((s) => component(s) === "pi.activity").length, 1);
  assert.equal(spans.filter((s) => component(s) === "pi.agent_run").length, 2);
  assert.equal(new Set(spans.map((s) => s.spanContext().traceId)).size, 1);
  assert.equal(spans.filter((s) => component(s) === "pi.generation").length, 2);
  const root = spans.find((s) => component(s) === "pi.activity");
  assert.equal(metadata(root, "agentRuns"), 2);
  assert.equal(metadata(root, "loops"), 2);
  assert.equal(metadata(root, "modelCalls"), 2);
});

test("steering/follow-up are intents, not fabricated model calls", async (t) => {
  const h = harness(t); h.emit("input", { source: "rpc", streamingBehavior: "steer" });
  assert.equal(h.controller.state.open.size, 0);
  h.start(); h.emit("input", { source: "rpc", streamingBehavior: "followUp" });
  h.generation(); h.emit("turn_end", { message: message() }); h.emit("agent_settled", { aborted: false });
  h.start(); h.generation(); h.emit("turn_end", { message: message() }); h.emit("agent_settled", { aborted: false });
  assert.equal((await h.spans()).filter((s) => component(s) === "pi.activity").length, 2);
});

test("parallel nested tools keep parent references even when parent ends first", async (t) => {
  const h = harness(t); h.start(); h.generation({ ...message(), content: [{ type: "toolCall", id: "A", name: "a", arguments: {} }] });
  for (const [id, parent] of [["A"], ["B"], ["A/1", "A"], ["A/2", "A"]])
    h.emit("tool_execution_start", { toolCallId: id, parentToolCallId: parent, toolName: id, args: {} });
  for (const [id, parent] of [["A"], ["A/2", "A"], ["B"], ["A/1", "A"]])
    h.emit("tool_execution_end", { toolCallId: id, parentToolCallId: parent, toolName: id, durationMs: 4, result: {}, isError: false });
  h.emit("turn_end", { message: message() }); h.emit("agent_settled", { aborted: false });
  const spans = await h.spans(); const a = spans.find((s) => component(s) === "pi.tool.A");
  for (const child of spans.filter((s) => component(s).startsWith("pi.tool.A/"))) assert.equal(child.parentSpanContext.spanId, a.spanContext().spanId);
  assert.ok(metadata(a, "sourceGenerationId"));
  assert.equal(spans.filter((s) => component(s).startsWith("pi.tool.")).length, 4);
  assert.equal(h.controller.tools.items.size, 0);
});

test("simulation evidence preserves independent execution and engineering outcomes", async (t) => {
  const h = harness(t); h.start();
  const details = { transport_ok: true, script_ok: false, acceptance: "not_evaluated", exit_code: 0,
    remote_state: "unknown", operation_id: "operation-1", output_truncated: true };
  h.emit("tool_execution_end", { toolCallId: "s", toolName: "simulation", durationMs: 12,
    isError: false, result: { details } });
  h.emit("agent_settled", { aborted: false });
  const span = (await h.spans()).find((s) => component(s) === "pi.tool.simulation");
  for (const [key, value] of Object.entries(details)) assert.equal(metadata(span, key), value);
  assert.equal(metadata(span, "toolApiOutcome"), "completed"); assert.equal(span.status.code, 2);
});

test("cancel, session replacement, and stale events never leak into the next activity", async (t) => {
  const h = harness(t); h.start(); h.emit("context_with_system", { messages: [] });
  h.emit("tool_execution_start", { toolCallId: "open", toolName: "wait" });
  h.emit("agent_settled", { aborted: true }); assert.equal(h.controller.state.open.size, 0);
  await h.emit("session_shutdown", { reason: "resume" });
  h.emit("message_end", { message: message() });
  h.session("session-b"); h.start(); h.generation();
  h.emit("turn_end", { message: message() }); h.emit("agent_settled", { aborted: false });
  const spans = await h.spans(); const roots = spans.filter((s) => component(s) === "pi.activity");
  assert.equal(roots.length, 2); assert.notEqual(roots[0].attributes["session.id"], roots[1].attributes["session.id"]);
  assert.equal(metadata(roots[0], "closeReason"), "cancelled");
});

test("compaction and human waiting have their own intervals and never add generation usage", async (t) => {
  const h = harness(t); h.start();
  h.emit("ui_prompt_start", { kind: "confirm" }); h.tick(100); h.emit("ui_prompt_end", { kind: "confirm" });
  h.emit("session_before_compact", { reason: "overflow", willRetry: true }); h.tick(200);
  h.emit("session_compact", { compactionEntry: { usage } }); h.emit("agent_settled", { aborted: false });
  const spans = await h.spans();
  assert.equal(metadata(spans.find((s) => component(s) === "pi.human_wait"), "durationMs"), 100);
  assert.equal(metadata(spans.find((s) => component(s) === "pi.compaction"), "durationMs"), 200);
  assert.equal(spans.filter((s) => component(s) === "pi.generation").length, 0);
});

test("usage subsets and unknown prices are never counted twice", () => {
  const normalized = normalizeUsage(usage, model);
  assert.equal(normalized.metadata.normalizedTotal, 440);
  assert.equal(normalized.metadata.cacheWriteOther, 40); assert.equal(normalized.metadata.nonReasoningOutput, 50);
  assert.equal(normalized.costDetails.input, 0.0001); assert.equal(normalized.costDetails.total, 0.000355);
  assert.equal(normalizeUsage(usage, {}).costDetails, undefined);
  assert.equal(normalizeUsage({ ...usage, cacheWrite1h: 61 }, model).metadata.usageStatus, "invalid");
  assert.equal(normalizeUsage({ ...usage, reasoning: 81 }, model).metadata.usageStatus, "invalid");
  assert.equal(normalizeUsage(undefined, model).usageDetails, undefined);
});

test("source filter excludes foreign roots and foreign children without losing owned parents", async (t) => {
  const h = harness(t); h.start();
  const parent = h.controller.state.activity.ref.otelSpan;
  const foreign = h.runtime.provider.getTracer("unrelated-framework");
  foreign.startSpan("foreign-root", { attributes: { "logos.observability.source": SOURCE } }).end();
  foreign.startSpan("foreign-child", {}, trace.setSpan(ROOT_CONTEXT, parent)).end();
  h.runtime.provider.getTracer(SOURCE).startSpan("missing-marker").end();
  h.generation(); h.emit("turn_end", { message: message() }); h.emit("agent_settled", { aborted: false });
  const spans = await h.spans();
  assert.ok(spans.every((s) => component(s).startsWith("pi.")));
  const ids = new Set(spans.map((s) => s.spanContext().spanId));
  for (const span of spans) if (span.parentSpanContext) assert.ok(ids.has(span.parentSpanContext.spanId));
});

test("process SDK reuse does not register a global provider or die on session shutdown", async (t) => {
  const before = trace.getTracerProvider();
  const config = { ...readConfig({}), enabled: true, publicKey: "fixture", secretKey: "fixture", baseUrl: "http://127.0.0.1:1" };
  const a = getRuntime(config); const b = getRuntime(config);
  t.after(() => a.shutdown());
  assert.equal(a, b); assert.equal(trace.getTracerProvider(), before);
  await a.flush(); assert.equal(getRuntime(config).closed, false);
});

test("bounded serialization handles secrets, cycles, huge contexts and getters", () => {
  const payload = { password: "secret", text: "Bearer abc123 secret=hidden", image: { type: "image", data: "x".repeat(1e6) } };
  payload.self = payload;
  Object.defineProperty(payload, "getter", { enumerable: true, get() { throw new Error("must not invoke"); } });
  const serialized = JSON.stringify(snapshot(payload));
  assert.ok(!serialized.includes("abc123")); assert.ok(!serialized.includes("hidden"));
  assert.ok(serialized.includes("REDACTED")); assert.ok(serialized.length < 1000);
  const long = snapshot(Array.from({ length: 10000 }, () => ({ content: "文".repeat(1000) })), 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(long.data)) <= 1024); assert.equal(long.truncated, true);
});

test("stalled exporter has bounded count/bytes and limited flush without blocking hooks", async () => {
  const config = { ...readConfig({}), queueSize: 2, queueBytes: 8192, flushMs: 20 };
  const queue = new BoundedExporter({ export() {}, shutdown: async () => {} }, config);
  const span = { attributes: { synthetic: true } };
  for (let i = 0; i < 20; i++) queue.export([span], () => {});
  assert.equal(queue.items.length, 2); assert.equal(queue.stats.dropped, 18);
  const start = performance.now(); await queue.forceFlush();
  assert.ok(performance.now() - start < 300); assert.ok(queue.bytes <= 8192);
  await queue.shutdown();
});

test("disabled or failing telemetry handlers preserve extension return semantics", async () => {
  const registered = new Map();
  const pi = { on(type, handler) { registered.set(type, handler); } };
  assert.equal(await registerObservability(pi, { config: readConfig({}) }), null);
  assert.equal(registered.size, 0);
  await registerObservability(pi, { config: { ...readConfig({}), enabled: true }, runtime: { start() { throw new Error("exporter failure"); } } });
  const ctx = { sessionManager: { getSessionId: () => "x" } };
  await registered.get("session_start")({ type: "session_start" }, ctx);
  assert.equal(await registered.get("agent_start")({ type: "agent_start" }, ctx), undefined);
});

test("first text timing excludes non-text deltas and ends before tools finish", async (t) => {
  const h = harness(t); h.start(); h.emit("context_with_system", { messages: [] });
  h.tick(10); h.emit("before_provider_request", { payload: { temperature: 0 } });
  h.tick(20); h.emit("message_start", { message: message() });
  h.emit("message_update", { message: message(), assistantMessageEvent: { type: "thinking_delta", delta: "hidden" } });
  h.tick(30); h.emit("message_update", { message: message(), assistantMessageEvent: { type: "text_delta", delta: "hello" } });
  h.tick(40); h.emit("message_end", { message: message() });
  h.tick(1000); h.emit("turn_end", { message: message() }); h.emit("agent_settled", { aborted: false });
  const g = (await h.spans()).find((s) => component(s) === "pi.generation");
  assert.equal(metadata(g, "durationMs"), 100); assert.equal(metadata(g, "firstTextLatencyMs"), 50);
});

test("watchdog cleans only telemetry and resumes observing after settled", async (t) => {
  const h = harness(t, { maxAgeMs: 100 }); h.start(); h.emit("context_with_system", { messages: [] });
  h.tick(101); assert.equal(h.controller.expire(), true);
  assert.equal(h.controller.state.open.size, 0);
  h.emit("agent_settled", { aborted: false }); h.start();
  h.generation(); h.emit("turn_end", { message: message() }); h.emit("agent_settled", { aborted: false });
  const roots = (await h.spans()).filter((s) => component(s) === "pi.activity");
  assert.equal(roots.length, 2); assert.equal(metadata(roots[0], "telemetryIncomplete"), true);
});

test("open-record and byte limits also constrain missing-end tools", async (t) => {
  const h = harness(t, { maxOpen: 8 }); h.start();
  for (let i = 0; i < 100; i++) h.emit("tool_execution_start", { toolCallId: `t-${i}`, toolName: "wait" });
  assert.ok(h.controller.state.open.size <= 8); assert.ok(h.controller.tools.items.size <= 8);
  h.emit("agent_settled", { aborted: true }); assert.equal(h.controller.state.open.size, 0);
  const root = (await h.spans()).find((s) => component(s) === "pi.activity");
  assert.ok(metadata(root, "droppedObservations") > 0);
  const queue = new BoundedExporter({ export(_s, done) { done({ code: 0 }); }, async shutdown() {} },
    { ...h.config, queueSize: 100, queueBytes: 2500 });
  queue.export([{ attributes: { text: "x".repeat(1000) } }], () => {});
  assert.equal(queue.stats.dropped, 1); assert.equal(queue.bytes, 0); await queue.shutdown();
});

test("manual failed compaction is a failed maintenance activity, without phantom usage", async (t) => {
  const h = harness(t);
  h.emit("session_before_compact", { reason: "manual", willRetry: false }); h.tick(20);
  h.emit("session_compact_failed", { errorMessage: "fixture failure", aborted: false });
  const spans = await h.spans();
  assert.equal(spans.length, 2); assert.ok(spans.every((s) => s.status.code === 2));
  assert.equal(h.controller.state.open.size, 0);
});

test("quoted JSON credentials and URL credentials are redacted before capture", () => {
  const output = snapshot('api_key="private-value" {"secret":"hidden-value"} https://user:password@example.com/?token=sensitive');
  const text = JSON.stringify(output);
  for (const secret of ["private-value", "hidden-value", "user:password", "sensitive"]) assert.ok(!text.includes(secret));
});

test("context capture keeps system and recent tool results and declares omissions", () => {
  const messages = [{ role: "system", content: "System instruction" },
    ...Array.from({ length: 1000 }, (_, i) => ({ role: "user", content: `Message ${i}` })),
    { role: "toolResult", toolCallId: "last-tool", content: [{ type: "text", text: "latest result" }] }];
  const view = contextView(messages, 32768);
  const exported = snapshot(view, 32768);
  assert.equal(exported.data.messages[0].message.role, "system");
  assert.equal(exported.data.messages.at(-1).message.toolCallId, "last-tool");
  assert.equal(view.capture.truncated, true);
  assert.equal(view.capture.totalMessages, 1002);
  assert.equal(view.capture.omittedMessages, 954);
  assert.ok(Buffer.byteLength(JSON.stringify(exported.data)) <= 32768);
});

test("reasoning capture distinguishes exposed, absent and redacted content without signatures", () => {
  assert.equal(assistantView(message()).reasoning.status, "not_exposed");
  const exposed = assistantView({ ...message(), content: [{ type: "thinking", thinking: "Provider summary secret=private", thinkingSignature: "opaque" }] });
  assert.equal(exposed.reasoning.status, "provider_exposed");
  assert.ok(!JSON.stringify(exposed).includes("private"));
  assert.ok(!JSON.stringify(exposed).includes("opaque"));
  const redacted = { type: "thinking", thinking: "never-export", thinkingSignature: "opaque", redacted: true };
  assert.equal(assistantView({ ...message(), content: [redacted] }).reasoning.status, "redacted_by_provider");
  assert.ok(!JSON.stringify(snapshot(redacted)).includes("never-export"));
});

test("metadata mode suppresses bodies and request titles while preserving loop counters", async (t) => {
  const h = harness(t, { content: false });
  h.emit("before_agent_start", { prompt: "private request" });
  h.start(); h.generation(); h.emit("turn_end", { message: message() }); h.emit("agent_settled", { aborted: false });
  const spans = await h.spans();
  assert.ok(spans.every((s) => !("langfuse.observation.input" in s.attributes) && !("langfuse.observation.output" in s.attributes)));
  const root = spans.find((s) => component(s) === "pi.activity");
  assert.equal(root.name, "用户请求");
  assert.equal(metadata(root, "loops"), 1); assert.equal(metadata(root, "modelCalls"), 1);
});
