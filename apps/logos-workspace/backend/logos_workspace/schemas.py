"""Public API contracts for the Logos workspace."""

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ApiModel(BaseModel):
    """Base response model that accepts SQLAlchemy objects."""

    model_config = ConfigDict(from_attributes=True)


class SessionStrategy(StrEnum):
    NEW = "new"
    CONTINUE = "continue"
    FORK = "fork"


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=4000)


class WorkspaceView(ApiModel):
    id: str
    name: str
    description: str
    current_revision: int
    created_at: datetime
    updated_at: datetime


class WorkspaceMemberUpsert(BaseModel):
    actor_type: Literal["user", "agent"]
    actor_id: str = Field(min_length=1, max_length=120)
    role: Literal["owner", "editor", "viewer"] = "editor"


class WorkspaceMemberView(ApiModel):
    id: str
    workspace_id: str
    actor_type: str
    actor_id: str
    role: str
    created_at: datetime
    updated_at: datetime


class AgentView(ApiModel):
    id: str
    name: str
    description: str
    role: str
    max_concurrency: int
    enabled: bool


class SessionCreate(BaseModel):
    title: str = Field(min_length=1, max_length=180)
    shared_revision: int | None = Field(default=None, ge=0)


class SessionFork(BaseModel):
    title: str = Field(min_length=1, max_length=180)
    source_checkpoint_id: str | None = Field(default=None, max_length=120)


class SessionView(ApiModel):
    id: str
    workspace_id: str
    agent_id: str
    thread_id: str
    title: str
    status: str
    shared_revision: int
    source_session_id: str | None
    source_checkpoint_id: str | None
    created_at: datetime
    updated_at: datetime


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=100_000)
    task_id: str | None = None
    in_reply_to: str | None = None


class MessageView(ApiModel):
    id: str
    workspace_id: str
    agent_id: str
    session_id: str
    task_id: str | None
    sender_type: str
    sender_id: str
    recipient_agent_id: str
    in_reply_to: str | None
    sequence: int
    content: str
    status: str
    created_at: datetime


class DispatchCreate(BaseModel):
    recipient_agent_id: str
    session_strategy: SessionStrategy = SessionStrategy.NEW
    session_id: str | None = None
    source_session_id: str | None = None
    source_checkpoint_id: str | None = None
    session_title: str = Field(min_length=1, max_length=180)
    task_title: str = Field(min_length=1, max_length=180)
    message: str = Field(min_length=1, max_length=100_000)
    shared_revision: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_strategy(self) -> "DispatchCreate":
        if self.session_strategy == SessionStrategy.CONTINUE and not self.session_id:
            raise ValueError("continue requires session_id")
        if self.session_strategy == SessionStrategy.FORK and not self.source_session_id:
            raise ValueError("fork requires source_session_id")
        if self.session_strategy == SessionStrategy.NEW and (self.session_id or self.source_session_id):
            raise ValueError("new does not accept an existing session")
        return self


class TaskView(ApiModel):
    id: str
    workspace_id: str
    requester_type: str
    requester_id: str
    assignee_agent_id: str
    session_id: str | None
    title: str
    description: str
    status: str
    shared_revision: int
    deliverable_summary: str
    created_at: datetime
    updated_at: datetime


class RunView(ApiModel):
    id: str
    workspace_id: str
    agent_id: str
    session_id: str
    message_id: str
    task_id: str | None
    status: str
    cancel_requested: bool
    stop_mode: str | None
    error: str
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class DispatchResult(BaseModel):
    task: TaskView
    session: SessionView
    message: MessageView
    run: RunView


class FileWrite(BaseModel):
    path: str = Field(min_length=1, max_length=500)
    content: str = Field(max_length=5_000_000)


class FileView(BaseModel):
    path: str
    scope: Literal["shared", "private", "session", "run"]
    size_bytes: int
    modified_at: datetime
    content: str | None = None


class PublishItem(BaseModel):
    source_path: str = Field(min_length=1, max_length=500)
    target_path: str = Field(min_length=1, max_length=500)
    kind: str = Field(default="document", min_length=1, max_length=48)
    media_type: str = Field(default="text/plain", min_length=1, max_length=120)


class ChangeSetCreate(BaseModel):
    base_revision: int = Field(ge=0)
    agent_id: str
    session_id: str
    run_id: str | None = None
    task_id: str | None = None
    summary: str = Field(min_length=1, max_length=4000)
    items: list[PublishItem] = Field(min_length=1, max_length=100)


class ArtifactView(ApiModel):
    id: str
    workspace_id: str
    changeset_id: str | None
    revision: int
    agent_id: str
    session_id: str
    run_id: str | None
    task_id: str | None
    kind: str
    name: str
    storage_path: str
    sha256: str
    size_bytes: int
    media_type: str
    created_at: datetime


class ChangeSetResult(BaseModel):
    changeset_id: str
    revision: int
    artifacts: list[ArtifactView]


class RevisionView(ApiModel):
    id: str
    workspace_id: str
    number: int
    parent_number: int | None
    changeset_id: str | None
    created_by: str
    summary: str
    created_at: datetime


class EventView(ApiModel):
    id: int
    workspace_id: str
    type: str
    agent_id: str | None
    session_id: str | None
    task_id: str | None
    run_id: str | None
    message_id: str | None
    payload: dict[str, Any]
    created_at: datetime


class Overview(BaseModel):
    workspace: WorkspaceView
    agents: list[AgentView]
    sessions: list[SessionView]
    tasks: list[TaskView]
    runs: list[RunView]
    artifacts: list[ArtifactView]
    revisions: list[RevisionView]
