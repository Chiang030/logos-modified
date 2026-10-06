"""Atomic message sequence allocation for multi-sender Sessions."""

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from logos_workspace.models import AgentSession


async def allocate_message_sequence(session: AsyncSession, session_id: str) -> int:
    """Reserve and return one monotonically increasing Session sequence."""
    result = await session.execute(
        update(AgentSession)
        .where(AgentSession.id == session_id)
        .values(next_sequence=AgentSession.next_sequence + 1)
        .returning(AgentSession.next_sequence)
    )
    next_sequence = result.scalar_one()
    return next_sequence - 1
