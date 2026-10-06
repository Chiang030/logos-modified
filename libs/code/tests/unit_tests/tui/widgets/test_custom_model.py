"""Tests for custom OpenAI-compatible model setup."""

import json
import tomllib
from pathlib import Path

import httpx
import pytest

from deepagents_code.tui.widgets.custom_model import (
    CustomEndpoint,
    discover_models,
    save_custom_provider,
)


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (
            {"data": [{"id": "model-b"}, {"id": "model-a"}, {"id": "model-a"}]},
            ["model-a", "model-b"],
        ),
        ({"data": "invalid"}, []),
    ],
)
async def test_discover_models_parses_openai_response(
    monkeypatch: pytest.MonkeyPatch,
    payload: object,
    expected: list[str],
) -> None:
    """Discovery returns sorted, unique IDs from an OpenAI models response."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://gateway.example/v1/models"
        assert request.headers["Authorization"] == "Bearer secret"
        return httpx.Response(200, content=json.dumps(payload))

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client(**kwargs: object) -> httpx.AsyncClient:
        return original_client(transport=transport, **kwargs)

    monkeypatch.setattr(
        "deepagents_code.tui.widgets.custom_model.httpx.AsyncClient", client
    )

    result = await discover_models(CustomEndpoint("secret", "https://gateway.example/v1/"))

    assert result == expected


def test_save_custom_provider_keeps_secret_out_of_config(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Saving writes provider metadata to TOML and the key to the auth store."""
    config_path = tmp_path / "config.toml"
    state_dir = tmp_path / ".state"
    monkeypatch.setattr("deepagents_code.model_config.DEFAULT_CONFIG_PATH", config_path)
    monkeypatch.setattr("deepagents_code.auth_store.DEFAULT_STATE_DIR", state_dir)

    warnings = save_custom_provider(
        CustomEndpoint("secret", "https://gateway.example/v1"),
        "deepseek-chat",
    )

    config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    provider = config["models"]["providers"]["custom"]
    assert provider["class_path"] == "langchain_openai:ChatOpenAI"
    assert provider["api_key_env"] == "CUSTOM_API_KEY"
    assert provider["base_url_env"] == "CUSTOM_BASE_URL"
    assert provider["models"] == ["deepseek-chat"]
    assert "secret" not in config_path.read_text(encoding="utf-8")
    assert warnings == ()
