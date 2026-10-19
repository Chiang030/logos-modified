import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readConfig } from "../src/observability/config.mjs";
import { snapshot } from "../src/observability/sanitize.mjs";
import { contextView } from "../src/observability/display.mjs";
import { piFixture } from "./fixture.mjs";

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const summarize = (values) => ({ p50: percentile(values, .5), p95: percentile(values, .95) });

async function measure(mode) {
  const config = { ...readConfig({}), enabled: mode === "on" };
  const setupStart = performance.now(), setupMemory = process.memoryUsage().rss;
  const runtime = config.enabled
    ? (await import("../src/observability/exporter.mjs")).createRuntime(config,
      { export(_spans, done) { done({ code: 0 }); }, async shutdown() {} })
    : { async flush() {}, async shutdown() {}, queue: { stats: {} } };
  const sdkSetupMs = performance.now() - setupStart, sdkRssDeltaMiB = (process.memoryUsage().rss - setupMemory) / 1048576;
  const fixture = await piFixture(runtime, config);
  const prompt = "Synthetic long-context benchmark. ".repeat(8192);
  const times = [], cpu = [], rss = [], heap = [];
  try {
    for (let i = 0; i < 24; i++) {
      const start = performance.now(), initialCpu = process.cpuUsage();
      await fixture.session.prompt(`${prompt}\nSample ${i}`);
      if (i >= 4) {
        times.push(performance.now() - start);
        const usage = process.cpuUsage(initialCpu); cpu.push((usage.user + usage.system) / 1000);
        const memory = process.memoryUsage(); rss.push(memory.rss / 1048576); heap.push(memory.heapUsed / 1048576);
      }
      await runtime.flush();
    }
    const context = Array.from({ length: 10000 }, () => ({ role: "user", content: prompt }));
    const snapshots = [], contextCaptures = [];
    for (let i = 0; i < 200; i++) { const start = performance.now(); snapshot(context); snapshots.push(performance.now() - start); }
    for (let i = 0; i < 200; i++) { const start = performance.now(); snapshot(contextView(context, 32768)); contextCaptures.push(performance.now() - start); }
    return { mode, samples: times.length, sdkSetupMs, sdkRssDeltaMiB, promptBytes: Buffer.byteLength(prompt), latencyMs: summarize(times),
      cpuMsPerRequest: summarize(cpu), sampledRssMiB: { ...summarize(rss), max: Math.max(...rss) },
      sampledHeapMiB: { ...summarize(heap), max: Math.max(...heap) }, queue: runtime.queue.stats,
      boundedSnapshotMs: summarize(snapshots), boundedContextCaptureMs: summarize(contextCaptures),
      model: "local synthetic SSE", flushIncludedInLatency: false };
  } finally { await fixture.close(); await runtime.shutdown(); }
}

if (process.argv[2] === "on" || process.argv[2] === "off") {
  console.log(JSON.stringify(await measure(process.argv[2])));
} else {
  const results = [];
  // Separate processes; reverse the order in the second pair to reduce order bias.
  for (const mode of ["off", "on", "on", "off"]) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", error = ""; child.stdout.on("data", (data) => { out += data; });
      child.stderr.on("data", (data) => { error += data; }); child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(error || `exit ${code}`)));
    });
    results.push(result);
  }
  const report = { measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
    method: "Four isolated processes, OFF/ON then ON/OFF; 4 warmups + 20 requests each; process samples, not host or remote model CPU; in-memory successful export transport", results };
  await mkdir(".observability-results", { recursive: true });
  await writeFile(".observability-results/benchmark.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
