"""Agent runtime adapters for deterministic development and LangGraph Server."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from logos_workspace.models import AgentSession, Message, Run, Task, Workspace

EmitEvent = Callable[[str, dict[str, Any]], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class RuntimeRequest:
    """One queued Agent turn with its durable collaboration context."""

    workspace: Workspace
    agent_session: AgentSession
    run: Run
    task: Task | None
    inbound: Message
    messages: Sequence[Message]


class AgentRuntime(Protocol):
    """Runtime boundary used by the Inbox scheduler."""

    async def respond(self, request: RuntimeRequest, emit: EmitEvent) -> str:
        """Execute one Agent turn and return the final public reply."""


class DeterministicRuntime:
    """Local, key-free runtime that exercises the complete collaboration loop."""

    async def respond(self, request: RuntimeRequest, emit: EmitEvent) -> str:
        latest = request.inbound.content
        agent_id = request.agent_session.agent_id
        if agent_id == "modeling_agent":
            await emit("tool_started", {"tool": "inspect_runtime_capabilities"})
            await emit(
                "tool_completed",
                {"tool": "inspect_runtime_capabilities", "result": "workspace and artifact services available"},
            )
            return (
                f"已在独立建模 Session 中接收任务：{latest}\n\n"
                f"本次工作固定使用共享工作区 revision {request.agent_session.shared_revision}。"
                "我会先在 Session 工作区形成候选模型，再通过 ChangeSet 发布正式产物。"
            )
        if agent_id == "validation_agent":
            await emit("tool_started", {"tool": "inspect_frozen_evidence"})
            await emit(
                "tool_completed",
                {
                    "tool": "inspect_frozen_evidence",
                    "result": f"revision {request.agent_session.shared_revision} pinned",
                },
            )
            return (
                f"已接收独立验证任务：{latest}\n\n"
                f"验证输入已固定为共享工作区 revision {request.agent_session.shared_revision}。"
                "验证过程不会修改被验证的模型或结果。"
            )
        return (
            f"已记录你的要求：{latest}\n\n"
            "我是总师智能体。可以继续澄清项目目标，也可以通过“派发任务”选择专业智能体，"
            "并明确新建、继续或 Fork Session。"
        )


class LangGraphRuntime:
    """Execute the independently registered Agent Graphs through Agent Server."""

    def __init__(self, server_url: str) -> None:
        self.server_url = server_url

    async def respond(self, request: RuntimeRequest, emit: EmitEvent) -> str:
        from langgraph_sdk import get_client

        client = get_client(url=self.server_url)
        await client.threads.create(
            thread_id=request.agent_session.thread_id,
            if_exists="do_nothing",
            metadata={
                "workspace_id": request.workspace.id,
                "agent_id": request.agent_session.agent_id,
                "session_id": request.agent_session.id,
            },
        )
        latest = request.inbound
        input_messages = [{"role": "user", "content": latest.content, "id": latest.id}]
        copied = [message for message in request.messages if message.status == "copied"]
        previous_live = [
            message
            for message in request.messages
            if message.status != "copied"
            and message.id != request.inbound.id
            and message.sequence < request.inbound.sequence
        ]
        if request.agent_session.source_session_id and copied and not previous_live:
            inherited = [
                {
                    "role": "user" if message.sender_type == "user" else "assistant",
                    "content": message.content,
                    "id": message.id,
                }
                for message in copied
                if message.sequence < request.inbound.sequence
            ]
            input_messages = [*inherited, *input_messages]
        result = await client.runs.wait(
            request.agent_session.thread_id,
            request.agent_session.agent_id,
            input={"messages": input_messages},
            config={
                "configurable": {
                    "workspace_id": request.workspace.id,
                    "agent_id": request.agent_session.agent_id,
                    "session_id": request.agent_session.id,
                    "run_id": request.run.id,
                    "task_id": request.run.task_id,
                    "shared_revision": request.agent_session.shared_revision,
                }
            },
        )
        messages = result.get("messages", []) if isinstance(result, dict) else []
        for message in reversed(messages):
            if isinstance(message, dict) and message.get("type", message.get("role")) in {"ai", "assistant"}:
                content = message.get("content", "")
                if isinstance(content, str) and content.strip():
                    return content.strip()
        await emit("run_diagnostic", {"detail": "Agent Server returned no displayable assistant message"})
        raise RuntimeError("Agent Server returned no displayable assistant message")
