# Web search timeout repair (0.3.12)

## Cause and behavior

On the affected Windows host, direct HTTPS connections to
`html.duckduckgo.com` timed out. There was no active Windows system proxy,
proxy environment variable, or VS Code `http.proxy`. The previous tool had
only one search provider, so every search on this connection failed.

DuckDuckGo remains the default. A network failure or timeout now permits a
Bing RSS attempt, within one 15-second request budget. The first provider
gets at most six seconds. Both providers share the configured proxy.
Results identify the actual source and include the reason for fallback.
Cancellation, CAPTCHA, rate limits, denied access, and malformed responses
do not trigger fallback. Failure details identify each attempted provider.
No credentials, proxy settings, or offline startup settings were changed.

## Verification

- Domain regression suite: 19 passed, including 13 web-search tests.
  Covers fallback, query preservation, cancellation, total timeout, proxy
  routing to both providers, rate limits, challenges, safe redirects,
  malformed feeds, response limits, and redaction of invalid proxy values.
- Extension compilation and type checking passed.
- Windows runtime preparation and integrity verification passed.
- Full Windows runtime smoke passed: discovery, bundled tools, reasoning
  request parameter, streaming, session switching, and a full process
  restart with prior context.
- `scripts/smoke-web-search.mjs --live` launches the bundled Node and Pi RPC
  runtime with the bundled LOGOS extension. A local model fixture requests
  the real search tool, receives its result, and completes the conversation.
  It uses an isolated profile and no live model credentials.
- The exact reported query, `北京天气 今天 2026年10月31日`, returned five Bing
  results after DuckDuckGo timed out. The full RPC turn took 10,449 ms,
  including model/tool dispatch and continuation. Source-level search alone
  took approximately 6.6 seconds in a separate live check.
- The refined query, `"北京" "天气" "2026年10月31日"`, returned five results
  including dated weather pages. The full RPC turn took 10,646 ms.

The original broad query returned mostly general Beijing pages. The tool
preserves queries rather than silently rewriting them; its description
instructs the agent to refine irrelevant queries and verify dates. Finding
weather pages is not independent verification of their weather claims.
Live results and provider availability may change. This repair was tested
on Windows; no Linux host or browser CAPTCHA flow was exercised.

Local detailed logs are in `pi-domain/test-web-search-fix.log` and
`vscode-extension/{build,prepare,verify,smoke-runtime}-web-search-fix.log`,
plus `vscode-extension/smoke-web-search-{live,refined}.log`.

## Local delivery

- Standard VSCE packaging passed: Windows x64, 7,321 files, 127.06 MB.
- Artifact: `vscode-extension/logos-vscode-win32-x64-0.3.12.vsix`.
- SHA-256: `D6A48B8A0C7D8232FC16EF2B7E5B14517B6528AA6C1B8DB80B2876D5E41A1942`.
- Package version and SHA-256 hashes of the host, UI, bundled domain extension,
  and payload manifest match the tested build.
- Installed into the normal Windows VS Code profile. Its extension registry
  selects 0.3.12, and all four installed files match the tested build.
  Installation log: `vscode-extension/install-web-search-fix.log`.
- Existing windows need `Developer: Reload Window` to activate this version.
  The active window was not forcibly reloaded.
- This report records validation before publication; see the GitHub release
  for distribution status.
