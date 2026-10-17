export type RuntimeStatus = "idle" | "starting" | "ready" | "running" | "stopping" | "error";

export interface ToolCallView {
  id: string;
  name: string;
  args?: unknown;
  output?: unknown;
  status: "running" | "completed" | "error";
  durationMs?: number;
}

export interface RestoredMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  position?: number;
}
export interface RestoredTool extends ToolCallView { position: number; }
export interface SessionListEntry { sessionId: string; title: string; sessionFile?: string; }

export type ExtensionToWebviewMessage =
  | { type: "runtime/status"; status: RuntimeStatus; detail?: string }
  | { type: "runtime/error"; message: string }
  | { type: "message/user"; id: string; text: string }
  | { type: "message/started"; id: string }
  | { type: "message/text_delta"; id: string; delta: string }
  | { type: "message/completed"; id: string; text: string; isError?: boolean }
  | { type: "tool/started"; tool: ToolCallView }
  | { type: "tool/updated"; tool: ToolCallView }
  | { type: "tool/completed"; tool: ToolCallView }
  | { type: "session/restore"; messages: RestoredMessage[]; tools?: RestoredTool[]; sessionName?: string }
  | { type: "session/list"; sessions: SessionListEntry[]; activeSessionId?: string }
  | { type: "session/reset" }
  | { type: "run/settled"; aborted: boolean };

export type WebviewToExtensionMessage =
  | { type: "webview/ready" }
  | { type: "chat/send"; text: string }
  | { type: "chat/abort" }
  | { type: "chat/retry"; text: string }
  | { type: "session/new" }
  | { type: "session/select"; sessionId: string }
  | { type: "runtime/restart" };

export function isWebviewToExtensionMessage(value: unknown): value is WebviewToExtensionMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "webview/ready":
    case "chat/abort":
    case "session/new":
    case "runtime/restart":
      return true;
    case "session/select":
      return typeof value.sessionId === "string" && value.sessionId.length > 0;
    case "chat/send":
    case "chat/retry":
      return typeof value.text === "string" && value.text.trim().length > 0;
    default:
      return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (!isRecord(block)) return "";
      return typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}
