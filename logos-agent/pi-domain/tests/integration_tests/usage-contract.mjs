import { mkdir, writeFile } from "node:fs/promises";
import { readConfig } from "../../src/observability/config.mjs";
import { createRuntime } from "../../src/observability/exporter.mjs";

const config = readConfig();
const runtime = createRuntime(config);
const root = runtime.start("pi.test.usage_contract", "span", null, "logos-pi:usage-contract-test");
const generation = runtime.start("pi.test.disjoint_usage", "generation", root, "logos-pi:usage-contract-test");
generation.update({ model: "logos-synthetic-contract", metadata: { synthetic: true },
  usageDetails: { input: 100, input_cache_read: 200, input_cache_write: 60, output: 80 },
  costDetails: { input: 0.0001, input_cache_read: 0.00002, input_cache_write: 0.000075, output: 0.00016, total: 0.000355 } });
generation.end(); root.end();
try {
  await runtime.flush();
  const headers = { Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}` };
  let data;
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(`${config.baseUrl}/api/public/v2/observations?traceId=${root.traceId}&fields=core,basic,usage`,
      { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Usage verification HTTP ${response.status}`);
    data = (await response.json()).data?.find((o) => o.type === "GENERATION");
    if (data) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const report = { traceId: root.traceId, inputUsage: data?.inputUsage, outputUsage: data?.outputUsage,
    totalUsage: data?.totalUsage, usageDetails: data?.usageDetails, costDetails: data?.costDetails, totalCost: data?.totalCost,
    verifiedDisjointAggregation: data?.inputUsage === 360 && data?.outputUsage === 80 && data?.totalUsage === 440,
    verifiedCost: Math.abs((data?.totalCost ?? -1) - 0.000355) < 1e-8,
    decision: "Disjoint input/cache/output usage; cost total supplied from final Pi usage.cost.total" };
  await mkdir(".observability-results", { recursive: true });
  await writeFile(".observability-results/usage-contract.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await runtime.shutdown(); }
