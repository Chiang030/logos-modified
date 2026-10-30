# LOGOS 0.3.7 stability validation

Validated on Windows on 2026-10-28. This report records the source changes and local installable artifacts before publication.

## Changes

- Session indexes use serialized atomic writes, recoverable backups and a versioned format. Existing JSONL transcripts remain authoritative. Startup reconciles orphan transcripts, preserves corrupt files with diagnostics and marks interrupted runs without rerunning computations. History is paginated instead of truncated at 50 entries. Manual names survive automatic title updates.
- Opening the chat synchronizes the current session, including partial responses when the runtime is already active. Sending waits for recovery. Failed switches preserve the current view. Menu and command actions share the new-session flow.
- Model, RPC, process and tool failures reach the frontend with redacted details and explicit outcomes. Ordinary stderr remains diagnostic evidence. Failed simulation results now carry the tool protocol's error flag. Pending cards settle on interruption; idle output shows a waiting indicator.
- Chat text is selectable. Scrolling respects reading and selection. File and HTTP(S) links go through the extension host; arbitrary command links are rejected. Errors offer copyable details and a log action.
- Registered models reuse the bundled Pi capability catalog and compatibility metadata. Per-model reasoning overrides support custom connections. The selector uses runtime-supported levels and confirms applied values. Session transcripts retain model and thinking changes.
- Bounded software discovery covers Blender, KiCad, FreeCAD, Gmsh, SolidCraft, Fluent, Mechanical, Workbench, HFSS/AEDT and SpaceClaim/Discovery. It exposes host, paths, version hints and discovery sources to settings and the agent. Existing Mechanical/Workbench installation interfaces remain intact. Discovery does not launch applications or consume licenses.
- The domain registers `web_search` using DuckDuckGo HTML without a search API key. It supports 1–10 results, cancellation, timeout, proxy configuration and explicit challenge/rate-limit/network/parse errors. Existing offline startup behavior is retained.

`undici` 8.10.2 is an explicit domain dependency for proxy-aware HTTP dispatch. This is the same version already used by the bundled Pi runtime, avoiding a second HTTP implementation. Undici is the actively maintained Node.js HTTP client underlying Node's fetch implementation.

## Automated and local validation

| Check | Result and evidence |
| --- | --- |
| Extension type checking and compiled bundles | Passed `npm run typecheck` and `npm run compile`; final host bundle rebuilt after activation diagnostics changes. |
| Extension tests | 97 tests in 17 files passed. Includes concurrent saves, more than 50 sessions, backup/orphan recovery, manual names, interrupted runs, failed switching, reopening partial streams, empty-content model errors, stderr handling, link validation and capability metadata. Log: `vscode-extension/test-stability.log`. |
| Domain tests | 11 passed: `node --test src/web-search.test.mjs src/software-discovery.test.mjs src/simulation/runner.test.mjs`. Includes software fixtures, version selection, stale paths, platform exclusions, result parsing, zero results, challenge, rate limiting, cancellation, timeout, network errors, HTTPS CONNECT proxy routing and simulation failures. |
| Windows runtime | Payload verification and smoke passed with the Windows runtime. Smoke checks tool registration, streaming, session switching and an actual child-process restart. The subsequent model request contains the earlier user and assistant messages. It also checks the outgoing `reasoning_effort: high` parameter against a local model endpoint. Logs: `verify-win32.log`, `smoke-win32.log`. |
| Linux package | Linux-x64 payload verification passed. Smoke passed using the Windows host Node.js to execute the Linux package's JavaScript. The Linux Node/Python binaries were not executed. Logs: `verify-linux.log`, `smoke-linux.log`. |
| Browser UI | Compiled UI exercised against `scripts/preview-regressions.mjs`: selectable text, encoded Chinese file link with line number, 25-to-50 history pagination, Enter rename, High reasoning message, error details/copy/log controls, no horizontal overflow at 320px and 430px. Screenshot: `vscode-extension/ui-regressions.png`. |
| Final archives | Both target manifests checked. All 587 files in each payload manifest were hashed inside the archives. Compiled host/UI files and package metadata match the final local build. |
| Isolated Windows installation | Final VSIX installed successfully using a fresh temporary `--user-data-dir` and `--extensions-dir`; CLI lists `logos.logos-vscode@0.3.7`. Normal VS Code directories were not modified. Log: `install-win32.log`. |
| Whitespace | `git diff --check` passed; Git emitted existing line-ending normalization notices. |

Commands and logs above are relative to `logos-agent/vscode-extension`, except the domain test command, which runs in `logos-agent/pi-domain`. Logs and VSIX files are local build artifacts, not committed sources.

The baseline VSIX files completed the regular vsce packaging scan. Final source updates were applied using `scripts/refresh-built-vsix.ps1`, which checks unchanged version/platform/simulation metadata, runs the same vsce secret scanner on changed files, updates a temporary archive and verifies hashes before replacement. Normal full packaging remains available through the package scripts.

## Remaining acceptance limits

- Live DuckDuckGo access from this machine timed out with `UND_ERR_CONNECT_TIMEOUT`; successful external search is **not verified**. Local HTTP fixtures and a local HTTPS CONNECT proxy validate handling and routing, not public-service availability. A reachable network or correctly configured proxy is needed for live acceptance.
- No native Linux desktop or running Linux container was available. Linux installation, native runtime execution and clean-user GUI acceptance remain unverified.
- Desktop automation could not connect to its native pipe. Browser UI checks and isolated CLI installation do not establish real VS Code mouse selection, OS clipboard, editor navigation or reload behavior in an interactive desktop. These require manual acceptance.
- Software discovery fixtures establish path and selection behavior, not real application readiness. Versions currently come from path hints; SDK dependencies and MCP connections are explicitly unverified. Licensed applications and remote-host execution were not run. A discovered executable is not evidence that a solver can run successfully.
- Model requests were validated against a local mock endpoint. Real provider authentication, rate-limit behavior and every provider-specific reasoning protocol were not exercised against live accounts.
- Existing OpenTelemetry dependency warnings/audit findings and a Browserslist age notice appeared during packaging. No unrelated dependency upgrades were applied.

## Installable artifacts

Both files are in `logos-agent/vscode-extension/`:

| Artifact | SHA-256 |
| --- | --- |
| `logos-vscode-win32-x64-0.3.7.vsix` | `CED87518424EB8CF5D42C43F8A4BC7BA3CD188095FDC325314AE492662788CAB` |
| `logos-vscode-linux-x64-0.3.7.vsix` | `CC0A8174CC0CDFC1CD69A054406520930F954B54C6613DD8450FAF1FC256F90B` |

Existing workspace changes, including the observability registration and `HANDOFF-codex-v0.3.6.md`, were preserved. Validation did not modify the normal VS Code installation. Publication is a separate step; this report describes the evidence collected before release.
