"""FastAPI routes for the Web workspace control plane."""

from __future__ import annotations

from dataclasses import asdict
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from logos_workspace.auth import Actor, current_actor
from logos_workspace.control_plane import ControlPlane
from logos_workspace.models import (
    Agent,
    AgentSession,
    Artifact,
    Message,
    Run,
    Task,
    Workspace,
    WorkspaceMember,
    WorkspaceRevision,
)
from logos_workspace.schemas import (
    AgentView,
    ArtifactView,
    ChangeSetCreate,
    ChangeSetResult,
    DispatchCreate,
    DispatchResult,
    FileView,
    FileWrite,
    MessageCreate,
    MessageView,
    Overview,
    RevisionView,
    RunView,
    SessionCreate,
    SessionFork,
    SessionView,
    TaskView,
    WorkspaceCreate,
    WorkspaceMemberUpsert,
    WorkspaceMemberView,
    WorkspaceView,
)

router = APIRouter(prefix="/api")
ActorDep = Annotated[Actor, Depends(current_actor)]


async def db_session(request: Request):
    async for session in request.app.state.database.session():
        yield session


DbDep = Annotated[AsyncSession, Depends(db_session)]


def plane(request: Request) -> ControlPlane:
    return request.app.state.control_plane


async def ensure_session_access(
    actor: Actor,
    agent_session: AgentSession,
    session: AsyncSession,
    control: ControlPlane,
    minimum_role: str = "viewer",
) -> None:
    """Keep Agent credentials scoped to their own Session identity."""
    await control.require_membership(session, actor, agent_session.workspace_id, minimum_role)
    if actor.type == "agent" and actor.id != agent_session.agent_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Agent cannot access another Agent's private Session")


@router.get("/health")
async def health(request: Request) -> dict[str, str]:
    return {"status": "ok", "runtime": request.app.state.settings.runtime_mode}


@router.get("/agents", response_model=list[AgentView])
async def list_agents(session: DbDep) -> list[Agent]:
    return list((await session.scalars(select(Agent).where(Agent.enabled.is_(True)).order_by(Agent.id))).all())


@router.get("/workspaces", response_model=list[WorkspaceView])
async def list_workspaces(session: DbDep, actor: ActorDep) -> list[Workspace]:
    return list(
        (
            await session.scalars(
                select(Workspace)
                .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
                .where(WorkspaceMember.actor_type == actor.type, WorkspaceMember.actor_id == actor.id)
                .order_by(Workspace.updated_at.desc())
            )
        ).all()
    )


@router.post("/workspaces", response_model=WorkspaceView, status_code=status.HTTP_201_CREATED)
async def create_workspace(data: WorkspaceCreate, request: Request, session: DbDep, actor: ActorDep) -> Workspace:
    return await plane(request).create_workspace(session, actor, data.name, data.description)


@router.get("/workspaces/{workspace_id}/members", response_model=list[WorkspaceMemberView])
async def list_workspace_members(
    workspace_id: str,
    request: Request,
    session: DbDep,
    actor: ActorDep,
) -> list[WorkspaceMember]:
    control = plane(request)
    await control.require_workspace(session, workspace_id)
    await control.require_membership(session, actor, workspace_id, "owner")
    return list(
        (
            await session.scalars(
                select(WorkspaceMember)
                .where(WorkspaceMember.workspace_id == workspace_id)
                .order_by(WorkspaceMember.actor_type, WorkspaceMember.actor_id)
            )
        ).all()
    )


@router.put("/workspaces/{workspace_id}/members", response_model=WorkspaceMemberView)
async def upsert_workspace_member(
    workspace_id: str,
    data: WorkspaceMemberUpsert,
    request: Request,
    session: DbDep,
    actor: ActorDep,
) -> WorkspaceMember:
    control = plane(request)
    await control.require_workspace(session, workspace_id)
    await control.require_membership(session, actor, workspace_id, "owner")
    if data.actor_type == "agent":
        await control.require_agent(session, data.actor_id)
    member = await session.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.actor_type == data.actor_type,
            WorkspaceMember.actor_id == data.actor_id,
        )
    )
    if member is None:
        member = WorkspaceMember(workspace_id=workspace_id, **data.model_dump())
        session.add(member)
    else:
        member.role = data.role
    await session.flush()
    await request.app.state.events.publish(
        session,
        workspace_id=workspace_id,
        event_type="workspace_updated",
        payload={"action": "member_upserted", "actor_type": data.actor_type, "actor_id": data.actor_id},
    )
    await session.commit()
    await request.app.state.events.notify()
    return member


@router.get("/workspaces/{workspace_id}/overview", response_model=Overview)
async def workspace_overview(workspace_id: str, request: Request, session: DbDep, actor: ActorDep) -> Overview:
    control = plane(request)
    workspace = await control.require_workspace(session, workspace_id)
    await control.require_membership(session, actor, workspace_id)
    agents = list((await session.scalars(select(Agent).where(Agent.enabled.is_(True)).order_by(Agent.id))).all())
    sessions = list(
        (
            await session.scalars(
                select(AgentSession)
                .where(AgentSession.workspace_id == workspace_id)
                .order_by(AgentSession.updated_at.desc())
            )
        ).all()
    )
    tasks = list(
        (
            await session.scalars(
                select(Task).where(Task.workspace_id == workspace_id).order_by(Task.updated_at.desc()).limit(100)
            )
        ).all()
    )
    runs = list(
        (
            await session.scalars(
                select(Run).where(Run.workspace_id == workspace_id).order_by(Run.created_at.desc()).limit(100)
            )
        ).all()
    )
    artifacts = list(
        (
            await session.scalars(
                select(Artifact)
                .where(Artifact.workspace_id == workspace_id)
                .order_by(Artifact.created_at.desc())
                .limit(100)
            )
        ).all()
    )
    revisions = list(
        (
            await session.scalars(
                select(WorkspaceRevision)
                .where(WorkspaceRevision.workspace_id == workspace_id)
                .order_by(WorkspaceRevision.number.desc())
                .limit(100)
            )
        ).all()
    )
    return Overview(
        workspace=WorkspaceView.model_validate(workspace),
        agents=[AgentView.model_validate(item) for item in agents],
        sessions=[SessionView.model_validate(item) for item in sessions],
        tasks=[TaskView.model_validate(item) for item in tasks],
        runs=[RunView.model_validate(item) for item in runs],
        artifacts=[ArtifactView.model_validate(item) for item in artifacts],
        revisions=[RevisionView.model_validate(item) for item in revisions],
    )


@router.get("/workspaces/{workspace_id}/agents/{agent_id}/sessions", response_model=list[SessionView])
async def list_sessions(
    workspace_id: str,
    agent_id: str,
    request: Request,
    session: DbDep,
    actor: ActorDep,
) -> list[AgentSession]:
    await plane(request).require_membership(session, actor, workspace_id)
    return list(
        (
            await session.scalars(
                select(AgentSession)
                .where(AgentSession.workspace_id == workspace_id, AgentSession.agent_id == agent_id)
                .order_by(AgentSession.updated_at.desc())
            )
        ).all()
    )


@router.post(
    "/workspaces/{workspace_id}/agents/{agent_id}/sessions",
    response_model=SessionView,
    status_code=status.HTTP_201_CREATED,
)
async def create_session(
    workspace_id: str,
    agent_id: str,
    data: SessionCreate,
    request: Request,
    session: DbDep,
    actor: ActorDep,
) -> AgentSession:
    control = plane(request)
    await control.require_membership(session, actor, workspace_id, "editor")
    return await control.create_session(session, workspace_id, agent_id, data)


@router.post("/sessions/{session_id}/fork", response_model=SessionView, status_code=status.HTTP_201_CREATED)
async def fork_session(
    session_id: str,
    data: SessionFork,
    request: Request,
    session: DbDep,
    actor: ActorDep,
) -> AgentSession:
    control = plane(request)
    source = await control.require_session(session, session_id)
    await ensure_session_access(actor, source, session, control, "editor")
    return await control.fork_session(session, source, data.title, data.source_checkpoint_id)


@router.patch("/sessions/{session_id}/archive", response_model=SessionView)
async def archive_session(session_id: str, request: Request, session: DbDep, actor: ActorDep) -> AgentSession:
    control = plane(request)
    agent_session = await control.require_session(session, session_id)
    await ensure_session_access(actor, agent_session, session, control, "editor")
    agent_session.status = "archived"
    await session.commit()
    return agent_session


@router.get("/sessions/{session_id}/messages", response_model=list[MessageView])
async def list_messages(
    session_id: str,
    request: Request,
    session: DbDep,
    actor: ActorDep,
) -> list[Message]:
    control = plane(request)
    agent_session = await control.require_session(session, session_id)
    await ensure_session_access(actor, agent_session, session, control)
    return list(
        (
            await session.scalars(select(Message).where(Message.session_id == session_id).order_by(Message.sequence))
        ).all()
    )


@router.post("/sessions/{session_id}/messages", response_model=RunView, status_code=status.HTTP_202_ACCEPTED)
async def create_message(
    session_id: str,
    data: MessageCreate,
    request: Request,
    session: DbDep,
    actor: ActorDep,
) -> Run:
    control = plane(request)
    agent_session = await control.require_session(session, session_id)
    await ensure_session_access(actor, agent_session, session, control, "editor")
    if agent_session.status != "active":
        raise HTTPException(status.HTTP_409_CONFLICT, "Session is archived")
    _, run = await control.create_message_run(session, actor, agent_session, data)
    return run


@router.post("/workspaces/{workspace_id}/dispatch", response_model=DispatchResult, status_code=status.HTTP_202_ACCEPTED)
async def dispatch_task(
    workspace_id: str,
    data: DispatchCreate,
    request: Request,
    session: DbDep,
    actor: ActorDep,
) -> DispatchResult:
    control = plane(request)
    await control.require_membership(session, actor, workspace_id, "editor")
    task, agent_session, message, run = await control.dispatch(session, actor, workspace_id, data)
    return DispatchResult(
        task=TaskView.model_validate(task),
        session=SessionView.model_validate(agent_session),
        message=MessageView.model_validate(message),
        run=RunView.model_validate(run),
    )


@router.post("/runs/{run_id}/cancel", response_model=RunView)
async def cancel_run(run_id: str, request: Request, session: DbDep, actor: ActorDep) -> Run:
    control = plane(request)
    existing = await session.get(Run, run_id)
    if existing is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found")
    await control.require_membership(session, actor, existing.workspace_id, "editor")
    run = await control.request_run_stop(session, run_id, interrupted=False)
    await request.app.state.scheduler.cancel(run_id)
    return run


@router.post("/runs/{run_id}/interrupt", response_model=RunView)
async def interrupt_run(run_id: str, request: Request, session: DbDep, actor: ActorDep) -> Run:
    control = plane(request)
    existing = await session.get(Run, run_id)
    if existing is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found")
    await control.require_membership(session, actor, existing.workspace_id, "editor")
    run = await control.request_run_stop(session, run_id, interrupted=True)
    await request.app.state.scheduler.cancel(run_id)
    return run


@router.get("/sessions/{session_id}/files", response_model=list[FileView])
async def list_files(
    session_id: str,
    request: Request,
    session: DbDep,
    actor: ActorDep,
    scope: Literal["shared", "private", "session", "run"] = Query(default="session"),
    run_id: str | None = None,
) -> list[FileView]:
    control = plane(request)
    agent_session = await control.require_session(session, session_id)
    await ensure_session_access(actor, agent_session, session, control)
    files = request.app.state.storage.list(
        scope=scope,
        workspace_id=agent_session.workspace_id,
        revision=agent_session.shared_revision,
        agent_id=agent_session.agent_id,
        session_id=agent_session.id,
        run_id=run_id,
    )
    return [FileView(**asdict(item)) for item in files]


@router.get("/sessions/{session_id}/file", response_model=FileView)
async def read_file(
    session_id: str,
    path: str,
    request: Request,
    session: DbDep,
    actor: ActorDep,
    scope: Literal["shared", "private", "session", "run"] = Query(default="session"),
    run_id: str | None = None,
) -> FileView:
    control = plane(request)
    agent_session = await control.require_session(session, session_id)
    await ensure_session_access(actor, agent_session, session, control)
    try:
        item = request.app.state.storage.read(
            scope=scope,
            workspace_id=agent_session.workspace_id,
            revision=agent_session.shared_revision,
            agent_id=agent_session.agent_id,
            session_id=agent_session.id,
            run_id=run_id,
            path=path,
        )
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    return FileView(**asdict(item))


@router.put("/sessions/{session_id}/files", response_model=FileView)
async def write_file(
    session_id: str,
    data: FileWrite,
    request: Request,
    session: DbDep,
    actor: ActorDep,
    scope: Literal["private", "session", "run"] = Query(default="session"),
    run_id: str | None = None,
) -> FileView:
    control = plane(request)
    agent_session = await control.require_session(session, session_id)
    await ensure_session_access(actor, agent_session, session, control, "editor")
    try:
        item = request.app.state.storage.write(
            scope=scope,
            workspace_id=agent_session.workspace_id,
            revision=agent_session.shared_revision,
            agent_id=agent_session.agent_id,
            session_id=agent_session.id,
            run_id=run_id,
            path=data.path,
            content=data.content,
        )
    except (PermissionError, ValueError) as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    return FileView(**asdict(item))


@router.post("/workspaces/{workspace_id}/changesets", response_model=ChangeSetResult)
async def publish_changeset(
    workspace_id: str,
    data: ChangeSetCreate,
    request: Request,
    session: DbDep,
    actor: ActorDep,
) -> ChangeSetResult:
    control = plane(request)
    workspace = await control.require_workspace(session, workspace_id)
    await control.require_membership(session, actor, workspace_id, "editor")
    changeset, artifacts = await control.publish_changeset(session, actor, workspace, data)
    return ChangeSetResult(
        changeset_id=changeset.id,
        revision=changeset.revision or 0,
        artifacts=[ArtifactView.model_validate(item) for item in artifacts],
    )


@router.post("/workspaces/{workspace_id}/revisions/{source_revision}/restore", response_model=RevisionView)
async def restore_revision(
    workspace_id: str,
    source_revision: int,
    request: Request,
    session: DbDep,
    actor: ActorDep,
) -> WorkspaceRevision:
    control = plane(request)
    workspace = await control.require_workspace(session, workspace_id)
    await control.require_membership(session, actor, workspace_id, "editor")
    return await control.rollback(session, actor, workspace, source_revision)


@router.get("/workspaces/{workspace_id}/events")
async def stream_events(
    workspace_id: str,
    request: Request,
    actor: ActorDep,
    after: int = Query(default=0, ge=0),
) -> StreamingResponse:
    # A request-scoped DB dependency would stay open for the lifetime of the
    # stream and retain a SQLite read transaction, blocking later writes.
    async with request.app.state.database.sessions() as session:
        control = plane(request)
        await control.require_workspace(session, workspace_id)
        await control.require_membership(session, actor, workspace_id)
    return StreamingResponse(
        request.app.state.events.stream(workspace_id, after),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
