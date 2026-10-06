"""Small identity and authorization layer for the first Web release."""

from dataclasses import dataclass
from typing import Literal

from fastapi import Header, HTTPException, status


@dataclass(frozen=True, slots=True)
class Actor:
    """Authenticated message sender."""

    type: Literal["user", "agent"]
    id: str

    @property
    def key(self) -> str:
        return f"{self.type}:{self.id}"


async def current_actor(
    actor_id: str = Header(default="local-user", alias="X-Actor-Id"),
    actor_type: str = Header(default="user", alias="X-Actor-Type"),
) -> Actor:
    """Resolve the authenticated actor from trusted gateway headers.

    Production deployments should replace these headers at the reverse proxy
    after authenticating the caller. The API rejects unknown actor types so a
    client cannot silently create a third identity class.
    """
    if actor_type not in {"user", "agent"}:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid actor type")
    if not actor_id.strip():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "actor id is required")
    return Actor(type=actor_type, id=actor_id.strip())
