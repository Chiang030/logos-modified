# KiCad MCP integration

## Server

LOGOS owns the server: the patched source fork lives in this repository at
`logos-agent/integrations/kicad-mcp-server/`, and the Pi runtime launches its
wrapper:

```text
logos-agent/integrations/kicad-mcp-server/bin/kicad-mcp-server
```

The launcher is deliberately dumb — it makes the fork's own `src/` win on
`PYTHONPATH` (PYTHONPATH precedes `site-packages` `.pth` entries, so another
editable install cannot shadow it), adds the user-space KiCad 9 prefix when it
exists, and then runs `python -m kicad_mcp_server` with the first interpreter
that has the MCP dependencies:

| Probe order | Value |
|---|---|
| 1 | `$LOGOS_KICAD_PYTHON` |
| 2 | `integrations/.venv/bin/python` (created by `integrations/setup.py`) |
| 3 | `~/.local/opt/kicad-mcp-venv/bin/python` (host dependency venv) |
| 4 | `python3` on `PATH` |

`pcbnew` is optional. Without it, project creation and PCB analysis fall back to
`kicad-cli` / system `python3`, which the upstream code already supports.

Historical note: before 2026-10-21 the runtime launched
`~/.local/bin/kicad-mcp-server`, an editable install of upstream 0.1.0 under
`~/.local/opt/kicad-mcp-server`. That copy is kept only as a comparison point;
changing it no longer affects the agent.

## Pi configuration

The entry is generated, not hand-written — `register-mcp.py` merges it into
`~/.pi/agent/mcp.json` (backup + JSON validation, other servers preserved):

```bash
python3 logos-agent/integrations/kicad-mcp-server/register-mcp.py --dry-run
python3 logos-agent/integrations/kicad-mcp-server/register-mcp.py
python3 logos-agent/integrations/kicad-mcp-server/register-mcp.py --remove
```

Resulting entry:

```json
{
  "mcpServers": {
    "kicad": {
      "command": "<repo>/logos-agent/integrations/kicad-mcp-server/bin/kicad-mcp-server",
      "timeout": 300,
      "exposure": "deferred",
      "description": "KiCad 原理图/PCB 分析、ERC/DRC、网表追踪、Gerber/SVG/STEP 导出与元件库检索；KiCad 任务使用 kicad 技能。"
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
3. Wrapper scripts in `~/.local/bin` named **`kicad9-cli`, `kicad9`, `pcbnew9`,
   `kicad9-python`** (the unversioned `kicad-cli` / `kicad-python` names do not
   exist; `kicad-cli` resolves to the system 10.0.7 package).
4. Python package `kicad-mcp-server` from the Seeed Studio repository installed
   into a dedicated venv at `~/.local/opt/kicad-mcp-venv`.

Re-verified on 2026-10-21 — the running mix is **CLI 10.0.7 + pcbnew 9.0.9
inside the MCP process**:

```text
/usr/bin/kicad-cli version                                 -> 10.0.7
/usr/bin/python3 -c "import pcbnew; print(pcbnew.Version())" -> 10.0.7
kicad9-cli version (user-space fallback)                   -> 9.0.9
```

## Fork patches applied 2026-10-21

The patches live in the vendored fork (`integrations/kicad-mcp-server/`), inside
this repository and in the release manifest. Provenance and licensing: its
`NOTICE`. The same patches were first prototyped against the legacy host install
under `~/.local/opt/kicad-mcp-server/src`, which is now only a comparison point.

| File | Change |
|---|---|
| `tools/validation.py` | `_collect_violations()` reads both ERC layouts (top-level and KiCad 10 `sheets[]`) and drops excluded entries; `_generate_erc_report` / `_generate_drc_report` delete the stale report first and return `None` + message on failure; `get_*_violations` no longer guesses from `❌`/`⚠️` strings; `export_*_report` treat warnings as findings (not failures) and create parent dirs |
| `tools/schematic_editor.py` | `add_wire` splits multi-point input into 2-point segments (a 3-point `(wire (pts ...))` made the schematic unloadable); `_flatten_symbol_extends()` resolves library `extends` chains so derived symbols keep their geometry and pins |
| `tools/netlist.py` | `trace_netlist_connection` formatter handles the per-net pin list returned for multi-pin components |
| `parsers/schematic_parser.py` | instance `(at ...)` parsed independently of file layout, so positions are no longer always (0, 0) |
| `tools/project.py`, `utils/kicad_version.py` | `create_kicad_project` writes project-local `sym-lib-table` / `fp-lib-table` (absolute paths) when the newest global KiCad table is empty, removing 6 library warnings per project; added `get_kicad_footprint_dir()` |

Regression evidence: `integrations/kicad-mcp-server/tests/test_fork_regressions.py` (29 offline checks) and
`integrations/kicad-mcp-server/tests/mcp_stdio_smoke.py` (14 checks over real MCP stdio, incl. fork-resolution and nested report export
and nested-dir report export). Re-run them after any further edit. The server
is spawned per LOGOS session — restart the session to pick up changes.

## Verified behavior after patching

```text
run_erc (KiCad 10 JSON, 15 violations)   -> 15 total, 3 errors  (was: "clean")
get_erc_violations severity=error        -> 3, incl. label:TESTNET (was: 0 / N/A)
export_erc_report (nested output dir)    -> created dirs + 15 counted
export_drc_report (board with warnings)  -> exported             (was: refused)
trace_netlist_connection U1              -> VIN/VOUT/GND, no crash
add_wire 4 points                        -> 3 legal segments, kicad-cli loads
add_component_from_library LP2985-3.3    -> 5 pins in KiCad netlist (was: 0)
create_kicad_project                     -> + sym-lib-table, fp-lib-table
run_erc on a new project with one part   -> 0 library warnings    (was: 6)
```

All of the above was re-verified on 2026-10-21 through the MCP tools of a
restarted session (not only by the offline scripts).

## Troubleshooting

**`libwx_gtk3u_core-3.2.so.0: cannot open shared object file`**  
The raw user-space binary was called without its wrapper. Use
`~/.local/bin/kicad9-cli`, or export `LD_LIBRARY_PATH` first. (The plain
`kicad-cli` on PATH is the system 10.0.7 package and needs no wrapper.)

**`ModuleNotFoundError: No module named 'pcbnew'`**  
Use `~/.local/bin/kicad9-python` (user-space 9.0.9) or `/usr/bin/python3`
(system 10.0.7), both of which import `pcbnew`. The plain `kicad-python` name
does not exist here.

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
