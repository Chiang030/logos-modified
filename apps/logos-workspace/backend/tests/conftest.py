"""Isolated ASGI test application fixtures."""

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from logos_workspace.config import get_settings
from logos_workspace.main import app


@pytest.fixture
async def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[httpx.AsyncClient]:
    db_path = tmp_path / "logos-test.db"
    monkeypatch.setenv("LOGOS_DATABASE_URL", f"sqlite+aiosqlite:///{db_path.as_posix()}")
    monkeypatch.setenv("LOGOS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("LOGOS_RUNTIME_MODE", "deterministic")
    monkeypatch.setenv("LOGOS_EVENT_POLL_SECONDS", "0.02")
    get_settings.cache_clear()
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as test_client:
            yield test_client
    get_settings.cache_clear()


@pytest.fixture
async def workspace_id(client: httpx.AsyncClient) -> str:
    response = await client.get("/api/workspaces")
    response.raise_for_status()
    return response.json()[0]["id"]
