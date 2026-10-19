import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseSpan, LangfuseGeneration, LangfuseTool, LangfuseAgent } from "@langfuse/tracing";
import { BoundedExporter, deadline } from "./queue.mjs";

export const SOURCE = "logos.pi-domain.observability.v1";
const OWNER = "logos.observability.source";
const SINGLETON = Symbol.for("logos.pi-domain.observability.runtime.v1");
const wrappers = { span: LangfuseSpan, generation: LangfuseGeneration, tool: LangfuseTool, agent: LangfuseAgent };

/** Deliberately excludes every foreign span, including foreign children of our roots. */
export function shouldExportSpan({ otelSpan }) {
  return otelSpan.attributes[OWNER] === SOURCE && otelSpan.instrumentationScope.name === SOURCE;
}

/** Private provider: never installs or replaces a global provider/context manager. */
export function createRuntime(config, transport) {
  const url = new URL(config.baseUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("Langfuse requires HTTPS except on loopback");
  }
  const http = transport ?? new OTLPTraceExporter({
    url: `${url.href.replace(/\/$/, "")}/api/public/otel/v1/traces`, timeoutMillis: config.requestTimeoutMs,
    headers: { Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
      "x-langfuse-ingestion-version": "4", "x-langfuse-sdk-name": "javascript", "x-langfuse-sdk-version": "6.0.1" },
  });
  const queue = new BoundedExporter(http, config);
  const processor = new LangfuseSpanProcessor({ exporter: queue, shouldExportSpan,
    mediaUploadEnabled: false, exportMode: "immediate", environment: config.environment });
  const provider = new NodeTracerProvider({ spanProcessors: [processor],
    spanLimits: { attributeCountLimit: 96, attributeValueLengthLimit: 65536, eventCountLimit: 0 } });
  const tracer = provider.getTracer(SOURCE, "1.0.0");
  return {
    provider, queue, config, closed: false,
    start(name, type, parent, sessionId, startTime = Date.now()) {
      const context = parent ? trace.setSpan(ROOT_CONTEXT, parent.otelSpan) : ROOT_CONTEXT;
      const otelSpan = tracer.startSpan(name, { startTime, attributes: {
        [OWNER]: SOURCE, "langfuse.observation.type": type, "session.id": sessionId,
      } }, context);
      return new (wrappers[type] ?? LangfuseSpan)({ otelSpan, attributes: {} });
    },
    async flush() { await deadline((async () => { await processor.forceFlush(); await queue.forceFlush(); })(), config.flushMs); },
    async shutdown() { if (this.closed) return; this.closed = true; await deadline(provider.shutdown(), config.flushMs); },
  };
}

/** Shared across session switches and extension module reloads in this process. */
export function getRuntime(config) {
  if (!config.enabled || !config.publicKey || !config.secretKey) return null;
  const existing = globalThis[SINGLETON];
  if (existing) {
    if (existing.config.baseUrl !== config.baseUrl || existing.config.publicKey !== config.publicKey
      || existing.config.secretKey !== config.secretKey || existing.closed) return null;
    return existing;
  }
  const runtime = createRuntime(config);
  globalThis[SINGLETON] = runtime;
  process.once("beforeExit", () => { void runtime.shutdown(); });
  return runtime;
}
