# Install the LOGOS web workspace

The v0.3.15 server source release includes CLI, web, the shared VS Code UI,
and the pinned Pi sources. Use Linux with Node.js 22.19 or newer. Initial
dependency installation requires internet access.

From the extracted release root, run `bash install.sh --with-web`. Add
`--with-sim` for simulation tooling. From a Git checkout, initialize the Pi
submodule, run `npm --prefix logos-agent run pi:setup`, then `npm ci` in
`logos-agent/pi-domain`, `logos-agent/vscode-extension` and `logos-agent/web`;
finish with `npm --prefix logos-agent/web run build`.

## Identity and storage

Copy `logos-agent/web/deploy/.env.example` to
`~/.config/logos-web-pilot/server.env`, creating the directory first, and set
the file mode to 0600. Fill the Lark application ID, secret, allowed enterprise
tenant key, and comma-separated administrator open IDs. For domestic Feishu,
set the identity platform to `feishu` and use `FEISHU_` credential names.
Publish the enterprise application and allow the intended employees to use it.

Set the public origin to your stable HTTPS URL. Register
`<public-origin>/auth/feishu/callback` in the identity application's redirect
allowlist. Configure a reverse proxy or the optional [ngrok service](ngrok.md).
The HTTP listener defaults to loopback. Keep the original public Host header.

For private VPN access without a public tunnel, see [NetBird setup](netbird.md).

Browser login lasts 30 days and renews when an authenticated user opens or
refreshes the workbench. Preserve the data directory across deployments and
restarts; it contains sessions, projects, usage records and the encryption key.
Changing domains requires one login on the new domain.

## Services

Copy the HTTP and worker templates from `web/deploy` to
`~/.config/systemd/user/`. Replace `@REPOSITORY@` with the absolute extracted
release root and replace `%h/.local/bin/node` if Node is installed elsewhere.
Create `~/.local/state/logos-web-pilot` for the worker lock, then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now logos-web-pilot logos-web-worker
sudo loginctl enable-linger "$USER"
```

The administrator configures model endpoints, API keys and models in the web
management page. Calls through the model broker are recorded per Lark user.
The file browser shows each user's projects, while Agent tools run with the
shared server account's normal filesystem and network access.

For updates, back up the complete data directory and protected configuration,
drain running tasks, rebuild web assets, and restart the HTTP and worker
services. Do not replace the data directory or its encryption key.

## ANSYS license manager

An optional installer registers an existing licensed ANSYS installation as a
system boot service. See [license service setup](ansys-license.md). License
files are not included or modified by LOGOS. Verify both the manager and its
vendor daemon with `lmutil lmstat`; an active systemd unit alone is insufficient.
