"""Control-plane tools used by independently running Agents."""

from __future__ import annotations

import os
from typing import Any, Literal

import httpx
from langchain.tools import ToolRuntime
from langchain_core.tools import tool


def _context(runtime: ToolRuntime) -> dict[str, Any]:
    configurable = runtime.config.get("configurable", {})
    required = {"workspace_id", "agent_id", "session_id"}
    missing = sorted(required - configurable.keys())
    if missing:
        raise RuntimeError(f"missing Agent runtime context: {', '.join(missing)}")
    return configurable


def _headers(context: dict[str, Any]) -> dict[str, str]:
    return {"X-Actor-Type": "agent", "X-Actor-Id": str(context["agent_id"])}


def _base_url() -> str:
    return os.getenv("LOGOS_CONTROL_PLANE_URL", "http://127.0.0.1:8000").rstrip("/")


@tool
async def dispatch_task(
    recipient_agent_id: Literal["modeling_agent", "validation_agent"],
    session_strategy: Literal["new", "continue", "fork"],
    session_title: str,
    task_title: str,
    message: str,
    runtime: ToolRuntime,
    session_id: str | None = None,
    source_session_id: str | None = None,
    source_checkpoint_id: str | None = None,
) -> dict[str, Any]:
    """Dispatch work to a peer Agent using an explicit Session strategy."""
    context = _context(runtime)
    payload = {
        "recipient_agent_id": recipient_agent_id,
        "session_strategy": session_strategy,
        "session_id": session_id,
        "source_session_id": source_session_id,
        "source_checkpoint_id": source_checkpoint_id,
        "session_title": session_title,
        "task_title": task_title,
        "message": message,
        "shared_revision": context.get("shared_revision"),
    }
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{_base_url()}/api/workspaces/{context['workspace_id']}/dispatch",
            json=payload,
            headers=_headers(context),
        )
        response.raise_for_status()
        return response.json()


@tool
async def list_workspace_files(
    scope: Literal["shared", "private", "session", "run"],
    runtime: ToolRuntime,
) -> list[dict[str, Any]]:
    """List files visible in one logical workspace scope."""
    context = _context(runtime)
    params: dict[str, Any] = {"scope": scope}
    if scope == "run":
        params["run_id"] = context.get("run_id")
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{_base_url()}/api/sessions/{context['session_id']}/files",
            params=params,
            headers=_headers(context),
        )
        response.raise_for_status()
        return response.json()


@tool
async def read_workspace_file(
    scope: Literal["shared", "private", "session", "run"],
    path: str,
    runtime: ToolRuntime,
) -> dict[str, Any]:
    """Read a text file from a logical workspace scope."""
    context = _context(runtime)
    params: dict[str, Any] = {"scope": scope, "path": path}
    if scope == "run":
        params["run_id"] = context.get("run_id")
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{_base_url()}/api/sessions/{context['session_id']}/file",
            params=params,
            headers=_headers(context),
        )
        response.raise_for_status()
        return response.json()


@tool
async def write_workspace_file(
    scope: Literal["private", "session", "run"],
    path: str,
    content: str,
    runtime: ToolRuntime,
) -> dict[str, Any]:
    """Write a working file; shared files require `publish_changeset`."""
    context = _context(runtime)
    params: dict[str, Any] = {"scope": scope}
    if scope == "run":
        params["run_id"] = context.get("run_id")
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.put(
            f"{_base_url()}/api/sessions/{context['session_id']}/files",
            params=params,
            json={"path": path, "content": content},
            headers=_headers(context),
        )
        response.raise_for_status()
        return response.json()


@tool
async def publish_changeset(
    summary: str,
    source_path: str,
    target_path: str,
    kind: str,
    media_type: str,
    runtime: ToolRuntime,
) -> dict[str, Any]:
    """Publish one Session file as an immutable shared Artifact revision."""
    context = _context(runtime)
    payload = {
        "base_revision": context.get("shared_revision", 0),
        "agent_id": context["agent_id"],
        "session_id": context["session_id"],
        "run_id": context.get("run_id"),
        "task_id": context.get("task_id"),
        "summary": summary,
        "items": [
            {
                "source_path": source_path,
                "target_path": target_path,
                "kind": kind,
                "media_type": media_type,
            }
        ],
    }
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{_base_url()}/api/workspaces/{context['workspace_id']}/changesets",
            json=payload,
            headers=_headers(context),
        )
        response.raise_for_status()
        return response.json()


WORKSPACE_TOOLS = [list_workspace_files, read_workspace_file, write_workspace_file, publish_changeset]
