"""End-to-end API tests for collaboration, scheduling, and workspace versions."""

import asyncio

import httpx

from logos_workspace.main import app


async def wait_for_run(client: httpx.AsyncClient, workspace_id: str, run_id: str) -> dict:
    for _ in range(100):
        overview = (await client.get(f"/api/workspaces/{workspace_id}/overview")).json()
        run = next(item for item in overview["runs"] if item["id"] == run_id)
        if run["status"] in {"completed", "failed", "cancelled", "interrupted"}:
            return run
        await asyncio.sleep(0.01)
    raise AssertionError(f"run {run_id} did not finish")


async def test_seeded_workspace_has_first_class_agents_and_sessions(
    client: httpx.AsyncClient,
    workspace_id: str,
) -> None:
    overview = (await client.get(f"/api/workspaces/{workspace_id}/overview")).json()

    assert {agent["id"] for agent in overview["agents"]} == {
        "chief_engineer",
        "modeling_agent",
        "validation_agent",
    }
    assert {item["agent_id"] for item in overview["sessions"]} == {
        "chief_engineer",
        "modeling_agent",
        "validation_agent",
    }
    assert all(item["thread_id"] for item in overview["sessions"])


async def test_direct_messages_reuse_one_session_and_are_processed_in_order(
    client: httpx.AsyncClient,
    workspace_id: str,
) -> None:
    overview = (await client.get(f"/api/workspaces/{workspace_id}/overview")).json()
    modeling = next(item for item in overview["sessions"] if item["agent_id"] == "modeling_agent")

    first = await client.post(
        f"/api/sessions/{modeling['id']}/messages",
        json={"content": "建立热结构模型"},
    )
    second = await client.post(
        f"/api/sessions/{modeling['id']}/messages",
        json={"content": "材料改为 6061-T6"},
    )
    first.raise_for_status()
    second.raise_for_status()
    assert (await wait_for_run(client, workspace_id, first.json()["id"]))["status"] == "completed"
    assert (await wait_for_run(client, workspace_id, second.json()["id"]))["status"] == "completed"

    messages = (await client.get(f"/api/sessions/{modeling['id']}/messages")).json()
    assert [message["sequence"] for message in messages] == list(range(1, len(messages) + 1))
    assert [message["sender_type"] for message in messages] == ["user", "user", "agent", "agent"]
    assert "6061-T6" in messages[-1]["content"]


async def test_dispatch_supports_new_continue_and_fork_with_visible_senders(
    client: httpx.AsyncClient,
    workspace_id: str,
) -> None:
    agent_headers = {"X-Actor-Type": "agent", "X-Actor-Id": "chief_engineer"}
    payload = {
        "recipient_agent_id": "modeling_agent",
        "session_strategy": "new",
        "session_title": "热结构模型 v2",
        "task_title": "建立模型",
        "message": "请建立热结构耦合模型",
    }
    dispatched = await client.post(f"/api/workspaces/{workspace_id}/dispatch", json=payload, headers=agent_headers)
    dispatched.raise_for_status()
    result = dispatched.json()
    target_session = result["session"]
    await wait_for_run(client, workspace_id, result["run"]["id"])

    messages = (await client.get(f"/api/sessions/{target_session['id']}/messages")).json()
    assert messages[0]["sender_type"] == "agent"
    assert messages[0]["sender_id"] == "chief_engineer"

    direct = await client.post(
        f"/api/sessions/{target_session['id']}/messages",
        json={"content": "温度上限是 180 摄氏度", "task_id": result["task"]["id"]},
    )
    direct.raise_for_status()
    await wait_for_run(client, workspace_id, direct.json()["id"])

    continue_payload = {
        **payload,
        "session_strategy": "continue",
        "session_id": target_session["id"],
        "task_title": "继续修订",
        "message": "整合用户补充参数",
    }
    continued = await client.post(
        f"/api/workspaces/{workspace_id}/dispatch",
        json=continue_payload,
        headers=agent_headers,
    )
    continued.raise_for_status()
    assert continued.json()["session"]["id"] == target_session["id"]

    fork_payload = {
        **payload,
        "session_strategy": "fork",
        "source_session_id": target_session["id"],
        "source_checkpoint_id": "message:2",
        "session_title": "替代材料方案",
        "task_title": "探索分支",
        "message": "探索替代材料",
    }
    forked = await client.post(f"/api/workspaces/{workspace_id}/dispatch", json=fork_payload, headers=agent_headers)
    forked.raise_for_status()
    assert forked.json()["session"]["source_session_id"] == target_session["id"]
    assert forked.json()["session"]["id"] != target_session["id"]


async def test_changeset_publication_conflict_permissions_and_restore(
    client: httpx.AsyncClient,
    workspace_id: str,
) -> None:
    overview = (await client.get(f"/api/workspaces/{workspace_id}/overview")).json()
    modeling = next(item for item in overview["sessions"] if item["agent_id"] == "modeling_agent")
    validation = next(item for item in overview["sessions"] if item["agent_id"] == "validation_agent")

    write = await client.put(
        f"/api/sessions/{modeling['id']}/files",
        json={"path": "candidate/model.json", "content": '{"material":"6061-T6"}'},
    )
    write.raise_for_status()
    publish_payload = {
        "base_revision": 0,
        "agent_id": "modeling_agent",
        "session_id": modeling["id"],
        "summary": "发布候选模型",
        "items": [
            {
                "source_path": "candidate/model.json",
                "target_path": "models/model.json",
                "kind": "model",
                "media_type": "application/json",
            }
        ],
    }
    published = await client.post(
        f"/api/workspaces/{workspace_id}/changesets",
        json=publish_payload,
        headers={"X-Actor-Type": "agent", "X-Actor-Id": "modeling_agent"},
    )
    published.raise_for_status()
    assert published.json()["revision"] == 1
    assert len(published.json()["artifacts"][0]["sha256"]) == 64

    stale = await client.post(f"/api/workspaces/{workspace_id}/changesets", json=publish_payload)
    assert stale.status_code == 409

    await client.put(
        f"/api/sessions/{validation['id']}/files",
        json={"path": "bad.json", "content": "{}"},
        headers={"X-Actor-Type": "agent", "X-Actor-Id": "validation_agent"},
    )
    forbidden_payload = {
        **publish_payload,
        "base_revision": 1,
        "agent_id": "validation_agent",
        "session_id": validation["id"],
        "items": [{**publish_payload["items"][0], "source_path": "bad.json"}],
    }
    forbidden = await client.post(
        f"/api/workspaces/{workspace_id}/changesets",
        json=forbidden_payload,
        headers={"X-Actor-Type": "agent", "X-Actor-Id": "validation_agent"},
    )
    assert forbidden.status_code == 403

    restored = await client.post(f"/api/workspaces/{workspace_id}/revisions/0/restore")
    restored.raise_for_status()
    assert restored.json()["number"] == 2


async def test_event_stream_replays_durable_events(client: httpx.AsyncClient, workspace_id: str) -> None:
    created = await client.post(
        f"/api/workspaces/{workspace_id}/agents/chief_engineer/sessions",
        json={"title": "事件测试"},
    )
    created.raise_for_status()
    stream = app.state.events.stream(workspace_id, 0)
    event = await anext(stream)
    await stream.aclose()
    assert "event:" in event
    assert f'"workspace_id": "{workspace_id}"' in event


async def test_workspace_membership_enforces_owner_editor_viewer_roles(
    client: httpx.AsyncClient,
    workspace_id: str,
) -> None:
    outsider = {"X-Actor-Type": "user", "X-Actor-Id": "reviewer"}
    assert (await client.get("/api/workspaces", headers=outsider)).json() == []
    denied = await client.get(f"/api/workspaces/{workspace_id}/overview", headers=outsider)
    assert denied.status_code == 403

    granted = await client.put(
        f"/api/workspaces/{workspace_id}/members",
        json={"actor_type": "user", "actor_id": "reviewer", "role": "viewer"},
    )
    granted.raise_for_status()
    assert granted.json()["role"] == "viewer"
    assert (await client.get(f"/api/workspaces/{workspace_id}/overview", headers=outsider)).status_code == 200

    overview = (await client.get(f"/api/workspaces/{workspace_id}/overview", headers=outsider)).json()
    target = next(item for item in overview["sessions"] if item["agent_id"] == "modeling_agent")
    write = await client.post(
        f"/api/sessions/{target['id']}/messages",
        json={"content": "viewer must not create a Run"},
        headers=outsider,
    )
    assert write.status_code == 403
