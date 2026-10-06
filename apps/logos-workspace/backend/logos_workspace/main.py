"""ASGI entry point for the Logos Workspace Web control plane."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from logos_workspace.api import router
from logos_workspace.config import get_settings
from logos_workspace.control_plane import ControlPlane
from logos_workspace.database import Database
from logos_workspace.events import EventStore
from logos_workspace.runtime import DeterministicRuntime, LangGraphRuntime
from logos_workspace.scheduler import RunScheduler
from logos_workspace.workspace_storage import WorkspaceStorage


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    database = Database(settings)
    await database.create_schema()
    storage = WorkspaceStorage(settings.resolved_data_dir)
    events = EventStore(database.sessions, settings.event_poll_seconds)
    control_plane = ControlPlane(events, storage)
    runtime = (
        LangGraphRuntime(settings.langgraph_url) if settings.runtime_mode == "langgraph" else DeterministicRuntime()
    )
    scheduler = RunScheduler(database.sessions, events, runtime, settings.run_concurrency)
    control_plane.enqueue_run = scheduler.enqueue

    app.state.settings = settings
    app.state.database = database
    app.state.storage = storage
    app.state.events = events
    app.state.control_plane = control_plane
    app.state.scheduler = scheduler

    async with database.sessions() as session:
        await control_plane.seed(session)
        for session_id in await control_plane.recover_runs(session):
            scheduler.enqueue(session_id)
    try:
        yield
    finally:
        await scheduler.close()
        await database.close()


app = FastAPI(title="Logos Workspace API", version="0.1.0", lifespan=lifespan)
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)
