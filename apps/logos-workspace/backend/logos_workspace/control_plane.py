"""Application services for workspaces, Sessions, messages, and tasks."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from logos_workspace.auth import Actor
from logos_workspace.events import EventStore
from logos_workspace.models import (
    Agent,
    AgentSession,
    Artifact,
    ChangeSet,
    Message,
    Run,
    Task,
    Workspace,
    WorkspaceMember,
    WorkspaceRevision,
)
from logos_workspace.schemas import ChangeSetCreate, DispatchCreate, MessageCreate, SessionCreate, SessionStrategy
from logos_workspace.sequences import allocate_message_sequence
from logos_workspace.workspace_storage import WorkspaceStorage

AGENT_DEFINITIONS = (
    {
        "id": "chief_engineer",
        "name": "总师智能体",
        "role": "chief",
        "description": "澄清目标、维护项目约束、派发任务并综合专业交付。",
        "max_concurrency": 2,
    },
    {
        "id": "modeling_agent",
        "name": "建模智能体",
        "role": "modeling",
        "description": "负责多物理场建模方案、计算准备和版本化模型交付。",
        "max_concurrency": 3,
    },
    {
        "id": "validation_agent",
        "name": "验证智能体",
        "role": "validation",
        "description": "独立读取冻结证据、执行确定性检查并发布验证报告。",
        "max_concurrency": 2,
    },
)
ROLE_LEVEL = {"viewer": 1, "editor": 2, "owner": 3}


class ControlPlane:
    """Coordinate first-class Agents without nesting their Runs."""

    def __init__(self, events: EventStore, storage: WorkspaceStorage) -> None:
        self.events = events
        self.storage = storage
        self.enqueue_run: Callable[[str], None] | None = None

    async def seed(self, session: AsyncSession) -> None:
        """Install built-in Agent identities and a usable initial workspace."""
        for definition in AGENT_DEFINITIONS:
            if await session.get(Agent, definition["id"]) is None:
                session.add(Agent(**definition))
        await session.flush()
        workspace = await session.scalar(select(Workspace).limit(1))
        if workspace is None:
            workspace = Workspace(name="Logos 示例项目", description="多智能体工程协作工作区")
            session.add(workspace)
            await session.flush()
            session.add(
                WorkspaceRevision(
                    workspace_id=workspace.id,
                    number=0,
                    parent_number=None,
                    created_by="system",
                    summary="Initial empty workspace",
                )
            )
            session.add(
                WorkspaceMember(
                    workspace_id=workspace.id,
                    actor_type="user",
                    actor_id="local-user",
                    role="owner",
                )
            )
            for definition in AGENT_DEFINITIONS:
                agent_session = AgentSession(
                    workspace_id=workspace.id,
                    agent_id=definition["id"],
                    title="项目主会话",
                    shared_revision=0,
                )
                session.add(agent_session)
                await session.flush()
                self.storage.initialize_session(workspace.id, agent_session.id)
            self.storage.initialize_workspace(workspace.id)
        workspaces = list((await session.scalars(select(Workspace))).all())
        for existing_workspace in workspaces:
            for definition in AGENT_DEFINITIONS:
                member = await session.scalar(
                    select(WorkspaceMember).where(
                        WorkspaceMember.workspace_id == existing_workspace.id,
                        WorkspaceMember.actor_type == "agent",
                        WorkspaceMember.actor_id == definition["id"],
                    )
                )
                if member is None:
                    session.add(
                        WorkspaceMember(
                            workspace_id=existing_workspace.id,
                            actor_type="agent",
                            actor_id=definition["id"],
                            role="editor",
                        )
                    )
        await session.commit()

    async def require_membership(
        self,
        session: AsyncSession,
        actor: Actor,
        workspace_id: str,
        minimum_role: str = "viewer",
    ) -> WorkspaceMember:
        """Authorize one actor against the workspace role hierarchy."""
        member = await session.scalar(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.actor_type == actor.type,
                WorkspaceMember.actor_id == actor.id,
            )
        )
        if member is None or ROLE_LEVEL.get(member.role, 0) < ROLE_LEVEL[minimum_role]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "workspace access denied")
        return member

    async def require_workspace(self, session: AsyncSession, workspace_id: str) -> Workspace:
        workspace = await session.get(Workspace, workspace_id)
        if workspace is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "workspace not found")
        return workspace

    async def require_agent(self, session: AsyncSession, agent_id: str) -> Agent:
        agent = await session.get(Agent, agent_id)
        if agent is None or not agent.enabled:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "agent not found")
        return agent

    async def require_session(self, session: AsyncSession, session_id: str) -> AgentSession:
        agent_session = await session.get(AgentSession, session_id)
        if agent_session is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found")
        return agent_session

    async def create_workspace(self, session: AsyncSession, actor: Actor, name: str, description: str) -> Workspace:
        workspace = Workspace(name=name, description=description)
        session.add(workspace)
        await session.flush()
        session.add_all(
            [
                WorkspaceMember(
                    workspace_id=workspace.id,
                    actor_type=actor.type,
                    actor_id=actor.id,
                    role="owner",
                ),
                WorkspaceRevision(
                    workspace_id=workspace.id,
                    number=0,
                    parent_number=None,
                    created_by=actor.key,
                    summary="Initial empty workspace",
                ),
                *[
                    WorkspaceMember(
                        workspace_id=workspace.id,
                        actor_type="agent",
                        actor_id=definition["id"],
                        role="editor",
                    )
                    for definition in AGENT_DEFINITIONS
                ],
            ]
        )
        self.storage.initialize_workspace(workspace.id)
        await self.events.publish(
            session,
            workspace_id=workspace.id,
            event_type="workspace_updated",
            payload={"action": "created", "name": name, "revision": 0},
        )
        await session.commit()
        await self.events.notify()
        return workspace

    async def create_session(
        self,
        session: AsyncSession,
        workspace_id: str,
        agent_id: str,
        data: SessionCreate,
    ) -> AgentSession:
        workspace = await self.require_workspace(session, workspace_id)
        await self.require_agent(session, agent_id)
        revision = workspace.current_revision if data.shared_revision is None else data.shared_revision
        if revision > workspace.current_revision:
            raise HTTPException(status.HTTP_409_CONFLICT, "shared revision does not exist")
        agent_session = AgentSession(
            workspace_id=workspace_id,
            agent_id=agent_id,
            title=data.title,
            shared_revision=revision,
        )
        session.add(agent_session)
        await session.flush()
        self.storage.initialize_session(workspace_id, agent_session.id)
        await self.events.publish(
            session,
            workspace_id=workspace_id,
            event_type="session_created",
            agent_id=agent_id,
            session_id=agent_session.id,
            payload={"title": data.title, "shared_revision": revision},
        )
        await session.commit()
        await self.events.notify()
        return agent_session

    async def fork_session(
        self,
        session: AsyncSession,
        source: AgentSession,
        title: str,
        checkpoint_id: str | None,
    ) -> AgentSession:
        target = AgentSession(
            workspace_id=source.workspace_id,
            agent_id=source.agent_id,
            title=title,
            shared_revision=source.shared_revision,
            source_session_id=source.id,
            source_checkpoint_id=checkpoint_id,
        )
        session.add(target)
        await session.flush()
        query = select(Message).where(Message.session_id == source.id).order_by(Message.sequence)
        if checkpoint_id and checkpoint_id.startswith("message:"):
            try:
                query = query.where(Message.sequence <= int(checkpoint_id.split(":", 1)[1]))
            except ValueError as exc:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "invalid checkpoint id") from exc
        copied_messages = list((await session.scalars(query)).all())
        for message in copied_messages:
            session.add(
                Message(
                    workspace_id=target.workspace_id,
                    agent_id=target.agent_id,
                    session_id=target.id,
                    task_id=None,
                    sender_type=message.sender_type,
                    sender_id=message.sender_id,
                    recipient_agent_id=target.agent_id,
                    sequence=message.sequence,
                    content=message.content,
                    status="copied",
                )
            )
        target.next_sequence = max((message.sequence for message in copied_messages), default=0) + 1
        self.storage.copy_session(source.workspace_id, source.id, target.id)
        await self.events.publish(
            session,
            workspace_id=target.workspace_id,
            event_type="session_forked",
            agent_id=target.agent_id,
            session_id=target.id,
            payload={"source_session_id": source.id, "checkpoint_id": checkpoint_id},
        )
        await session.commit()
        await self.events.notify()
        return target

    async def create_message_run(
        self,
        session: AsyncSession,
        actor: Actor,
        agent_session: AgentSession,
        data: MessageCreate,
    ) -> tuple[Message, Run]:
        sequence = await allocate_message_sequence(session, agent_session.id)
        message = Message(
            workspace_id=agent_session.workspace_id,
            agent_id=agent_session.agent_id,
            session_id=agent_session.id,
            task_id=data.task_id,
            sender_type=actor.type,
            sender_id=actor.id,
            recipient_agent_id=agent_session.agent_id,
            in_reply_to=data.in_reply_to,
            sequence=sequence,
            content=data.content,
            status="queued",
        )
        session.add(message)
        await session.flush()
        run = Run(
            workspace_id=agent_session.workspace_id,
            agent_id=agent_session.agent_id,
            session_id=agent_session.id,
            message_id=message.id,
            task_id=data.task_id,
        )
        session.add(run)
        await session.flush()
        self.storage.initialize_run(agent_session.workspace_id, run.id)
        await self.events.publish(
            session,
            workspace_id=agent_session.workspace_id,
            event_type="message_created",
            agent_id=agent_session.agent_id,
            session_id=agent_session.id,
            task_id=data.task_id,
            run_id=run.id,
            message_id=message.id,
            payload={"sender_type": actor.type, "sender_id": actor.id, "sequence": sequence},
        )
        await self.events.publish(
            session,
            workspace_id=agent_session.workspace_id,
            event_type="run_queued",
            agent_id=agent_session.agent_id,
            session_id=agent_session.id,
            task_id=data.task_id,
            run_id=run.id,
            message_id=message.id,
        )
        await session.commit()
        await self.events.notify()
        if self.enqueue_run:
            self.enqueue_run(agent_session.id)
        return message, run

    async def dispatch(
        self,
        session: AsyncSession,
        actor: Actor,
        workspace_id: str,
        data: DispatchCreate,
    ) -> tuple[Task, AgentSession, Message, Run]:
        workspace = await self.require_workspace(session, workspace_id)
        await self.require_agent(session, data.recipient_agent_id)
        revision = workspace.current_revision if data.shared_revision is None else data.shared_revision
        if revision > workspace.current_revision:
            raise HTTPException(status.HTTP_409_CONFLICT, "shared revision does not exist")

        if data.session_strategy == SessionStrategy.NEW:
            target = await self.create_session(
                session,
                workspace_id,
                data.recipient_agent_id,
                SessionCreate(title=data.session_title, shared_revision=revision),
            )
        elif data.session_strategy == SessionStrategy.CONTINUE:
            target = await self.require_session(session, data.session_id or "")
            if target.workspace_id != workspace_id or target.agent_id != data.recipient_agent_id:
                raise HTTPException(status.HTTP_409_CONFLICT, "target Session belongs to another Agent or Workspace")
        else:
            source = await self.require_session(session, data.source_session_id or "")
            if source.workspace_id != workspace_id or source.agent_id != data.recipient_agent_id:
                raise HTTPException(status.HTTP_409_CONFLICT, "source Session belongs to another Agent or Workspace")
            target = await self.fork_session(session, source, data.session_title, data.source_checkpoint_id)

        task = Task(
            workspace_id=workspace_id,
            requester_type=actor.type,
            requester_id=actor.id,
            assignee_agent_id=data.recipient_agent_id,
            session_id=target.id,
            title=data.task_title,
            description=data.message,
            shared_revision=revision,
        )
        session.add(task)
        await session.flush()
        await self.events.publish(
            session,
            workspace_id=workspace_id,
            event_type="task_dispatched",
            agent_id=data.recipient_agent_id,
            session_id=target.id,
            task_id=task.id,
            payload={"strategy": data.session_strategy.value, "title": data.task_title, "revision": revision},
        )
        await session.commit()
        actor_message = MessageCreate(content=data.message, task_id=task.id)
        message, run = await self.create_message_run(session, actor, target, actor_message)
        return task, target, message, run

    async def request_run_stop(self, session: AsyncSession, run_id: str, *, interrupted: bool) -> Run:
        run = await session.get(Run, run_id)
        if run is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found")
        if run.status in {"completed", "failed", "cancelled", "interrupted"}:
            return run
        run.cancel_requested = True
        run.stop_mode = "interrupted" if interrupted else "cancelled"
        if run.status == "queued":
            run.status = run.stop_mode
        await self.events.publish(
            session,
            workspace_id=run.workspace_id,
            event_type="run_interrupt_requested" if interrupted else "run_cancel_requested",
            agent_id=run.agent_id,
            session_id=run.session_id,
            task_id=run.task_id,
            run_id=run.id,
        )
        await session.commit()
        await self.events.notify()
        return run

    async def publish_changeset(
        self, session: AsyncSession, actor: Actor, workspace: Workspace, data: ChangeSetCreate
    ) -> tuple[ChangeSet, list[Artifact]]:
        agent_session = await self.require_session(session, data.session_id)
        if agent_session.workspace_id != workspace.id or agent_session.agent_id != data.agent_id:
            raise HTTPException(status.HTTP_409_CONFLICT, "Session does not match publication identity")
        allowed = {
            "chief_engineer": {"requirement", "decision", "document"},
            "modeling_agent": {"model", "configuration", "result", "document"},
            "validation_agent": {"validation_report", "evidence", "document"},
        }
        invalid = [item.kind for item in data.items if item.kind not in allowed.get(data.agent_id, set())]
        if invalid:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Agent cannot publish artifact kinds: {', '.join(invalid)}")

        async with self.storage.lock(workspace.id):
            await session.refresh(workspace)
            if data.base_revision != workspace.current_revision:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"base revision {data.base_revision} is stale; current revision is {workspace.current_revision}",
                )
            revision_number = workspace.current_revision + 1
            changeset = ChangeSet(
                workspace_id=workspace.id,
                base_revision=data.base_revision,
                revision=revision_number,
                agent_id=data.agent_id,
                session_id=data.session_id,
                run_id=data.run_id,
                task_id=data.task_id,
                summary=data.summary,
                status="committed",
            )
            session.add(changeset)
            await session.flush()
            try:
                files = self.storage.publish(
                    workspace_id=workspace.id,
                    base_revision=data.base_revision,
                    revision=revision_number,
                    session_id=data.session_id,
                    items=[(item.source_path, item.target_path, item.kind, item.media_type) for item in data.items],
                )
            except (FileNotFoundError, FileExistsError, ValueError) as exc:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
            artifacts = [
                Artifact(
                    workspace_id=workspace.id,
                    changeset_id=changeset.id,
                    revision=revision_number,
                    agent_id=data.agent_id,
                    session_id=data.session_id,
                    run_id=data.run_id,
                    task_id=data.task_id,
                    kind=item.kind,
                    name=item.name,
                    storage_path=str(item.path),
                    sha256=item.sha256,
                    size_bytes=item.size_bytes,
                    media_type=item.media_type,
                )
                for item in files
            ]
            session.add_all(artifacts)
            session.add(
                WorkspaceRevision(
                    workspace_id=workspace.id,
                    number=revision_number,
                    parent_number=data.base_revision,
                    changeset_id=changeset.id,
                    created_by=actor.key,
                    summary=data.summary,
                )
            )
            workspace.current_revision = revision_number
            await session.flush()
            for artifact in artifacts:
                await self.events.publish(
                    session,
                    workspace_id=workspace.id,
                    event_type="artifact_published",
                    agent_id=data.agent_id,
                    session_id=data.session_id,
                    task_id=data.task_id,
                    run_id=data.run_id,
                    payload={"artifact_id": artifact.id, "name": artifact.name, "revision": revision_number},
                )
            await self.events.publish(
                session,
                workspace_id=workspace.id,
                event_type="workspace_updated",
                agent_id=data.agent_id,
                session_id=data.session_id,
                task_id=data.task_id,
                run_id=data.run_id,
                payload={"revision": revision_number, "base_revision": data.base_revision},
            )
            await session.commit()
        await self.events.notify()
        return changeset, artifacts

    async def rollback(
        self, session: AsyncSession, actor: Actor, workspace: Workspace, source_revision: int
    ) -> WorkspaceRevision:
        exists = await session.scalar(
            select(WorkspaceRevision).where(
                WorkspaceRevision.workspace_id == workspace.id,
                WorkspaceRevision.number == source_revision,
            )
        )
        if exists is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "source revision not found")
        async with self.storage.lock(workspace.id):
            await session.refresh(workspace)
            target_revision = workspace.current_revision + 1
            self.storage.rollback(workspace.id, source_revision, target_revision)
            revision = WorkspaceRevision(
                workspace_id=workspace.id,
                number=target_revision,
                parent_number=workspace.current_revision,
                created_by=actor.key,
                summary=f"Rollback to revision {source_revision}",
            )
            workspace.current_revision = target_revision
            session.add(revision)
            await self.events.publish(
                session,
                workspace_id=workspace.id,
                event_type="workspace_updated",
                payload={"revision": target_revision, "restored_from": source_revision},
            )
            await session.commit()
        await self.events.notify()
        return revision

    async def recover_runs(self, session: AsyncSession) -> list[str]:
        """Requeue Runs left active by a previous process."""
        await session.execute(
            update(Run).where(Run.status == "running").values(status="queued", error="Recovered after restart")
        )
        session_ids = list(await session.scalars(select(Run.session_id).where(Run.status == "queued").distinct()))
        await session.commit()
        return session_ids
