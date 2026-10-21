# KiCad MCP integration

## Server

The LOGOS server runs the Seeed Studio `kicad-mcp-server` over stdio:

```text
/home/jiangjincheng/.local/bin/kicad-mcp-server
```

The wrapper exports the user-space KiCad 9 environment before starting the
server:

```sh
LD_LIBRARY_PATH=$HOME/.local/opt/kicad-9.0.9/usr/lib/x86_64-linux-gnu:$HOME/.local/opt/kicad-9.0.9/usr/lib
PYTHONPATH=$HOME/.local/opt/kicad-9.0.9/usr/lib/python3/dist-packages
KICAD_STOCK_DATA_HOME=$HOME/.local/opt/kicad-9.0.9/usr/share/kicad
PATH=$HOME/.local/bin:$PATH
```

It launches the MCP package from
`$HOME/.local/opt/kicad-mcp-venv` and sets `KICAD_PYTHON` to
`$HOME/.local/bin/kicad-python` so project creation and `pcbnew` analysis use
the KiCad 9 Python bindings.

## Pi configuration

Add the server to `~/.pi/agent/mcp.json`. Merge it with any existing servers
such as `solidcraft`; do not replace the file wholesale.

```json
{
  "mcpServers": {
    "kicad": {
      "command": "/home/jiangjincheng/.local/bin/kicad-mcp-server",
      "timeout": 300,
      "exposure": "deferred",
      "description": "KiCad 9 原理图/PCB 分析、ERC/DRC、网表追踪、Gerber/SVG/STEP 导出与元件库检索；KiCad 任务使用 kicad 技能。"
    }
  }
}
```

`exposure: "deferred"` keeps the 47 tools out of the initial tool list. The
agent must call `tool_search` with a KiCad-related query first, then call the
returned `mcp__kicad__*` tool. This is intentional: it keeps the base context
small.

After changing `mcp.json`, restart the LOGOS session. `/mcp` in the Pi TUI
shows connection status and lets you inspect or enable servers.

## Tool inventory

### Schematic analysis

- `list_schematic_components`
- `list_schematic_nets`
- `get_schematic_info`
- `search_symbols`
- `get_symbol_details`
- `search_components_by_type`

### PCB analysis

- `list_pcb_footprints`
- `get_pcb_statistics`
- `find_tracks_by_net`
- `analyze_pcb_nets`
- `analyze_pcb_signal_integrity`
- `analyze_pcb_power_integrity`

### Netlist and hierarchy

- `generate_netlist`
- `trace_netlist_connection`
- `get_netlist_nets`
- `get_netlist_components`
- `trace_hierarchical_connection`
- `analyze_hierarchical_nets`

### Validation

- `run_erc`
- `get_erc_violations`
- `export_erc_report`
- `run_drc`
- `get_drc_violations`
- `export_drc_report`
- `detect_pin_conflicts`
- `validate_pin_configuration`

### Project and editing

- `create_kicad_project`
- `add_component_from_library`
- `add_wire`
- `add_label`
- `add_global_label`
- `add_hierarchical_label`
- `setup_pcb_layout`

### Export and rendering

- `export_gerber`
- `export_schematic_svg`
- `render_pcb`
- `export_pcb_3d`

### Parts registry

- `search_parts_registry`
- `get_registry_part`
- `download_registry_part`

Registry downloads are host-allowlisted, extension-checked, and size-capped.
Inspect downloaded symbols, footprints, and 3D models before committing them to
a project.

### Firmware and pin data

- `generate_device_tree`
- `extract_gpio_config`
- `extract_i2c_devices`
- `extract_spi_devices`
- `extract_power_domains`
- `analyze_pin_functions`
- `extract_pinmux_config`

## Installation record

Installed on 2026-10-20 without system-wide packages:

1. KiCad 9.0.9 binaries and libraries from the official
   `kicad/kicad-9.0-releases` PPA, extracted with `dpkg-deb -x` under
   `~/.local/opt/kicad-9.0.9`.
2. Missing runtime libraries (wxWidgets 3.2, OCCT 7.6, nng, git2, ngspice,
   unixODBC `libodbc2`, GLEW, FreeImage, OpenEXR, TBB, mbedTLS, and related
   packages) extracted into the same prefix.
3. Wrapper scripts in `~/.local/bin` for `kicad-cli`, `kicad`, `pcbnew`, and
   `kicad-python`.
4. Python package `kicad-mcp-server` from the Seeed Studio repository installed
   into a dedicated venv at `~/.local/opt/kicad-mcp-venv`.

Verified:

```text
kicad-cli version                 -> 9.0.9
kicad-python -c "import pcbnew"   -> 9.0.9
create_kicad_project              -> .kicad_pro, .kicad_sch, .kicad_pcb
get_pcb_statistics                -> design rules and layer data
run_drc                           -> violation report
export_gerber                     -> 26 fabrication files
run_erc                           -> no violations
export_schematic_svg              -> smoke.svg
kicad-cli sch export svg          -> smoke.svg
kicad-cli pcb export step         -> board.step
```

## Troubleshooting

**`libwx_gtk3u_core-3.2.so.0: cannot open shared object file`**  
The raw binary was called without the wrapper. Use
`~/.local/bin/kicad-cli` or export `LD_LIBRARY_PATH` first.

**`ModuleNotFoundError: No module named 'pcbnew'`**  
Use `~/.local/bin/kicad-python`, which sets `PYTHONPATH` to the KiCad Python
directory. A plain `python3` cannot import `pcbnew`.

**`schema file '/usr/share/kicad/schemas/api.v1.schema.json' not found`**  
Set `KICAD_STOCK_DATA_HOME` to the extracted `share/kicad` directory. The
wrappers already do this.

**`libodbc.so.2: cannot open shared object file`**  
The unixODBC runtime is missing. Extract Ubuntu's `libodbc2` package into the
KiCad prefix (`dpkg-deb -x libodbc2_*.deb ~/.local/opt/kicad-9.0.9`); the
wrapper's `LD_LIBRARY_PATH` already includes the prefix library directory.

**`kicad-cli sch upgrade` fails**  
KiCad 9.0.9 does not provide `sch upgrade`; the MCP server reports this as a
harmless warning after creating a project. Open and save the project once in
KiCad if an explicit upgrade is required.

**MCP server starts but tools are absent**  
Check that `exposure` is `deferred` and use `tool_search`. Check `~/.pi/agent/mcp.json`
for JSON errors. Run
`~/.local/bin/kicad-mcp-server` manually and look at stderr.

**KiCad GUI cannot start over SSH**  
That is expected. Headless analysis and CLI export work; GUI work needs a real
desktop session (for example, a local login, RDP, or VNC).
