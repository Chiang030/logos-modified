---
name: logos-project-layout
description: Manage LOGOS project assets, study configurations, execution snapshots, logs, results, and reports using the project-study-run layout.
---

# LOGOS project, study, and run layout

For simulation work, first call project_workspace with action list at the selected
project root. Browser navigation never changes that root. If managed is true,
this guide takes precedence over caseDict/A-geo/B-mesh/C-run conventions in
older domain references. If false, preserve existing files and use their current
organization. Initialize only an empty project when a new project is requested.

## Sources of truth

- project.md: intent, constraints, acceptance criteria, open questions.
- assets/: original references and uploaded files; preserve them.
- models/: editable CAD sources and exports. Use SolidCraft by default according
  to the system's CAD discipline unless the user selects another tool.
- meshes/: reusable meshes, generation scripts, quality evidence.
- studies/<id>/study.json: editable physical/numerical configuration for one
  study. Never create caseDict as a second configuration authority.
- studies/<id>/scripts/: reusable input-generation and execution scripts.
- studies/<id>/runs/<run-id>/: one execution attempt, with inputs/, logs/,
  results/, and manifest.json.
- studies/<id>/analysis/: post-processing and comparisons citing specific runs.
- reports/: final deliverables citing study IDs and run IDs.
- .logos/: internal bookkeeping. Not a user report or physics configuration.

Create folders only as needed. New projects start with project.md and the baseline
study. Ordinary additional files remain supported. Do not migrate existing
VibeFlow directories automatically.

## Configuration schema, version 1

Use project_workspace create_study with a lowercase ID (letters, numbers,
hyphens, underscores; at most 64 characters) and a human-readable name.
The initial config includes schemaVersion, id, name, physics (object), materials
(array), boundaries (array), model and mesh (project-relative file or null),
solver (name and settings), execution (object), outputs (array), and inputs
(array of project-relative files).

Read list to obtain the current config and revision. Edit the complete config
and call save_study with the same revision. A stale revision is rejected:
reload and reconcile instead of overwriting somebody else's changes.

Physical/numerical detail is solver-dependent within these fields. Record units
and assumptions explicitly; never invent missing requirements just to pass
structural validation. Objects and arrays are not evidence of physics readiness.
No automatic solver-specific input generator is implied by this schema.

## Running

1. Confirm the selected study and resolve the required physical/numerical inputs.
2. Generate native solver inputs and scripts; list every file used by execution
   in inputs. The model and mesh references are included automatically.
   Allowed inputs are files under assets/, models/, meshes/, or this study's
   scripts/. List dependencies individually. Directory snapshots are not supported.
3. Call prepare_run. This creates a new run ID, copies the study config and
   referenced input files, records checksums, and creates logs/ and results/.
   No solver is started. A snapshot is limited to 2 GiB; report this limit and
   agree on an alternative before handling larger inputs.
4. For simulation run/exec, supply study and run_id. The tool changes its CLI
   working directory to that run directory, records the command and lifecycle,
   and saves stdout, stderr, and operation evidence in logs/. Use copied input
   paths (e.g. inputs/studies/<id>/scripts/run.py), not mutable source paths.
   Solvers attached remotely may not inherit this cwd: set their paths explicitly
   and collect results into this run before claiming outputs are available.
5. For direct bash/Python/MCP execution, call update_run with status running and
   the actual command before execution. Explicitly execute from the run directory
   using snapshot inputs. Record software version evidence, logs, outputs, and a
   terminal status via update_run. The shell and external MCP tools do not
   automatically record their lifecycle for you.
6. A completed process does not mean scientifically validated results.
   manifest acceptance stays not_evaluated. Record validation in analysis/reports.
   A timeout or service crash can leave a remote solver's state unknown; inspect
   it before retrying or marking the run interrupted.

Never overwrite an old run to retry. Create a new snapshot. Do not modify
inputs/ after execution begins. Record checkpoint/parent-run references for a
resume. No filesystem permission isolation is imposed by this layout.

## Workflow mapping for domain references

Interpret legacy geometry-stage output as models/, meshing-stage output as
meshes/, solver input/output as the selected run's inputs/ and results/,
post-processing as the study's analysis/, reports as reports/, and caseDict
parameters as study.json. Domain-specific physics and validation guidance still
applies. Do not claim VibeFlow Studio auto-execution, GUI previews, or ParaView
watchers exist in the web app. Execute supported tools explicitly and inspect
their actual outputs.
