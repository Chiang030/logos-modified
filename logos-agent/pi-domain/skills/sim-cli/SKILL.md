---
name: sim-cli
description: "Shared decision rules for LOGOS simulation tools: installation selection, runtime evidence, session ownership, input requirements, acceptance and failure handling. Use alongside the relevant solver skill."
---

# LOGOS Simulation Tools

## Tool selection

- `simulation_discover`: discover Mechanical/Workbench installations on the target host. Supply an explicit path when known; select an installation ID from the returned evidence.
- `simulation`: pass that ID to `launch` or `probe`, or use `attach` with an existing endpoint. Execute and inspect through the selected host and session. Use `help` to confirm the installed CLI syntax.
- Other products: follow their solver-specific discovery instructions. These tools do not yet provide generic installation discovery for every solver.
- Use solver-native batch commands or SDKs when they are the appropriate backend; keep the same evidence and acceptance rules. Unsupported tool actions such as screenshots still require the documented native CLI/API.

The tools own path persistence, argument passing, timeout handling and evidence storage. Do not duplicate these mechanisms in ad hoc scripts. For external CLI use without the LOGOS tools, consult [CLI reference](references/cli-reference.md) only as needed.

## Runtime and session decisions

1. Discovery identifies an installation, not the running solver. After launch/attach, inspect `session.versions` and session identity before applying version-specific instructions.
2. Assess compatibility per product, OS, solver version, SDK version and capability. States are verified, experimental, unknown and known-incompatible. Missing Skill overlays do not establish incompatibility; older notes do not prove support for newer versions. Unknown combinations permit version queries and read-only probes; require capability evidence before mutation or solve.
3. Choose launch for a new owned session and attach for an existing user project. Confirm the expected project before modification. Detach attached sessions without closing the user's software; do not use stop-server as ordinary cleanup.
4. For existing solved files, use file-side analysis such as DPF without launching a solver. Smoke validation must use a new isolated project, never an attached user project.

## Inputs and acceptance

| Input | Rule |
|---|---|
| Physical decisions: geometry, materials, BCs, physics, acceptance criterion | Obtain missing values from the user; example values are not defaults. |
| Operational choices: processors, UI mode, workspace, log verbosity | May default when suitable; disclose the choice. |
| File-derived values: mesh counts, boundary names, fields, material IDs | Infer from actual files or read-only queries, not analogous examples. |

Missing physical inputs block model setup/solve, not installation discovery or read-only diagnostics.

Check `transport_ok`, `script_ok` and physical acceptance separately. Null script evidence is unknown; process exit zero is not convergence or physical validity. Evaluate results against the user's measurable acceptance criterion and retain relevant artifact identity.

## Failure and long-running work

Execute one bounded step, inspect its result, then proceed. Find the first causal failure: environment/license, connection, import, setup, mesh, solve, or export. Preserve the initial error and active runtime evidence; use the smallest diagnostic that tests a stated cause. Do not alter physics to conceal an unproven environment or import failure.

Never silently retry or switch SDK execution to batch after a failed mutation. Timeout/cancellation may leave a remote operation running or partly committed; inspect its state before proposing another execution. Use session health, progress and artifact queries between bounded steps for long workflows.

## GUI requirements

GUI control requires a GUI-capable session and, on Windows, a real interactive desktop on the server. Missing windows or black screenshots from an SSH/service session are environment evidence, not a reason to retry clicks. Ask the operator to provide an interactive session. Read [GUI guide](gui/SKILL.md) only for GUI actuation; use solver scripting APIs when available.
