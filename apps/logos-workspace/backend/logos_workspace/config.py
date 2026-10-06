"""Environment-backed application settings."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration shared by the API, scheduler, and agent runtime."""

    model_config = SettingsConfigDict(env_prefix="LOGOS_", env_file="../.env", extra="ignore")

    app_name: str = "Logos Workspace"
    database_url: str = "sqlite+aiosqlite:///./.logos/logos.db"
    data_dir: Path = Path(".logos")
    runtime_mode: Literal["deterministic", "langgraph"] = "deterministic"
    langgraph_url: str = "http://127.0.0.1:2025"
    web_origin: str = "http://127.0.0.1:5173"
    event_poll_seconds: float = Field(default=0.5, gt=0)
    run_concurrency: int = Field(default=4, ge=1, le=32)

    @property
    def resolved_data_dir(self) -> Path:
        """Return the absolute application data directory."""
        return self.data_dir.resolve()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide settings object."""
    return Settings()
