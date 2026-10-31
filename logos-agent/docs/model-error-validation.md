# Account-limit retry repair — 0.3.11

The reported response was `429: {"code":"1113","message":"余额不足或无可用资源包,请充值。"}`. The pinned runtime recognized the HTTP 429 as retryable but did not recognize this localized account-limit message. Its three retries produced four assistant error replies for one user prompt.

The LOGOS domain extension now uses Pi's supported `message_end` replacement hook to normalize known account-exhaustion errors to its existing `insufficient_quota` classification. It preserves the complete provider error and finalized message content. This runs before persistence and retry classification, so no retry is scheduled and the failed response remains available when restoring the session. Successful messages, tool results and temporary rate-limit errors are not reclassified.

The extension displays an explanation to recharge, activate a resource package or switch the model connection. Model failures no longer mark the run settled while the runtime may still be performing recovery; the actual `agent_settled` event determines completion and preserves a failed outcome.

## Validation

- Extension tests: 109 passed across 19 files, including localized/numeric quota errors, ordinary rate limits, message-content preservation, normalization idempotence and frontend failure settlement.
- TypeScript checking and host/webview builds passed.
- `node scripts/smoke-model-errors.mjs --baseline` reproduced four HTTP requests and four error replies for one prompt against a local HTTP 429 endpoint.
- `node scripts/smoke-model-errors.mjs --bundled-domain` exercised the actual bundled Pi process and complete bundled LOGOS extension: one HTTP request, one error reply, no scheduled retry, failure preserved after switching away and restoring the session, transient 429 recovery on the second request, and a successful later prompt.
- Windows runtime verification passed for the updated payload, including the unchanged simulation runtime. The pinned Pi source was not modified; no new dependency was added.

The request fixtures use no live provider credentials and incur no model charges. They verify retry and presentation behavior, not the account balance. The provider still requires a funded account or a different available connection to answer normally. Native Linux installation has not been exercised for this repair.

Logs are local artifacts under `logos-agent/vscode-extension`: `test-model-errors.log`, `build-model-errors.log`, `prepare-model-errors.log`, `verify-model-errors.log`, and `smoke-model-errors.log`.

## Local delivery

Standard VSCE packaging completed for Windows x64: 7,320 files, 127.06 MB. The VSIX host, UI, bundled domain extension and payload manifest hashes match the tested build.

- Artifact: `vscode-extension/logos-vscode-win32-x64-0.3.11.vsix`.
- SHA-256: `656BF040AF585CE0CACC66C739254BACCA78D7C7F1621A5DE626C7E61A30864C`.
- Installed into the normal Windows VS Code profile. Its extension registry selects 0.3.11, and the installed host, bundled domain extension and payload manifest hashes match the tested build. Log: `vscode-extension/install-model-errors.log`.
- Existing windows need `Developer: Reload Window` to activate the repair. The user's active window was not forcibly reloaded, and no live model request was sent with their credentials.
- This report records local validation before publication; see the GitHub release for distribution status.
