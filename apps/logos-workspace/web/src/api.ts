import type {
  AgentSession,
  DispatchInput,
  DispatchResult,
  Message,
  Overview,
  Run,
  Workspace,
  WorkspaceFile,
} from "./types";

export const API_URL = (import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

type RequestOptions = RequestInit & { actor?: { type: "user" | "agent"; id: string } };

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  headers.set("X-Actor-Type", options.actor?.type ?? "user");
  headers.set("X-Actor-Id", options.actor?.id ?? "local-user");
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail));
  }
  return response.json() as Promise<T>;
}

export const api = {
  workspaces: () => request<Workspace[]>("/api/workspaces"),
  createWorkspace: (name: string, description: string) =>
    request<Workspace>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    }),
  overview: (workspaceId: string) => request<Overview>(`/api/workspaces/${workspaceId}/overview`),
  messages: (sessionId: string) => request<Message[]>(`/api/sessions/${sessionId}/messages`),
  sendMessage: (sessionId: string, content: string, taskId?: string) =>
    request<Run>(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, task_id: taskId }),
    }),
  createSession: (workspaceId: string, agentId: string, title: string, sharedRevision?: number) =>
    request<AgentSession>(`/api/workspaces/${workspaceId}/agents/${agentId}/sessions`, {
      method: "POST",
      body: JSON.stringify({ title, shared_revision: sharedRevision }),
    }),
  forkSession: (sessionId: string, title: string, checkpoint?: string) =>
    request<AgentSession>(`/api/sessions/${sessionId}/fork`, {
      method: "POST",
      body: JSON.stringify({ title, source_checkpoint_id: checkpoint }),
    }),
  archiveSession: (sessionId: string) =>
    request<AgentSession>(`/api/sessions/${sessionId}/archive`, { method: "PATCH" }),
  dispatch: (workspaceId: string, input: DispatchInput, asChief: boolean) =>
    request<DispatchResult>(`/api/workspaces/${workspaceId}/dispatch`, {
      method: "POST",
      body: JSON.stringify(input),
      actor: asChief ? { type: "agent", id: "chief_engineer" } : undefined,
    }),
  stopRun: (runId: string, mode: "cancel" | "interrupt") =>
    request<Run>(`/api/runs/${runId}/${mode}`, { method: "POST" }),
  files: (sessionId: string, scope: string, runId?: string) => {
    const search = new URLSearchParams({ scope });
    if (runId) search.set("run_id", runId);
    return request<WorkspaceFile[]>(`/api/sessions/${sessionId}/files?${search}`);
  },
  readFile: (sessionId: string, scope: string, path: string, runId?: string) => {
    const search = new URLSearchParams({ scope, path });
    if (runId) search.set("run_id", runId);
    return request<WorkspaceFile>(`/api/sessions/${sessionId}/file?${search}`);
  },
  writeFile: (
    sessionId: string,
    scope: "private" | "session" | "run",
    path: string,
    content: string,
    runId?: string,
  ) => {
    const search = new URLSearchParams({ scope });
    if (runId) search.set("run_id", runId);
    return request<WorkspaceFile>(`/api/sessions/${sessionId}/files?${search}`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    });
  },
  publish: (
    workspaceId: string,
    input: {
      base_revision: number;
      agent_id: string;
      session_id: string;
      summary: string;
      items: Array<{ source_path: string; target_path: string; kind: string; media_type: string }>;
    },
  ) => request(`/api/workspaces/${workspaceId}/changesets`, { method: "POST", body: JSON.stringify(input) }),
  restore: (workspaceId: string, revision: number) =>
    request(`/api/workspaces/${workspaceId}/revisions/${revision}/restore`, { method: "POST" }),
  eventUrl: (workspaceId: string, after = 0) =>
    `${API_URL}/api/workspaces/${workspaceId}/events?after=${after}`,
};
