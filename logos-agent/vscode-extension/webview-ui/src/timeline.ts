import type { RestoredMessage, RestoredTool, ToolCallView } from "./protocol";

export interface TimelineMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  status: "streaming" | "complete" | "error" | "aborted" | "interrupted";
}

export type TimelineItem =
  | { kind: "message"; value: TimelineMessage; order: number }
  | { kind: "tool"; value: ToolCallView; order: number };

export function appendMessage(items: TimelineItem[], message: TimelineMessage, order: number): TimelineItem[] {
  return [...items, { kind: "message", value: message, order }];
}

export function appendTool(items: TimelineItem[], tool: ToolCallView, order: number): TimelineItem[] {
  return [...items, { kind: "tool", value: tool, order }];
}

export function updateMessage(
  items: TimelineItem[],
  id: string,
  update: (message: TimelineMessage) => TimelineMessage,
  order: number,
): TimelineItem[] {
  if (!items.some((item) => item.kind === "message" && item.value.id === id)) {
    return appendMessage(items, update({ id, role: "assistant", text: "", status: "streaming" }), order);
  }
  return items.map((item) => item.kind === "message" && item.value.id === id
    ? { ...item, value: update(item.value) }
    : item);
}

export function updateTool(items: TimelineItem[], next: ToolCallView, order: number): TimelineItem[] {
  if (!items.some((item) => item.kind === "tool" && item.value.id === next.id)) {
    return appendTool(items, next, order);
  }
  return items.map((item) => item.kind === "tool" && item.value.id === next.id
    ? { ...item, value: next }
    : item);
}

export function restoreTimeline(messages: RestoredMessage[], tools: RestoredTool[]): TimelineItem[] {
  const entries: TimelineItem[] = [
    ...messages.map((message, index) => ({
      kind: "message" as const,
      value: { ...message, status: message.isError ? "error" as const : "complete" as const },
      order: message.position ?? index,
    })),
    ...tools.map((tool, index) => ({
      kind: "tool" as const,
      value: tool,
      order: tool.position ?? messages.length + index,
    })),
  ];
  return entries.sort((left, right) => left.order - right.order);
}

export function settleTimeline(items: TimelineItem[], outcome: string): TimelineItem[] {
  return items.map((item) => {
    if (item.kind === "message" && item.value.status === "streaming") return { ...item, value: { ...item.value,
      status: outcome === "completed" ? "complete" : outcome === "aborted" ? "aborted" : outcome === "interrupted" ? "interrupted" : "error", text: item.value.text || (outcome === "aborted" ? "已停止" : "运行已结束") } };
    if (item.kind === "tool" && item.value.status === "running") return { ...item, value: { ...item.value,
      status: outcome === "aborted" ? "aborted" : "interrupted", output: item.value.output ?? (outcome === "aborted" ? "已停止" : "运行中断，未收到工具结果") } };
    return item;
  });
}

export function maxTimelineOrder(items: TimelineItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.order), 0);
}
