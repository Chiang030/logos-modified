import { snapshot } from "./sanitize.mjs";

export const emptyCounts = () => ({ agentRuns: 0, loops: 0, modelCalls: 0, toolCalls: 0, toolErrors: 0 });
export function count(state, key) {
  for (const record of [state.activity, state.run, state.turn]) if (record?.counts) record.counts[key]++;
}

export function displayName(component, metadata = {}) {
  const names = { "pi.activity": metadata.activityKind === "maintenance" ? "会话维护" : "用户请求",
    "pi.agent_run": `Agent 执行 #${metadata.activityRun ?? 1}`,
    "pi.turn": `循环 #${metadata.loopNumber ?? 1}`,
    "pi.generation": `模型调用 #${metadata.requestNumber ?? 1}`,
    "pi.compaction": "压缩上下文", "pi.human_wait": "等待用户确认" };
  return names[component] ?? (component.startsWith("pi.tool.") ? `工具 · ${component.slice(8)}` : component);
}

/** Only provider-exposed reasoning is represented; signatures/opaque redactions are omitted. */
export function assistantView(message, budget = 32768) {
  const blocks = Array.isArray(message?.content) ? message.content.slice(0, 64) : [];
  const thoughts = blocks.filter((p) => p.type === "thinking");
  const visible = thoughts.filter((p) => !p.redacted && typeof p.thinking === "string" && p.thinking.length);
  const fieldBudget = Math.max(256, Math.floor(budget / 5));
  const copy = (value) => snapshot(value, fieldBudget);
  const answer = copy(blocks.filter((p) => p.type === "text").map((p) => p.text));
  const toolCalls = copy(blocks.filter((p) => p.type === "toolCall").map((p) => ({
    toolCallId: p.id, tool: p.name, arguments: p.arguments })));
  const reasoning = copy(visible.map((p) => p.thinking));
  return { stopReason: message?.stopReason, toolCalls: toolCalls.data, answer: answer.data,
    reasoning: { status: visible.length ? "provider_exposed" : thoughts.some((p) => p.redacted) ? "redacted_by_provider" : "not_exposed",
      source: "final_assistant_message", blocks: reasoning.data },
    capture: { truncated: (message?.content?.length ?? 0) > 64 || answer.truncated || toolCalls.truncated || reasoning.truncated } };
}

/** Keep the system prefix and recent history, with an explicit index/omission manifest. */
export function contextView(messages, budget) {
  const list = Array.isArray(messages) ? messages : [];
  const indexes = [];
  for (let i = 0; i < Math.min(8, list.length) && list[i]?.role === "system"; i++) indexes.push(i);
  const tail = Math.max(indexes.length, list.length - (48 - indexes.length));
  for (let i = tail; i < list.length; i++) indexes.push(i);
  const perMessage = Math.max(64, Math.floor((budget - 2048) / Math.max(1, indexes.length)));
  let truncated = indexes.length !== list.length;
  const captured = indexes.map((index) => {
    const copy = snapshot(list[index], perMessage);
    truncated ||= copy.truncated;
    return { index, message: copy.data, truncated: copy.truncated };
  });
  return { capture: { stage: "context_with_system", totalMessages: list.length,
    capturedMessages: indexes.length, omittedMessages: list.length - indexes.length, truncated,
    selection: "system_prefix_and_recent_history", exactWirePayload: false }, messages: captured };
}

export function resultView(state, record, status) {
  return { status, summary: record?.counts ?? emptyCounts(), response: state.lastAssistant ?? null };
}
