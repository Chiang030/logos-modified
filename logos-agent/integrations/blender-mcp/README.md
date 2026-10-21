# blender-mcp integration

Wires the published `mcp-for-blender` MCP server into the Pi runtime and, with
the `blender` skill (`pi-domain/skills/blender/`), gives LOGOS 3D logo /
rendering capability.

Pieces:

- `bin/blender-mcp-server` - launcher: pins uvx path + Tsinghua PyPI mirror,
  then `exec uvx mcp-for-blender`. `--logos-info` prints the uvx in use.
- `register-mcp.py` - merges the `blender` entry into `~/.pi/agent/mcp.json`
  (never replaces; backs up first). `--dry-run` / `--remove` supported.

Host-side prerequisites (already provisioned 2026-10-21):

- Blender 5.2.2 LTS at `~/opt/blender-5.2.2-linux-x64/`, entry
  `~/.local/bin/blender`; addon installed and enabled in
  `~/.config/blender/5.2/scripts/addons/`.
- systemd --user unit `blender-mcp.service`: GUI Blender under `xvfb-run`,
  addon listening on `127.0.0.1:9876`, linger enabled. The addon cannot run in
  `--background` mode, so this daemon is required for MCP.
- `uv` pip-installed at `~/.local/bin/uv` (astral.sh is blocked by the proxy).

Re-register after moving this tree:

```bash
python3 register-mcp.py
```
