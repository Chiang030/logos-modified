export type RuntimeStatus = "idle" | "starting" | "ready" | "running" | "stopping" | "error";

export interface ModelOption {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface RuntimeConfig {
  models: ModelOption[];
  activeModel?: ModelOption;
  thinkingLevel?: string;
  thinkingLevels: string[];
  contextUsage?: ContextUsage;
}

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
  | { type: "runtime/config"; config: RuntimeConfig }
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
  | { type: "session/new" }
  | { type: "session/select"; sessionId: string }
  | { type: "model/select"; provider: string; modelId: string }
  | { type: "thinking/select"; level: string }
  | { type: "runtime/restart" };

export function isWebviewToExtensionMessage(value: unknown): value is WebviewToExtensionMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "webview/ready":
    case "chat/abort":
    case "session/new":
    case "runtime/restart":
      return true;
    case "model/select":
      return typeof value.provider === "string" && value.provider.length > 0 && typeof value.modelId === "string" && value.modelId.length > 0;
    case "thinking/select":
      return typeof value.level === "string" && value.level.length > 0;
    case "session/select":
      return typeof value.sessionId === "string" && value.sessionId.length > 0;
    case "chat/send":
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
