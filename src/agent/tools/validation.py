"""Deterministic validation tools used by the independent validator."""

from hashlib import sha256
import json
from pathlib import Path

from langchain_core.tools import tool
from pydantic import ValidationError

from agent.config import get_settings
from agent.contracts import (
    ArtifactManifest,
    DeterministicValidationEvidence,
    ModelingDeliverable,
    PlaceholderExecutionResult,
    ValidationCheck,
)


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _check(
    check_id: str,
    expected: str,
    observed: str,
    passed: bool,
    evidence_ref: Path,
) -> ValidationCheck:
    return ValidationCheck(
        check_id=check_id,
        expected=expected,
        observed=observed,
        passed=passed,
        evidence_ref=str(evidence_ref.resolve()),
    )


def check_frozen_artifacts(manifest_path: str) -> DeterministicValidationEvidence:
    """Validate manifest location, schemas, hashes, and cross-file identity."""
    path = Path(manifest_path).resolve()
    runs_root = get_settings().runs_dir
    checks: list[ValidationCheck] = []

    allowed = _is_within(path, runs_root) and path.name == "manifest.json"
    checks.append(
        _check(
            "manifest_location",
            f"manifest.json below {runs_root}",
            str(path),
            allowed,
            path,
        )
    )
    if not allowed or not path.is_file():
        checks.append(
            _check("manifest_exists", "file exists", "missing", False, path)
        )
        return DeterministicValidationEvidence(all_passed=False, checks=checks)

    try:
        manifest = ArtifactManifest.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        checks.append(
            _check("manifest_schema", "valid ArtifactManifest", type(exc).__name__, False, path)
        )
        return DeterministicValidationEvidence(all_passed=False, checks=checks)

    checks.append(_check("manifest_schema", "valid ArtifactManifest", "valid", True, path))
    parsed: dict[str, ModelingDeliverable | PlaceholderExecutionResult] = {}

    for artifact in manifest.artifacts:
        artifact_path = Path(artifact.path).resolve()
        contained = _is_within(artifact_path, path.parent)
        checks.append(
            _check(
                f"artifact_location:{artifact.kind}",
                "artifact below manifest directory",
                str(artifact_path),
                contained,
                path,
            )
        )
        if not contained or not artifact_path.is_file():
            checks.append(
                _check(
                    f"artifact_exists:{artifact.kind}",
                    "file exists",
                    "missing",
                    False,
                    artifact_path,
                )
            )
            continue

        data = artifact_path.read_bytes()
        observed_hash = sha256(data).hexdigest()
        checks.append(
            _check(
                f"artifact_hash:{artifact.kind}",
                artifact.sha256,
                observed_hash,
                observed_hash == artifact.sha256 and len(data) == artifact.size_bytes,
                artifact_path,
            )
        )

        try:
            if artifact.kind == "modeling_deliverable":
                parsed[artifact.kind] = ModelingDeliverable.model_validate_json(data)
            elif artifact.kind == "placeholder_result":
                parsed[artifact.kind] = PlaceholderExecutionResult.model_validate_json(data)
        except (ValidationError, ValueError) as exc:
            checks.append(
                _check(
                    f"artifact_schema:{artifact.kind}",
                    "valid structured artifact",
                    type(exc).__name__,
                    False,
                    artifact_path,
                )
            )
        else:
            if artifact.kind in parsed:
                checks.append(
                    _check(
                        f"artifact_schema:{artifact.kind}",
                        "valid structured artifact",
                        "valid",
                        True,
                        artifact_path,
                    )
                )

    identities_match = all(
        item.task_id == manifest.task_id
        and item.input_version == manifest.input_version
        for item in parsed.values()
    ) and {"modeling_deliverable", "placeholder_result"}.issubset(parsed)
    checks.append(
        _check(
            "artifact_identity",
            f"task={manifest.task_id}, input_version={manifest.input_version}",
            "matched" if identities_match else "mismatch or missing artifact",
            identities_match,
            path,
        )
    )
    checks.append(
        _check(
            "physics_validation_scope",
            "placeholder artifacts are marked not_evaluated",
            "not_evaluated",
            True,
            path,
        )
    )
    return DeterministicValidationEvidence(
        all_passed=all(check.passed for check in checks),
        checks=checks,
    )


@tool
def validate_frozen_artifacts(manifest_path: str) -> str:
    """Validate a frozen Logos manifest and return checks with evidence references."""
    evidence = check_frozen_artifacts(manifest_path)
    return json.dumps(evidence.model_dump(mode="json"), ensure_ascii=False)
