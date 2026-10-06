"""Versioned project, agent, session, and run filesystem storage."""

from __future__ import annotations

import asyncio
import hashlib
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath


@dataclass(frozen=True, slots=True)
class StoredFile:
    """Metadata for a file inside one logical workspace scope."""

    path: str
    scope: str
    size_bytes: int
    modified_at: datetime
    content: str | None = None


@dataclass(frozen=True, slots=True)
class PublishedFile:
    """Immutable artifact produced by a workspace publication."""

    name: str
    path: Path
    sha256: str
    size_bytes: int
    kind: str
    media_type: str


class WorkspaceStorage:
    """Route logical workspace scopes onto secured local directories."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, asyncio.Lock] = {}

    def lock(self, workspace_id: str) -> asyncio.Lock:
        """Return the publication lock for one workspace."""
        return self._locks.setdefault(workspace_id, asyncio.Lock())

    @staticmethod
    def normalize(path: str) -> Path:
        """Validate a user-supplied logical path and return a relative path."""
        candidate = PurePosixPath(path.replace("\\", "/").strip("/"))
        if not candidate.parts or any(part in {"", ".", ".."} for part in candidate.parts):
            raise ValueError("path must be a non-empty relative path without traversal")
        if candidate.is_absolute():
            raise ValueError("absolute paths are not allowed")
        return Path(*candidate.parts)

    def workspace_root(self, workspace_id: str) -> Path:
        return self.root / "workspaces" / workspace_id

    def shared_revision_root(self, workspace_id: str, revision: int) -> Path:
        return self.workspace_root(workspace_id) / "shared" / "revisions" / f"{revision:08d}"

    def agent_private_root(self, workspace_id: str, agent_id: str) -> Path:
        return self.workspace_root(workspace_id) / "agents" / agent_id / "private"

    def session_root(self, workspace_id: str, session_id: str) -> Path:
        return self.workspace_root(workspace_id) / "sessions" / session_id

    def run_root(self, workspace_id: str, run_id: str) -> Path:
        return self.workspace_root(workspace_id) / "runs" / run_id

    def initialize_workspace(self, workspace_id: str) -> None:
        """Create the immutable empty revision zero for a workspace."""
        self.shared_revision_root(workspace_id, 0).mkdir(parents=True, exist_ok=True)

    def initialize_session(self, workspace_id: str, session_id: str) -> None:
        self.session_root(workspace_id, session_id).mkdir(parents=True, exist_ok=True)

    def initialize_run(self, workspace_id: str, run_id: str) -> None:
        self.run_root(workspace_id, run_id).mkdir(parents=True, exist_ok=True)

    def copy_session(self, workspace_id: str, source_session_id: str, target_session_id: str) -> None:
        """Copy task-local files when forking a Session."""
        source = self.session_root(workspace_id, source_session_id)
        target = self.session_root(workspace_id, target_session_id)
        if source.exists():
            shutil.copytree(source, target, dirs_exist_ok=True)
        else:
            target.mkdir(parents=True, exist_ok=True)

    def _scope_root(
        self,
        *,
        scope: str,
        workspace_id: str,
        revision: int,
        agent_id: str,
        session_id: str,
        run_id: str | None,
    ) -> Path:
        if scope == "shared":
            return self.shared_revision_root(workspace_id, revision)
        if scope == "private":
            return self.agent_private_root(workspace_id, agent_id)
        if scope == "session":
            return self.session_root(workspace_id, session_id)
        if scope == "run" and run_id:
            return self.run_root(workspace_id, run_id)
        raise ValueError("run scope requires a run_id")

    def write(
        self,
        *,
        scope: str,
        workspace_id: str,
        revision: int,
        agent_id: str,
        session_id: str,
        run_id: str | None,
        path: str,
        content: str,
    ) -> StoredFile:
        """Write a non-shared working file."""
        if scope == "shared":
            raise PermissionError("shared files must be published through a ChangeSet")
        root = self._scope_root(
            scope=scope,
            workspace_id=workspace_id,
            revision=revision,
            agent_id=agent_id,
            session_id=session_id,
            run_id=run_id,
        )
        target = root / self.normalize(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return self.describe(target, root, scope, include_content=True)

    def read(
        self,
        *,
        scope: str,
        workspace_id: str,
        revision: int,
        agent_id: str,
        session_id: str,
        run_id: str | None,
        path: str,
    ) -> StoredFile:
        root = self._scope_root(
            scope=scope,
            workspace_id=workspace_id,
            revision=revision,
            agent_id=agent_id,
            session_id=session_id,
            run_id=run_id,
        )
        target = root / self.normalize(path)
        if not target.is_file():
            raise FileNotFoundError(path)
        return self.describe(target, root, scope, include_content=True)

    def list(
        self,
        *,
        scope: str,
        workspace_id: str,
        revision: int,
        agent_id: str,
        session_id: str,
        run_id: str | None,
    ) -> list[StoredFile]:
        root = self._scope_root(
            scope=scope,
            workspace_id=workspace_id,
            revision=revision,
            agent_id=agent_id,
            session_id=session_id,
            run_id=run_id,
        )
        if not root.exists():
            return []
        return [self.describe(path, root, scope) for path in sorted(root.rglob("*")) if path.is_file()]

    @staticmethod
    def describe(path: Path, root: Path, scope: str, *, include_content: bool = False) -> StoredFile:
        stat = path.stat()
        return StoredFile(
            path=path.relative_to(root).as_posix(),
            scope=scope,
            size_bytes=stat.st_size,
            modified_at=datetime.fromtimestamp(stat.st_mtime, tz=UTC),
            content=path.read_text(encoding="utf-8") if include_content else None,
        )

    def publish(
        self,
        *,
        workspace_id: str,
        base_revision: int,
        revision: int,
        session_id: str,
        items: list[tuple[str, str, str, str]],
    ) -> list[PublishedFile]:
        """Create a complete immutable shared snapshot from Session files."""
        base = self.shared_revision_root(workspace_id, base_revision)
        target_root = self.shared_revision_root(workspace_id, revision)
        if target_root.exists():
            raise FileExistsError(f"workspace revision {revision} already exists")
        if base.exists():
            shutil.copytree(base, target_root)
        else:
            target_root.mkdir(parents=True)

        session_root = self.session_root(workspace_id, session_id)
        published: list[PublishedFile] = []
        for source_path, target_path, kind, media_type in items:
            source = session_root / self.normalize(source_path)
            if not source.is_file():
                raise FileNotFoundError(source_path)
            destination = target_root / self.normalize(target_path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            data = destination.read_bytes()
            published.append(
                PublishedFile(
                    name=destination.relative_to(target_root).as_posix(),
                    path=destination,
                    sha256=hashlib.sha256(data).hexdigest(),
                    size_bytes=len(data),
                    kind=kind,
                    media_type=media_type,
                )
            )
        return published

    def rollback(self, workspace_id: str, source_revision: int, target_revision: int) -> None:
        """Create a new immutable revision from a historical snapshot."""
        source = self.shared_revision_root(workspace_id, source_revision)
        target = self.shared_revision_root(workspace_id, target_revision)
        if not source.is_dir():
            raise FileNotFoundError(f"workspace revision {source_revision}")
        shutil.copytree(source, target)
