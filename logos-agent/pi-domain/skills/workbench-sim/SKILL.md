---
name: workbench-sim
description: "Run Ansys Workbench journals, inspect projects, manage persistent sessions, hand off to Mechanical, and troubleshoot through sim-cli."
---

# workbench-sim

You are connected to **Ansys Workbench** via sim-cli. This file is the
**index**. It tells you where to look for actual content — it does not
contain the content itself.

For installation selection and session lifecycle, read [sim-cli](../sim-cli/SKILL.md).
In LOGOS, use `simulation_discover` for installation evidence and `simulation`
for bounded launch/attach/exec/inspect calls. Keep the same target host and
explicit session ID across calls.

Read relevant `base/` references first. Load SDK/solver overlays only when
active-runtime evidence identifies their matching versions; a missing overlay
is a documentation gap, not proof of runtime incompatibility.

---

## base/ — always relevant

Concepts, API patterns, and version-agnostic reference:

| Path | What's there |
|---|---|
| `base/reference/pyworkbench_api.md` | PyWorkbench SDK API surface: `launch_workbench`, `run_script_string`, `upload_file`, `download_file`, `start_mechanical_server`, `start_fluent_server`. **Read first.** |
| `base/reference/journal_scripting.md` | IronPython `.wbjn` scripting reference: `SetScriptVersion`, `GetTemplate`, `CreateSystem`, `GetContainer`, and the result file convention. |
| `base/reference/system_templates.md` | Live template discovery and resolver workflow. Template names are product/configuration dependent; treat any examples as non-authoritative. |
| `base/reference/file_transfer.md` | File upload/download patterns between client and server. |
| `base/reference/sub_solver_integration.md` | Starting PyMechanical, PyFluent, PySherlock servers from within a Workbench session. |
| `base/snippets/` | Numbered journal examples. LOGOS rewrites the conventional result filename to a unique operation directory for SDK/snippet execution. |
| `base/examples/` | Official PyWorkbench examples from pyansys.com — Fluent workflow, PyMechanical integration, logging, cooled turbine blade, cyclic symmetry, axisymmetric rotor, material designer. |
| `base/workflows/static_structural/` | **6-step Static Structural walkthrough** (Engineering Data → Geometry → Model → Setup → Solution → Results). Per-cell API reference + gotchas + executable `walk_workflow.py`. |
| `base/workflows/project_review_loop.md` | Required checkpoint loop: inspect health, project identity, systems summary, then run one bounded journal step. |
| `base/workflows/debug_failed_exec.md` | Failure triage loop for failed Workbench snippets and RunWB2 journals. |
| `base/workflows/mechanical_handoff.md` | Workbench-to-Mechanical checklist for Static Structural workflows. |
| `base/known_issues.md` | Vendor quirks, SDK version constraints, IronPython limitations. |

## sdk/<active_sdk_layer>/ — PyWorkbench SDK specifics

- `sdk/0.4/` — Minimum SDK for Ansys 24.1.
  - `notes.md` — `release` parameter (not `version`), missing methods vs 0.10+.
- `sdk/0.10/` — Modern SDK (requires Ansys >= 24.2).
  - `notes.md` — New APIs (`download_project_archive`, `stop_*_server`), version gate.

## solver/<active_solver_layer>/ — Ansys release specifics

- `solver/24.1/` — Ansys 2024 R1.
  - `notes.md` — IronPython .NET 4.x constraints, SDK 0.4-0.9 only.

---

## Hard constraints (apply to every session)

1. **Never call `launch_workbench()` from a snippet.** sim-cli already
   started the Workbench session. A second launch spawns a conflicting
   server process.
2. **All snippets are IronPython journals**, not Python SDK calls. The
   driver's `run()` method sends code through `run_script_string()` to
   the Workbench IronPython sandbox. Use Workbench API calls
   (`SetScriptVersion`, `GetTemplate`, etc.), not `ansys.workbench.core`.
3. **Results go through file convention.** IronPython stdout is not
   piped. Write JSON to `%TEMP%/sim_wb_result.json` for the driver to
   read back.
4. **Never invent Category A defaults.** Geometry, materials, BCs,
   acceptance criteria — if missing, ask the user.
5. **Acceptance ≠ exit code.** Validate against physics-based criteria
   (e.g., component count, temperature range), not just exit code.
6. **Workbench owns cells 1-3.** Engineering Data, Geometry, and Model
   orchestration belongs here. Mechanical setup, solve, and results belong to
   `solver=mechanical`.
5. **Resolve templates dynamically.** Before creating any Workbench system,
   query the live session with `workbench.templates.visible` and
   `workbench.templates.resolve:<intent>`. If resolution fails, compare the
   live template list with official PyWorkbench examples/docs instead of
   copying a template table into the skill.

---

## Required protocol (one paragraph)

After a session is established: read `base/reference/pyworkbench_api.md`,
`base/reference/journal_scripting.md`,
`base/reference/system_templates.md`, and
`base/workflows/project_review_loop.md`. Inspect `session.health`,
`workbench.project.identity`, `workbench.systems.summary`, and the relevant
template resolver result before creating a system. Execute IronPython journals
incrementally through `simulation` with `action=exec`, checking `last.result` and
`workbench.systems.summary` after every step. Use snippets from
`base/snippets/` adapted to the user's task. Before handoff, read
`base/workflows/mechanical_handoff.md` and confirm Workbench has a refreshed
Model cell. Mechanical owns setup, solve, and result extraction.
