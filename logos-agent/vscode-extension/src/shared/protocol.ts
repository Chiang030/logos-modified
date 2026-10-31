import { isProviderId, type ProviderId } from "./providerPresets";
import type { SoftwareDiscovery } from "../../../pi-domain/src/software-discovery.mjs";

export type RuntimeStatus = "idle" | "starting" | "ready" | "running" | "stopping" | "error";

export interface ModelOption {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  /** 归属的本地 API 配置；运行时返回的每个 provider 都映射回一条连接。 */
  connectionId?: string;
  connectionName?: string;
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
  status: "running" | "completed" | "error" | "aborted" | "interrupted";
  durationMs?: number;
}

export interface RestoredMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  position?: number;
  isError?: boolean;
}
export interface RestoredTool extends ToolCallView { position: number; }
export interface SessionListEntry { sessionId: string; title: string; sessionFile?: string; }

export type ApiProtocol = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export type ModelSource = "upstream" | "fallback";
export type OpenAiLoginPhase = "waiting" | "exchanging" | "done";

/** 一条保存到本地的 API 配置；每条拥有独立的 URL、协议和 API Key。 */
export interface ConnectionEntry {
  id: string;
  name: string;
  providerId: ProviderId;
  baseUrl: string;
  api: ApiProtocol;
  /** 该配置的默认模型，也是新建时必须先选中的一条。 */
  modelId: string;
  /** 该配置开放给左下角切换器的全部模型。 */
  modelIds: string[];
  modelCapabilities?: Record<string, { reasoning?: boolean }>;
}

export interface ConnectionsSettings {
  connections: ConnectionEntry[];
  /** 当前对话使用的连接；`activeModelId` 必须属于该连接的模型列表。 */
  activeConnectionId?: string;
  activeModelId: string;
  systemPrompt: string;
  appendPrompt: string;
  skillsEnabled: boolean;
  skillPaths: string[];
}

export interface SettingsView extends ConnectionsSettings {
  /** 连接 id → 是否已有可用凭据（ChatGPT 连接取登录状态）。 */
  hasApiKeyByConnection: Record<string, boolean>;
  hasOpenAiLogin: boolean;
  bundledSkills: string[];
  configDirectory: string;
  domainDirectory: string;
}

export type ExtensionToWebviewMessage =
  | { type: "software/result"; result: SoftwareDiscovery }
  | { type: "software/error"; message: string }
  | { type: "settings/loaded"; settings: SettingsView }
  | { type: "settings/models"; modelIds: string[]; source: ModelSource }
  | { type: "settings/openaiLoginStatus"; phase: OpenAiLoginPhase; url?: string }
  | { type: "settings/saved" }
  | { type: "settings/error"; message: string }
  | { type: "runtime/status"; status: RuntimeStatus; detail?: string }
  | { type: "runtime/config"; config: RuntimeConfig }
  | { type: "extension/info"; version: string }
  | { type: "runtime/error"; message: string; fatal?: boolean }
  | { type: "session/loading"; loading: boolean }
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
  | { type: "run/settled"; aborted: boolean; outcome?: "completed" | "failed" | "aborted" | "interrupted" };

export type WebviewToExtensionMessage =
  | { type: "software/load"; refresh?: boolean }
  | { type: "software/path"; product: string; path: string }
  | { type: "settings/load" }
  | { type: "settings/models"; baseUrl: string; api: ApiProtocol; apiKey?: string }
  | { type: "settings/save"; systemPrompt: string; appendPrompt: string; skillsEnabled: boolean; skillPaths: string[] }
  | { type: "connection/save"; entry: ConnectionEntry; apiKey?: string; deleteApiKey?: boolean }
  | { type: "connection/delete"; connectionId: string }
  | { type: "settings/openaiLogin" }
  | { type: "settings/openaiCancelLogin" }
  | { type: "settings/openaiManualCallback"; url: string }
  | { type: "settings/openaiLogout" }
  | { type: "webview/ready" }
  | { type: "chat/send"; text: string }
  | { type: "chat/abort" }
  | { type: "session/new" }
  | { type: "session/select"; sessionId: string }
  | { type: "session/rename"; sessionId: string; title: string }
  | { type: "link/open"; href: string }
  | { type: "diagnostics/open" }
  | { type: "model/select"; provider: string; modelId: string }
  | { type: "thinking/select"; level: string }
  | { type: "runtime/restart" };

export function isWebviewToExtensionMessage(value: unknown): value is WebviewToExtensionMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "software/load": return value.refresh === undefined || typeof value.refresh === "boolean";
    case "software/path": return typeof value.product === "string" && typeof value.path === "string";
    case "diagnostics/open": return true;
    case "link/open": return typeof value.href === "string" && value.href.length > 0;
    case "session/rename": return typeof value.sessionId === "string" && typeof value.title === "string";
    case "settings/load": return true;
    case "settings/models":
      return typeof value.baseUrl === "string" && isApiProtocol(value.api) && (value.apiKey === undefined || typeof value.apiKey === "string");
    case "settings/save":
      return typeof value.systemPrompt === "string" && typeof value.appendPrompt === "string"
        && typeof value.skillsEnabled === "boolean" && Array.isArray(value.skillPaths) && value.skillPaths.every((path) => typeof path === "string");
    case "connection/save":
      return isConnectionEntry(value.entry) && (value.apiKey === undefined || typeof value.apiKey === "string") && (value.deleteApiKey === undefined || typeof value.deleteApiKey === "boolean");
    case "connection/delete":
      return typeof value.connectionId === "string" && value.connectionId.length > 0;
    case "settings/openaiLogin":
    case "settings/openaiCancelLogin":
    case "settings/openaiLogout":
      return true;
    case "settings/openaiManualCallback":
      return typeof value.url === "string" && value.url.length > 0;
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

export function isConnectionEntry(value: unknown): value is ConnectionEntry {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0 && typeof value.name === "string"
    && (value.providerId === undefined || isProviderId(value.providerId))
    && typeof value.baseUrl === "string" && isApiProtocol(value.api)
    && typeof value.modelId === "string" && Array.isArray(value.modelIds) && value.modelIds.every((id) => typeof id === "string")
    && (value.modelCapabilities === undefined || (isRecord(value.modelCapabilities) && Object.values(value.modelCapabilities).every((capability) => isRecord(capability) && (capability.reasoning === undefined || typeof capability.reasoning === "boolean"))));
}

export function isConnectionsSettings(value: unknown): value is ConnectionsSettings {
  return isRecord(value) && Array.isArray(value.connections) && value.connections.every(isConnectionEntry)
    && (value.activeConnectionId === undefined || typeof value.activeConnectionId === "string")
    && typeof value.activeModelId === "string"
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
