# KiCad MCP integration

## Selected server

LOGOS uses the MIT-licensed
[`mixelpixx/KiCAD-MCP-Server`](https://github.com/mixelpixx/KiCAD-MCP-Server)
release `v2.8.2`, pinned to commit
`670d2a9c48e1588f2e07edaf656b5e301fc55a50`. This release supports KiCad 9,
Linux, stdio MCP, headless `kicad-cli`, and the `pcbnew` Python bindings.

The newer Konnect agent has bundled skills and agents, but its live PCB path
requires KiCad 10 and a running PCB editor. KiCad MCP Pro also targets KiCad 10
for its full CLI-backed contract. Neither is the default on this KiCad 9
headless server.

Installed paths:

| Item | Path |
|---|---|
| Source | `/home/jiangjincheng/.local/opt/kicad-mcp-server-mixelpixx-2.8.2` |
| Python environment | `/home/jiangjincheng/.local/opt/kicad-mcp-mixelpixx-venv` |
| Wrapper | `/home/jiangjincheng/.local/bin/kicad-mcp-server` |
| Previous Seeed implementation | `/home/jiangjincheng/.local/opt/kicad-mcp-server` (inactive rollback copy) |

The wrapper exports the user-space KiCad 9 library paths, selects the dedicated
Python environment, disables auto-launch and GUI-driver behavior, and starts
`dist/index.js` with Node.js.

## Pi configuration

Merge this server into `~/.pi/agent/mcp.json`; do not replace other servers:

```json
{
  "mcpServers": {
    "kicad": {
      "command": "/home/jiangjincheng/.local/bin/kicad-mcp-server",
      "timeout": 300,
      "exposure": "deferred",
      "description": "KiCad 9 headless schematic/PCB analysis, ERC/DRC, routing review and manufacturing export via mixelpixx KiCAD-MCP-Server v2.8.2; use the kicad skill."
    }
  }
}
```

`deferred` is required because the server registers 244 tools. Use Pi's
`tool_search` first so only relevant MCP tools enter context.

## Discovery workflow

1. Call `tool_search` for `kicad search tools` and expose `search_tools`.
2. Call `search_tools` with the concrete operation, such as `DRC report`,
   `schematic net trace`, or `Gerber drill export`.
3. If the result is ambiguous, expose and call `get_category_tools` for the
   relevant category.
4. Expose only the selected operation tools and call them with absolute paths.
5. Re-run ERC/DRC and inspect output artifacts after every mutation.

The server registry is authoritative. Its `docs/TOOL_INVENTORY.md` records 244
registered tools, of which 184 are keyword-indexed across 17 categories.

## Headless limits

- Keep `KICAD_AUTO_LAUNCH=false` and `KICAD_GUI_DRIVER_ENABLE=0`.
- Do not use GUI-driver, menu, toolbar, dialog, or live-window tools over SSH.
- Tools backed by `kicad-cli`, saved project files, or `pcbnew` may run
  headlessly. Confirm the selected tool's requirements before calling it.
- Never claim that ERC/DRC proves electrical function or manufacturability.
- Back up the project before mutation and keep one writer at a time.

## Validation

After an install or upgrade, verify all of the following:

```bash
kicad-cli version
kicad-python -c "import pcbnew; print(pcbnew.Version())"
/home/jiangjincheng/.local/bin/kicad-mcp-server
```

Use an MCP client for the last command and require:

- successful `initialize`;
- server version `2.8.2` or the expected pinned build;
- 244 tools from `tools/list`;
- successful `search_tools` call;
- at least one read-only operation against a disposable KiCad fixture;
- no leftover Node or Python worker after client disconnect.

## Dependency risk

The pinned upstream lockfile reported npm audit findings at installation time.
Do not run `npm audit fix --force` in place because it changes the reviewed
dependency graph and may break the server. Upgrade only to a reviewed upstream
release, then repeat protocol and fixture validation before switching LOGOS.
