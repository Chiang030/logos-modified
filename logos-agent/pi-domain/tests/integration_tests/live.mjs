import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { readConfig } from "../../src/observability/config.mjs";
import { createRuntime } from "../../src/observability/exporter.mjs";
import { piFixture } from "../fixture.mjs";
import { demoPrompt } from "../demo.mjs";

const config = readConfig();
assert.ok(config.enabled && config.publicKey && config.secretKey, "Configure a test Langfuse project first");
assert.ok(config.content, "Live content acceptance needs LOGOS_OBSERVABILITY_CONTENT=full");
const runtime = createRuntime(config);
let traceId;
const start = runtime.start.bind(runtime);
runtime.start = (...args) => { const span = start(...args); if (!args[2]) traceId = span.traceId; return span; };
const fixture = await piFixture(runtime, config, () => {}, { demo: true });
try {
  await fixture.session.prompt(demoPrompt);
  await runtime.flush();
  const headers = { Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}` };
  let result;
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(`${config.baseUrl}/api/public/v2/observations?traceId=${traceId}&fields=core,basic,usage,metadata,io&limit=100`, { headers, signal: AbortSignal.timeout(5000) });
    if (response.ok) { result = await response.json(); if (result.data?.length >= 10) break; }
    else if (response.status !== 404) throw new Error(`Langfuse verification HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.ok(result?.data?.length, `Trace ${traceId} not visible yet; exporter failures=${runtime.queue.stats.failed}`);
  const observations = result.data.map((o) => ({ id: o.id, parentObservationId: o.parentObservationId,
    name: o.name, type: o.type, inputUsage: o.inputUsage, outputUsage: o.outputUsage, totalUsage: o.totalUsage,
    usageDetails: o.usageDetails, costDetails: o.costDetails, totalCost: o.totalCost,
    input: o.input, output: o.output, metadata: o.metadata, calculatedTotalCost: o.calculatedTotalCost }));
  const decode = (value) => typeof value === "string" ? JSON.parse(value) : value;
  for (const o of observations) { o.input = decode(o.input); o.output = decode(o.output); }
  const generations = observations.filter((o) => o.type === "GENERATION");
  assert.equal(generations.length, 3);
  for (const g of generations) { assert.equal(g.inputUsage, 360); assert.equal(g.outputUsage, 80);
    assert.equal(g.usageDetails.total, 440); assert.equal(g.usageDetails.input, 100);
    assert.equal(g.usageDetails.input_cache_read, 200); assert.equal(g.usageDetails.input_cache_write, 60);
    assert.ok(Math.abs(g.totalCost - 0.000355) < 1e-8); }
  for (const o of observations) { assert.ok(o.input, `${o.name}: input`); assert.ok(o.output, `${o.name}: output`); }
  const root = observations.find((o) => !o.parentObservationId);
  assert.equal(root.input.userRequest, demoPrompt);
  assert.deepEqual(root.output.summary, { agentRuns: 1, loops: 3, modelCalls: 3, toolCalls: 2, toolErrors: 0 });
  assert.ok(JSON.stringify(root.output.response.answer).includes("5.4 kg"));
  assert.ok(generations.every((o) => o.output.reasoning.status === "provider_exposed"));
  const second = generations.find((o) => o.name.startsWith("模型调用 #2"));
  assert.ok(second.input.messages.some((m) => m.message.role === "toolResult" && m.message.toolName === "demo_material_lookup"));
  const tool = observations.find((o) => o.name === "工具 · demo_mass_calculate");
  assert.deepEqual(tool.input.arguments, { density_kg_m3: 2700, volume_m3: 0.002 });
  assert.equal(tool.output.result.details.mass_kg, 5.4);
  const ids = new Set(observations.map((o) => o.id));
  for (const o of observations) if (o.parentObservationId) assert.ok(ids.has(o.parentObservationId));
  await mkdir(".observability-results", { recursive: true });
  const report = { traceId, projectUrl: config.baseUrl, sessionId: result.data[0].sessionId, observations, exportStats: runtime.queue.stats };
  await writeFile(".observability-results/live.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ traceId, observations: observations.map(({ name, type }) => ({ name, type })),
    summary: root.output.summary, ioVerified: true, reasoningVerified: true, exportStats: runtime.queue.stats }, null, 2));
} finally { await fixture.close(); await runtime.shutdown(); }
