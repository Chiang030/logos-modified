# LOGOS web workspace development

Updated: 2026-11-07. Server branch: `Chiang030/web/workspace`.
Core baseline: `e2bc89f` / `v0.3.14`; no core or extension release bump.

## Delivered behavior

The browser reuses the extension React App through HostBridge. Its surrounding
workspace adds personal folders, project selection, uploads, file previews,
conversation history and an administrator console.

- Lark international / Feishu OAuth with explicit enterprise and administrator
  identities. The live pilot uses Lark and has passed one real employee login.
- Users access only their own projects, files, sessions, task events and runs.
  The browser and arbitrary Agent code both enforce this separation.
- Administrators configure API URL, protocol, encrypted key, models, context,
  output limit, thinking availability and enabled state. Supported protocols:
  OpenAI Chat Completions, OpenAI Responses and Anthropic Messages.
- Model keys stay on the server. Ordinary users get enabled model descriptors,
  without API addresses or keys. Changing an address requires a fresh key.
- Durable tasks run real Pi read/write/edit/bash tools in a Linux namespace.
  Maximum five running tasks globally, one per user and project. Additional
  tasks queue; each user may have up to ten queued tasks. A session accepts
  only one unfinished task. Task submission retries use an idempotency key.
- The browser replays durable streaming events after reconnect or refresh.
  Task completion refreshes the file browser. Cancellation stops the child
  process group and active provider requests before releasing its slot.
- Every upstream generation request is attributed to user/project/session/run,
  model connection and configuration version. Reports filter by Beijing dates,
  user and model, and export CSV. Inputs include cache tokens; cache columns
  are breakdowns, not additional consumption. Missing usage stays unknown.

## Architecture and security boundaries

The HTTP server uses Node HTTP and SQLite WAL. A separate worker claims tasks
transactionally, publishes a heartbeat and limits concurrency. Its systemd unit
uses flock to prevent duplicate managers. Worker restart marks previously active
runs interrupted without replaying them; queued tasks remain eligible.

Each task uses a root-owned bubblewrap launcher with a dedicated AppArmor
user-namespace profile. This does not disable global AppArmor restrictions.
The sandbox has separate PID, mount and network namespaces, a cleared environment,
read-only system/Pi/domain files, and writable mounts only for its project and
session home/transcripts. Host user directories, web configuration and accounting
data are not mounted. Agent code receives a dummy model key.

The only external channel is a private per-run Unix socket. A loopback proxy
inside the sandbox connects it to a host broker, which accepts only the selected
model and protocol endpoint, injects the real key and records upstream usage.
Socket directories use short random paths under the system temporary directory,
independent of potentially long data-directory paths, and are removed after runs.
DeepSeek's native provider identity is retained when its official endpoint is
proxied, preserving its developer-role, token-limit and thinking compatibility.

The worker unit limits all tasks together to 8 CPU cores, 12 GiB memory and
512 processes/threads. Each task has a 60-minute limit and numerical-library
thread defaults of four. These are aggregate service limits, not per-user quotas.
The host service account remains trusted; this is not isolation from server admins.

## File behavior and current limits

Personal folders must be selected before creating projects; nested overlapping
projects are rejected. Uploads preserve relative paths and reject existing files
without overwriting. Maximum upload size is 64 MiB per file. Files are opened
through held directory descriptors with symlink/path traversal checks.

Text preview includes line numbers and up to 512 KiB; image/PDF preview and
downloads are available. Binary formats require download. Markdown/CSV currently
use text preview. There is no rich CAD/mesh preview, editor, user quota, project
deletion, automatic backup scheduler or upload overwrite/retry UI.

The sandbox currently exposes core file/shell tools and domain skills/prompts.
Host solver installations outside the mounted system directories, external MCP
services, web browsing/search and license servers are not integrated. They need
explicit isolated mounts or brokered services before they can be used safely.
This release does not claim complete parity with every local extension tool.

## Build and verification

Linux and Node.js 22.23.3 are required. File operations rely on Linux /proc/self/fd.
Node's SQLite experimental warning is retained. No backend framework or ORM was
added. React, esbuild, TypeScript and Tailwind reuse the extension toolchain.

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

The HTTP server runs source TypeScript with --experimental-strip-types.
The worker and browser are compiled by scripts/build.mjs. Build after changing
worker or browser code. Restart only the affected service; drain active tasks
before restarting the worker.

The 12 web tests cover encryption, owner/admin/CSRF checks, path escapes,
no-overwrite/interrupted uploads, OAuth success/error/tenant handling, durable
ownership, the five-slot queue, idempotency, token semantics and CSV escaping.
Integration tests run real bubblewrap and Pi against a local simulated provider,
including file creation, follow-up context, cancellation, long data paths,
foreign files, host networking, environment and system-write rejection.
Sandbox tests skip when the administrator installation is absent; inspect skips.

Browser acceptance used a separate loopback-only fixture: administrator model
save/list test, task submission, real Pi file writing, automatic file refresh,
preview, restored chat after refresh, and a report/CSV with two requests and
32 tokens. Simulated usage was never inserted into the pilot database.

Live acceptance verified Lark login, existing GPT provider consumption and a
DeepSeek response through the isolated worker and broker. The dedicated
"网页联调验收" project retains its real requests, including an initial HTTP 422
failure and the successful compatibility-fix retry (3,758 input, 5 output).
Failed requests with no provider usage remain visible as unknown.

## Configuration

| Variable | Meaning |
| --- | --- |
| LOGOS_WEB_HOST | Default 127.0.0.1 |
| LOGOS_WEB_PORT | Default 18880; pilot uses 18881 |
| LOGOS_WEB_PUBLIC_URL | Exact public origin, without a subpath |
| LOGOS_WEB_DATA_DIR | Default ~/.local/share/logos-web, outside the checkout |
| LOGOS_WEB_PREVIEW | Default 0; 1 permits only loopback static UI preview |
| LOGOS_WEB_IDENTITY_PLATFORM | feishu or lark; pilot uses lark |
| LARK_APP_ID / LARK_APP_SECRET / LARK_TENANT_KEY | Lark application and allowed enterprise |
| FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_TENANT_KEY | Domestic Feishu alternative |
| LOGOS_WEB_ADMIN_OPEN_IDS | Explicit app-scoped employee open IDs; no first-user promotion |

Keep secrets in a mode-0600 environment file. Public HTTPS enables Secure
cookies; cookies are HttpOnly and SameSite. Mutations require matching Origin
and CSRF. A reverse proxy must preserve the configured public Host.
Login sessions expire after 12 hours. Identity binds platform/application,
tenant and open ID; changing applications requires a separate identity migration.
Administrator status refreshes on login. One real employee login is verified;
a second real employee acceptance session remains an operational rollout check.

The callback path stays `/auth/feishu/callback` for both platforms. It does not
select the identity platform. Lark uses accounts.larksuite.com authorization
and open.larksuite.com token/profile APIs; string and numeric zero success codes
are supported. The application must be published and available to employees.
The pilot enterprise key was verified through tenant/v2/tenant/query after the
administrator enabled tenant:tenant:readonly.

## Pilot deployment

Active repository:
`/home/jiangjincheng/logos-server-20261009/logos-server`

Protected environment:
`~/.config/logos-web-pilot/server.env`

Data:
`~/.local/share/logos-web-pilot`

Services:
- logos-web-pilot.service: HTTP on 127.0.0.1:18881.
- logos-web-worker.service: isolated task manager.
- logos-web-tunnel.service: Cloudflare Quick Tunnel.

The service templates in deploy/ use @REPOSITORY@ as an absolute-path placeholder.
Install the narrowly scoped launcher with:
`sudo bash logos-agent/web/scripts/install-sandbox.sh`.

The current temporary URL is:
https://clause-daisy-solutions-rachel.trycloudflare.com/

The backend and worker are supervised. The Quick Tunnel deliberately has no
automatic restart or boot enable, because restarting it can change the hostname
and invalidate the registered OAuth callback. This is a temporary internet-facing
pilot with enterprise login, not a permanent intranet deployment. A stable domain
or named tunnel is required for a durable callback and unattended reboot recovery.

```sh
systemctl --user status logos-web-pilot logos-web-worker logos-web-tunnel
journalctl --user -u logos-web-pilot -u logos-web-worker -n 100
```

Do not print the protected environment, decrypted API keys or authentication
cookies into logs. The model-list check only checks listing; an actual generation
is required to verify a model ID and generation protocol.

## Persistence, backup and recovery

```text
<data>/state/application.sqlite
<data>/state/model-master.key
<data>/state/sessions/<session-id>/{home,transcripts}/
<data>/users/<user-id>/workspace/<project-folder>/
```

SQLite stores identities, auth, projects, conversations, queued/running jobs,
replayable events, encrypted model connections and request-level usage.
The master key is necessary to decrypt model credentials. Never back up the
database without also preserving that key securely.

For a full consistent manual backup:
1. Let active tasks finish, then stop the worker and HTTP service.
2. Copy the entire data directory (including SQLite WAL/SHM if present),
   the protected environment and service definitions into a private backup.
3. Restart HTTP and worker; leave the live Quick Tunnel untouched.
4. Store an off-host encrypted copy according to company policy.

For a database-only online snapshot, use SQLite's backup API rather than copying
only the live main database file. A pre-runtime snapshot is retained under the
pilot backups directory. Restore with both writers stopped, preserve ownership
and restrictive permissions, and restore the matching master key, user files
and session transcripts. Validate login, model decryption and a controlled task
before reopening access. No automated backup or restore drill is claimed.
