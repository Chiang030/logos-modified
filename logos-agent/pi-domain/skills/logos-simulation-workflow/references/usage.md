## Usage Mode Execution Workflow

### Stage 1: Requirement Clarification and `caseDict` Completion

- Objective: convert user requirements into a structured, executable case definition.
- Input: user requirements, user-provided materials under `Ref`, the existing `0-caseDict/caseDict`, and necessary databases or public literature.
- Actions:
  - Read and preserve parameters the user has already specified explicitly.
  - Check `0-caseDict/caseDict` item by item, ask follow-up questions for missing and uncertain items, and complete parameters as far as possible. If anything is unclear, ask the user and continue only after receiving explicit requirements.
  - If `0-caseDict/caseDict` lacks case parameters or modules required for downstream work, add them proactively.
  - Write newly added parameters, constraints, case status, error status, and related information back to `caseDict`.
- Output: `0-caseDict/caseDict`, which can serve as the sole basis for all subsequent stages.
- Condition for entering the next stage: `caseMeta`, `intent`, `physicalProblem`, key geometry parameters, materials, regions/interfaces, boundaries/loads/initial values, mesh targets, numerical-method targets, and post-processing objectives are sufficiently clear, and the user agrees to enter the geometry stage.

### Stage 2: Parametric Geometry Modeling

- Objective: generate repeatable, modifiable, exportable parametric geometry based on `caseDict`, using SolidCraft as the CAD source of truth.
- Input: `0-caseDict/caseDict`
- Actions:
  - Use the `solidcraft` Skill and SolidCraft MCP to import, reconstruct, edit, inspect, save, and export the geometry. Keep the `.solidcraft` design under `A-geo/` as the editable source and export `STEP`/`STL`/`3MF` artifacts under `A-geo/exports` for downstream stages.
  - If a scripted geometry helper is needed, it must produce or drive a reproducible SolidCraft command script; do not make CadQuery or FreeCAD the default geometry source. Locate inputs and outputs from `ctx.case_root` and `ctx.a_geo_dir`; do not rely only on the current working directory.
  - Keep `0-caseDict/caseDict` as the source of truth. Parameter names in scripts must match `geometry.parameters`; geometry-entity naming must serve `geometry.entities`, `regions`, `interfaces`, and `boundariesLoadsInitials.boundarySets`.
  - After a SolidCraft operation, inspect timeline errors/warnings and run independent measurements and a screenshot or model render. Geometry is complete only after the `.solidcraft` file can be reopened and the required exports pass inspection.
  - If modeling fails, dimensions conflict, or Boolean operations behave abnormally, consult the SolidCraft modeling/checking references first; if the issue comes from unclear requirements, return to Stage 1.
- Output: SolidCraft source design, exported geometry files, reproducible command/script record, validation notes, and a geometry manifest usable for meshing.
- Condition for entering the next stage: geometry can be rebuilt reliably, naming and parameter semantics are clear, the geometry satisfies user requirements, and the user agrees to enter the mesh stage.

### Stage 3: Meshing and Boundary Checks

- Objective: generate a mesh that satisfies computational requirements based on the geometry and `caseDict`.
- Input: geometry files under `A-geo/`, and `0-caseDict/caseDict`
- Actions:
  - Consume the verified SolidCraft export. Use the corresponding meshing capability, such as `blockMesh`, `snappyHexMesh`, or `gmsh`, for mesh generation and boundary preparation; do not silently edit or replace the CAD source in this stage.
  - If using `gmsh`, store the meshing script, `.msh` file, and related intermediate artifacts under `B-mesh/`. If using OpenFOAM-native mesh tools such as `blockMesh` or `snappyHexMesh`, proceed directly to `C-run` operations.
  - Select the meshing strategy according to the physics problem and physical model: structured mesh, unstructured mesh, or hybrid mesh.
  - If script errors, topology anomalies, mesh distortion, or boundary naming confusion occur, consult the backend software reference entry first. If the geometry itself is problematic, return to Stage 2 and repair it in SolidCraft before re-exporting.
  - If anything is unclear or uncertain, ask the user and continue only after receiving explicit requirements.
- Output: mesh files and scripts with clear boundary naming and conversion readiness for the backend software.
- Condition for entering the next stage: the mesh can be generated successfully, region/interface/boundary-set and mesh names are consistent with `caseDict`, quality satisfies current computational requirements, and the user agrees to enter the solve stage.

### Stage 4: Case Generation, Checks, and Solve

- Objective: generate a runnable case and complete the computation.
- Input: `0-caseDict/caseDict`, and mesh files under `B-mesh/`.
- Actions:
  - Based on `physicalProblem`, `materials`, `regions`, `interfaces`, `boundariesLoadsInitials`, `mesh`, `numericalMethod`, and `execution`, select the closest baseline case in the backend software and copy it to `C-run/case-1`; if none exists, generate it yourself.
  - Generate or modify parameters according to the unified physical/numerical description in `caseDict`.
  - Use backend mesh-check tools such as `checkMesh` to check the mesh; if the problem originates from mesh generation, return to Stage 3.
  - Run the solver and record logs. If errors occur, first consult local backend source code and reference entries.
  - If the user needs multiple operating conditions and `case-1` cannot satisfy the requirement, copy and create additional cases under `C-run`, rename them according to case characteristics, and update `0-caseDict/caseDict`.
  - If anything is unclear or uncertain, ask the user and continue only after receiving explicit requirements.
- Output: reproducible experimental cases, runtime logs, and result data under `C-run/`.
- Condition for entering the next stage: mesh conversion succeeds, dictionaries/configuration are complete, the case runs without unresolved errors, results satisfy the current analysis objective, and the user agrees to enter the post-processing stage.

### Stage 5: Post-Processing and Visualization

- Objective: extract plots, field visualizations, and derived data that can answer the user's question from the simulation results.
- Input: computation results under `C-run/`, and `0-caseDict/caseDict`
- Actions:
  - Prefer Python for line plots, statistics, and tables, and write the script as `D-post/postprocess.py`.
  - For visualization tasks such as geometry, slices, isosurfaces, streamlines, vector fields, and mesh scenes, write a `paraview.simple` script and save it as `D-post/scenes.py`; do not execute it manually, because the GUI automatically detects file changes and executes it. `D-post/scenes.py` is the only script that interacts with the ParaView GUI. `D-post/logs/paraview_executor.log` is the automatic execution log from Studio; after writing the script, inspect `paraview_executor.log`, and consult references to resolve errors.
  - Do not set `view.ViewSize` in `D-post/scenes.py`; Studio automatically synchronizes the GUI viewport size. `ViewSize` is only used in `D-post/pvpython.py` for offline screenshots or `SaveScreenshot` resolution control.
  - In the Studio GUI executor, locate the script path with `Path(globals().get("__file__", globals().get("VIBEFLOW_PARAVIEW_SCRIPT", "D-post/scenes.py")))`; do not assume every execution context provides `__file__` by default.
  - Do not use `display.ColorArrayName = ["", ""]` for solid coloring; ParaView 5.11 may raise `invalid association string ''`. Prefer guarded `ColorBy(display, None)`, and if it fails, only set display properties such as `DiffuseColor` and `Opacity`.
  - When controlling the current Studio GUI, scripts must be incremental: preferentially reuse existing objects in the current Pipeline, create only missing objects, and do not clear the session by default.
  - ParaView objects created or maintained by AI must use the `VF_` prefix consistently. Scripts may only modify such objects unless the user explicitly requests otherwise; do not delete or overwrite GUI objects manually created by the user.
  - Do not use `ResetSession()`, batch `Delete(...)`, or rebuild the entire scene by default. If a reset is truly required, first explain its impact and obtain user confirmation.
  - If offline post-processing or batch image/animation generation is required, write `D-post/pvpython.py`, execute it with `pvpython`, and output images, animations, or data.
  - If script or rendering issues occur, consult the `ParaView` reference entry first. If the results themselves are insufficient to support the conclusion, return to Stage 4.
  - If anything is unclear or uncertain, ask the user and continue only after receiving explicit requirements.
- Output: reproducible post-processing scripts, images, data tables, and summary conclusions.
- Condition for entering the next stage: key charts and field visualizations have been generated, results can support the conclusion, and the user agrees to enter the report stage.

### Stage 6: Report Generation

- Objective: produce a deliverable and traceable case report.
- Input: relevant artifacts under `A-geo/`, `B-mesh/`, `C-run/`, and `D-post/`.
- Actions:
  - Write `report.md` under `E-report/`.
  - The report should cover at least: problem definition, key parameters, geometry and mesh methods, solve settings, result analysis, main conclusions, assumptions, and limitations.
  - If case-configuration figures, mesh figures, result data, result images, or similar artifacts exist, include tables, figures, data, and analysis. If any item is missing, ask the user whether to supplement it and then continue.
  - Writing requirements: write from the author's perspective in an objective, detailed, scientific, professional, academic, coherent, elegant, well-structured, logical, and engaging style. Convert the content into mathematical and academic language, forming a paper-like description.
  - If key gaps remain, return to the corresponding preceding stage to complete them instead of forcing conclusions into the report.
  - If anything is unclear or uncertain, ask the user and continue only after receiving explicit requirements.
- Output: `E-report/report.md`
- Completion condition: the report is complete, conclusions are consistent with upstream artifacts, and it can independently explain the full history and rationale of the case.

