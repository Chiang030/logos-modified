"""Local immutable artifact creation for prototype runs."""

from hashlib import sha256
import json
from pathlib import Path

from agent.config import get_settings
from agent.contracts import (
    ArtifactManifest,
    ArtifactRef,
    ModelingDeliverable,
    PlaceholderExecutionResult,
)


def _write_json(path: Path, payload: dict[str, object]) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _artifact_ref(kind: str, path: Path) -> ArtifactRef:
    data = path.read_bytes()
    return ArtifactRef(
        kind=kind,
        path=str(path.resolve()),
        sha256=sha256(data).hexdigest(),
        size_bytes=len(data),
    )


def freeze_placeholder_run(
    run_id: str,
    deliverable: ModelingDeliverable,
) -> ArtifactManifest:
    """Write a versioned placeholder run and return its frozen manifest."""
    run_dir = (
        get_settings().runs_dir
        / run_id
        / f"input-v{deliverable.input_version}"
    )
    run_dir.mkdir(parents=True, exist_ok=True)

    deliverable_path = run_dir / "modeling_deliverable.json"
    result_path = run_dir / "placeholder_result.json"
    log_path = run_dir / "placeholder.log"

    _write_json(deliverable_path, deliverable.model_dump(mode="json"))
    result = PlaceholderExecutionResult(
        run_id=run_id,
        task_id=deliverable.task_id,
        input_version=deliverable.input_version,
        metrics={"solver_iterations": 0.0, "physical_fields": 0.0},
        log=[
            "No supported solver was executed.",
            "This artifact only validates orchestration and evidence handling.",
        ],
    )
    _write_json(result_path, result.model_dump(mode="json"))
    log_path.write_text("\n".join(result.log) + "\n", encoding="utf-8")

    manifest = ArtifactManifest(
        run_id=run_id,
        task_id=deliverable.task_id,
        input_version=deliverable.input_version,
        artifacts=[
            _artifact_ref("modeling_deliverable", deliverable_path),
            _artifact_ref("placeholder_result", result_path),
            _artifact_ref("execution_log", log_path),
        ],
    )
    _write_json(run_dir / "manifest.json", manifest.model_dump(mode="json"))
    return manifest
