# LOGOS web workspace development

Updated: 2026-11-07. Server branch: `Chiang030/web/workspace`.
Baseline: `e2bc89f` / `v0.3.14`; core and extension versions are unchanged.
This is a development milestone, not a deployable multi-user Agent service.

## Implementation status

| Area | Implemented | Still required |
| --- | --- | --- |
| Shared interface | Browser imports extension App through HostBridge; sidebar and preview | Live runtime interactions |
| Identity | Feishu/Lark OAuth, tenant check, hashed sessions, one-use state, CSRF; one real Lark account verified | Real second-account isolation and logout/relogin acceptance |
| Projects | Personal folders, folder-based projects, duplicate/overlap checks | Recent-project restoration and lifecycle controls |
| Files | Browse/filter, mkdir, file/folder upload, download, text/image/PDF preview, copy relative path | Rich previews, retry/overwrite choices, quotas and configurable limits |
| Conversations | Persistent empty conversation records and titles | Messages, transcripts and runtime recovery |
| Execution | Explicit rejection before accepting a prompt | Isolation, Pi RPC, streaming, queue, cancellation and recovery |
| Administration | Configured administrator identity flag | Central model configuration and per-user token ledger/reports |
| Deployment | Loopback development server | HTTPS, supervision and backup/restore |

Text previews show line numbers, limited to 512 KiB. Binary files require download.
Syntax highlighting, Markdown rendering, CSV tables, text search, large-log
paging, preview tabs and resizing are not implemented. Single explicit byte-range
downloads are supported. Uploads are limited to 64 MiB per file; existing files
are rejected rather than overwritten. The indicator counts files, not bytes.
Folder upload preserves relative file paths, not empty folders or local permissions.

## Setup

Supported environment: Linux with Node.js 22.23.3 and npm. File handling relies on
Linux `/proc/self/fd`. Node 22's built-in SQLite is experimental; its warning is
retained. Validate the runtime before production deployment.

From the repository root:

```sh
export PATH="$HOME/.local/bin:$PATH"
cd logos-agent/vscode-extension
npm ci
cd ../web
npm ci
npm run typecheck
npm test
npm run build
npm start
```

The build imports extension components and its existing Tailwind toolchain.
React, React DOM, TypeScript and esbuild reuse the extension's ecosystem; resolved
versions are pinned in the lockfile. No backend framework, ORM or native SQLite
package was added. The backend uses Node HTTP, filesystem, crypto and SQLite.

Start from `logos-agent/web`. TypeScript executes with
`--experimental-strip-types`. Rebuild after UI edits; restart after backend edits.

| Variable | Default / meaning |
| --- | --- |
| `LOGOS_WEB_HOST` | `127.0.0.1` |
| `LOGOS_WEB_PORT` | `18880` |
| `LOGOS_WEB_PUBLIC_URL` | `http://127.0.0.1:<port>`; exact origin without subpath |
| `LOGOS_WEB_DATA_DIR` | `~/.local/share/logos-web`; outside the checkout |
| `LOGOS_WEB_PREVIEW` | `0`; `1` enables static loopback-only sample UI |
| `LOGOS_WEB_IDENTITY_PLATFORM` | `feishu` (default) or `lark`; pilot uses `lark` |
| `FEISHU_APP_ID` | Required for Feishu login |
| `FEISHU_APP_SECRET` | Required server-side secret |
| `FEISHU_TENANT_KEY` | Required allowed Feishu enterprise |
| `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_TENANT_KEY` | Required instead of FEISHU credentials when platform is `lark` |
| `LOGOS_WEB_ADMIN_OPEN_IDS` | Comma-separated app-scoped Feishu open IDs; no automatic first-user admin |

Use a protected server environment file for secrets. Never place them in source,
frontend bundles or shared command history. A reverse proxy must preserve the
public Host header. Mutations require the configured Origin and CSRF token.
HTTPS public URLs enable Secure cookies; direct TLS termination is not implemented.

## Read-only preview

```sh
LOGOS_WEB_PREVIEW=1 \
LOGOS_WEB_DATA_DIR="$HOME/.local/state/logos-web-development/data" \
npm start
```

Open `http://127.0.0.1:18880/?preview=1`. From a workstation:

```sh
ssh -N -L 127.0.0.1:18880:127.0.0.1:18880 leadhk01
```

The sample UI cannot authenticate, upload, read server workspace data or call a
model. Real APIs still require login. There is no development-login HTTP endpoint.
The current development process uses
`~/.local/state/logos-web-development/server.pid` and `server.log`.
Verify its command and working directory before stopping it. These files are
development conventions, not service supervision.

## Feishu handoff

A company administrator must create/publish an enterprise application, enable
the chosen web OAuth identity flow, approve its identity permissions and employee
availability, then configure:

```text
<LOGOS_WEB_PUBLIC_URL>/auth/feishu/callback
```

Current code targets:

- `https://accounts.feishu.cn/open-apis/authen/v1/authorize`
- `https://open.feishu.cn/open-apis/authen/v2/oauth/token`
- `https://open.feishu.cn/open-apis/authen/v1/user_info`

These endpoints and payloads have only been tested using mocked responses.
Verify current documentation, scopes, callback restrictions and returned
`tenant_key` with a real enterprise application. The `feishuReady` flag only
means configuration is present; it does not prove connectivity or valid credentials.

Identity binds app + tenant + open_id, not display name. Changing applications
may change identity; migration is not implemented. Sessions expire after 12 hours.
Admin status refreshes at login; immediate revocation and disabled-user policy
remain deployment work. Use two accounts to test login/logout, expired/replayed
state, enterprise mismatch and inaccessible foreign files/projects.
Browsers must reach the intranet callback and the server must reach Feishu HTTPS.

## Agent isolation blocker

bubblewrap 0.9.0 is installed. The kernel enables unprivileged user namespaces,
but AppArmor restricts them. Actual probes failed:

- Full namespace isolation: `loopback: Failed RTM_NEWADDR: Operation not permitted`.
- Without the network namespace: `setting up uid map: Permission denied`.

Repeat with `bash scripts/check-isolation.sh`. The current service account cannot
provision a policy with passwordless sudo. An administrator must provide a scoped
execution mechanism, such as a suitable AppArmor policy or isolated Linux
identities/containers. Do not disable global protections or run Agents as
unrestricted shared-host processes.

Passing a namespace probe is only the first check. Verify read/write/bash/Python
and delegated tool services cannot reach other users, model secrets or service
state. Validate solver mounts, license connectivity, child-process cancellation
and CPU/memory limits. Host-reading MCP/tool services need the same isolation.

HTTP file ownership and symlink checks do not establish arbitrary-code isolation.
`chat/send` returns 503 without saving the prompt or invoking a model.
No model key is passed to an Agent; there is no unsafe execution override.

## Persistence and verification

Current storage:

```text
<data>/state/application.sqlite
<data>/users/<internal-user-id>/workspace/<project-folder>/
```

SQLite contains identities, auth sessions, OAuth states, projects and conversation
metadata, not task events or usage. It uses WAL. The initial schema is version 1;
future changes require explicit migrations. Use a SQLite backup API or stop
writers and back up consistent database state; do not copy only the live main DB.
Backup/restore automation is not yet provided.

```sh
cd logos-agent/web
npm run typecheck
npm test
npm run build
cd ../vscode-extension
npm run compile
npm test
```

Six web tests cover persistent ownership, mocked OAuth checks, traversal/symlink
rejection, upload no-overwrite/limits/interruption cleanup, and real HTTP auth,
CSRF, project/file/session behavior and blocked execution.

Browser acceptance exercised folder/project creation, UTF-8 upload/preview,
conversation persistence after refresh, blocked submission and logout/API denial.
This used a disposable identity inserted into the development DB, not real Feishu
authentication. Its session was logged out. Sample UI screenshots are separate.

Next: validate execution isolation; integrate Pi worker, persistent queue
(maximum five tasks), streaming and cancellation; build central model settings
and an idempotent request-level usage ledger; finish rich file interactions;
then real Feishu and HTTPS deployment acceptance. Failed model calls without
usage must remain unknown, not zero. Queue/accounting are not delivered here.

## Lark international application (2026-11-07)

The user confirmed that the application was created in open.larksuite.com.
The pilot uses LOGOS_WEB_IDENTITY_PLATFORM=lark and the LARK_APP_ID,
LARK_APP_SECRET and LARK_TENANT_KEY environment variables. Configure credentials
in ~/.config/logos-web-pilot/server.env (mode 0600), outside the repository.
The callback remains /auth/feishu/callback for compatibility with the URL already
registered in the application; its path does not choose the identity platform.

The provider's official documentation was reviewed:
- Authorization: https://open.larksuite.com/document/common-capabilities/sso/api/obtain-oauth-code
- Token exchange: https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token
- User profile: https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get

Lark uses accounts.larksuite.com for authorization and open.larksuite.com for
token/profile calls. Token success may contain code as the string "0", not
only the number 0. Both are accepted; upstream failures and foreign tenants are
rejected. Lark identities have a separate namespace, preserving existing Feishu
identity keys. User-facing login labels follow the configured platform.

Lark credentials never fall back to Feishu credentials. Both providers still
require an explicit enterprise tenant key before enabling login. To obtain it,
the application administrator can authorize the official user_info API debug
tool with a user_access_token and copy data.tenant_key from their own account's
response. Do not paste access tokens into chat or the web configuration file.

The application must be published/approved and available to the test users.
Current tests use simulated OAuth responses, including string/numeric success,
upstream failure and enterprise mismatch. They do not prove a real Lark login.


## Live Lark login acceptance (2026-11-07)

After the application administrator enabled tenant:tenant:readonly, the server
successfully called the official tenant information API using the application's
tenant_access_token. The returned tenant_key was saved in the protected pilot
environment file. No token or application secret was stored in this repository.

The pilot backend was restarted without restarting the Cloudflare tunnel.
Verified the authorization redirect, exact configured callback, correct app ID,
state parameter and Secure/HttpOnly OAuth cookie. The browser reached the Lark
authorization page and returned to the workspace. A real application session
was established; /api/bootstrap reported an authenticated Lark identity, and
the current user's /api/projects and /api/files returned 200 with empty lists.
The first login retained the ordinary user role; no administrator was inferred
from login order. No sample project or file was created in the real user space.

This verifies a single real Lark login, not a two-user acceptance test, token
accounting or Agent execution. The browser remains logged in for the user.
The temporary HTTPS hostname still depends on the running Quick Tunnel process.
