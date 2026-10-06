"""Independent evidence-validation agent."""

import json

from langchain.agents import create_agent
from langchain.agents.structured_output import ToolStrategy
from langchain_core.messages import ToolMessage
from langchain_core.runnables import RunnableConfig

from agent.config import build_chat_model
from agent.contracts import (
    DeterministicValidationEvidence,
    EngineeringStatus,
    NumericalValidationStatus,
    ValidationReport,
)
from agent.tools.validation import validate_frozen_artifacts


validation_agent = create_agent(
    model=build_chat_model(),
    tools=[validate_frozen_artifacts],
    system_prompt=(
        "你是独立验证智能体。你只能依据本次输入给出的目标、验收条件和冻结 manifest 取证。"
        "必须调用 validate_frozen_artifacts，并引用其检查结果。"
        "placeholder 结果不能被判为数值验证通过或工程验收通过；两者必须保持 not_evaluated。"
    ),
    response_format=ToolStrategy(ValidationReport),
    name="validation_agent",
)


def _extract_evidence(messages: list[object]) -> DeterministicValidationEvidence:
    for message in reversed(messages):
        if isinstance(message, ToolMessage) and message.name == "validate_frozen_artifacts":
            return DeterministicValidationEvidence.model_validate_json(str(message.content))
    raise RuntimeError("Validation agent did not call validate_frozen_artifacts")


def invoke_validation_agent(
    objective: str,
    acceptance_criteria: list[str],
    manifest_path: str,
    config: RunnableConfig | None = None,
) -> ValidationReport:
    """Validate frozen evidence without receiving modeling-agent messages."""
    payload = {
        "objective": objective,
        "acceptance_criteria": acceptance_criteria,
        "manifest_path": manifest_path,
    }
    result = validation_agent.invoke(
        {"messages": [{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]},
        config={**(config or {}), "recursion_limit": 30},
    )
    evidence = _extract_evidence(result["messages"])
    report = ValidationReport.model_validate(result["structured_response"])

    if evidence.all_passed:
        return report.model_copy(
            update={
                "verdict": "evidence_validated",
                "checks": evidence.checks,
                "issues": [],
                "repair_requirements": [],
                "numerical_validation_status": NumericalValidationStatus.NOT_EVALUATED,
                "engineering_status": EngineeringStatus.NOT_EVALUATED,
            }
        )

    failed = [check.check_id for check in evidence.checks if not check.passed]
    return report.model_copy(
        update={
            "verdict": "revision_required",
            "checks": evidence.checks,
            "issues": [f"Deterministic check failed: {name}" for name in failed],
            "repair_requirements": [
                "Regenerate the affected artifacts and freeze a new input version."
            ],
            "numerical_validation_status": NumericalValidationStatus.NOT_EVALUATED,
            "engineering_status": EngineeringStatus.NOT_EVALUATED,
        }
    )
