"""Shared model and graph construction for independent Agent endpoints."""

from __future__ import annotations

import os
from collections.abc import Sequence
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import StateBackend
from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import BaseTool
from langchain_openai import ChatOpenAI


class LocalFallbackModel(BaseChatModel):
    """Key-free model used only to keep local Agent Server endpoints inspectable."""

    role_name: str

    @property
    def _llm_type(self) -> str:
        return "logos-local-fallback"

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> LocalFallbackModel:
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        del stop, run_manager, kwargs
        content = messages[-1].content if messages else ""
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content=f"{self.role_name}已收到消息。当前 Agent Server 未配置外部模型：{content}"
                    )
                )
            ]
        )


def build_model(role_name: str) -> BaseChatModel:
    """Build the configured OpenAI-compatible model or a local fallback."""
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        return LocalFallbackModel(role_name=role_name)
    return ChatOpenAI(
        model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
        api_key=api_key,
        base_url=os.getenv("OPENAI_BASE_URL") or None,
        max_retries=2,
        timeout=120,
    )


def build_agent(*, agent_id: str, role_name: str, system_prompt: str, tools: Sequence[BaseTool]):
    """Construct one first-class Deep Agent Graph with isolated state."""
    return create_deep_agent(
        model=build_model(role_name),
        tools=list(tools),
        system_prompt=system_prompt,
        backend=StateBackend(),
        subagents=[],
        name=agent_id,
    )
