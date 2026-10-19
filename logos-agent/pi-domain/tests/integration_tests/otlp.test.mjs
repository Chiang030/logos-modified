import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRuntime } from "../../src/observability/exporter.mjs";
import { readConfig } from "../../src/observability/config.mjs";

for (const status of [200, 401, 429, 503, "hang"]) {
  test(`real OTLP transport isolates HTTP ${status} and respects timeout`, async () => {
    let requests = 0, protocol;
    const server = createServer(async (req, res) => {
      requests++; protocol = req.headers["x-langfuse-ingestion-version"];
      for await (const _chunk of req) { /* Consume only synthetic telemetry. */ }
      if (status === "hang") return;
      res.writeHead(status, { "content-type": "application/json" }); res.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const config = { ...readConfig({}), baseUrl: `http://127.0.0.1:${server.address().port}`,
      publicKey: "fixture", secretKey: "fixture", requestTimeoutMs: 80, flushMs: 300 };
    const runtime = createRuntime(config);
    try {
      const span = runtime.start("pi.test.http", "span", null, "fixture"); span.end();
      const start = performance.now(); await runtime.flush();
      assert.ok(performance.now() - start < 1500);
      assert.ok(requests > 0); assert.equal(protocol, "4");
      if (status === 200) assert.equal(runtime.queue.stats.exported, 1);
      else assert.equal(runtime.queue.stats.failed, 1);
      assert.equal(runtime.queue.inFlight, 0);
    } finally {
      await runtime.shutdown(); server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
