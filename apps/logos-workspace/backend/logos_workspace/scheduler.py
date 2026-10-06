"""Per-Session Inbox scheduler with restart recovery and cancellation."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from logos_workspace.events import EventStore
from logos_workspace.models import Agent, AgentSession, Message, Run, Task, Workspace
from logos_workspace.runtime import AgentRuntime, RuntimeRequest
from logos_workspace.sequences import allocate_message_sequence


class RunScheduler:
    """Drain each Session sequentially while allowing cross-Session concurrency."""

    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        events: EventStore,
        runtime: AgentRuntime,
        concurrency: int,
    ) -> None:
        self._sessions = sessions
        self._events = events
        self._runtime = runtime
        self._semaphore = asyncio.Semaphore(concurrency)
        self._agent_semaphores: dict[str, asyncio.Semaphore] = {}
        self._workers: dict[str, asyncio.Task[None]] = {}
        self._current_runs: dict[str, str] = {}
        self._closed = False

    def enqueue(self, session_id: str) -> None:
        """Ensure a worker is draining the requested Session."""
        if self._closed:
            return
        worker = self._workers.get(session_id)
        if worker is None or worker.done():
            self._workers[session_id] = asyncio.create_task(self._drain(session_id), name=f"logos-session-{session_id}")

    async def cancel(self, run_id: str) -> None:
        """Cancel an in-process Run; durable status is finalized by the worker."""
        for session_id, active_run_id in tuple(self._current_runs.items()):
            if active_run_id == run_id:
                worker = self._workers.get(session_id)
                if worker and not worker.done():
                    worker.cancel()
                return

    async def close(self) -> None:
        """Stop local workers without losing queued durable Runs."""
        self._closed = True
        workers = list(self._workers.values())
        for worker in workers:
            worker.cancel()
        if workers:
            await asyncio.gather(*workers, return_exceptions=True)

    async def _next_run(self, session: AsyncSession, session_id: str) -> Run | None:
        return await session.scalar(
            select(Run).where(Run.session_id == session_id, Run.status == "queued").order_by(Run.created_at).limit(1)
        )

    async def _agent_semaphore(self, agent_id: str) -> asyncio.Semaphore:
        semaphore = self._agent_semaphores.get(agent_id)
        if semaphore is not None:
            return semaphore
        async with self._sessions() as session:
            agent = await session.get(Agent, agent_id)
            limit = agent.max_concurrency if agent else 1
        return self._agent_semaphores.setdefault(agent_id, asyncio.Semaphore(limit))

    async def _drain(self, session_id: str) -> None:
        while not self._closed:
            async with self._sessions() as session:
                run = await self._next_run(session, session_id)
                if run is None:
                    return
                if run.cancel_requested:
                    run.status = run.stop_mode or "cancelled"
                    run.completed_at = datetime.now(UTC)
                    await session.commit()
                    continue
                run.status = "running"
                run.started_at = datetime.now(UTC)
                inbound = await session.get(Message, run.message_id)
                if inbound:
                    inbound.status = "processing"
                await self._events.publish(
                    session,
                    workspace_id=run.workspace_id,
                    event_type="run_started",
                    agent_id=run.agent_id,
                    session_id=run.session_id,
                    task_id=run.task_id,
                    run_id=run.id,
                    message_id=run.message_id,
                )
                await session.commit()
            await self._events.notify()

            self._current_runs[session_id] = run.id
            try:
                async with self._semaphore:
                    async with await self._agent_semaphore(run.agent_id):
                        await self._execute(run.id)
            except asyncio.CancelledError:
                await self._finish_stopped(run.id)
                if not self._closed:
                    self._workers.pop(session_id, None)
                    self.enqueue(session_id)
                return
            finally:
                self._current_runs.pop(session_id, None)

    async def _emit_runtime_event(self, run_id: str, event_type: str, payload: dict[str, Any]) -> None:
        async with self._sessions() as session:
            run = await session.get(Run, run_id)
            if run is None:
                return
            await self._events.publish(
                session,
                workspace_id=run.workspace_id,
                event_type=event_type,
                agent_id=run.agent_id,
                session_id=run.session_id,
                task_id=run.task_id,
                run_id=run.id,
                message_id=run.message_id,
                payload=payload,
            )
            await session.commit()
        await self._events.notify()

    async def _execute(self, run_id: str) -> None:
        async with self._sessions() as session:
            run = await session.get(Run, run_id)
            if run is None:
                return
            agent_session = await session.get(AgentSession, run.session_id)
            workspace = await session.get(Workspace, run.workspace_id)
            task = await session.get(Task, run.task_id) if run.task_id else None
            inbound = await session.get(Message, run.message_id)
            messages = list(
                (
                    await session.scalars(
                        select(Message).where(Message.session_id == run.session_id).order_by(Message.sequence)
                    )
                ).all()
            )
            if agent_session is None or workspace is None or inbound is None:
                raise RuntimeError("Run references missing workspace, Session, or inbound message")

        try:
            response = await self._runtime.respond(
                RuntimeRequest(
                    workspace=workspace,
                    agent_session=agent_session,
                    run=run,
                    task=task,
                    inbound=inbound,
                    messages=messages,
                ),
                lambda event_type, payload: self._emit_runtime_event(run_id, event_type, payload),
            )
            await self._finish_success(run_id, response)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._finish_failure(run_id, f"{type(exc).__name__}: {exc}")

    async def _finish_success(self, run_id: str, response: str) -> None:
        async with self._sessions() as session:
            run = await session.get(Run, run_id)
            if run is None:
                return
            if run.cancel_requested:
                run.status = run.stop_mode or "cancelled"
                run.completed_at = datetime.now(UTC)
                await session.commit()
                return
            sequence = await allocate_message_sequence(session, run.session_id)
            reply = Message(
                workspace_id=run.workspace_id,
                agent_id=run.agent_id,
                session_id=run.session_id,
                task_id=run.task_id,
                sender_type="agent",
                sender_id=run.agent_id,
                recipient_agent_id=run.agent_id,
                in_reply_to=run.message_id,
                sequence=sequence,
                content=response,
                status="completed",
            )
            session.add(reply)
            inbound = await session.get(Message, run.message_id)
            if inbound:
                inbound.status = "completed"
            run.status = "completed"
            run.completed_at = datetime.now(UTC)
            if run.task_id:
                task = await session.get(Task, run.task_id)
                if task:
                    task.status = "completed"
                    task.deliverable_summary = response[:1000]
            await session.flush()
            await self._events.publish(
                session,
                workspace_id=run.workspace_id,
                event_type="agent_message",
                agent_id=run.agent_id,
                session_id=run.session_id,
                task_id=run.task_id,
                run_id=run.id,
                message_id=reply.id,
                payload={"sequence": sequence},
            )
            await self._events.publish(
                session,
                workspace_id=run.workspace_id,
                event_type="run_completed",
                agent_id=run.agent_id,
                session_id=run.session_id,
                task_id=run.task_id,
                run_id=run.id,
                message_id=reply.id,
            )
            await session.commit()
        await self._events.notify()

    async def _finish_failure(self, run_id: str, error: str) -> None:
        async with self._sessions() as session:
            run = await session.get(Run, run_id)
            if run is None:
                return
            run.status = "failed"
            run.error = error[:4000]
            run.completed_at = datetime.now(UTC)
            if run.task_id:
                task = await session.get(Task, run.task_id)
                if task:
                    task.status = "failed"
            await self._events.publish(
                session,
                workspace_id=run.workspace_id,
                event_type="run_failed",
                agent_id=run.agent_id,
                session_id=run.session_id,
                task_id=run.task_id,
                run_id=run.id,
                payload={"error": run.error},
            )
            await session.commit()
        await self._events.notify()

    async def _finish_stopped(self, run_id: str) -> None:
        async with self._sessions() as session:
            run = await session.get(Run, run_id)
            if run is None:
                return
            run.status = run.stop_mode or "cancelled"
            run.cancel_requested = True
            run.completed_at = datetime.now(UTC)
            await self._events.publish(
                session,
                workspace_id=run.workspace_id,
                event_type="run_interrupted" if run.status == "interrupted" else "run_cancelled",
                agent_id=run.agent_id,
                session_id=run.session_id,
                task_id=run.task_id,
                run_id=run.id,
            )
            await session.commit()
        await self._events.notify()
