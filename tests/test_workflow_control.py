"""Fast contract checks without external model calls."""

from agent.contracts import (
    ArtifactManifest,
    ArtifactRef,
    ChatDecision,
    EngineeringStatus,
    NumericalValidationStatus,
    TaskPlan,
    TaskPlanDraft,
    ValidationReport,
)
from agent.graph import adopt_chat_decision, graph, run_validation


def _plan(task_id: str = "task-1") -> TaskPlan:
    return TaskPlan(
        task_id=task_id,
        objective="Check a placeholder workflow",
        steps=["model", "validate"],
        acceptance_criteria=["evidence is immutable"],
    )


def test_chat_plan_submission_gets_graph_owned_identifiers() -> None:
    decision = ChatDecision(
        action="submit_plan",
        response="计划已提交。",
        plan=TaskPlanDraft(
            objective="Check a placeholder workflow",
            steps=["model", "validate"],
            constraints=["placeholder only"],
            acceptance_criteria=["frozen hashes match"],
        ),
    )
    result = adopt_chat_decision({"structured_response": decision})
    assert result["task_id"].startswith("task-")
    assert result["run_id"]
    assert result["task_plan"]["task_id"] == result["task_id"]
    assert result["next_step"] == "modeling"


def test_validation_node_receives_no_modeling_messages(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_validation(objective, acceptance_criteria, manifest_path, config):
        captured.update(
            objective=objective,
            acceptance_criteria=acceptance_criteria,
            manifest_path=manifest_path,
        )
        return ValidationReport(
            verdict="evidence_validated",
            checks=[],
            numerical_validation_status=NumericalValidationStatus.NOT_EVALUATED,
            engineering_status=EngineeringStatus.NOT_EVALUATED,
        )

    monkeypatch.setattr("agent.graph.invoke_validation_agent", fake_validation)
    manifest = ArtifactManifest(
        run_id="run-1",
        task_id="task-1",
        input_version=1,
        artifacts=[
            ArtifactRef(
                kind="placeholder_result",
                path="C:/runs/result.json",
                sha256="a" * 64,
                size_bytes=1,
            )
        ],
    )
    result = run_validation(
        {
            "task_plan": _plan().model_dump(mode="json"),
            "artifact_manifest": manifest.model_dump(mode="json"),
            "modeling_deliverable": {"private_marker": "MODELING_SECRET"},
            "attempts": 1,
            "input_version": 1,
        },
        {},
    )
    assert "MODELING_SECRET" not in str(captured)
    assert result["status"] == "prototype_complete"


def test_root_graph_has_no_browser_driven_interrupt_nodes() -> None:
    assert "modeling" in graph.nodes
    assert "validation" in graph.nodes
    assert "wait_child" not in graph.nodes
    assert "process_control" not in graph.nodes
