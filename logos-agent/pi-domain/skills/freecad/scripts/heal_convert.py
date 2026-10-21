"""Heal a CAD shape and/or convert between formats, headless.

Run with freecadcmd (sys.argv[2:] carries the script args):

  freecadcmd heal_convert.py <input> <output> [heal] [norefine]

Option words are positional, not --flags: freecadcmd's own CLI parser
intercepts dashed arguments before the script sees them. `heal` forces
ShapeFix even when the input reports valid; without it, ShapeFix runs
only on invalid shapes. Refine (removeSplitter, on by default) merges
coplanar/cocylindrical faces; `norefine` keeps the face structure.

Inputs: .step/.stp/.iges/.igs/.brep/.fcstd/.stl (STL becomes a faceted
solid; its STEP/BREP output stays faceted). Outputs: .step/.stp/.brep/
.iges/.igs/.stl. Volume preservation is reported so a heal that ate
geometry is visible in the transcript.
"""

import os
import sys

import FreeCAD
import Part

ARGS = sys.argv[2:]
FORCE_HEAL = "heal" in ARGS
NO_REFINE = "norefine" in ARGS
PATHS = [a for a in ARGS if a not in ("heal", "norefine")]


def finish(code):
    # freecadcmd discards buffered stdout on SystemExit; flush first so
    # the status lines and the exit code both reach the caller.
    sys.stdout.flush()
    sys.exit(code)


def load(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".step", ".stp", ".iges", ".igs", ".brep"):
        return Part.read(path)
    if ext == ".fcstd":
        doc = FreeCAD.openDocument(path)
        shapes = [o.Shape for o in doc.Objects if hasattr(o, "Shape") and not o.Shape.isNull()]
        if not shapes:
            raise ValueError("no shape objects in document")
        return Part.makeCompound(shapes)
    if ext == ".stl":
        import Mesh
        mesh = Mesh.Mesh(path)
        shape = Part.Shape()
        shape.makeShapeFromMesh(mesh.Topology, 0.05)
        return shape
    raise ValueError(f"unsupported input format: {ext}")


def save(shape, path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".step", ".stp"):
        shape.exportStep(path)
    elif ext == ".brep":
        shape.exportBrep(path)
    elif ext in (".iges", ".igs"):
        shape.exportIges(path)
    elif ext == ".stl":
        doc = FreeCAD.newDocument("heal_convert")
        obj = doc.addObject("Part::Feature", "Shape")
        obj.Shape = shape
        import Mesh
        Mesh.export([obj], path)
        FreeCAD.closeDocument(doc.Name)
    else:
        raise ValueError(f"unsupported output format: {ext}")


def main():
    if len(PATHS) != 2:
        print("usage: freecadcmd heal_convert.py <input> <output> [heal] [norefine]")
        finish(2)
    src, dst = PATHS
    if not os.path.isfile(src):
        print(f"ERROR: input not found: {src}")
        finish(1)

    try:
        shape = load(src)
    except Exception as exc:
        print(f"ERROR: import failed: {exc}")
        finish(1)

    volume_in, faces_in = shape.Volume, len(shape.Faces)
    print(f"input: solids={len(shape.Solids)} faces={faces_in} "
          f"volume={volume_in:.3f} valid={shape.isValid()}")

    if FORCE_HEAL or not shape.isValid():
        fixer = Part.ShapeFix.Shape(shape)
        fixer.perform()
        shape = fixer.shape()

    if not NO_REFINE and shape.Solids:
        shape = shape.removeSplitter()

    # Faceted imports (STL) arrive as shells; wrap closed ones into solids
    # so boolean comparison and downstream exact-CAD tools accept them.
    if not shape.Solids and shape.Shells:
        solids = [Part.Solid(shell) for shell in shape.Shells if shell.isClosed()]
        if solids:
            shape = solids[0] if len(solids) == 1 else Part.makeCompound(solids)

    volume_out, faces_out = shape.Volume, len(shape.Faces)
    kept = (volume_out / volume_in * 100) if volume_in else float("nan")
    print(f"output: solids={len(shape.Solids)} faces={faces_out} "
          f"volume={volume_out:.3f} ({kept:.3f}% preserved) valid={shape.isValid()}")

    try:
        save(shape, dst)
    except Exception as exc:
        print(f"ERROR: export failed: {exc}")
        finish(1)
    print(f"STATUS: OK wrote {dst} ({os.path.getsize(dst)} bytes)")
    finish(0)


try:
    main()
except SystemExit:
    raise
except Exception as exc:  # freecadcmd swallows script exceptions and exits 0
    print(f"ERROR: {exc}")
    finish(1)
