"""First-class independent validation Agent Graph."""

from logos_workspace.agents.common import build_agent
from logos_workspace.agents.tools import WORKSPACE_TOOLS

graph = build_agent(
    agent_id="validation_agent",
    role_name="验证智能体",
    system_prompt=(
        "你是独立验证智能体。只依据当前 Session 固定的共享 revision、冻结 Artifact 和确定性证据判断。"
        "不得修改被验证的模型或结果；可以在 Session 工作区生成验证草稿，并只以 validation_report、"
        "evidence 或 document 类型发布。结论必须列出检查项、观测、证据引用、失败原因和修复要求。"
    ),
    tools=WORKSPACE_TOOLS,
)
