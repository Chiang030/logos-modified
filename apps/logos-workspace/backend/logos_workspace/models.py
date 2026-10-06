"""Persistent control-plane models."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from logos_workspace.database import Base


def new_id() -> str:
    """Return a sortable-enough opaque identifier for public resources."""
    return uuid4().hex


def utcnow() -> datetime:
    """Return an aware UTC timestamp."""
    return datetime.now(UTC)


class TimestampMixin:
    """Creation and update timestamps shared by mutable records."""

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Workspace(TimestampMixin, Base):
    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, default="")
    current_revision: Mapped[int] = mapped_column(Integer, default=0)


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(String(64))
    max_concurrency: Mapped[int] = mapped_column(Integer, default=2)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class WorkspaceMember(TimestampMixin, Base):
    __tablename__ = "workspace_members"
    __table_args__ = (UniqueConstraint("workspace_id", "actor_type", "actor_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    actor_type: Mapped[str] = mapped_column(String(16))
    actor_id: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(32), default="editor")


class AgentSession(TimestampMixin, Base):
    __tablename__ = "agent_sessions"
    __table_args__ = (Index("ix_agent_sessions_workspace_agent", "workspace_id", "agent_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"))
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"))
    thread_id: Mapped[str] = mapped_column(String(64), unique=True, default=new_id)
    title: Mapped[str] = mapped_column(String(180))
    status: Mapped[str] = mapped_column(String(24), default="active")
    shared_revision: Mapped[int] = mapped_column(Integer, default=0)
    next_sequence: Mapped[int] = mapped_column(Integer, default=1)
    source_session_id: Mapped[str | None] = mapped_column(ForeignKey("agent_sessions.id"), nullable=True)
    source_checkpoint_id: Mapped[str | None] = mapped_column(String(120), nullable=True)


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (UniqueConstraint("session_id", "sequence"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("agent_sessions.id", ondelete="CASCADE"), index=True)
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"), nullable=True, index=True)
    sender_type: Mapped[str] = mapped_column(String(16))
    sender_id: Mapped[str] = mapped_column(String(120))
    recipient_agent_id: Mapped[str] = mapped_column(String(64))
    in_reply_to: Mapped[str | None] = mapped_column(ForeignKey("messages.id"), nullable=True)
    sequence: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(24), default="created")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Task(TimestampMixin, Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    requester_type: Mapped[str] = mapped_column(String(16))
    requester_id: Mapped[str] = mapped_column(String(120))
    assignee_agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    session_id: Mapped[str | None] = mapped_column(ForeignKey("agent_sessions.id"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(180))
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(24), default="queued")
    shared_revision: Mapped[int] = mapped_column(Integer)
    deliverable_summary: Mapped[str] = mapped_column(Text, default="")


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("agent_sessions.id", ondelete="CASCADE"), index=True)
    message_id: Mapped[str] = mapped_column(ForeignKey("messages.id"))
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(24), default="queued")
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    stop_mode: Mapped[str | None] = mapped_column(String(16), nullable=True)
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ChangeSet(Base):
    __tablename__ = "changesets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    base_revision: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"))
    session_id: Mapped[str] = mapped_column(ForeignKey("agent_sessions.id"))
    run_id: Mapped[str | None] = mapped_column(ForeignKey("runs.id"), nullable=True)
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"), nullable=True)
    summary: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(24), default="proposed")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class WorkspaceRevision(Base):
    __tablename__ = "workspace_revisions"
    __table_args__ = (UniqueConstraint("workspace_id", "number"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    parent_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    changeset_id: Mapped[str | None] = mapped_column(ForeignKey("changesets.id"), nullable=True)
    created_by: Mapped[str] = mapped_column(String(160))
    summary: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    changeset_id: Mapped[str | None] = mapped_column(ForeignKey("changesets.id"), nullable=True)
    revision: Mapped[int] = mapped_column(Integer)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"))
    session_id: Mapped[str] = mapped_column(ForeignKey("agent_sessions.id"))
    run_id: Mapped[str | None] = mapped_column(ForeignKey("runs.id"), nullable=True)
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"), nullable=True)
    kind: Mapped[str] = mapped_column(String(48))
    name: Mapped[str] = mapped_column(String(220))
    storage_path: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64))
    size_bytes: Mapped[int] = mapped_column(Integer)
    media_type: Mapped[str] = mapped_column(String(120), default="application/octet-stream")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    type: Mapped[str] = mapped_column(String(48), index=True)
    agent_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    session_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    task_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    run_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    message_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
