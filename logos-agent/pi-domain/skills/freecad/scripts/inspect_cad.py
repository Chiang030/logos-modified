"""Headless CAD inspection: solids/volume/bbox/mass properties/validity.

Run with freecadcmd (sys.argv[2:] carries the script args):

  freecadcmd inspect_cad.py <file> [<file> ...]

Supported inputs: .step/.stp/.iges/.igs/.brep (exact BREP), .fcstd (all
object shapes merged into one compound), .stl (faceted approximation).

Prints one block per file and a final SUMMARY line per file with verdict
PASS / WARN / FAIL, so the caller can grep instead of parsing prose.
"""

import os
import sys

import FreeCAD
import Part

ARGS = sys.argv[2:]


def finish(code):
    # freecadcmd discards buffered stdout on SystemExit; flush first so
    # the verdict lines and the exit code both reach the caller.
    sys.stdout.flush()
    sys.exit(code)


def load(path):
    """Return (shape, note) or raise. Exact formats keep real geometry;
    STL is tessellated, so its numbers carry mesh-resolution error."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".step", ".stp", ".iges", ".igs", ".brep"):
        return Part.read(path), ""
    if ext == ".fcstd":
        doc = FreeCAD.openDocument(path)
        shapes = [o.Shape for o in doc.Objects if hasattr(o, "Shape") and not o.Shape.isNull()]
        if not shapes:
            raise ValueError("no shape objects in document")
        return Part.makeCompound(shapes), f"{len(shapes)} objects merged"
    if ext == ".stl":
        import Mesh
        mesh = Mesh.Mesh(path)
        if mesh.CountFacets == 0:
            raise ValueError("empty mesh")
        shape = Part.Shape()
        shape.makeShapeFromMesh(mesh.Topology, 0.05)
        return shape, "MESH_APPROX from facets, volume/bbox carry tessellation error"
    raise ValueError(f"unsupported input format: {ext}")


def inspect(path):
    print(f"== {path}")
    try:
        shape, note = load(path)
    except Exception as exc:
        print(f"  ERROR: {exc}")
        return "FAIL"
    if note:
        print(f"  note: {note}")

    bb = shape.BoundBox
    print(f"  solids: {len(shape.Solids)}  shells: {len(shape.Shells)}  "
          f"faces: {len(shape.Faces)}  edges: {len(shape.Edges)}")
    print(f"  volume: {shape.Volume:.3f}  area: {shape.Area:.3f}")
    print(f"  bbox: X[{bb.XMin:.3f},{bb.XMax:.3f}] Y[{bb.YMin:.3f},{bb.YMax:.3f}] "
          f"Z[{bb.ZMin:.3f},{bb.ZMax:.3f}]")
    if shape.Solids:
        com = shape.Solids[0].CenterOfMass
        print(f"  center of mass (solid 1): ({com.x:.3f}, {com.y:.3f}, {com.z:.3f})")

    verdict = "PASS"
    if not shape.isValid():
        print("  invalid geometry (isValid=False) - heal with heal_convert.py")
        verdict = "FAIL"
    if shape.Volume <= 0:
        print("  non-positive volume - open shell or wrong orientation")
        verdict = "FAIL"
    if len(shape.Solids) > 1:
        print(f"  note: {len(shape.Solids)} separate solids in one compound")
        if verdict == "PASS":
            verdict = "WARN"
    return verdict


def main():
    if not ARGS:
        print("usage: freecadcmd inspect_cad.py <file> [<file> ...]")
        finish(2)
    verdicts = {}
    for path in ARGS:
        if os.path.isfile(path):
            verdicts[path] = inspect(path)
        else:
            print(f"== {path}\n  ERROR: file not found")
            verdicts[path] = "FAIL"
    for path, verdict in verdicts.items():
        print(f"SUMMARY: {path} {verdict}")
    finish(1 if "FAIL" in verdicts.values() else 0)


try:
    main()
except SystemExit:
    raise
except Exception as exc:  # freecadcmd swallows script exceptions and exits 0
    print(f"ERROR: {exc}")
    finish(1)
