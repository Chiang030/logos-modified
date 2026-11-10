# Administrator ChatGPT account

The management page supports a central ChatGPT authorization in addition to
API keys. Only a logged-in LOGOS administrator may start, complete, cancel or
remove this authorization. Normal employees keep using Lark/Feishu login, and
model requests continue through the existing per-user usage broker.

In **管理后台 → 模型 API**, choose **ChatGPT 账号连接**, or edit an existing
connection and change **身份验证** to **ChatGPT 账号授权**. Click **登录 ChatGPT**,
open the authorization page, and complete the account's sign-in and consent.
Copy the complete final `http://127.0.0.1:1455/auth/callback?...` URL from the
browser into the management page and click **完成账号连接**. On a remote-server
deployment, the browser may show a local connection error on that final page;
the address can still be copied. Keep this one-time authorization URL private.

This uses the extension's existing PKCE/state-validated OpenAI authorization
implementation. The server-side loopback listener is never exposed publicly.
The callback is bound to its initiating LOGOS administrator and expires after
ten minutes. Replayed or mismatched callbacks are rejected. No OpenAI password
is entered in LOGOS.

After login, retrieve the account's available models and save the connection.
Model IDs come from the authenticated official model list, intersected with
the runtime's supported Responses chat models. The administrator controls the
final enabled list, context window, output limit and reasoning capability.
Select the saved connection/model in the workbench before sending a message.
Account authorization is fixed to `https://api.openai.com/v1` with Responses;
it cannot be redirected to a third-party endpoint.

Access and refresh credentials are encrypted with the existing model master
key in the application database and are never returned in web APIs. An expired
credential refreshes on demand; a database lease serializes token rotation
across the HTTP and task services. Logout or replacement cannot be undone by
an older in-flight refresh. Authentication failures require administrator
sign-in again; transient network failures retain the stored credential.

Build the web package before starting it: `npm run build` also bundles the
extension authorization adapter into `dist/openai-auth.mjs`. Deploy the source
and rebuilt worker together. If OpenAI requires the deployment's existing
egress proxy, set `LOGOS_WEB_OPENAI_PROXY` in both protected HTTP and worker
environment files. TLS certificate verification remains enabled. This uses
the existing domain package's Undici dependency; no dependency was added.

The usage ledger records provider-reported token counts per LOGOS user. It is
not the provider's billing or subscription dashboard, and missing usage stays
unknown. Account access and available models must be verified after real
authorization. Official sign-in documentation:
https://developers.openai.com/codex/auth/ .
