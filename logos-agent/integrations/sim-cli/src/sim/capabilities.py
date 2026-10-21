"""Runtime capability assessment, independent of Skill overlay profiles."""
from __future__ import annotations
from dataclasses import dataclass, asdict
import json
import os
from pathlib import Path

STATES = {"verified", "experimental", "unknown", "known_incompatible"}

def load_rules():
    path = Path(os.environ.get("SIM_CAPABILITY_MATRIX", str(Path(__file__).with_name("runtime-capabilities.json"))))
    rows = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else []
    return tuple(CapabilityRule(**row) for row in rows)

@dataclass(frozen=True)
class CapabilityRule:
    product: str
    platform: str
    solver_version: str
    sdk_version: str
    capability: str
    status: str
    evidence: str

    def __post_init__(self):
        if self.status not in STATES: raise ValueError("invalid compatibility state")
        if not self.evidence: raise ValueError("compatibility rule requires evidence")

def assess(product, platform, solver_version, sdk_version, capability, *, rules=None, detected=False):
    rules = load_rules() if rules is None else rules
    key = (product, platform, solver_version, sdk_version, capability)
    for rule in rules:
        if (rule.product, rule.platform, rule.solver_version, rule.sdk_version, rule.capability) == key:
            return asdict(rule)
    return {"product": product, "platform": platform, "solver_version": solver_version,
            "sdk_version": sdk_version, "capability": capability,
            "status": "experimental" if detected else "unknown",
            "evidence": "capability probe succeeded; regression unverified" if detected else "no matching runtime evidence",
            "read_only_probe_allowed": True}
