# LOGOS workspace layout

Released with LOGOS v0.3.15 on 2026-11-10. The web service runs on Linux;
the shared project workspace tool also supports Windows and macOS desktop paths.

An empty folder registered as a new project receives project.md,
studies/baseline/study.json, and .logos/project.json. Existing nonempty folders
are registered unchanged. A managed project can create additional studies,
edit their JSON configurations, and prepare run input snapshots. Shared asset
folders are created on demand; uploads at a managed project's root go to assets/.

## Browser

The file view displays Chinese labels for recognized directories and keeps an
ordinary filename view through the Chinese-category toggle. Dotfiles are hidden
by default and can be shown. The study tab supports creating studies, editing
configuration, preparing runs, and opening each run's manifest, inputs, logs, and
results. Preparation never starts a solver. File browsing does not change the
task's working directory.

Configuration saves use a content revision to reject lost updates. A draft
configuration requires physical-problem details and a solver name before run
preparation. Solver-specific completeness still requires domain validation.

## Schema and snapshots

study.json schemaVersion 1 contains id, name, physics, materials, boundaries,
model, mesh, solver, execution, outputs, and inputs. Model and mesh are
project-relative file references or null. Inputs lists additional files under
assets/, models/, meshes/, or the study's scripts/. Nested solver-specific
settings are retained; no universal solver input generator is claimed.

Each preparation creates a distinct timestamp/UUID directory. It copies the
configuration and referenced files into inputs/, records SHA-256 checksums, and
creates logs/ and results/. Input files are limited to 2 GiB in total; directory
inputs and symlinks are rejected. Failed preparations retain a failed manifest.
Large-data deduplication and retention policies are not implemented.

Snapshots are preserved by application behavior, not filesystem permissions.
The shared server account still has ordinary host access. Agent instructions
require execution from snapshot inputs and prohibit modifying them afterward.

## Execution and ownership

The project_workspace tool and authenticated /api/workspace route share the
same implementation. The browser route resolves the logged-in user's project
and pins its directory descriptor before operations. Paths cannot traverse
symlinks or leave that root.

The simulation tool's run and exec actions require a prepared study/run ID for
managed projects. They set the CLI cwd to that run, record the command and
status, and save stdout, stderr, and operation evidence. Remote sessions may
use their own working directories; callers must set output paths and collect
results explicitly. Completed means execution finished; acceptance remains
not_evaluated.

Other bash, Python, or MCP calls require explicit project_workspace lifecycle
updates by the Agent. The web task ID is recorded when starting a run. An abrupt
worker or host interruption can leave a manifest marked running; inspect the
actual solver before recording interrupted. No automatic restart or scientific
validation is inferred.

## Compatibility and verification

Legacy caseDict and staged directories remain ordinary files. Managed projects
use the logos-project-layout skill and the system prompt's path mapping, which
takes precedence over legacy domain-reference paths. No legacy importer,
automatic GUI preview, or workflow graph engine is implemented.

Validation covers new/legacy initialization, duplicate study rejection,
revision conflicts, invalid configurations and paths, symlink rejection,
distinct input snapshots, simulation cwd/results/logs, HTTP ownership and CSRF,
and real headless Chrome project creation/configuration/run browsing against a
temporary database. Browser fixture: tests/browser/workspace-management.mjs.
