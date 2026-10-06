"""Custom OpenAI-compatible endpoint setup for the model selector."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, ClassVar
from urllib.parse import urlsplit

import httpx
from textual.binding import Binding, BindingType
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Input, OptionList, Static
from textual.widgets.option_list import Option

if TYPE_CHECKING:
    from textual.app import ComposeResult

from deepagents_code import auth_store
from deepagents_code.configuration.writer import update_user_config
from deepagents_code.model_config import clear_caches

CUSTOM_PROVIDER = "custom"


@dataclass(frozen=True, slots=True)
class CustomEndpoint:
    """Credentials and endpoint entered for an OpenAI-compatible API."""

    api_key: str
    base_url: str


def _normalize_base_url(value: str) -> str:
    """Validate and normalize an HTTP API base URL."""
    normalized = value.strip().rstrip("/")
    parsed = urlsplit(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        msg = "Base URL must be a complete http:// or https:// URL"
        raise ValueError(msg)
    return normalized


async def discover_models(endpoint: CustomEndpoint) -> list[str]:
    """Return model IDs exposed by an OpenAI-compatible `/models` endpoint."""
    url = f"{_normalize_base_url(endpoint.base_url)}/models"
    headers = {"Authorization": f"Bearer {endpoint.api_key}"}
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        payload = response.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return []
    models = {
        item["id"].strip()
        for item in data
        if isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and item["id"].strip()
    }
    return sorted(models, key=str.casefold)


def save_custom_provider(endpoint: CustomEndpoint, model_id: str) -> tuple[str, ...]:
    """Persist the custom provider definition and its credential locally."""
    normalized_url = _normalize_base_url(endpoint.base_url)
    cleaned_model = model_id.strip()
    if not cleaned_model:
        msg = "Model ID is required"
        raise ValueError(msg)

    def mutate(data: dict[str, Any]) -> bool:
        models = data.setdefault("models", {})
        if not isinstance(models, dict):
            msg = "[models] must be a table"
            raise ValueError(msg)
        providers = models.setdefault("providers", {})
        if not isinstance(providers, dict):
            msg = "[models.providers] must be a table"
            raise ValueError(msg)
        desired = {
            "display_name": "Custom (OpenAI-compatible)",
            "short_name": "Custom",
            "class_path": "langchain_openai:ChatOpenAI",
            "api_key_env": "CUSTOM_API_KEY",
            "base_url_env": "CUSTOM_BASE_URL",
            "models": [cleaned_model],
        }
        current = providers.get(CUSTOM_PROVIDER)
        if current == desired:
            return False
        providers[CUSTOM_PROVIDER] = desired
        return True

    result = update_user_config(mutate)
    if not result.ok:
        raise RuntimeError(result.error or "Could not save custom provider")
    outcome = auth_store.set_stored_key(
        CUSTOM_PROVIDER,
        endpoint.api_key,
        base_url=normalized_url,
    )
    clear_caches()
    return outcome.warnings


class CustomEndpointScreen(ModalScreen[CustomEndpoint | None]):
    """Collect an API key and base URL for a custom endpoint."""

    BINDINGS: ClassVar[list[BindingType]] = [
        Binding("escape", "cancel", "Cancel", show=False),
    ]

    DEFAULT_CSS = """
    CustomEndpointScreen { align: center middle; }
    CustomEndpointScreen > Vertical {
        width: 72; height: auto; max-height: 22;
        padding: 1 2; border: round $primary; background: $surface;
    }
    CustomEndpointScreen Input { margin-top: 1; }
    CustomEndpointScreen .custom-error { color: $error; height: auto; margin-top: 1; }
    CustomEndpointScreen .custom-help { color: $text-muted; height: auto; margin-top: 1; }
    """

    def compose(self) -> ComposeResult:
        """Compose the two-field endpoint form."""
        with Vertical():
            yield Static("Custom OpenAI-compatible API", classes="auth-prompt-title")
            yield Input(placeholder="API key", password=True, id="custom-api-key")
            yield Input(
                placeholder="Base URL, for example https://host.example/v1",
                id="custom-base-url",
            )
            yield Static("", classes="custom-error", id="custom-endpoint-error")
            yield Static("Enter continue | Esc cancel", classes="custom-help")

    def on_mount(self) -> None:
        """Focus the secret field first."""
        self.query_one("#custom-api-key", Input).focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        """Advance from the key field or submit the completed form."""
        if event.input.id == "custom-api-key":
            self.query_one("#custom-base-url", Input).focus()
            return
        key = self.query_one("#custom-api-key", Input).value.strip()
        base_url = self.query_one("#custom-base-url", Input).value.strip()
        try:
            if not key:
                msg = "API key is required"
                raise ValueError(msg)
            normalized = _normalize_base_url(base_url)
        except ValueError as exc:
            self.query_one("#custom-endpoint-error", Static).update(str(exc))
            return
        self.dismiss(CustomEndpoint(key, normalized))

    def action_cancel(self) -> None:
        """Close without saving."""
        self.dismiss(None)


class CustomModelScreen(ModalScreen[str | None]):
    """Choose a discovered model or enter an ID manually."""

    BINDINGS: ClassVar[list[BindingType]] = [
        Binding("escape", "cancel", "Cancel", show=False),
    ]

    DEFAULT_CSS = """
    CustomModelScreen { align: center middle; }
    CustomModelScreen > Vertical {
        width: 76; height: auto; max-height: 32;
        padding: 1 2; border: round $primary; background: $surface;
    }
    CustomModelScreen OptionList { height: auto; max-height: 16; margin-top: 1; }
    CustomModelScreen Input { margin-top: 1; }
    CustomModelScreen .custom-help { color: $text-muted; height: auto; margin-top: 1; }
    """

    def __init__(self, models: list[str], *, discovery_error: str | None = None) -> None:
        """Initialize the model chooser with discovered IDs."""
        super().__init__()
        self._models = models
        self._discovery_error = discovery_error

    def compose(self) -> ComposeResult:
        """Compose discovered choices and the manual fallback."""
        with Vertical():
            yield Static("Choose a model", classes="auth-prompt-title")
            if self._models:
                yield OptionList(
                    *(Option(model, id=f"custom-model-{index}") for index, model in enumerate(self._models)),
                    id="custom-model-list",
                )
            else:
                detail = self._discovery_error or "The endpoint returned no models."
                yield Static(detail, classes="custom-help")
            yield Input(placeholder="Or enter a model ID manually", id="custom-model-id")
            yield Static("Enter select | Esc cancel", classes="custom-help")

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        """Return the selected discovered model."""
        if event.option_index < len(self._models):
            self.dismiss(self._models[event.option_index])

    def on_input_submitted(self, event: Input.Submitted) -> None:
        """Return a manually entered model ID."""
        model_id = event.value.strip()
        if model_id:
            self.dismiss(model_id)

    def action_cancel(self) -> None:
        """Close without selecting a model."""
        self.dismiss(None)
