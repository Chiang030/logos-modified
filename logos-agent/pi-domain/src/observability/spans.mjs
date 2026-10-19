import { snapshot } from "./sanitize.mjs";
import { displayName } from "./display.mjs";

export function clock() {
  const wall = Date.now(), mono = performance.now();
  return () => wall + performance.now() - mono;
}

/** Only bounded copies cross the SDK boundary. Parent references are always explicit. */
export function open(state, name, type, parent, metadata = {}, start = state.now()) {
  if (state.open.size >= state.config.maxOpen) { state.dropped++; return null; }
  const ref = state.runtime.start(displayName(name, metadata), type, parent?.ref, state.sessionId, start);
  const record = { ref, start, end: undefined, closed: false, metadata: {} };
  state.open.add(record); update(state, record, { metadata: { component: name, ...metadata,
    contentCapture: state.config.content ? "bounded_redacted" : "disabled" } });
  return record;
}

export function rename(record, title) {
  if (record && !record.closed) record.ref.otelSpan.updateName(snapshot(title, 512).data);
}

export function update(state, record, fields) {
  if (!record || record.closed) return;
  const next = { ...fields };
  if (fields.modelParameters) next.modelParameters = snapshot(fields.modelParameters, 2048).data;
  if (typeof fields.model === "string") next.model = snapshot(fields.model, 512).data;
  if (fields.metadata) {
    const safe = snapshot(fields.metadata, 8192);
    Object.assign(record.metadata, safe.data && typeof safe.data === "object" ? safe.data : {});
    const bounded = snapshot(record.metadata, 8192);
    next.metadata = bounded.data;
  }
  for (const key of ["input", "output"]) {
    if (!(key in fields)) continue;
    if (!state.config.content) { delete next[key]; continue; }
    const copy = snapshot(fields[key], state.config.contentBytes);
    next[key] = copy.data;
    if (copy.truncated) {
      record.metadata[`${key}TelemetryTruncated`] = true;
      next.metadata = { ...next.metadata, [`${key}TelemetryTruncated`]: true };
    }
  }
  record.ref.update(next);
}

export function close(state, record, reason = "completed", end = state.now()) {
  if (!record || record.closed) return;
  update(state, record, { metadata: { closeReason: reason, durationMs: Math.max(0, end - record.start),
    telemetryIncomplete: !["completed", "error", "failed", "cancelled", "aborted", "deferred"].includes(reason) } });
  if (["error", "failed"].includes(reason)) record.ref.otelSpan.setStatus({ code: 2 });
  record.closed = true; record.end = end;
  record.ref.end(new Date(Math.max(record.start, end))); state.open.delete(record);
}
