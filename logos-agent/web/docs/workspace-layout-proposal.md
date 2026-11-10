# LOGOS workspace layout proposal

Approved and implemented initial layout, 2026-11-10. Existing projects are not
migrated automatically. See workspace-layout.md for the current implementation.

## Structure

Organize work as a project containing reusable assets, studies, and distinct
execution attempts. Begin with one baseline study and create folders on demand.

```text
project/
  project.md
  assets/
  models/
  meshes/
  studies/
    baseline/
      study.json
      scripts/
      runs/
        <timestamp>-<unique-id>/
          manifest.json
          inputs/
          logs/
          results/
      analysis/
  reports/
  .logos/
```

- project.md: objectives, constraints, acceptance criteria, unresolved questions.
- assets: original uploads, references, measurements; preserve originals.
- models: editable CAD sources, generation scripts, and derived exports.
- meshes: reusable meshes, generation scripts, source references, quality reports.
- study.json: the authoritative editable physical/numerical configuration for
  one study, including materials, boundaries, model/mesh references, solver,
  execution settings, and requested measurements. Use project-relative paths.
  Define and validate a versioned schema before implementing adapters.
- scripts: reusable preparation and execution scripts.
- runs: a new uniquely named directory for every attempt; never overwrite a
  previous run to retry. Preserve failed and cancelled attempts. Resume must
  identify its parent run and checkpoint.
- inputs: resolved configuration and actual solver inputs captured before launch.
  Mutable source references alone do not establish reproducibility.
- manifest.json: input checksums, software/version evidence, executed command,
  start/end timestamps, status, and artifact references. It records execution
  evidence and is not a second editable study configuration.
- logs/results: native solver logs and outputs belonging to that attempt.
- analysis: scripts, figures, and comparisons referencing explicit run IDs.
- reports: deliverables citing their studies and runs.
- .logos: internal indexes, caches, and tool bookkeeping; hidden by default with
  a show-internal-files toggle. Do not store login/API credentials in projects.

Studies share assets while varying design or operating conditions. Their editable
configuration may evolve; previous runs retain the inputs actually used. A
successful process exit and validated scientific results remain separate states.

## Browser and Agent behavior

Use Chinese display labels: 项目说明, 原始资料, 几何模型, 网格, 计算方案, 报告.
Each study contains 配置, 运行记录, 后处理. Preserve actual filesystem names and an
ordinary file view for arbitrary files. Display grouping must not move files.

Keep the selected project as the task root; navigating a subfolder does not
change the Agent working directory. Add an explicit new-study action. Do not
create a large empty tree on project creation.

Update browser behavior, Agent instructions, and solver adapters together after
the design is agreed. Solvers consume generated native input files; they do not
need to understand study.json. This draft does not promise automatic CAD previews,
a workflow engine, or stage-by-stage approval gates.

## Existing projects

Continue displaying legacy caseDict/A-geo/B-mesh/C-run directories as ordinary
folders. Do not migrate, rename, or delete them automatically. Do not establish
two writable configuration authorities. An optional future importer should
preview mappings, detect collisions, preserve originals, and select the new
configuration authority explicitly.

## Implementation order and open decisions

1. Agree on the hierarchy and minimal study schema.
2. Implement new-project/study creation and browser grouping.
3. Integrate Agent/adapters and per-run input snapshots.
4. Add run status, logs/results viewing, and report traceability.
5. Consider legacy import after validating the new workflow.

Still open: storage policy for large input snapshots and outputs; settings that
need form controls rather than JSON editing; and whether initial delivery needs
legacy import. Recommended first experience: project-level shared assets and one
baseline study, with additional studies created only when needed.
