"""Structured contracts shared by the three Agents and the LangGraph."""

from enum import StrEnum
from typing import Annotated, Any, Literal

from langchain_core.messages import AnyMessage
from langgraph.graph import add_messages
from pydantic import BaseModel, Field, model_validator
from typing_extensions import TypedDict


class ExecutionStatus(StrEnum):
    NOT_RUN = "not_run"
    PLACEHOLDER_COMPLETE = "placeholder_complete"
    COMPLETED = "completed"
    FAILED = "failed"


class NumericalValidationStatus(StrEnum):
    NOT_EVALUATED = "not_evaluated"
    PASSED = "passed"
    FAILED = "failed"


class EngineeringStatus(StrEnum):
    NOT_EVALUATED = "not_evaluated"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class TaskPlan(BaseModel):
    """An adopted plan with identifiers owned by LangGraph."""

    task_id: str
    objective: str
    steps: list[str] = Field(min_length=1)
    constraints: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(min_length=1)


class TaskPlanDraft(BaseModel):
    """Plan content proposed by the conversation Agent."""

    objective: str
    steps: list[str] = Field(min_length=1)
    constraints: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(min_length=1)


class ChatDecision(BaseModel):
    """One user-facing turn plus an optional transition into modeling."""

    action: Literal["answer", "clarify", "submit_plan"]
    response: str = Field(min_length=1)
    plan: TaskPlanDraft | None = None

    @model_validator(mode="after")
    def validate_plan(self) -> "ChatDecision":
        if self.action == "submit_plan" and self.plan is None:
            raise ValueError("submit_plan requires plan")
        if self.action != "submit_plan" and self.plan is not None:
            raise ValueError("plan is only allowed for submit_plan")
        return self


class ModelingDeliverable(BaseModel):
    """A versioned modeling proposal produced before deterministic execution."""

    task_id: str
    input_version: int = Field(ge=1)
    physics: list[str] = Field(min_length=1)
    assumptions: list[str] = Field(default_factory=list)
    boundary_conditions: list[str] = Field(default_factory=list)
    coupling_strategy: str
    solver_configuration: dict[str, str] = Field(default_factory=dict)
    execution_mode: Literal["placeholder"] = "placeholder"
    solver_status: Literal["placeholder_complete"] = "placeholder_complete"
    unresolved_issues: list[str] = Field(default_factory=list)


class PlaceholderExecutionResult(BaseModel):
    run_id: str
    task_id: str
    input_version: int = Field(ge=1)
    execution_mode: Literal["placeholder"] = "placeholder"
    status: Literal["placeholder_complete"] = "placeholder_complete"
    metrics: dict[str, float] = Field(default_factory=dict)
    log: list[str] = Field(default_factory=list)


class ArtifactRef(BaseModel):
    kind: str
    path: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes: int = Field(ge=0)


class ArtifactManifest(BaseModel):
    run_id: str
    task_id: str
    input_version: int = Field(ge=1)
    execution_mode: Literal["placeholder"] = "placeholder"
    artifacts: list[ArtifactRef] = Field(min_length=1)


class ValidationCheck(BaseModel):
    check_id: str
    expected: str
    observed: str
    passed: bool
    evidence_ref: str


class DeterministicValidationEvidence(BaseModel):
    all_passed: bool
    checks: list[ValidationCheck]


class ValidationReport(BaseModel):
    verdict: Literal["evidence_validated", "revision_required", "needs_evidence"]
    checks: list[ValidationCheck]
    issues: list[str] = Field(default_factory=list)
    repair_requirements: list[str] = Field(default_factory=list)
    numerical_validation_status: NumericalValidationStatus
    engineering_status: EngineeringStatus


class SimulationState(TypedDict, total=False):
    """Serializable state for the root conversation and execution graph."""

    messages: Annotated[list[AnyMessage], add_messages]
    structured_response: Any
    chat_decision: dict[str, Any]
    run_id: str
    task_id: str
    task_plan: dict[str, Any]
    modeling_deliverable: dict[str, Any]
    artifact_manifest: dict[str, Any]
    validation_report: dict[str, Any]
    status: str
    attempts: int
    execution_status: str
    numerical_validation_status: str
    engineering_status: str
    error: str
    input_version: int
    next_step: str
