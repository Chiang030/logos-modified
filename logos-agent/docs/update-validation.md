# Automatic update repair validation — 2026-10-31

The updater repair is packaged as 0.3.10 and installed in the normal Windows VS Code profile. This report records validation before publication; see the GitHub release for distribution status. The published 0.3.9 VSIX used in the earlier smoke runs below is the installation target, not an artifact containing this repair.

## Observed failure

The normal Windows profile was running LOGOS 0.3.8 with `logos.update.feedUrl` set to an unavailable local test server, `http://127.0.0.1:4890/api`. The old updater suppressed the network failure and still advanced its 24-hour check timestamp. It also checked only at activation. The profile's feed setting was restored to the public GitHub mirror after backing up settings; at that stage, the normal extension installation was not changed.

## Repair

- Show check, download, failure and installation state in the status bar and a dedicated LOGOS Updates output channel. Settings includes check and log actions.
- Check after startup and periodically while the window stays open. Cache only successful checks for one hour, scoped to feed and installed version; failed checks remain eligible at the next five-minute tick. Configuration changes trigger a fresh check.
- Download anonymously from the public release URL, show byte progress, retry interrupted transfers up to twice, and verify size, ZIP signature and published SHA-256 before installation.
- Install through the current VS Code window's extension command. Report completion and offer reload without waiting for that choice to persist check success.

## Evidence

- `npm run compile` passed, including TypeScript checking and both bundles. Existing Browserslist age notice remains.
- `npm test` passed: 106 tests in 18 files. Updater tests cover failed checks, periodic checks, disabled automation/manual checks, changed feeds, overlapping requests, installation failure, checksum rejection and interrupted downloads.
- `scripts/smoke-update.mjs` runs the current updater in an isolated Windows extension host, simulating installed version 0.3.8 and installing the real 0.3.9 VSIX. It verifies the isolated extension registry after installation.
- Public-feed run: `%TEMP%/logos-update-smoke-6eWPV3`. Found 0.3.9 at 03:39:26 UTC; first download failed at 03:42:02; periodic check retried at 03:44:23; real installation finished at 03:45:14. This run predates the additional immediate transport retries and byte-progress reporting.
- Final-source local HTTP fixture run: `%TEMP%/logos-update-smoke-GUHLOs`. Download, checksum validation and real VS Code installation completed at 03:47:20 UTC. The interrupted-transfer regression test covers the final immediate retry behavior.

Both earlier smoke runs used separate user-data and extension directories. They establish Windows automatic discovery/download/installation. Native Linux update installation, remote extension hosts and private-feed installation were not exercised. No new repair package was published by this validation.

## Normal-profile installation follow-up

The user still had 0.3.8 installed after the feed-setting repair. The source changes had not reached the normal installation, so its old updater and throttle remained active.

- Bumped the extension and lockfile version to 0.3.10. Rebuilt both bundles, verified the Windows payload and passed the native runtime smoke (including restored model context).
- Standard `vsce package --target win32-x64` completed successfully, including its package scan: 7,317 files, 127.06 MB. The packaged host and UI hashes match the current build.
- Artifact: `vscode-extension/logos-vscode-win32-x64-0.3.10.vsix`; SHA-256 `4299D25BBA36A1209C7A45FFFA218765A5A473AE3EB47C25AC29D9C152DCF2D8`.
- Installed with the normal `Code` user-data directory and `.vscode/extensions` directory. The extension registry selects 0.3.10 and its installed host bundle hash matches the repair build. Evidence: `vscode-extension/install-update-normal.log`.
- A new normal-profile empty window activated LOGOS through `onStartupFinished`. Its log records checking v0.3.10 against the public feed at 12:29:06 China time and success at 12:29:07 on 2026-10-31. No newer stable package was available. Evidence: `%APPDATA%/Code/logs/20261031T121454/window3/exthost/output_logging_20261031T122858/1-LOGOS Updates.log`.
- The first temporary-workspace window did not activate LOGOS, so it was not counted as a successful startup check. The subsequent empty-window check used `--disable-workspace-trust` for validation. The original working window was not forcibly reloaded; it needs a reload to replace its already loaded 0.3.8 code.

Run from `logos-agent/vscode-extension`:

```powershell
node scripts/smoke-update.mjs --code 'D:/Microsoft VS Code/Code.exe' --asset logos-vscode-win32-x64-0.3.9.vsix
node scripts/smoke-update.mjs --code 'D:/Microsoft VS Code/Code.exe' --asset logos-vscode-win32-x64-0.3.9.vsix --live
```
