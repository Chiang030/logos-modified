import test from "node:test";
const component = (span) => JSON.parse(span.attributes["langfuse.observation.metadata.component"] ?? "null") ?? span.name;
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { createRuntime, shouldExportSpan } from "../../src/observability/exporter.mjs";
import { readConfig } from "../../src/observability/config.mjs";
import { piFixture } from "../fixture.mjs";
import { demoPrompt } from "../demo.mjs";

test("three-loop request exposes context, reasoning, tool arguments/results and final answer", async () => {
  const transport = new InMemorySpanExporter(); const config = { ...readConfig({}), enabled: true };
  const runtime = createRuntime(config, transport);
  const fixture = await piFixture(runtime, config, () => {}, { demo: true });
  const field = (span, key) => JSON.parse(span.attributes[`langfuse.observation.${key}`]);
  try {
    await fixture.session.prompt(demoPrompt); await runtime.flush();
    const spans = transport.getFinishedSpans();
    const root = spans.find((s) => component(s) === "pi.activity");
    assert.ok(root.name.startsWith("用户请求 · 演示"));
    assert.equal(field(root, "input").userRequest, demoPrompt);
    assert.deepEqual(field(root, "output").summary, { agentRuns: 1, loops: 3, modelCalls: 3, toolCalls: 2, toolErrors: 0 });
    assert.match(JSON.stringify(field(root, "output").response.answer), /5.4 kg/);
    for (const span of spans) { assert.ok(field(span, "input")); assert.ok(field(span, "output")); }
    const generations = spans.filter((s) => component(s) === "pi.generation");
    assert.equal(generations.length, 3);
    assert.ok(generations.every((s) => field(s, "output").reasoning.status === "provider_exposed"));
    const second = generations.find((s) => s.name.startsWith("模型调用 #2"));
    const context = field(second, "input");
    assert.ok(context.messages.some((m) => m.message.role === "system"));
    assert.ok(context.messages.some((m) => m.message.role === "toolResult" && m.message.toolName === "demo_material_lookup"));
    assert.equal(context.capture.truncated, false);
    const tool = spans.find((s) => component(s) === "pi.tool.demo_mass_calculate");
    assert.deepEqual(field(tool, "input").arguments, { density_kg_m3: 2700, volume_m3: 0.002 });
    assert.equal(field(tool, "output").result.details.mass_kg, 5.4);
    assert.equal(field(tool, "output").isError, false);
  } finally { await fixture.close(); await runtime.shutdown(); }
});

test("real Pi request exports a root, two generations, a tool and disjoint usage", async () => {
  const transport = new InMemorySpanExporter();
  const config = { ...readConfig({}), enabled: true };
  const runtime = createRuntime(config, transport);
  const fixture = await piFixture(runtime, config);
  try {
    await fixture.session.prompt("Run a synthetic echo and report completion.");
    await runtime.flush();
    const spans = transport.getFinishedSpans();
    assert.equal(fixture.calls, 2);
    assert.equal(spans.filter((s) => component(s) === "pi.activity").length, 1);
    const generations = spans.filter((s) => component(s) === "pi.generation");
    assert.equal(generations.length, 2);
    assert.equal(spans.filter((s) => component(s) === "pi.tool.observability_echo").length, 1);
    assert.ok(spans.every((otelSpan) => shouldExportSpan({ otelSpan })));
    const ids = new Set(spans.map((s) => s.spanContext().spanId));
    for (const span of spans) if (span.parentSpanContext) assert.ok(ids.has(span.parentSpanContext.spanId));
    for (const generation of generations) {
      assert.deepEqual(JSON.parse(generation.attributes["langfuse.observation.usage_details"]),
        { input: 100, input_cache_read: 200, input_cache_write: 60, output: 80 });
    }
    assert.equal(fixture.controller.state.open.size, 0);
  } finally { await fixture.close(); await runtime.shutdown(); }
});

test("actual domain entry loads without changing simulation tools; nested execution is traced", async () => {
  const transport = new InMemorySpanExporter(); const config = { ...readConfig({}), enabled: true };
  const runtime = createRuntime(config, transport);
  const fixture = await piFixture(runtime, config, (pi) => {
    pi.registerTool({ name: "observability_child", label: "Child", description: "Synthetic nested tool",
      parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: "child" }] }; } });
  }, { loadDomain: true, execute: async (ctx) => {
    await Promise.all([ctx.executeTool("observability_child", {}), ctx.executeTool("observability_child", {})]);
  } });
  try {
    assert.ok(fixture.session.getAllTools().some((tool) => tool.name === "simulation"), JSON.stringify(fixture.session.getAllTools().map((tool) => tool.name)));
    await fixture.session.prompt("Synthetic request with nested calls."); await runtime.flush();
    const spans = transport.getFinishedSpans();
    const parent = spans.find((s) => component(s) === "pi.tool.observability_echo");
    const children = spans.filter((s) => component(s) === "pi.tool.observability_child");
    assert.equal(children.length, 2);
    assert.ok(children.every((s) => s.parentSpanContext.spanId === parent.spanContext().spanId));
  } finally { await fixture.close(); await runtime.shutdown(); }
});

test("real extension reload creates fresh controller state while reusing the provider", async () => {
  const transport = new InMemorySpanExporter(); const config = { ...readConfig({}), enabled: true };
  const runtime = createRuntime(config, transport); const fixture = await piFixture(runtime, config);
  try {
    await fixture.session.prompt("Synthetic request before reload.");
    const previous = fixture.controller;
    await fixture.session.reload();
    assert.notEqual(fixture.controller, previous);
    assert.equal(previous.state.open.size, 0); assert.equal(previous.state.disabled, true);
    assert.equal(fixture.controller.state.runtime.provider, runtime.provider);
    await fixture.session.prompt("Synthetic request after reload."); await runtime.flush();
    const spans = transport.getFinishedSpans();
    assert.equal(spans.filter((s) => component(s) === "pi.activity").length, 2);
    assert.equal(spans.filter((s) => component(s) === "pi.generation").length, 4);
    assert.equal(new Set(spans.filter((s) => component(s) === "pi.activity").map((s) => s.spanContext().traceId)).size, 2);
  } finally { await fixture.close(); await runtime.shutdown(); }
});
