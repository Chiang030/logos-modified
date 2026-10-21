---
name: gmsh
description: Use when generating, repairing, converting, checking, or scripting finite-element meshes with Gmsh (CLI or Python API), including STEP/BREP import, physical groups, size fields, boundary layers, quality checks, and MSH/INP/STL/MED export.
---

# Gmsh

## Scope

Use this skill for mesh generation and mesh-side geometry preparation:

- importing STEP, BREP, IGES, or STL into a headless meshing session;
- creating volumes, physical groups, named boundaries, and size fields;
- generating 2D/3D meshes, boundary layers, and structured or hybrid meshes;
- checking mesh quality, node/element counts, and expected physical groups;
- exporting MSH, INP, STL, MED, UNV, CGNS, or solver-specific meshes;
- writing a reproducible Gmsh Python driver for a LOGOS case.

Do not use Gmsh to construct or edit the authoritative CAD model. Route CAD
construction, reconstruction, repair, and export through the `solidcraft` skill
and MCP server. If a mesh exposes a geometry defect, return to the CAD source,
repair it there, revalidate, and re-export. Do not silently patch STEP or mesh
files.

## Discover the installation

The Linux server deployment was verified on 2026-10-20 with Gmsh 4.15.2:

| Capability | Path |
|---|---|
| CLI | `/home/jiangjincheng/.local/bin/gmsh` |
| Python API | `/home/jiangjincheng/.local/opt/gmsh-venv/bin/python` (`import gmsh`) |
| Headless GUI | Not available over SSH; do not call `-gui` or `gmsh.fltk.run()` |

On any host, verify before use rather than assuming this layout:

```bash
command -v gmsh
gmsh --version
/home/jiangjincheng/.local/opt/gmsh-venv/bin/python -c "import gmsh; print(gmsh.__version__)"
```

If the CLI or Python module is missing, stop and report which capability is
missing. Do not install or download a different Gmsh without asking the user.

## Non-negotiable rules

1. Keep `0-caseDict/caseDict` as the source of truth for dimensions, units,
   regions, interfaces, and mesh targets.
2. Keep the meshing driver, `.geo` files, `.msh` files, and logs under `B-mesh/`.
   Do not overwrite `A-geo/` or the CAD source.
3. Record the command or script, Gmsh version, input geometry, output mesh,
   node/element counts, and quality metrics in the case notes.
4. A zero exit code only proves that a file was written. It does not prove that
   the mesh is valid, watertight, solver-compatible, or converged.
5. Do not claim a y+ target was met from Gmsh alone. y+ depends on the solver
   flow field and must be checked after the solve.
6. Do not re-run a failed long meshing job blindly. Inspect the log, entity
   count, and partial output first; then change the smallest relevant setting.

## CLI quick reference

Generate a 3D mesh from STEP with explicit size limits:

```bash
gmsh -3 -format msh22 -o B-mesh/case.msh A-geo/exports/case.step \
  -setnumber Mesh.CharacteristicLengthMin 0.5 \
  -setnumber Mesh.CharacteristicLengthMax 5.0 \
  -setnumber Mesh.Algorithm3D 10
```

Generate a 2D surface mesh:

```bash
gmsh -2 -format msh22 -o B-mesh/surface.msh A-geo/exports/surface.step
```

Export another format:

```bash
gmsh -3 -format inp -o B-mesh/case.inp A-geo/exports/case.step
gmsh -3 -format stl -o B-mesh/case.stl A-geo/exports/case.step
```

Check a mesh file and print its summary:

```bash
gmsh -check B-mesh/case.msh
```

Use `-v 3` for normal progress and `-v 5` for detailed diagnostics. Keep the
stdout/stderr log next to the mesh.

## Python API pattern

Always initialize and finalize inside `try/finally`. Keep the script
deterministic and run it with the interpreter that can import `gmsh`.

```python
import gmsh

STEP = "A-geo/exports/case.step"
OUT = "B-mesh/case.msh"

gmsh.initialize(["-nopopup"])
try:
    gmsh.option.setNumber("General.Terminal", 1)
    gmsh.model.add("case")
    gmsh.model.occ.importShapes(STEP)
    gmsh.model.occ.healShapes()
    gmsh.model.occ.removeAllDuplicates()
    gmsh.model.occ.synchronize()

    volumes = gmsh.model.getEntities(3)
    if not volumes:
        raise RuntimeError("no 3D volumes were imported")

    gmsh.option.setNumber("Mesh.CharacteristicLengthMin", 0.5)
    gmsh.option.setNumber("Mesh.CharacteristicLengthMax", 5.0)
    gmsh.option.setNumber("Mesh.Algorithm3D", 10)
    gmsh.model.mesh.generate(3)
    gmsh.model.mesh.optimize("Netgen")
    gmsh.write(OUT)
finally:
    gmsh.finalize()
```

### Physical groups and named boundaries

Add groups deliberately; downstream solvers rely on stable names:

```python
def add_group(dim: int, tags: list[int], name: str) -> int:
    tag = gmsh.model.addPhysicalGroup(dim, tags)
    gmsh.model.setPhysicalName(dim, tag, name)
    return tag

volumes = [tag for _, tag in gmsh.model.getEntities(3)]
add_group(3, volumes, "fluid")

boundary = gmsh.model.getBoundary([(3, tag) for tag in volumes],
                                  oriented=False, combined=False)
by_dim = {}
for dim, tag in boundary:
    by_dim.setdefault(dim, []).append(tag)
add_group(2, by_dim[2], "walls")
```

Inspect existing names before adding new ones. Duplicate or empty physical
groups are a common cause of solver-side boundary errors.

### Local refinement with a size field

```python
distance = gmsh.model.mesh.field.add("Distance")
gmsh.model.mesh.field.setNumbers(distance, "SurfacesList", surface_tags)
gmsh.model.mesh.field.setNumber(distance, "Sampling", 100)

threshold = gmsh.model.mesh.field.add("Threshold")
gmsh.model.mesh.field.setNumber(threshold, "Ifield", distance)
gmsh.model.mesh.field.setNumber(threshold, "SizeMin", 0.2)
gmsh.model.mesh.field.setNumber(threshold, "SizeMax", 5.0)
gmsh.model.mesh.field.setNumber(threshold, "DistMin", 0.5)
gmsh.model.mesh.field.setNumber(threshold, "DistMax", 10.0)
gmsh.model.mesh.field.setAsBackgroundMesh(threshold)

gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
```

### Boundary layers

For a wall boundary with physical tag `wall_tag`:

```python
field = gmsh.model.mesh.field.add("BoundaryLayer")
gmsh.model.mesh.field.setNumbers(field, "FacesList", [wall_tag])
gmsh.model.mesh.field.setNumber(field, "Size", first_layer_height)
gmsh.model.mesh.field.setNumber(field, "Ratio", growth_ratio)
gmsh.model.mesh.field.setNumber(field, "Quads", 1)
gmsh.model.mesh.field.setAsBoundaryLayer(field)
```

Check the actual layer count and first-layer height after meshing. A valid
boundary-layer field does not by itself satisfy a y+ target.

## Mesh quality and validation

Use the bundled read-only report script:

```bash
/home/jiangjincheng/.local/opt/gmsh-venv/bin/python \
  scripts/mesh_report.py B-mesh/case.msh
```

`scripts/mesh_report.py` is relative to this skill directory. `A-geo/` and
`B-mesh/` are relative to the LOGOS case workspace, not to the skill directory.

The script prints node and element counts, physical groups, bounding box, and
per-element-type quality extrema. Treat its output as evidence, not as an
automatic pass/fail decision. State the acceptance threshold used by the case
and report the measured value.

Minimum checks before handing a mesh to a solver:

- the mesh file exists and is non-empty;
- node and element counts are non-zero;
- the bounding box matches the intended geometry within a stated tolerance;
- every required physical group exists with the expected dimension and name;
- no duplicate or zero-area/zero-volume entities were introduced;
- the worst element quality and the percentage below the case threshold are
  recorded;
- a solver-side import check (or `gmsh -check`) has run.

## Export formats

| Format | Flag | Typical use |
|---|---|---|
| MSH 2.2 | `-format msh22` | broad solver compatibility |
| MSH 4.1 | `-format msh41` | modern Gmsh, large models |
| INP | `-format inp` | Abaqus/CalculiX-style input |
| STL | `-format stl` | surface exchange and visualization |
| MED | `-format med` | Code_Aster / Salome |
| UNV | `-format unv` | legacy solvers |
| CGNS | `-format cgns` | CFD exchange |

Choose the format and version required by the downstream solver. Do not assume
that a successful export preserves physical-group names in the target format;
verify the imported mesh.

## LOGOS case handoff

For a LOGOS simulation case:

1. Read `0-caseDict/caseDict` and confirm units, mesh targets, region names, and
   boundary names.
2. Write `B-mesh/mesh.py` (or `B-mesh/mesh.geo`) and keep it reproducible.
3. Run the mesher and save `B-mesh/mesh.log`.
4. Run `scripts/mesh_report.py` and record the evidence in the case notes.
5. Convert to the solver format under `B-mesh/` or the solver's expected path.
6. Report the actual mesh statistics and any unverified items. Do not claim
   solver convergence or physical acceptance from meshing alone.
