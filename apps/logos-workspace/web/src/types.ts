export type Workspace = {
  id: string;
  name: string;
  description: string;
  current_revision: number;
  created_at: string;
  updated_at: string;
};

export type Agent = {
  id: string;
  name: string;
  description: string;
  role: string;
  max_concurrency: number;
  enabled: boolean;
};

export type AgentSession = {
  id: string;
  workspace_id: string;
  agent_id: string;
  thread_id: string;
  title: string;
  status: string;
  shared_revision: number;
  source_session_id: string | null;
  source_checkpoint_id: string | null;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: string;
  workspace_id: string;
  agent_id: string;
  session_id: string;
  task_id: string | null;
  sender_type: "user" | "agent";
  sender_id: string;
  recipient_agent_id: string;
  in_reply_to: string | null;
  sequence: number;
  content: string;
  status: string;
  created_at: string;
};

export type Task = {
  id: string;
  workspace_id: string;
  requester_type: string;
  requester_id: string;
  assignee_agent_id: string;
  session_id: string | null;
  title: string;
  description: string;
  status: string;
  shared_revision: number;
  deliverable_summary: string;
  created_at: string;
  updated_at: string;
};

export type Run = {
  id: string;
  workspace_id: string;
  agent_id: string;
  session_id: string;
  message_id: string;
  task_id: string | null;
  status: string;
  cancel_requested: boolean;
  stop_mode: string | null;
  error: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type Artifact = {
  id: string;
  workspace_id: string;
  changeset_id: string | null;
  revision: number;
  agent_id: string;
  session_id: string;
  run_id: string | null;
  task_id: string | null;
  kind: string;
  name: string;
  storage_path: string;
  sha256: string;
  size_bytes: number;
  media_type: string;
  created_at: string;
};

export type Revision = {
  id: string;
  workspace_id: string;
  number: number;
  parent_number: number | null;
  changeset_id: string | null;
  created_by: string;
  summary: string;
  created_at: string;
};

export type Overview = {
  workspace: Workspace;
  agents: Agent[];
  sessions: AgentSession[];
  tasks: Task[];
  runs: Run[];
  artifacts: Artifact[];
  revisions: Revision[];
};

export type WorkspaceFile = {
  path: string;
  scope: "shared" | "private" | "session" | "run";
  size_bytes: number;
  modified_at: string;
  content: string | null;
};

export type WorkspaceEvent = {
  id: number;
  workspace_id: string;
  type: string;
  agent_id: string | null;
  session_id: string | null;
  task_id: string | null;
  run_id: string | null;
  message_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export type DispatchInput = {
  recipient_agent_id: string;
  session_strategy: "new" | "continue" | "fork";
  session_id?: string;
  source_session_id?: string;
  source_checkpoint_id?: string;
  session_title: string;
  task_title: string;
  message: string;
  shared_revision?: number;
};

export type DispatchResult = {
  task: Task;
  session: AgentSession;
  message: Message;
  run: Run;
};

export type InspectorTab = "tasks" | "runs" | "files" | "artifacts" | "revisions";
