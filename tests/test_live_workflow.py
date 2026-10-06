"""Live integration checks for the official three-Agent composition."""

from hashlib import sha256
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

import pytest
from langgraph_sdk import get_sync_client

from agent.agents.validation_agent import invoke_validation_agent
from agent.config import get_settings
from agent.contracts import ArtifactManifest, TaskPlan
from agent.graph import graph


def _live_client():
    url = get_settings().agent_server_url
    try:
        with urlopen(f"{url}/info", timeout=2) as response:
            assert response.status == 200
    except (URLError, TimeoutError, OSError) as exc:
        pytest.skip(f"Agent Server is not running at {url}: {exc}")
    return get_sync_client(url=url)


@pytest.mark.live
def test_live_three_agent_flow_and_tamper_detection() -> None:
    client = _live_client()
    thread_id = client.threads.create(metadata={"test": "live-workflow"})["thread_id"]
    run = client.runs.create(
        thread_id,
        "chat_agent",
        input={
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Submit a placeholder plan for a 1.0 m x 0.2 m x 0.01 m "
                        "three-dimensional steel plate. Use E=210 GPa, nu=0.30, "
                        "alpha=12e-6/K, k=45 W/(m K), initial temperature 20 C, "
                        "uniform delta T +50 C, one-way thermal-to-structural "
                        "coupling, and fully constrain translations on the left "
                        "end face. Acceptance requires complete frozen artifacts "
                        "and exact SHA-256 manifest matches. Do not ask questions."
                    ),
                }
            ]
        },
    )
    client.runs.join(thread_id, run["run_id"])
    result = client.threads.get_state(thread_id).get("values") or {}

    assert result["status"] == "prototype_complete"
    assert result["execution_status"] == "placeholder_complete"
    assert result["numerical_validation_status"] == "not_evaluated"
    assert result["engineering_status"] == "not_evaluated"

    plan = TaskPlan.model_validate(result["task_plan"])
    manifest = ArtifactManifest.model_validate(result["artifact_manifest"])
    root_history = "\n".join(
        str(message.get("content", ""))
        for message in result.get("messages", [])
        if isinstance(message, dict)
    )
    assert "inspect_runtime_capabilities" not in root_history

    manifest_path = (Path(manifest.artifacts[0].path).parent / "manifest.json").resolve()
    artifact = next(
        item for item in manifest.artifacts if item.kind == "modeling_deliverable"
    )
    artifact_path = Path(artifact.path)
    original = artifact_path.read_bytes()
    assert sha256(original).hexdigest() == artifact.sha256

    try:
        artifact_path.write_bytes(original + b"\n")
        tampered = invoke_validation_agent(
            plan.objective,
            plan.acceptance_criteria,
            str(manifest_path),
        )
        assert tampered.verdict == "revision_required"
        assert any("artifact_hash:modeling_deliverable" in issue for issue in tampered.issues)
    finally:
        artifact_path.write_bytes(original)


def test_empty_request_stops_before_agent_calls() -> None:
    result = graph.invoke({"messages": []})
    assert result["status"] == "needs_input"
    assert result["execution_status"] == "not_run"
    assert "run_id" not in result


def test_root_graph_exposes_official_agent_nodes() -> None:
    schema = graph.get_input_jsonschema()
    assert "messages" in schema["properties"]
    assert {"chat", "modeling", "validation"} <= set(graph.nodes)
    assert "simulation" not in graph.nodes
