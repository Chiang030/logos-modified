import { open, update, close, rename } from "./spans.mjs";
import { normalizeUsage } from "./usage.mjs";
import { contextView, assistantView, count } from "./display.mjs";

export class Generations {
  constructor(state) { this.state = state; this.active = null; this.sequence = 0; }
  prepare(event, ctx) {
    this.finish("missing_end");
    const span = this.create(ctx);
    if (span) {
      const input = this.state.config.content ? contextView(event.messages, this.state.config.contentBytes) : undefined;
      update(this.state, span, { input, metadata: { captureStage: "context_with_system",
        contextMessageCount: event.messages?.length, contextTruncated: input?.capture.truncated } });
      update(this.state, this.state.turn, { metadata: { contextObservationId: span.ref.id } });
    }
  }
  create(ctx, missingContext = false) {
    const s = this.state;
    if (!s.turn || !s.activity) return null;
    const span = open(s, "pi.generation", "generation", s.turn, { generationSequence: ++this.sequence, missingContext,
      requestNumber: (s.activity.counts?.modelCalls ?? 0) + 1, loopNumber: s.turn.metadata.loopNumber });
    if (!span) return null;
    count(s, "modelCalls");
    this.active = { span, state: "prepared", model: ctx?.model, usageCommitted: false };
    return span;
  }
  request(event) {
    const g = this.active;
    if (!g || g.state === "end_seen") return;
    g.state = "started"; g.requestAt ??= this.state.now();
    const p = event.payload;
    const params = {};
    for (const key of ["temperature", "max_tokens", "max_output_tokens", "top_p", "reasoning_effort"])
      if (typeof p?.[key] === "number" || typeof p?.[key] === "string") params[key] = p[key];
    update(this.state, g.span, { modelParameters: params, metadata: { providerHookObserved: true } });
  }
  response(event) {
    if (!this.active || this.active.state === "end_seen") return;
    update(this.state, this.active.span, { metadata: { httpStatus: event.status,
      requestId: event.headers?.["x-request-id"] ?? event.headers?.["request-id"] } });
  }
  message(event, ctx) {
    if (event.message?.role !== "assistant") return;
    if (!this.active) this.create(ctx, true);
    const g = this.active;
    if (!g || g.state === "end_seen") return;
    const message = event.message;
    if (event.type === "message_start") {
      g.state = "started";
      if (Number.isFinite(message.timestamp)) g.modelStartedAt = message.timestamp;
    }
    if (event.type === "message_update") {
      g.state = "streaming";
      if (event.assistantMessageEvent?.type === "text_delta" && event.assistantMessageEvent.delta && !g.firstTextAt)
        g.firstTextAt = this.state.now();
    }
    if (event.type === "message_end") {
      g.state = "end_seen"; g.message = message; g.endedAt = this.state.now();
      this.recordCalls(message, g);
    }
  }
  recordCalls(message, g) {
    for (const part of message.content ?? []) {
      if (part.type === "toolCall" && this.state.toolSources.size < this.state.config.maxClosed)
        this.state.toolSources.set(part.id, g.span.ref.id);
    }
  }
  finish(reason = "completed", message, entryId) {
    const g = this.active;
    if (!g) return;
    this.active = null;
    const m = message?.role === "assistant" ? message : g.message;
    if (m && !g.usageCommitted) {
      const usage = normalizeUsage(m.usage, g.model?.id === m.model ? g.model : undefined);
      const output = this.state.config.content ? assistantView(m, this.state.config.contentBytes) : undefined;
      const hasTools = m.content?.some((part) => part.type === "toolCall");
      rename(g.span, `模型调用 #${g.span.metadata.requestNumber} · ${hasTools ? "请求工具" : "返回响应"}`);
      update(this.state, g.span, { ...usage, model: m.model, output,
        completionStartTime: g.firstTextAt === undefined ? undefined : new Date(g.firstTextAt),
        metadata: { ...usage.metadata, provider: m.provider, responseId: m.responseId, responseModel: m.responseModel,
          stopReason: m.stopReason, error: m.errorMessage, messageEntryId: entryId, reasoningStatus: output?.reasoning.status,
          piDurationMs: m.durationMs, modelStartedAt: m.timestamp,
          requestHookAt: g.requestAt, firstTextStartSource: g.requestAt === undefined ? "context_hook" : "provider_request_hook",
          firstTextLatencyMs: g.firstTextAt === undefined ? undefined : Math.max(0, g.firstTextAt - (g.requestAt ?? g.span.start)),
          timingSource: "hook_monotonic", telemetryIncomplete: g.state !== "end_seen" } });
      g.usageCommitted = true;
      if (m.stopReason === "error") reason = "error";
      if (m.stopReason === "aborted") reason = "cancelled";
      if (m.stopReason === "deferred") reason = "deferred";
      this.state.lastOutcome = reason;
      this.state.lastAssistant = output;
    }
    if (!m) update(this.state, g.span, { metadata: { usageStatus: "missing", telemetryIncomplete: true } });
    close(this.state, g.span, reason, g.endedAt ?? this.state.now());
  }
}
