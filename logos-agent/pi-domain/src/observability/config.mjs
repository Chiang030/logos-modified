/** Limits constrain telemetry only, never the agent or its tools. */
export function readConfig(env = process.env) {
  const number = (key, fallback, max) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
  };
  return Object.freeze({
    enabled: env.LOGOS_OBSERVABILITY === "1",
    baseUrl: env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    environment: env.LANGFUSE_TRACING_ENVIRONMENT ?? "development",
    namespace: env.LOGOS_OBSERVABILITY_NAMESPACE ?? "logos-pi",
    content: env.LOGOS_OBSERVABILITY_CONTENT !== "metadata",
    contentBytes: number("LOGOS_OBSERVABILITY_CONTENT_BYTES", 32768, 65536),
    queueSize: number("LOGOS_OBSERVABILITY_QUEUE_SIZE", 512, 2048),
    queueBytes: number("LOGOS_OBSERVABILITY_QUEUE_BYTES", 16 * 1024 * 1024, 32 * 1024 * 1024),
    maxOpen: 1024, maxClosed: 2048, maxInputs: 64,
    flushMs: 2000, requestTimeoutMs: 1000, batchSize: 32,
    maxAgeMs: number("LOGOS_OBSERVABILITY_MAX_AGE_MS", 86400000, 7 * 86400000),
  });
}
