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

export type ApiProtocol = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export interface ConnectionSettings {
  baseUrl: string;
  api: ApiProtocol;
  modelId: string;
  modelIds: string[];
  systemPrompt: string;
  appendPrompt: string;
  skillsEnabled: boolean;
  skillPaths: string[];
}
export interface SettingsView extends ConnectionSettings {
  hasApiKey: boolean;
  bundledSkills: string[];
  configDirectory: string;
  domainDirectory: string;
}

export type ExtensionToWebviewMessage =
  | { type: "settings/loaded"; settings: SettingsView }
  | { type: "settings/models"; modelIds: string[] }
  | { type: "settings/saved" }
  | { type: "settings/error"; message: string }
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
  | { type: "settings/load" }
  | { type: "settings/models"; baseUrl: string; api: ApiProtocol; apiKey?: string }
  | { type: "settings/save"; settings: ConnectionSettings; apiKey?: string; deleteApiKey?: boolean }
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
    case "settings/load": return true;
    case "settings/models":
      return typeof value.baseUrl === "string" && isApiProtocol(value.api) && (value.apiKey === undefined || typeof value.apiKey === "string");
    case "settings/save":
      return isConnectionSettings(value.settings) && (value.apiKey === undefined || typeof value.apiKey === "string") && (value.deleteApiKey === undefined || typeof value.deleteApiKey === "boolean");
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

export function isApiProtocol(value: unknown): value is ApiProtocol {
  return ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].includes(String(value));
}

export function isConnectionSettings(value: unknown): value is ConnectionSettings {
  return isRecord(value) && typeof value.baseUrl === "string" && isApiProtocol(value.api)
    && typeof value.modelId === "string" && Array.isArray(value.modelIds) && value.modelIds.every((id) => typeof id === "string")
    && typeof value.systemPrompt === "string" && typeof value.appendPrompt === "string"
    && typeof value.skillsEnabled === "boolean" && Array.isArray(value.skillPaths) && value.skillPaths.every((path) => typeof path === "string");
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
