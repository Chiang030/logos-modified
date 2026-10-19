# Ansys Fluent Automation Playbook

## Official References

- Fluent Batch Execution: https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/flu_ug/flu_ug_BatchExecution.html
- Fluent User's Guide: https://ansyshelp.ansys.com/public/Views/Secured/corp/v251/en/flu_ug/flu_ug.html
- Launching and connecting with PyFluent: https://fluent.docs.pyansys.com/version/stable/user_guide/session/launching_ansys_fluent.html
- Fluent case/data files: https://ansyshelp.ansys.com/public/Views/Secured/corp/v251/en/flu_ug/flu_ug_CaseDataFiles.html
- Parallel startup on Windows: https://ansyshelp.ansys.com/public/Views/Secured/corp/v251/en/flu_ug/flu_ug_parallel_start_windows.html
- Journal compatibility and TUI version: https://ansyshelp.ansys.com/public/Views/Secured/corp/v251/en/flu_mig/flu_mig_chp_intro.html

Commands, TUI paths, and PyFluent object trees vary by release. Match the documentation release to the installed Fluent release before generating production scripts.

## VibeFlow Configuration Keys

| Key | Meaning |
| --- | --- |
| `cae.fluent` | Resolved `fluent` or `fluent.exe` entry |
| `cae.fluentVersion` | Release inferred from the install path or recorded by Setup |
| `VIBEFLOW_FLUENT` | Automation command environment variable |

Setup deliberately avoids launching Fluent because startup can request a license. Run a separate license-aware smoke test before production.

## Journal Versus PyFluent

| Requirement | Journal/TUI | PyFluent |
| --- | --- | --- |
| Fixed sequence and existing case | Preferred | Possible but unnecessary |
| Minimal dependencies and HPC batch | Preferred | Requires a Python environment |
| Dynamic queries and branches | Awkward | Preferred |
| Persistent service connection | Not suitable | Preferred through gRPC |
| Cross-release stability | Requires TUI versioning | Requires compatible PyFluent/Fluent |
| Reusing recorded automation | Common | Requires translation |

A case can use a journal for solution and PyFluent for orchestration, but never let two controllers modify the same session concurrently.

## Recommended Layout

```text
C-run/fluent/case-1/
+-- input/mesh.msh.h5
+-- input/baseline.cas.h5
+-- journals/00-check.jou
+-- journals/10-setup.jou
+-- journals/20-run.jou
+-- journals/30-export.jou
+-- pyfluent/run_case.py
+-- udf/src/
+-- run/
+-- logs/transcript.log
+-- checkpoints/
+-- exports/monitors/
+-- exports/fields/
`-- case-manifest.md
```

## Headless Windows Execution

```powershell
$fluent = $env:VIBEFLOW_FLUENT
& $fluent 3d -g -wait -i 'journals/20-run.jou' *> 'logs/fluent-launcher.log'
if ($LASTEXITCODE -ne 0) { throw "Fluent failed: $LASTEXITCODE" }
```

Common startup options:

| Option | Purpose |
| --- | --- |
| `2d` / `3d` | Dimension |
| `-g` | Headless batch mode |
| `-hidden` | Hidden mode when supported and appropriate |
| `-wait` | Make the Windows caller wait for Fluent to finish |
| `-i <journal>` | Execute a journal |
| `-t<n>` | Parallel process count, for example `-t8` |

Confirm precision, MPI, and remote options in current release documentation. Always check the outer process exit code.

## Journal Design

A journal streams TUI commands and prompt answers. A production journal must:

1. Set the TUI compatibility release used to record the workflow.
2. Start a transcript.
3. Read an explicit mesh/case/data file.
4. Complete one verifiable stage.
5. Write a checkpoint or result.
6. Stop the transcript.
7. Exit explicitly and answer save prompts.

Structural example:

```scheme
; Use the exact TUI version and commands from the target Fluent release.
/file/set-tui-version "25.1"
; start transcript
; read mesh/case
; mesh check, setup, initialize, iterate or advance time
; write case/data to a new path
; export monitors/results
; stop transcript
/exit yes
```

Comments are placeholders, not executable commands. Obtain exact TUI commands by recording a journal with the target release or consulting its TUI documentation.

### Why Split Journals

- `00-check`: read and check the mesh without solving.
- `10-setup`: set materials, zones, models, and solver controls; save a configured case.
- `20-run`: read the configured case, initialize/continue, and write checkpoints.
- `30-export`: read final case/data and export monitors and fields.

Staging isolates prompts and release issues and supports restart from the most recent valid artifact.

## Mapping From caseDict

| caseDict Concept | Fluent Object | Validation |
| --- | --- | --- |
| Geometry/mesh | Mesh, cell zones, face zones | Units, dimension, zone names |
| Regions | Cell zone conditions | Fluid, solid, porous types |
| Interfaces | Mesh interfaces | Both zones, direction, nonconformal behavior |
| Materials | Materials | Density, viscosity, thermal properties, species |
| Boundary sets | Boundary conditions | Type, profile, reference direction |
| Physical problem | Models | Energy, viscous, multiphase, species, and others |
| Numerical method | Solution methods and controls | Coupling, schemes, relaxation, time step |
| Execution | Run calculation | Iterations, time steps, checkpoint, parallelism |
| Post-processing | Reports, monitors, exports | Units, surfaces, statistical window |

Zone names are an interface contract. Export or print the zone inventory immediately after import and compare it with `caseDict`; stop on missing or unexpected zones.

## Smoke Test

A smoke test proves workflow closure rather than convergence:

1. Read mesh/case.
2. Run mesh check.
3. Check zone count and types.
4. Initialize.
5. Advance 3-10 steady iterations or 1-3 transient steps.
6. Write new `.cas.h5/.dat.h5` files.
7. Export one residual/monitor file.
8. Exit normally.

Proceed to production only when the smoke test is noninteractive, has no fatal error, and produces complete outputs.

## PyFluent Pattern

```python
import ansys.fluent.core as pyfluent

solver = pyfluent.launch_fluent(
    mode="solver",
    dimension=3,
    precision="double",
    processor_count=4,
)
try:
    # Query the target release's settings/TUI API before assigning values.
    # Read case/mesh, configure, initialize, run, save, and export.
    pass
finally:
    solver.exit()
```

Confirm actual arguments and setting paths in current PyFluent documentation. Rules:

- Pin compatible PyFluent and Fluent releases.
- Specify startup behavior explicitly rather than relying on desktop preferences.
- Query object state and allowed values before assignment.
- Preserve transcript/checkpoint on exceptions and close owned sessions in `finally`.
- Protect server-info files and never commit connection secrets.

## Parallel, Remote, And Scheduled Runs

- Use `-t<n>` for common Windows process-count selection.
- Benchmark the same mesh at representative process counts and record wall time, memory, and license usage.
- Remote/HPC runs require shared-path, MPI, scheduler, license-connectivity, and result-retrieval design.
- The outer scheduler must parse transcript fatal/license errors as well as the Fluent process exit.

## UDF Development

Record the following for every UDF:

- Fluent release, compiler, and platform.
- Interpreted/compiled and serial/parallel target.
- `DEFINE_*` hooks, data dependencies, and units.
- Source, build log, hook location, and minimal validation case.
- Host/node behavior and data reduction for parallel code.

Never compile and test a UDF for the first time in an unvalidated production case.

## Result Evidence

- Transcript and launcher log.
- `.cas.h5/.dat.h5` checkpoints and final files.
- CSV residuals, report definitions, mass/energy balance, force/moment/pressure-drop targets.
- Surface and volume exports with location, units, time, and operating point.
- Fixed camera, color map, and range for image exports.

## Failure Matrix

| Symptom | Category | First Check |
| --- | --- | --- |
| Immediate exit or license error | Toolchain/license | Entry, release, license service |
| Journal hangs | Interaction | TUI release, unanswered prompt, command path |
| Invalid command | Release | Recording release versus runtime release |
| Zone not found | Mesh/interface | Mesh zone names versus `caseDict` |
| Divergence detected | Numerical/physics | Mesh, boundaries, initialization, time step, schemes |
| UDF compile failure | Development/toolchain | Compiler, headers, API, parallel target |
| Normal exit without data | Workflow | Write command, path, save prompt, disk |

## Completion Criteria

- The headless workflow closes successfully with exit-code and transcript evidence.
- Case/data, journal/PyFluent scripts, logs, and open-format exports are complete.
- Zones, materials, models, numerical methods, and targets trace back to `caseDict`.
- Licensing, release, process count, UDFs, and recovery points are recorded.
