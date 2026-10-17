# LOGOS VS Code extension

This package provides the local LOGOS workbench for VS Code. It starts the
LOGOS Node entry point in the current workspace and renders a React chat UI in
a Webview.

## Development

```powershell
npm install
npm run compile
npm test
npm run package
```

Press `F5` from this directory to launch an Extension Development Host. The
extension looks for `logos-agent/bin/logos.mjs` in the opened workspace. Set
`logos.executablePath` when the runtime is stored elsewhere.

The packaged file is `logos-vscode-0.1.0.vsix`. Install it from the VS Code
Extensions view with **Install from VSIX…**.

The first version intentionally runs a local process only. Remote transport
and remote installation are separate follow-up work.
