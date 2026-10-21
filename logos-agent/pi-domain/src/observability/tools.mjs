import { open, update, close, rename } from "./spans.mjs";
import { simulationResult } from "./simulation.mjs";
import { count } from "./display.mjs";

function toolRole(name) {
  if (name === "simulation" || name === "simulation_discover") return "solver_lifecycle";
  if (name === "bash") return "workspace_or_diagnostics";
  if (["read", "write", "edit"].includes(name)) return "workspace_authoring";
  return "other";
}

export class Tools {
  constructor(state) { this.state = state; this.items = new Map(); this.closed = new Set(); }
  key(id) { return `${this.state.epoch}/${this.state.runSequence}/${id}`; }
  ensure(id, parentId, name, ancestors = new Set()) {
    const key = this.key(id);
    if (this.closed.has(key)) return null;
    if (this.items.has(key)) return this.items.get(key);
    const s = this.state;
    if (!s.turn) return null;
    const cyclic = ancestors.has(id) || id === parentId;
    ancestors.add(id);
    const parent = parentId && !cyclic ? this.ensure(parentId, undefined, "unknown", ancestors) : null;
    const span = open(s, `pi.tool.${name}`, "tool", parent?.span ?? s.turn, {
      toolCallId: id, parentToolCallId: parentId, missingStart: true, invalidParent: cyclic,
      sourceGenerationId: s.toolSources.get(id),
    });
    if (!span) return null;
    const item = { key, span, parent, parentId, children: new Set(), placeholder: true };
    parent?.children.add(item); this.items.set(key, item); return item;
  }
  start(event) {
    const item = this.ensure(event.toolCallId, event.parentToolCallId, event.toolName);
    if (!item || !item.placeholder) return;
    item.placeholder = false;
    this.countCall(item);
    rename(item.span, `工具 · ${event.toolName}`);
    update(this.state, item.span, { input: { tool: event.toolName, toolCallId: event.toolCallId,
      arguments: event.args }, metadata: { component: `pi.tool.${event.toolName}`, missingStart: false,
      parentToolCallId: event.parentToolCallId,
      relationshipIncomplete: item.parentId !== event.parentToolCallId, toolRole: toolRole(event.toolName) } });
  }
  end(event) {
    const item = this.ensure(event.toolCallId, event.parentToolCallId, event.toolName);
    if (!item || item.endedAt !== undefined) return;
    this.countCall(item);
    const engineering = event.toolName === "simulation" || event.toolName === "simulation_discover"
      ? simulationResult(event.result) : {};
    update(this.state, item.span, { output: { tool: event.toolName, isError: event.isError,
      result: event.result, execution: engineering }, metadata: { ...engineering,
      toolRole: toolRole(event.toolName), toolApiOutcome: event.isError ? "error" : "completed", executeDurationMs: event.durationMs,
      executed: event.durationMs !== undefined, telemetryIncomplete: item.placeholder } });
    item.reason = event.isError || engineering.transport_ok === false || engineering.script_ok === false ? "error" : "completed";
    if (item.reason === "error") count(this.state, "toolErrors");
    item.endedAt = this.state.now(); this.finalize(item);
  }
  countCall(item) {
    if (item.counted) return;
    item.counted = true; count(this.state, "toolCalls");
  }
  finalize(item) {
    if (item.endedAt === undefined || item.children.size) return;
    close(this.state, item.span, item.reason, item.endedAt);
    this.items.delete(item.key); this.closed.add(item.key);
    if (this.closed.size > this.state.config.maxClosed) this.closed.delete(this.closed.values().next().value);
    if (item.parent) { item.parent.children.delete(item); this.finalize(item.parent); }
  }
  clear(reason) {
    for (const item of [...this.items.values()].reverse()) {
      item.reason ??= reason; item.endedAt ??= this.state.now(); item.children.clear(); this.finalize(item);
    }
  }
}
