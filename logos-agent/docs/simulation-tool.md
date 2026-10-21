# Simulation tool

LOGOS registers `simulation` and `simulation_discover` through its Pi extension. The underlying executable remains `sim`. LOGOS maintains source forks of core and the Mechanical/Workbench plugins under `integrations/`.

The default is the project-local `integrations/.venv` Python running `-m sim`, with `--json --no-interactive`. Prepare it with `npm run sim:setup`. If that environment is absent, the adapter falls back to `sim` on PATH. Set `LOGOS_SIM_COMMAND` in `logos-agent/.env` to override it, for example:

```dotenv
LOGOS_SIM_COMMAND='["C:/path/to/venv/Scripts/python.exe", "-m", "sim"]'
```

The tool never executes through a shell. The subprocess inherits the current LOGOS workspace and environment. It does not copy API credentials to configuration files.

Inputs: `action`, optional literal `args`, optional `host`/`port`/`session`, optional `installation` for launch/probe, and `timeout_ms` (100–3600000). First call `help` when using an external CLI; that CLI may lack the LOGOS-added commands.

`simulation_discover` takes `product` (mechanical/workbench), optional explicit `path` and optional `host`. It returns installation IDs and source/version evidence without launching software. Explicit paths are registered on the target machine so subsequent `simulation` calls can select the same ID. Remote discovery runs on the server, not the client. IDs are not executable instructions and stale paths are revalidated before use.

Every call writes a unique `.logos/simulation/operations/<UUID>/` directory with stdout, stderr and a structured result. Results separate `transport_ok`, nullable `script_ok`, and `acceptance: not_evaluated`. Without explicit script evidence, a successful process exit does not prove script success. Outputs are capped at 1 MiB per stream and report truncation. Do not pass secrets as command arguments or print them from scripts, as operation output is retained.

Timeout or cancellation terminates the CLI client, marks remote state unknown, and never retries. It does not claim to stop a remote solve or clean up solver processes. The LOGOS server records launched/attached origin and ownership, selects driver detach for attached software, and preserves records when teardown fails. External CLI/server implementations must be checked for equivalent ownership behavior.

## Source and implementation

Core 0.3.9 was imported from the user-provided `sim-cli-main.zip`; Mechanical 0.1.6 and Workbench 0.1.2 source files were extracted from their wheels, preserving license files. Local plugin package versions carry `+logos.1`. Setup installs all three as editable packages. Changes are confined to LOGOS integration sources, not Pi upstream.

- Product/OS discovery follows explicit path, official SDK, environment, PATH and platform directories. Multiple sources are merged. Unknown versions remain visible. Directory-name versions are labeled hints, not verified runtime versions.
- `runtime-capabilities.json` is independent of Skill documentation. Rows are keyed by product, OS, solver version, SDK version and capability, with evidence and verified/experimental/unknown/known_incompatible status. It is initially empty: no untested combination is declared verified. `SIM_CAPABILITY_MATRIX` selects an external matrix. Successful connection evidence is experimental; GUI/batch/script capabilities are assessed separately. Known-incompatible script capabilities are blocked.
- Runtime versions come from connected SDK properties, never another detected installation. Absent properties remain unknown. Session metadata includes origin, ownership, endpoint, backend and nullable project/process fields.
- Workbench SDK launch/execute failures no longer silently replay through native batch. Batch launch requires explicit backend selection. Attached SDK sessions can use the existing GUI's script interface, including user scripts that call `Model.SendCommand`.
- Workbench's conventional result filename is rewritten to an operation-specific transfer directory for SDK/snippet execution. Core preserves per-operation evidence and explicit script errors. Plain transport success leaves script success unknown.
- Doctor checks configuration; probe checks installations; verify connects and queries runtime evidence; smoke launches a separate temporary workspace and performs an isolated project query. Smoke is rejected for an existing endpoint or connected driver. This is a minimal lifecycle smoke, not a physical solve or model-creation regression.

## Remaining validation and limitations

Actual 2026 R1/Linux/Windows solver combinations, licenses, GUI capture, port contention, native batch transfer and SDK-specific ownership/destructor behavior require real runtime regression. Current tests use fake installations and SDK/session objects. Do not claim these combinations verified. Project/process metadata can be null when the SDK does not report it. Remote verification currently requires running `verify` on the server; remote discovery/probe/launch/attach are supported. Timeout stops the client, not necessarily the submitted solver action; inspect before retrying. Capability assessment currently blocks known-incompatible script execution; unknown states are exposed for explicit operator decisions, not auto-promoted to supported.

2026 R1 acceptance requires discovery, explicit compatibility, observed running version and specified operations in an isolated project. Adding a 26.1 profile alone does not pass acceptance. No Ansys installation or remote runtime was exercised by the adapter tests.
