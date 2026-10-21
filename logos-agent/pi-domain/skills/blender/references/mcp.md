# Blender MCP integration

## Server

LOGOS owns the launcher; the server itself is the published `mcp-for-blender`
package, run through uvx:

```text
logos-agent/integrations/blender-mcp/bin/blender-mcp-server
logos-agent/integrations/blender-mcp/register-mcp.py   # writes ~/.pi/agent/mcp.json
```

The launcher pins `~/.local/bin/uvx` (uv is pip-installed; astral.sh install
script is blocked by the proxy) and `UV_DEFAULT_INDEX` to the Tsinghua PyPI
mirror (pypi.org is unreliable through the proxy). After the first start the
package is served from the uv cache, so later starts are offline-fast.

## Architecture: two processes

The MCP server is only the transport. It forwards every tool call over a raw
socket to the Blender addon running inside a GUI Blender instance:

| Piece | What it is | How it runs |
|---|---|---|
| `blender-mcp.service` | Blender 5.2.2 GUI under `xvfb-run`, addon auto-starts a socket server on `127.0.0.1:9876` | systemd --user, linger on, `Restart=on-failure` |
| `blender_mcp.py` addon | `~/.config/blender/5.2/scripts/addons/blender_mcp.py`, enabled in user prefs, auto-start on load | inside the daemon above |
| MCP server | `uvx mcp-for-blender` | spawned per Pi runtime via the launcher |

The addon **refuses to start in `--background` mode** (`blender -b`): its
command queue is drained by a GUI timer that never fires headless. That is why
the xvfb daemon exists. Do not try to "simplify" it away.

Consequences:

- MCP commands mutate the *shared daemon scene*. Anything the daemon renders or
  queries reflects prior commands from any session.
- `systemctl --user restart blender-mcp` gives a clean factory scene.
- For stateless, reproducible output (logo generation), prefer the headless
  script path (`blender -b --python ...`) — see SKILL.md.

## Tools (verified by live MCP handshake 2026-10-21, server v1.30.0)

| Tool | Use |
|---|---|
| `execute_blender_code` | run a Python snippet inside the daemon Blender (main entry for incremental edits) |
| `get_scene_info` | objects, materials, world, render settings |
| `look` | capture a viewport screenshot (works under xvfb) |
| `get_addon_status` | addon/server connection status |
| `generate_3d`, `search_assets`, `import_asset` | online asset generation/libraries - need API keys, not provisioned |
| `disable_telemetry` | opt the server out of telemetry (safe to call once) |

Note: tool names above are what the MCP server actually exposes (verified via
`tools/list` handshake). Names seen in the addon source (`execute_code`,
`get_object_info`, ...) are internal command names, not MCP tools.

## Operations

```bash
systemctl --user status blender-mcp         # daemon state
ss -ltn | grep 9876                         # addon listening
systemctl --user restart blender-mcp        # reset scene + reconnect
python3 logos-agent/integrations/blender-mcp/bin/../register-mcp.py --dry-run
journalctl --user -u blender-mcp -n 30      # daemon log
```
