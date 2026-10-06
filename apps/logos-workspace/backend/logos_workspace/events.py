"""Durable workspace event publishing and SSE serialization."""

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from logos_workspace.models import Event


class EventStore:
    """Persist observable events and expose a restart-safe polling stream."""

    def __init__(self, sessions: async_sessionmaker[AsyncSession], poll_seconds: float) -> None:
        self._sessions = sessions
        self._poll_seconds = poll_seconds
        self._changed = asyncio.Condition()

    async def publish(
        self,
        session: AsyncSession,
        *,
        workspace_id: str,
        event_type: str,
        agent_id: str | None = None,
        session_id: str | None = None,
        task_id: str | None = None,
        run_id: str | None = None,
        message_id: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> Event:
        """Append an event within the caller's transaction."""
        event = Event(
            workspace_id=workspace_id,
            type=event_type,
            agent_id=agent_id,
            session_id=session_id,
            task_id=task_id,
            run_id=run_id,
            message_id=message_id,
            payload=payload or {},
        )
        session.add(event)
        await session.flush()
        return event

    async def notify(self) -> None:
        """Wake connected streams after a transaction commits."""
        async with self._changed:
            self._changed.notify_all()

    async def stream(self, workspace_id: str, after: int = 0) -> AsyncIterator[str]:
        """Yield durable events as Server-Sent Events."""
        cursor = after
        while True:
            async with self._sessions() as session:
                rows = (
                    await session.scalars(
                        select(Event)
                        .where(Event.workspace_id == workspace_id, Event.id > cursor)
                        .order_by(Event.id)
                        .limit(200)
                    )
                ).all()
            if rows:
                for event in rows:
                    cursor = event.id
                    data = {
                        "id": event.id,
                        "workspace_id": event.workspace_id,
                        "type": event.type,
                        "agent_id": event.agent_id,
                        "session_id": event.session_id,
                        "task_id": event.task_id,
                        "run_id": event.run_id,
                        "message_id": event.message_id,
                        "payload": event.payload,
                        "created_at": event.created_at.isoformat(),
                    }
                    yield f"id: {event.id}\nevent: {event.type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
                continue
            try:
                async with self._changed:
                    await asyncio.wait_for(self._changed.wait(), timeout=self._poll_seconds)
            except TimeoutError:
                yield ": keep-alive\n\n"
