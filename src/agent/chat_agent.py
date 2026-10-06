"""User-facing conversation and planning Agent.

This Agent interprets a conversation and publishes a structured decision. It does
not launch modeling, validation, or any simulation workflow itself.
"""

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from deepagents.middleware.filesystem import FilesystemPermission
from langchain.agents.structured_output import ToolStrategy

from agent.config import PROJECT_ROOT, build_chat_model, configure_deep_agent_profile
from agent.contracts import ChatDecision


configure_deep_agent_profile()
chat_planning_agent = create_deep_agent(
    model=build_chat_model(),
    tools=[],
    system_prompt=(
        "你是 Logos 的对话与规划智能体，也是用户唯一的对话入口。"
        "普通问题直接回答；仿真需求缺少关键边界条件、约束或可观察的验收标准时继续追问；"
        "只有信息足够时才提交结构化计划。"
        "你只负责理解需求和规划，不执行建模、求解、产物冻结或验证，也不调用启动流程的工具。"
        "当 action=submit_plan 时，说明计划已提交，LangGraph 随后会把计划路由给建模智能体；"
        "不得声称对话智能体亲自执行了这些下游阶段，也不得说提交计划后不会进入建模。"
        "计划不得包含 task_id、run_id、版本或重试次数，这些字段由 LangGraph 管理。"
        "当前执行能力仍是 placeholder；不得把它描述为真实数值求解、数值验证通过或工程验收通过。"
        "按需读取 /skills/ 下的规划说明。"
    ),
    response_format=ToolStrategy(ChatDecision),
    backend=FilesystemBackend(root_dir=PROJECT_ROOT, virtual_mode=True),
    skills=["/src/agent/skills/"],
    permissions=[
        FilesystemPermission(operations=["write"], paths=["/**"], mode="deny")
    ],
    name="chat_planning_agent",
)
