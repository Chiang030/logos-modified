# LOGOS VS Code extension

A standalone LOGOS package for VS Code 1.90 or newer, built per platform:
`win32-x64`, `linux-x64`, and `linux-arm64`. The VSIX includes the Pi core,
Node.js, LOGOS system prompts, skills, and domain extension. The win32-x64 and
linux-x64 packages additionally bundle the sim simulation backend (relocatable
Python with the sim packages installed), so the simulation tools need no local
Python. No separate Pi, Node.js, or LOGOS checkout is needed.

## Installation and configuration

Install the VSIX matching your platform (for example
`logos-vscode-linux-x64-0.3.0.vsix`, or `logos-vscode-win32-x64-0.3.0.vsix`
on local Windows), open a project folder, and run
**LOGOS: Open Chat**. Open the gear button to configure the API URL and API key,
fetch upstream models, select a model, and click **保存并应用**. Model IDs can also
be entered manually. The panel supports system and appended prompts, bundled
skills, and additional skill directories.

The extension uses its own local configuration and VS Code SecretStorage for
API keys. It does not import Pi profiles, inherited provider keys, project `.env`
files, or automatically discovered Pi extensions and skills. Workspace AGENTS.md
instructions remain available as project context.

The installed extension contains `runtime/vendor` and `runtime/logos-agent`.
On first activation the payload is materialized under VS Code's LOGOS global
storage `installations/<payload-hash>/`, containing `vendor/pi`, `vendor/node`,
and `logos-agent/pi-domain`; win32-x64 and linux-x64 payloads additionally
contain `logos-agent/integrations/.venv`, the bundled sim backend. Persistent
connection and prompt configuration is in global storage
`logos-agent/config/connection.json`. Per-workspace runtime profiles and
conversations use workspace storage. Actual configuration and Logos paths are
shown in the settings panel. Updates preserve saved settings.

Only the configured model API is contacted for inference and model discovery.
Engineering solver executables and their licenses are not included. On win32-x64
and linux-x64 the simulation tools run the bundled backend by default; linux-arm64
payloads bundle no backend (simparse publishes no aarch64 wheel), so those hosts
need a repository install or `LOGOS_SIM_COMMAND`/`sim` on PATH.

The runtime resolves Node.js in this order: the `logos.nodeExecutable` setting
(absolute path to a Node.js ≥ 22.19.0 executable — use it when the remote
host's Node, for example one installed via nvm, is not on the extension host
PATH), then a qualifying `node` found on PATH, then the bundled runtime for
the package's platform.

## Updates

From v0.2.0 the extension checks its release channel for newer VSIX builds:
silently on startup (at most once every 24 hours) and on demand via
**LOGOS: Check for Updates**. When a newer version is found it offers a
one-click download and install through the `code` CLI, then asks to reload
the window. Versions up to and including v0.1.7 have no updater inside;
install the current VSIX once manually.

The default feed is the public `Chiang030/logos-modified` mirror, so update
checks and downloads work without any GitHub authorization. Point
`logos.update.feedUrl` at another repository (for example the private
`Lead-Intelligent/logos` source releases) to switch channels; a private feed
needs a GitHub sign-in (prompted on the first manual check) or a fine-grained
PAT with Contents read access (**LOGOS: Set Update Token**). Settings:

- `logos.update.feedUrl` — GitHub API base URL; point it at an internal mirror
  that serves GitHub-shaped releases JSON to bypass GitHub entirely.
- `logos.update.autoCheck` — disable the silent startup check.

Note: the check uses direct HTTPS and ignores VS Code's `http.proxy` setting;
proxied machines should use an internal feed URL instead.

## Publishing a release

The publish script attaches the VSIX to the release of the given tag on
`Lead-Intelligent/logos` (creating the release if needed, replacing a
same-named asset). `vsce` names the package `logos-vscode-<platform>-<version>.vsix`
by default; the updater accepts both that and `logos-vscode-<version>-<platform>.vsix`,
preferring a platform-specific asset over a universal one. Publish all three
platform builds to the same release tag so each remote picks its own:

```powershell
npm run package:win32-x64
npm run package:linux-x64
npm run package:linux-arm64
$env:GITHUB_TOKEN = "<fine-grained PAT, Contents read+write>"
npm run publish:release -- --tag v0.3.0 --asset logos-vscode-win32-x64-0.3.0.vsix
npm run publish:release -- --tag v0.3.0 --asset logos-vscode-linux-x64-0.3.0.vsix
npm run publish:release -- --tag v0.3.0 --asset logos-vscode-linux-arm64-0.3.0.vsix
```

## Development

```powershell
npm install
npm run compile
npm test
npm run package:win32-x64
```

Packaging builds the pinned Pi revision, bundles the LOGOS domain extension,
downloads the pinned official Node.js distribution for the target platform
from nodejs.org (verified against `SHASUMS256.txt`, cached under
`.node-dist-cache/`), verifies payload integrity, and runs a network-free
smoke test against a local mock model API. For win32-x64 and linux-x64,
packaging also assembles the bundled sim runtime — the SHA256-pinned python.org
embeddable distribution on Windows, the astral python-build-standalone archive
installed cross-platform with pinned uv on Linux (cached under
`.sim-runtime-cache/`; set `PIP_INDEX_URL` to redirect package downloads). Cross-platform builds (for example
`package:linux-x64` on a Windows machine) run the smoke test with the host
Node.js and report that the target binary itself was not executed.
The smoke test verifies skills, prompts, domain tools, streaming, sessions, and
isolation from project Pi settings.

To exercise the updater locally, serve a fake feed with
`node scripts/mock-update-feed.mjs --version <newer> --asset <vsix>` and set
`logos.update.feedUrl` to `http://127.0.0.1:4890/api`.
