#!/usr/bin/env python3
"""Read-only STEP complexity preflight for SolidCraft imports."""
from __future__ import annotations
import collections, json, re, sys
from pathlib import Path

ENTITY = re.compile(r"#\d+\s*=\s*([A-Z][A-Z0-9_]*)\s*\(")

def main() -> int:
    if len(sys.argv) != 2:
        print("usage: step_preflight.py FILE.step", file=sys.stderr)
        return 2
    path = Path(sys.argv[1]).expanduser().resolve()
    if not path.is_file():
        print(json.dumps({"error": f"file not found: {path}"}))
        return 1
    raw = path.read_bytes()
    text = raw.decode("utf-8", errors="ignore")
    counts = collections.Counter(ENTITY.findall(text))
    products = sum(counts[k] for k in ("PRODUCT", "PRODUCT_DEFINITION"))
    occurrences = sum(counts[k] for k in ("NEXT_ASSEMBLY_USAGE_OCCURRENCE", "CONTEXT_DEPENDENT_SHAPE_REPRESENTATION"))
    solids = sum(counts[k] for k in ("MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS", "SHELL_BASED_SURFACE_MODEL"))
    faces = counts["ADVANCED_FACE"] + counts["FACE_SURFACE"] + counts["FACE_OUTER_BOUND"]
    result = {
        "path": str(path), "bytes": len(raw), "megabytes": round(len(raw) / 1_000_000, 3),
        "schema": re.findall(r"FILE_SCHEMA\s*\(\((.*?)\)\)", text, re.S)[:1],
        "entities": sum(counts.values()), "products": products,
        "occurrences": occurrences, "solids": solids, "faces": faces,
        "large_file": len(raw) > 10_000_000,
        "large_entity_count": sum(counts.values()) > 100_000,
        "recommendation": "preflight complete; import separately with the 1800-second MCP timeout",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
