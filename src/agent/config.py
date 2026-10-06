"""Runtime configuration shared by the Logos agents."""

from dataclasses import dataclass
import os
from pathlib import Path

from dotenv import load_dotenv
from deepagents import (
    GeneralPurposeSubagentProfile,
    HarnessProfile,
    register_harness_profile,
)
from langchain_openai import ChatOpenAI


PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    """Environment-backed settings for local execution."""

    openai_api_key: str
    openai_base_url: str | None
    openai_model: str
    runs_dir: Path
    max_attempts: int
    agent_server_url: str


def get_settings() -> Settings:
    """Read settings without exposing secrets to graph state or logs."""
    runs_value = os.getenv("LOGOS_RUNS_DIR", ".runs")
    runs_dir = Path(runs_value)
    if not runs_dir.is_absolute():
        runs_dir = PROJECT_ROOT / runs_dir

    return Settings(
        openai_api_key=os.getenv("OPENAI_API_KEY", ""),
        openai_base_url=os.getenv("OPENAI_BASE_URL") or None,
        openai_model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
        runs_dir=runs_dir.resolve(),
        max_attempts=max(1, int(os.getenv("LOGOS_MAX_ATTEMPTS", "3"))),
        agent_server_url=os.getenv(
            "LOGOS_AGENT_SERVER_URL", "http://127.0.0.1:2025"
        ).rstrip("/"),
    )


def build_chat_model() -> ChatOpenAI:
    """Create the shared model configuration used by each independent agent."""
    settings = get_settings()
    return ChatOpenAI(
        model=settings.openai_model,
        api_key=settings.openai_api_key or "not-configured",
        base_url=settings.openai_base_url,
        max_retries=2,
        timeout=120,
    )


def configure_deep_agent_profile() -> None:
    """Disable the implicit general-purpose subagent for the configured model."""
    settings = get_settings()
    register_harness_profile(
        f"openai:{settings.openai_model}",
        HarnessProfile(
            general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False)
        ),
    )
