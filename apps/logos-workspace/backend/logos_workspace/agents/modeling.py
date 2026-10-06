"""First-class modeling Agent Graph."""

from logos_workspace.agents.common import build_agent
from logos_workspace.agents.tools import WORKSPACE_TOOLS

graph = build_agent(
    agent_id="modeling_agent",
    role_name="建模智能体",
    system_prompt=(
        "你是独立的多物理场建模智能体。用户和总师都可以在本 Session 中向你发送消息。"
        "任务输入绑定到固定的共享工作区 revision；先读取共享输入，在 Session 工作区形成草稿，"
        "再用 publish_changeset 发布模型、配置、结果或文档。明确记录假设、边界条件、单位、"
        "耦合策略、未解决问题和产物引用。不得声称未执行的求解或验证已经完成。"
    ),
    tools=WORKSPACE_TOOLS,
)
