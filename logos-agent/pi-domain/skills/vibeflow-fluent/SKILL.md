---
name: vibeflow-fluent
description: Use when preparing, running headlessly, debugging, or post-processing Ansys Fluent commercial CFD workflows in VibeFlow/VibeCAE, including .cas.h5/.dat.h5 files, journal/TUI automation, PyFluent/gRPC, mesh and physics setup, parallel execution, UDFs, residual monitoring, checkpoints, and batch result export.
---

# VibeFlow Ansys Fluent
## 当前机器的软件位置

首次使用先读取运行时提供的软件清单；缺失或过期时调用 `software_discover`。使用返回的当前主机绝对路径，不要全盘搜索或把历史部署路径当作本机事实。安装、SDK、许可证和 MCP 连接分别验证；远程任务必须在目标主机探测。


This skill maps `caseDict` to auditable Fluent case/data files, journals, or PyFluent scripts. Prefer headless batch execution and always produce a complete transcript, saved results, and an explicit exit.

## When To Use

- The user explicitly selects Fluent or provides `.msh.h5`, `.cas.h5`, `.dat.h5`, `.jou`, or a PyFluent script.
- Materials, cell zones, boundaries, models, discretization, initialization, iteration/time advancement, or exports must be automated.
- Batch operating points, remote/parallel solving, a UDF, or gRPC control is required.
- Journal blocking, TUI release, licensing, divergence, data-file, or UDF compilation failures need diagnosis.

## Choose The Entry

- Stable existing case with a fixed command sequence: prefer journal/TUI.
- Object queries, dynamic branches, or service-style control: use PyFluent.
- User-defined physics: treat the UDF as release- and compiler-constrained development work.
- Missing command, license, PyFluent, or compiler: switch to `vibeflow-toolchain` first.

## Read First

- Fluid model, materials, regions, boundaries, initialization, numerical methods, stopping criteria, and post-processing targets in `0-caseDict/caseDict`.
- `references/fluent-playbook.md`.
- `references/fluent-practical-tips.md`.
- Existing case/data, journals, UDFs, mesh reports, and manuals under `Ref/`.
- Setup values for `cae.fluent` and `cae.fluentVersion`; Setup validates the path but does not prove license availability.

## Recommended Artifacts

```text
C-run/fluent/case-1/
├── input/
├── journals/
│   ├── setup.jou
│   ├── run.jou
│   └── export.jou
├── pyfluent/
├── udf/
├── run/
├── logs/
├── checkpoints/
├── exports/
├── case-manifest.md
└── run-fluent.ps1
```

## Usage-Mode Workflow

1. Read `caseDict` and confirm dimension, precision, steady/transient mode, materials, zones, boundaries, turbulence/multiphase/energy models, discretization, initialization, and stopping criteria.
2. Check mesh units, dimension, zone names, negative volumes, quality, and closure; zone names must match `caseDict`.
3. Select a Fluent release and set the matching TUI compatibility version at the beginning of the journal to reduce prompt drift.
4. Split setup, run, and export into independently repeatable scripts. Each script reads an explicit file and starts a transcript.
5. Run a smoke test: read mesh/case, check mesh, initialize, advance a few iterations/steps, write a checkpoint, and exit normally.
6. Use `fluent 3d -g -wait -i run.jou` for the full batch run; `-wait` lets the outer workflow observe actual completion.
7. For transient/long runs, write case/data checkpoints at a controlled interval and retain the most recent valid checkpoint.
8. Export residuals, monitors, force/moment, mass flow, surface/volume data, and required images; do not keep only `.dat.h5`.
9. Check exit code, transcript, fatal/error messages, final iteration/time step, conservation, and exports before updating `caseDict`.

## PyFluent Workflow

1. Pin an `ansys-fluent-core` version compatible with the Fluent release.
2. Call `launch_fluent()` with explicit mode, dimension, precision, processor count, and GUI behavior, or connect using a protected server-info file.
3. Query available settings/commands before assigning values; do not guess paths from another release.
4. Close owned sessions in `try/finally`; preserve transcript and the latest checkpoint on exceptions.
5. Protect server-info files and never write connection secrets into project documentation.

## Development Mode And UDFs

- Treat UDFs, journal generators, PyFluent adapters, and log parsers as development-mode work.
- Record Fluent release, compiler, parallel mode, hooks, inputs/outputs, and the minimal validation case in `UDF/README.md`.
- Compile UDFs with a compiler supported by the target Fluent release and validate serial and parallel targets separately.

## Core Rules

- `caseDict` is the source of truth; case/data plus journal/PyFluent scripts are execution artifacts.
- Journals must be noninteractive: answer every prompt, write a transcript, save results, and exit explicitly.
- Never overwrite user baseline case/data files; use working copies and operating-point-specific outputs.
- Do not launch Fluent during Setup testing because startup can check out a license.
- Never store license data, server-info secrets, or remote credentials in context.
- Inspect model state before changes; rerunning scripts must not create duplicate monitors/reports.
- Choose parallel process count from licensing, memory, mesh size, and benchmarks, not the assumption that more is always faster.

## Acceptance And Fallbacks

- A batch run reads input, checks mesh, initializes, advances a few steps, saves, and exits normally.
- Transcript contains no unanswered prompts or fatal errors; residuals, conservation, and engineering monitors are interpretable.
- Key results are exported as CSV/text/images or formats readable by ParaView/Python.
- Stuck journal: inspect TUI release and missing prompts instead of hiding the issue with a longer timeout.
- UDF failure: separate compiler, header/API, parallel-hook, and physics-logic problems.
- Numerical divergence: return to mesh, boundaries, initialization, time step, and discretization before changing the installation.
