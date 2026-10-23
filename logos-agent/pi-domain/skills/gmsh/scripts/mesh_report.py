#!/usr/bin/env python3
"""Print a read-only summary of a Gmsh mesh file.

The report covers node and element counts, physical groups, the bounding box,
and per-element-type quality extrema. It never modifies the input mesh.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def _element_summary(gmsh: Any, dimension: int) -> list[dict[str, Any]]:
    element_types, element_tags, _ = gmsh.model.mesh.getElements(dimension)
    rows: list[dict[str, Any]] = []
    for element_type, tags in zip(element_types, element_tags):
        name, _, order, node_count, _, _ = gmsh.model.mesh.getElementProperties(element_type)
        row: dict[str, Any] = {
            "name": name,
            "type": int(element_type),
            "order": int(order),
            "nodes_per_element": int(node_count),
            "count": int(len(tags)),
        }
        if len(tags) > 0:
            try:
                qualities = gmsh.model.mesh.getElementQualities(tags, "minSICN")
                row["quality_minSICN"] = {
                    "min": float(min(qualities)),
                    "max": float(max(qualities)),
                }
            except Exception as error:  # quality is optional evidence
                row["quality_error"] = str(error)
        rows.append(row)
    return rows


def build_report(path: str) -> dict[str, Any]:
    import gmsh

    gmsh.initialize(["-nopopup"])
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.open(path)
        report: dict[str, Any] = {
            "file": path,
            "gmsh_version": gmsh.__version__,
            "model_name": gmsh.model.getCurrent(),
            "entities": len(gmsh.model.getEntities()),
            "nodes": 0,
            "elements": [],
            "physical_groups": [],
            "bounding_box": None,
        }

        node_tags = gmsh.model.mesh.getNodes()[0]
        report["nodes"] = int(len(node_tags))

        for dimension in (0, 1, 2, 3):
            report["elements"].extend(_element_summary(gmsh, dimension))

        for dimension, tag in gmsh.model.getPhysicalGroups():
            report["physical_groups"].append({
                "dimension": int(dimension),
                "tag": int(tag),
                "name": gmsh.model.getPhysicalName(dimension, tag),
                "entities": [int(item) for item in
                             gmsh.model.getEntitiesForPhysicalGroup(dimension, tag)],
            })

        if gmsh.model.getEntities():
            xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.getBoundingBox(-1, -1)
            report["bounding_box"] = {
                "min": [xmin, ymin, zmin],
                "max": [xmax, ymax, zmax],
                "size": [xmax - xmin, ymax - ymin, zmax - zmin],
            }

        return report
    finally:
        gmsh.finalize()


def _print_text(report: dict[str, Any]) -> None:
    print(f"File: {report['file']}")
    print(f"Gmsh: {report['gmsh_version']}  Model: {report['model_name']}")
    print(f"Entities: {report['entities']}  Nodes: {report['nodes']}")
    print("Elements:")
    for row in report["elements"]:
        quality = row.get("quality_minSICN")
        suffix = ""
        if quality:
            suffix = f"  minSICN={quality['min']:.4g}..{quality['max']:.4g}"
        print(f"  {row['name']} ({row['nodes_per_element']} nodes): "
              f"{row['count']}{suffix}")
    print("Physical groups:")
    for group in report["physical_groups"]:
        print(f"  dim {group['dimension']} tag {group['tag']} "
              f"{group['name']!r}: {group['entities']}")
    box = report["bounding_box"]
    if box:
        print(f"Bounding box min: {box['min']}")
        print(f"Bounding box size: {box['size']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mesh", help="Path to a .msh file")
    parser.add_argument("--json", action="store_true", help="Print JSON instead of text")
    args = parser.parse_args()

    try:
        report = build_report(args.mesh)
    except ImportError:
        print("The gmsh Python module is not importable. Use the Gmsh venv interpreter.",
              file=sys.stderr)
        return 2
    except Exception as error:
        print(f"Failed to read {args.mesh}: {error}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print_text(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
