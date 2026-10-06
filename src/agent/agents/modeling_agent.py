"""Modeling agent with explicit runtime-capability inspection."""

import json

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from langchain.agents.structured_output import ToolStrategy
from langchain_core.runnables import RunnableConfig

from agent.config import PROJECT_ROOT, build_chat_model, configure_deep_agent_profile
from agent.contracts import ModelingDeliverable, TaskPlan
from agent.tools.runtime import inspect_runtime_capabilities


configure_deep_agent_profile()
modeling_agent = create_deep_agent(
    model=build_chat_model(),
    tools=[inspect_runtime_capabilities],
    system_prompt=(
        "你是多物理场建模智能体。首先必须调用 inspect_runtime_capabilities。"
        "当前首版只能生成 placeholder 建模交付，不得声称运行了真实求解器、完成数值验证或工程验收。"
        "必须原样保留 task_id 和 input_version，并以结构化格式交付。"
    ),
    response_format=ToolStrategy(ModelingDeliverable),
    backend=FilesystemBackend(root_dir=PROJECT_ROOT, virtual_mode=True),
    skills=["/src/agent/skills/"],
    name="modeling_agent",
)


def invoke_modeling_agent(
    plan: TaskPlan,
    input_version: int,
    repair_requirements: list[str],
    config: RunnableConfig | None = None,
) -> ModelingDeliverable:
    """Produce a versioned modeling deliverable."""
    payload = {
        "task_plan": plan.model_dump(mode="json"),
        "input_version": input_version,
        "repair_requirements": repair_requirements,
    }
    result = modeling_agent.invoke(
        {"messages": [{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]},
        config={**(config or {}), "recursion_limit": 30},
    )
    deliverable = ModelingDeliverable.model_validate(result["structured_response"])
    return deliverable.model_copy(
        update={
            "task_id": plan.task_id,
            "input_version": input_version,
            "execution_mode": "placeholder",
            "solver_status": "placeholder_complete",
        }
    )
