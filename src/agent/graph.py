"""Root LangGraph for conversation, modeling, freezing, and validation."""

from pathlib import Path
from typing import Literal
from uuid import uuid4

from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from agent.agents.modeling_agent import invoke_modeling_agent
from agent.agents.validation_agent import invoke_validation_agent
from agent.artifacts import freeze_placeholder_run
from agent.chat_agent import chat_planning_agent
from agent.config import get_settings
from agent.contracts import (
    ArtifactManifest,
    ChatDecision,
    EngineeringStatus,
    ExecutionStatus,
    ModelingDeliverable,
    NumericalValidationStatus,
    SimulationState,
    TaskPlan,
    ValidationReport,
)


def _safe_error(exc: Exception) -> str:
    message = f"{type(exc).__name__}: {exc}"
    api_key = get_settings().openai_api_key
    if api_key:
        message = message.replace(api_key, "[REDACTED]")
    return message[:800]


def needs_input(_: SimulationState) -> SimulationState:
    """Reject an empty invocation without calling a model."""
    return {
        "status": "needs_input",
        "attempts": 0,
        "execution_status": ExecutionStatus.NOT_RUN.value,
        "numerical_validation_status": NumericalValidationStatus.NOT_EVALUATED.value,
        "engineering_status": EngineeringStatus.NOT_EVALUATED.value,
        "error": "messages are required",
    }


def prepare_chat(_: SimulationState) -> SimulationState:
    return {"structured_response": None, "chat_decision": {}, "error": ""}


def adopt_chat_decision(state: SimulationState) -> SimulationState:
    """Publish the chat reply and initialize execution for a submitted plan."""
    try:
        decision = ChatDecision.model_validate(state.get("structured_response"))
    except Exception as exc:
        return {
            "messages": [
                AIMessage(
                    content="无法解析本轮规划结果，请重新描述需求。",
                    name="chat_planning_agent",
                )
            ],
            "status": "chat_error",
            "error": _safe_error(exc),
            "next_step": "end",
        }

    base: SimulationState = {
        "messages": [
            AIMessage(content=decision.response, name="chat_planning_agent")
        ],
        "chat_decision": decision.model_dump(mode="json"),
        "structured_response": None,
        "error": "",
    }
    if decision.action != "submit_plan":
        return {
            **base,
            "status": "needs_clarification" if decision.action == "clarify" else "ready",
            "next_step": "end",
        }

    if decision.plan is None:
        raise RuntimeError("submit_plan did not include a plan")

    run_id = uuid4().hex
    task_id = f"task-{run_id[:12]}"
    plan = TaskPlan(task_id=task_id, **decision.plan.model_dump())
    return {
        **base,
        "run_id": run_id,
        "task_id": task_id,
        "task_plan": plan.model_dump(mode="json"),
        "modeling_deliverable": {},
        "artifact_manifest": {},
        "validation_report": {},
        "status": "planned",
        "attempts": 0,
        "input_version": 1,
        "execution_status": ExecutionStatus.NOT_RUN.value,
        "numerical_validation_status": NumericalValidationStatus.NOT_EVALUATED.value,
        "engineering_status": EngineeringStatus.NOT_EVALUATED.value,
        "next_step": "modeling",
    }


def run_modeling(
    state: SimulationState, config: RunnableConfig
) -> SimulationState:
    """Run the modeling Deep Agent with only the adopted plan and repair request."""
    try:
        plan = TaskPlan.model_validate(state["task_plan"])
        repairs: list[str] = []
        if state.get("validation_report"):
            repairs = ValidationReport.model_validate(
                state["validation_report"]
            ).repair_requirements
        deliverable = invoke_modeling_agent(
            plan,
            int(state["input_version"]),
            repairs,
            config,
        )
        return {
            "modeling_deliverable": deliverable.model_dump(mode="json"),
            "attempts": int(state.get("attempts", 0)) + 1,
            "status": "modeled",
            "next_step": "freeze",
            "error": "",
        }
    except Exception as exc:
        return {
            "status": "failed",
            "execution_status": ExecutionStatus.FAILED.value,
            "error": _safe_error(exc),
            "next_step": "end",
        }


def freeze_artifacts(state: SimulationState) -> SimulationState:
    """Run the deterministic placeholder executor and freeze immutable evidence."""
    try:
        manifest = freeze_placeholder_run(
            state["run_id"],
            ModelingDeliverable.model_validate(state["modeling_deliverable"]),
        )
        return {
            "artifact_manifest": manifest.model_dump(mode="json"),
            "status": "artifacts_frozen",
            "execution_status": ExecutionStatus.PLACEHOLDER_COMPLETE.value,
            "next_step": "validation",
            "error": "",
        }
    except Exception as exc:
        return {
            "status": "failed",
            "execution_status": ExecutionStatus.FAILED.value,
            "error": _safe_error(exc),
            "next_step": "end",
        }


def run_validation(
    state: SimulationState, config: RunnableConfig
) -> SimulationState:
    """Run validation from the plan and frozen manifest, without modeling messages."""
    try:
        plan = TaskPlan.model_validate(state["task_plan"])
        manifest = ArtifactManifest.model_validate(state["artifact_manifest"])
        manifest_path = (
            get_settings().runs_dir
            / manifest.run_id
            / f"input-v{manifest.input_version}"
            / "manifest.json"
        )
        report = invoke_validation_agent(
            plan.objective,
            plan.acceptance_criteria,
            str(Path(manifest_path)),
            config,
        )
        updates: SimulationState = {
            "validation_report": report.model_dump(mode="json"),
            "numerical_validation_status": report.numerical_validation_status.value,
            "engineering_status": report.engineering_status.value,
            "error": "",
        }
        if report.verdict == "evidence_validated":
            return {
                **updates,
                "status": "prototype_complete",
                "next_step": "end",
            }
        if int(state.get("attempts", 0)) >= get_settings().max_attempts:
            return {
                **updates,
                "status": "max_attempts_exhausted",
                "next_step": "end",
            }
        return {
            **updates,
            "status": "revision_required",
            "input_version": int(state["input_version"]) + 1,
            "next_step": "modeling",
        }
    except Exception as exc:
        return {
            "status": "failed",
            "execution_status": ExecutionStatus.FAILED.value,
            "error": _safe_error(exc),
            "next_step": "end",
        }


def present_result(state: SimulationState) -> SimulationState:
    lines = [
        "本轮任务已结束。",
        "",
        f"- 流程状态：`{state.get('status', 'unknown')}`",
        f"- 执行状态：`{state.get('execution_status', 'unknown')}`",
        f"- 数值验证：`{state.get('numerical_validation_status', 'unknown')}`",
        f"- 工程验收：`{state.get('engineering_status', 'unknown')}`",
        f"- 建模次数：`{state.get('attempts', 0)}`",
    ]
    if run_id := state.get("run_id"):
        lines.append(f"- Run ID：`{run_id}`")
    if error := state.get("error"):
        lines.extend(["", f"错误：{error}"])
    lines.extend(
        [
            "",
            "当前执行仍是 `placeholder`；它不代表真实数值求解、数值验证通过或工程验收通过。",
        ]
    )
    return {
        "messages": [AIMessage(content="\n".join(lines), name="workflow_result")]
    }


def route_entry(state: SimulationState) -> Literal["needs_input", "prepare_chat"]:
    return "prepare_chat" if state.get("messages") else "needs_input"


def route_after_chat(state: SimulationState) -> Literal["modeling", "end"]:
    return "modeling" if state.get("next_step") == "modeling" else "end"


def route_after_modeling(state: SimulationState) -> Literal["freeze", "present"]:
    return "freeze" if state.get("next_step") == "freeze" else "present"


def route_after_freeze(state: SimulationState) -> Literal["validation", "present"]:
    return "validation" if state.get("next_step") == "validation" else "present"


def route_after_validation(state: SimulationState) -> Literal["modeling", "present"]:
    return "modeling" if state.get("next_step") == "modeling" else "present"


builder = StateGraph(SimulationState)
builder.add_node("needs_input", needs_input)
builder.add_node("prepare_chat", prepare_chat)
builder.add_node("chat", chat_planning_agent)
builder.add_node("adopt_chat_decision", adopt_chat_decision)
builder.add_node("modeling", run_modeling)
builder.add_node("freeze_artifacts", freeze_artifacts)
builder.add_node("validation", run_validation)
builder.add_node("present_result", present_result)

builder.add_conditional_edges(
    START,
    route_entry,
    {"needs_input": "needs_input", "prepare_chat": "prepare_chat"},
)
builder.add_edge("needs_input", END)
builder.add_edge("prepare_chat", "chat")
builder.add_edge("chat", "adopt_chat_decision")
builder.add_conditional_edges(
    "adopt_chat_decision",
    route_after_chat,
    {"modeling": "modeling", "end": END},
)
builder.add_conditional_edges(
    "modeling",
    route_after_modeling,
    {"freeze": "freeze_artifacts", "present": "present_result"},
)
builder.add_conditional_edges(
    "freeze_artifacts",
    route_after_freeze,
    {"validation": "validation", "present": "present_result"},
)
builder.add_conditional_edges(
    "validation",
    route_after_validation,
    {"modeling": "modeling", "present": "present_result"},
)
builder.add_edge("present_result", END)

graph = builder.compile()
