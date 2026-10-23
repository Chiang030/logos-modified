# LOGOS VS Code extension

A standalone Windows x64 LOGOS package for VS Code 1.90 or newer. The VSIX
includes the Pi core, Node.js, LOGOS system prompts, skills, and domain extension.
No separate Pi, Node.js, or LOGOS checkout is needed.

## Installation and configuration

Install `logos-vscode-0.1.7-win32-x64.vsix`, open a project folder, and run
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
and `logos-agent/pi-domain`. Persistent connection and prompt configuration is
in global storage `logos-agent/config/connection.json`. Per-workspace runtime
profiles and conversations use workspace storage. Actual configuration and
Logos paths are shown in the settings panel. Updates preserve saved settings.

Only the configured model API is contacted for inference and model discovery.
Engineering solver executables and their licenses are not included.

## Development

```powershell
npm install
npm run compile
npm test
npm run package:win32-x64
```

Packaging builds the pinned Pi revision, bundles the LOGOS domain extension,
copies the Windows x64 Node executable used for packaging, verifies payload
integrity, and runs a network-free smoke test against a local mock model API.
The smoke test verifies skills, prompts, domain tools, streaming, sessions, and
isolation from project Pi settings.
