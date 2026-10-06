"""Async database lifecycle and session helpers."""

from collections.abc import AsyncIterator
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from logos_workspace.config import Settings


class Base(DeclarativeBase):
    """Base class for control-plane persistence models."""


class Database:
    """Own the SQLAlchemy engine and transactional session factory."""

    def __init__(self, settings: Settings) -> None:
        if settings.database_url.startswith("sqlite"):
            db_path = settings.database_url.rsplit("///", 1)[-1]
            if db_path and db_path != ":memory:":
                Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        engine_options = {"pool_pre_ping": True}
        if settings.database_url.startswith("sqlite"):
            engine_options["connect_args"] = {"timeout": 30}
        self.engine: AsyncEngine = create_async_engine(settings.database_url, **engine_options)
        if settings.database_url.startswith("sqlite"):
            self._configure_sqlite()
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    def _configure_sqlite(self) -> None:
        """Make the isolated local database tolerate concurrent Session workers."""

        @event.listens_for(self.engine.sync_engine, "connect")
        def set_sqlite_pragmas(dbapi_connection, _connection_record) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=30000")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    async def create_schema(self) -> None:
        """Create tables for a fresh local or test installation."""
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def close(self) -> None:
        """Release database connections."""
        await self.engine.dispose()

    async def session(self) -> AsyncIterator[AsyncSession]:
        """Yield one transaction-scoped session for FastAPI dependencies."""
        async with self.sessions() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
