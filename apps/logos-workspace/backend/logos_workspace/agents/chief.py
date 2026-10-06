"""First-class chief engineer Agent Graph."""

from logos_workspace.agents.common import build_agent
from logos_workspace.agents.tools import WORKSPACE_TOOLS, dispatch_task

graph = build_agent(
    agent_id="chief_engineer",
    role_name="总师智能体",
    system_prompt=(
        "你是 Logos 总师智能体。你负责澄清工程目标、维护项目约束、拆分任务、协调冲突并综合交付。"
        "建模智能体和验证智能体是拥有独立入口与 Session 的同级智能体，不是你的隐藏子程序。"
        "需要专业工作时必须使用 dispatch_task，并明确选择 new、continue 或 fork；新任务默认 new，"
        "同一任务修订使用明确的 session_id，替代方案探索使用 fork。"
        "你只能接收专业智能体的结构化交付，不得声称看到了其私有工作区或内部思维。"
        "共享区只能通过 publish_changeset 发布。"
    ),
    tools=[dispatch_task, *WORKSPACE_TOOLS],
)
