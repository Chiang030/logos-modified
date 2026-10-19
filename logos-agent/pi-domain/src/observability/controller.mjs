import { clock, open, update, close, rename } from "./spans.mjs";
import { Generations } from "./generation.mjs";
import { Tools } from "./tools.mjs";
import { snapshot } from "./sanitize.mjs";
import { emptyCounts, count, assistantView, resultView } from "./display.mjs";

export const EVENTS = ["session_start", "session_shutdown", "input", "before_agent_start", "agent_start", "agent_end",
  "agent_before_settle", "agent_settled", "turn_start", "turn_end", "context_with_system", "before_provider_request",
  "after_provider_response", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end",
  "session_before_compact", "session_compact", "session_compact_failed", "ui_prompt_start", "ui_prompt_end", "session_tree"];

export class Controller {
  constructor(runtime, config, now = clock()) {
    this.state = { runtime, config, now, sessionId: "", epoch: 0, open: new Set(), toolSources: new Map(),
      runSequence: 0, dropped: 0, inputs: [], disabled: false };
    this.generations = new Generations(this.state); this.tools = new Tools(this.state); this.waits = [];
  }
  handle(event, ctx) {
    const s = this.state;
    if (event.type === "session_start") return this.session(ctx);
    if (s.expired && event.type === "agent_settled") { s.expired = false; s.disabled = false; return; }
    if (s.disabled || !s.sessionId || `${s.config.namespace}:${ctx.sessionManager.getSessionId()}` !== s.sessionId) return;
    if (this.expire()) return;
    if (event.type === "session_shutdown") { this.finish("shutdown"); s.disabled = true; return s.runtime.flush(); }
    if (event.type === "before_agent_start") { s.prompt = s.config.content ? snapshot(event.prompt, s.config.contentBytes).data : undefined; return; }
    if (event.type === "input") {
      if (s.inputs.length >= s.config.maxInputs) s.inputs.shift();
      s.inputs.push({ source: event.source, streamingBehavior: event.streamingBehavior, state: "observed_intent" }); return;
    }
    if (event.type === "agent_start") return this.run();
    if (event.type === "turn_start") return this.turn(event);
    if (event.type === "context_with_system") return this.generations.prepare(event, ctx);
    if (event.type === "before_provider_request") return this.generations.request(event);
    if (event.type === "after_provider_response") return this.generations.response(event);
    if (event.type === "message_start" && event.message?.role === "user") {
      s.userMessages = (s.userMessages ?? 0) + 1;
      update(s, s.activity, { metadata: { observedUserMessages: s.userMessages } }); return;
    }
    if (event.type.startsWith("message_")) return this.generations.message(event, ctx);
    if (event.type === "tool_execution_start") return this.tools.start(event);
    if (event.type === "tool_execution_end") return this.tools.end(event);
    if (event.type === "turn_end") return this.endTurn(event);
    if (event.type === "agent_end") { this.endTurn(); this.endRun(s.lastOutcome ?? "completed"); return; }
    if (event.type === "agent_before_settle") { s.boundaryOutcome = event.outcome; return; }
    if (event.type === "agent_settled") return this.finish(event.aborted ? "cancelled" : s.boundaryOutcome ?? s.lastOutcome ?? "completed");
    this.auxiliary(event);
  }
  session(ctx) {
    this.finish("session_replaced");
    const s = this.state; s.epoch++; s.disabled = false; s.expired = false;
    s.sessionId = `${s.config.namespace}:${ctx.sessionManager.getSessionId()}`;
    s.inputs = []; s.prompt = undefined; s.lastOutcome = undefined; s.boundaryOutcome = undefined;
    this.tools.closed.clear();
  }
  activity(kind = "agent") {
    const s = this.state;
    if (!s.activity) {
      s.activity = open(s, "pi.activity", "span", null, { activityKind: kind, piVersion: "1.1.0", epoch: s.epoch });
      if (s.activity) s.activity.counts = emptyCounts();
      s.lastAssistant = undefined;
      update(s, s.activity, { input: { userRequest: s.prompt ?? null } });
      if (kind === "agent" && typeof s.prompt === "string") rename(s.activity, `用户请求 · ${s.prompt.slice(0, 80)}`);
    }
    return s.activity;
  }
  expire() {
    const s = this.state;
    if (!s.activity || s.now() - s.activity.start <= s.config.maxAgeMs) return false;
    this.finish("observation_expired"); s.disabled = true; s.expired = true; return true;
  }
  run() {
    const s = this.state;
    this.endTurn(); this.endRun("missing_end");
    const root = this.activity();
    update(s, root, { metadata: { inputIntents: s.inputs } });
    const activityRun = (root?.counts.agentRuns ?? 0) + 1;
    s.run = open(s, "pi.agent_run", "agent", root, { runSequence: ++s.runSequence, activityRun,
      continuationReason: activityRun === 1 ? "initial" : "unknown" });
    if (s.run) s.run.counts = emptyCounts();
    count(s, "agentRuns");
    update(s, s.run, { input: { userRequest: s.prompt ?? null, executionNumber: activityRun,
      reason: activityRun === 1 ? "执行用户请求" : "Pi 自动继续执行，具体触发原因未暴露" } });
    s.lastOutcome = undefined; s.boundaryOutcome = undefined;
  }
  turn(event) {
    this.endTurn(); const s = this.state;
    if (s.run) {
      const loopNumber = (s.activity?.counts.loops ?? 0) + 1;
      s.turn = open(s, "pi.turn", "span", s.run, { turnIndex: event.turnIndex, runSequence: s.runSequence, loopNumber });
      if (s.turn) s.turn.counts = emptyCounts();
      count(s, "loops");
      update(s, s.turn, { input: { loopNumber, userRequest: s.prompt ?? null,
        contextLocation: "本轮模型调用节点的 Input：system、历史消息和已返回的工具结果" } });
    }
  }
  endTurn(event) {
    const s = this.state;
    this.generations.finish(event ? "completed" : "missing_end", event?.message, event?.messageEntryId);
    this.tools.clear("missing_end");
    if (event?.message && s.turn) {
      s.lastAssistant = s.config.content ? assistantView(event.message, s.config.contentBytes) : undefined;
      if (event.outcome) s.lastOutcome = event.outcome;
    }
    if (s.turn) {
      const action = s.turn.counts.toolCalls ? `调用工具 (${s.turn.counts.toolCalls})` : "模型响应";
      rename(s.turn, `循环 #${s.turn.metadata.loopNumber} · ${action}`);
      update(s, s.turn, { output: resultView(s, s.turn, s.lastOutcome ?? "completed"), metadata: { ...s.turn.counts } });
    }
    close(s, s.turn, s.lastOutcome ?? "completed"); s.turn = null; s.toolSources.clear();
  }
  endRun(reason) {
    const s = this.state;
    update(s, s.run, { output: resultView(s, s.run, reason), metadata: { ...s.run?.counts } });
    close(s, s.run, reason); s.run = null;
  }
  auxiliary(event) {
    const s = this.state;
    if (event.type === "session_before_compact") {
      close(s, s.compaction, "missing_end");
      s.compaction = open(s, "pi.compaction", "span", this.activity("maintenance"), { reason: event.reason, willRetry: event.willRetry });
    } else if (event.type === "session_compact" || event.type === "session_compact_failed") {
      const outcome = event.aborted ? "cancelled" : event.type.endsWith("failed") ? "error" : "completed";
      update(s, s.compaction, { metadata: { error: event.errorMessage } });
      close(s, s.compaction, outcome);
      s.compaction = null;
      if (!s.run && s.activity?.metadata.activityKind === "maintenance") this.finish(outcome);
    } else if (event.type === "ui_prompt_start" && s.activity) {
      const wait = open(s, "pi.human_wait", "span", s.turn ?? s.activity, { kind: event.kind });
      if (wait) this.waits.push(wait);
    } else if (event.type === "ui_prompt_end") close(s, this.waits.pop());
    else if (event.type === "session_tree") update(s, s.activity, { metadata: { branchChanged: true } });
  }
  finish(reason = "incomplete") {
    const s = this.state;
    update(s, s.activity, { metadata: { inputIntents: s.inputs, droppedObservations: s.dropped } });
    this.generations.finish(reason); this.tools.clear(reason);
    update(s, s.turn, { output: resultView(s, s.turn, reason), metadata: { ...s.turn?.counts } });
    this.endRun(reason);
    update(s, s.activity, { output: resultView(s, s.activity, reason), metadata: { ...s.activity?.counts } });
    for (const record of [...s.open].reverse()) close(s, record, reason);
    s.activity = s.run = s.turn = s.compaction = null;
    s.toolSources.clear(); s.inputs = []; this.waits = []; s.prompt = undefined; s.userMessages = 0; s.lastAssistant = undefined;
  }
}
