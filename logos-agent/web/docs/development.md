# LOGOS web workspace development

Updated: 2026-11-10. Integrated branch: `Chiang030/logos/web-v0315`.
Integrated release: `v0.3.15`, including web, CLI/domain, and VS Code sources.
The pre-web baseline was `e2bc89f` / `v0.3.14`.

## Current execution policy

The user explicitly requested shared server-account execution. All Agent tasks
run directly as the Linux service account, currently `jiangjincheng` on
`leadhk01`. No per-user Linux identities, bubblewrap namespaces, network
isolation, read-only filesystem mounts or project-only command permissions
are applied. The worker service no longer sets NoNewPrivileges or custom
CPU/memory/process resource caps. The normal operating system account
permissions still apply; tasks are not automatically elevated to root.

The file explorer, project/session lists and their HTTP routes continue to show
the logged-in user's own data. This is application organization, not a boundary
for Agent shell commands: those commands can reach any file or network service
available to the shared Linux account, including other users' directories.

Model configuration is still administrator-managed in the UI. API responses
do not return model keys, and the normal model route uses the per-run broker for
accounting. Since all tasks share the server account, this is not a security
boundary against code that reads server configuration or calls a provider
directly. Only calls through the broker are included in the token ledger.

The previous bubblewrap implementation, installer and isolation tests were
removed from the repository. The previously installed system bwrap copy and
AppArmor profile are unused; no global OS policy was disabled.

## Features

- The browser reuses the extension React App through HostBridge.
- Lark international / Feishu OAuth uses an explicit enterprise and administrator
  allowlist. The pilot uses Lark and a verified real employee account.
- Users select a personal folder to establish a project. The browser supports
  folder/file upload, text/image/PDF preview, downloads and persistent sessions.
- Administrators manage API URL, protocol, encrypted key, enabled models,
  thinking support and context/output limits. Protocols: OpenAI Chat Completions,
  OpenAI Responses and Anthropic Messages.
- Durable tasks queue with at most five active globally, one per user and
  project, and up to ten queued per user. Submission retries are idempotent.
- Streaming task events replay after reconnect. Completed tasks refresh files.
  Absolute links under the project's real server path open as project files.
- Usage is attributed to user/project/session/run/model/configuration version,
  with date/user/model filters, request details and CSV export.
- Input tokens include cache tokens; cache columns are breakdowns. Missing
  provider usage stays unknown rather than being reported as zero.

## Host tools and discovery

The worker imports the server login-shell environment and the optional
`logos-agent/.env`, following the CLI. HOME remains the actual server home.
Per-session Pi configuration and transcripts keep model selection/conversations
separate; they do not restrict filesystem access. Unneeded Lark/web environment
variables are omitted from child environments.

The LOGOS domain extension is explicitly loaded with its software discovery,
simulation, simulation discovery, web search and observability handlers.
The domain skills/prompts are loaded as before. Existing account-level
`~/.pi/agent/mcp.json` (or the source PI_CODING_AGENT_DIR) is copied into the
session profile without removing literal tool configuration. Actual MCP
availability still depends on the account's configured services.

The **服务器工具** button opens the reused plugin software panel. All logged-in
users may run discovery and update the shared executable paths. Discovery uses
the server account, not the browser workstation. Global scanning starts a
background job and the UI polls its status, so a long scan does not depend on
one Cloudflare HTTP request staying open. Scans are deduplicated.

Shared configuration and cache:
```text
<data>/state/software-paths.json
<data>/state/software-cache.json
```

Selected executable wrappers are generated inside each session profile. Their
directory precedes discovered application directories on PATH, so FreeCAD's
bundled gmsh cannot silently override the selected Gmsh installation. Wrappers
preserve arguments and quoted installation paths.

Live discovery found Blender, KiCad, FreeCAD, Gmsh, SolidCraft, Fluent,
Workbench and HFSS. Quick and global discovery now include /srv shared software
installations. The pilot explicitly selects /srv/shared/ansys_inc/v261/fluent/bin/fluent
from ANSYS 2026 R1. Mechanical was not found by the supported executable names. Discovery
is installation evidence, not proof of SDK, license or remote MCP readiness.
The simulation CLI help command and Gmsh 4.15.2 executed successfully.

## Runtime and lifecycle

A separate systemd worker claims jobs transactionally from SQLite WAL.
A flock lock prevents duplicate managers. Worker restart marks previously active
jobs interrupted without replaying them; queued jobs remain eligible.

Each task has a short private Unix socket and an ephemeral loopback TCP proxy.
This preserves central model routing and allows concurrent runs without port
collisions. The broker accepts the selected model/protocol and observes provider
usage. DeepSeek's provider identity is retained for request compatibility.

Cancellation sends Pi's abort command before stopping the runtime. Shutdown
also enumerates descendant process groups, including detached bash tool groups,
and terminates them. The queue slot is released after process shutdown. Requests
are aborted and recorded with known or unknown consumption. Jobs retain the
60-minute task limit. External services or deliberately daemonized processes
are not guaranteed to stop with the task and require their own lifecycle control.

## Files and remaining product limits

Uploads are limited to 64 MiB per file and reject existing names without
overwriting. Folder uploads preserve relative paths. Web file routes use held
directory descriptors and reject traversal/symlinks to keep the explorer scoped
to its user's data. Agent commands are unrestricted by these route checks.

Text previews include line numbers and up to 512 KiB. Markdown/CSV currently
use text preview. Binary formats require download. There is no rich CAD/mesh
preview, editor, user quota, project-deletion UI or automatic backup scheduler.

## Build and tests

Linux and Node.js >=22.19 are required. Node's SQLite experimental warning is
retained. No backend framework or ORM was added.

```sh
export PATH="$HOME/.local/bin:$PATH"
cd logos-agent/vscode-extension
npm ci
cd ../web
npm ci
npm run typecheck
npm test
npm run build
```

The HTTP service runs source TypeScript with --experimental-strip-types;
the browser and worker are compiled by scripts/build.mjs. Rebuild after worker
or UI changes, and drain active tasks before restarting the worker.

Twenty-two tests cover identity/file-route ownership, OAuth/tenant/CSRF, encrypted
model configuration, admin APIs, the five-slot queue, token normalization,
unknown usage, no-overwrite uploads and CSV escaping. New host-runtime coverage:
- Actual Pi calls can read a fixture outside the project and reach host networking.
- LOGOS software/simulation/web-search tools appear in model tool definitions.
- Two real concurrent runtimes use different proxy ports and retain accounting.
- Cancelling both a hanging provider request and a real shell with a sleeping
  child leaves no running test child.
- Shared software path changes are visible to another logged-in user.
- A selected Gmsh executable wins over a fake CAD-bundled version, including
  installation paths containing spaces and apostrophes.

The folder picker commits its path and directory entries together after a successful
read, disables navigation/project creation while loading, and preserves the last
verified location on failure. Browser regression coverage lives in
tests/browser/folder-navigation.mjs: call its default export with a Playwright
Page and a running web origin. It intercepts every /api request (including
mutations), so it does not create live projects or modify user files. It covers
delayed double-clicks, empty-folder project creation, failed navigation/retry and
real same-name nested folders. This case is run with a supplied browser; it is
separate from the Node test suite.

The main file explorer also commits the project, path, and entries together only
after a successful read. Pending navigation blocks stale row clicks and uploads;
failed navigation retains the verified parent, failed refresh requires retry, and
responses from previous projects are ignored. Browser coverage in
`tests/browser/file-navigation.mjs` mocks every API route and checks rapid clicks,
file previews, failed reads/retry, empty and real same-name directories, selecting
the current project again, and project switching during a delayed response.

Initial browser acceptance displayed five installed software categories; after
adding /srv discovery, the server inventory contains eight. A real
DeepSeek task successfully called software_discover and bash, confirmed the
jiangjincheng account and executed Gmsh. Its calls were recorded under the
logged-in user. A subsequent direct runtime-environment check verified the
PATH correction selects Gmsh 4.15.2. Simulated tests use separate databases.

## Configuration and deployment

| Variable | Meaning |
| --- | --- |
| LOGOS_WEB_HOST | Default 127.0.0.1 |
| LOGOS_WEB_PORT | Default 18880; pilot uses 18882 |
| LOGOS_WEB_PUBLIC_URL | Exact public origin, without a subpath |
| LOGOS_WEB_DATA_DIR | Default ~/.local/share/logos-web, outside the checkout |
| LOGOS_WEB_PREVIEW | Default 0; 1 permits loopback static UI preview |
| LOGOS_WEB_IDENTITY_PLATFORM | feishu or lark; pilot uses lark |
| LARK_APP_ID / LARK_APP_SECRET / LARK_TENANT_KEY | Lark application and allowed enterprise |
| FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_TENANT_KEY | Domestic Feishu alternative |
| LOGOS_WEB_ADMIN_OPEN_IDS | Explicit app-scoped open IDs; no first-user promotion |

Environment file: `~/.config/logos-web-pilot/server.env` (mode 0600).
Repository: `/home/jiangjincheng/logos-server-20261009/logos-server`.
Data: `~/.local/share/logos-web-pilot`.

The callback stays `/auth/feishu/callback` for both identity platforms.
Lark uses accounts.larksuite.com authorization and open.larksuite.com token/
profile APIs. The application must be published and available to employees.
Browser login cookies and database sessions last 30 days. An authenticated
bootstrap (opening or refreshing the workbench) renews both for another 30 days.
Expired or logged-out sessions cannot be renewed; admin status refreshes at login. Identity binds
platform/application, tenant and open ID. A second real employee login remains
an operational rollout check.

Services: logos-web-pilot (HTTP), logos-web-worker (tasks), logos-web-ngrok.
The deploy templates use @REPOSITORY@ as an absolute-path placeholder.

```sh
systemctl --user status logos-web-pilot logos-web-worker logos-web-ngrok
journalctl --user -u logos-web-pilot -u logos-web-worker -n 100
```

Previous public pilot: https://outward-speed-alto.ngrok-free.dev/ (retired after NetBird login verification).

See [fixed ngrok deployment](ngrok.md) for the previous endpoint, quota limits,
and restart verification. The Cloudflare notes below describe the retired pilot.

The Quick Tunnel has no automatic restart or boot enable because a restart can
change its hostname and invalidate the OAuth callback. It is a temporary public
HTTPS pilot with enterprise login. A stable domain/named tunnel is needed for
unattended reboot recovery. Preserve the public Host header through proxies.

## Backup and recovery

```text
<data>/state/application.sqlite
<data>/state/model-master.key
<data>/state/software-{paths,cache}.json
<data>/state/sessions/<session-id>/{home,transcripts}/
<data>/users/<user-id>/workspace/<project-folder>/
```

The master key is necessary to decrypt model credentials. For a full consistent
manual backup, drain active tasks, stop HTTP and worker, and copy the entire data
directory plus protected environment/service definitions into a private backup.
Restart HTTP/worker without restarting the Quick Tunnel. Preserve ownership and
the matching key, files and transcripts on restore. Validate login, model
decryption and a controlled task before reopening access.

For a database-only online snapshot use SQLite's backup API, not a copy of only
the live main DB. A pre-runtime snapshot is under the pilot backups directory.
No automated backup scheduler or restore drill is claimed.

## Local service recovery on 2026-11-10

The old pilot port 18881 was occupied by another service. LOGOS now listens on
127.0.0.1:18882. The HTTP and task units are enabled under the account user
manager, with lingering already enabled and Restart=on-failure. Local bootstrap
responds successfully and reports the task worker ready. The old Quick Tunnel
is inactive. The fixed ngrok endpoint now targets port 18882, and its Lark
callback has been added by the administrator. Persistent-login tests pass;
a real browser session should retain login when refreshed on that domain.

## Project/study/run layout

See [workspace layout](workspace-layout.md) for initialization, study configuration,
input snapshots, execution records, browser behavior, and legacy compatibility.
The shared project_workspace tool is loaded with the LOGOS domain extension.

## NetBird deployment (current)

The active workbench is http://10.250.179.176:18882, bound only to the existing
NetBird interface on leadhk01. The administrator confirmed the replacement
Lark callback and access. Users must connect to NetBird. The shared data and
worker remain unchanged; login persists for 30 days and renews on bootstrap.

The enabled user services are `logos-web-netbird` and `logos-web-worker`.
The HTTP service reads `~/.config/logos-web-pilot/netbird.env` (0600).
`logos-web-pilot` and `logos-web-ngrok` are stopped and disabled; their protected
configuration remains available for rollback. See [NetBird setup](netbird.md).

The system service `logos-ansys-license` is enabled and runs as the existing
installation owner. Both `lmgrd` and `ansyslmd` reported UP after stale,
unheld lock files were preserved under backup names. License files were not
modified. A licensed solver computation has not been claimed by this check.
