---
name: kicad
description: Use for KiCad schematic and PCB projects - inspect components, nets, footprints and routing, trace connections, run ERC/DRC, export netlist/BOM/Gerber/SVG/STEP, create projects, search parts, and generate firmware pin or device-tree data through the kicad MCP server or kicad-cli.
---

# KiCad

## Scope

Use this skill for electronic CAD work in KiCad:

- reading a `.kicad_pro`, `.kicad_sch`, or `.kicad_pcb` project;
- listing components, nets, symbols, footprints, tracks, and vias;
- tracing pin-level connections and hierarchical nets;
- running ERC and DRC and exporting reports;
- exporting netlist, BOM, Gerber, drill, SVG, PDF, STEP, or 3D output;
- creating a project or adding/library parts;
- generating firmware pin maps, device trees, or hardware test scaffolding.

Do not use KiCad for mechanical CAD, finite-element meshing, or CFD. Route
mechanical geometry through the `solidcraft` skill and meshing through the
`gmsh` skill.

## Discover the installation

The Linux server deployment was verified on 2026-10-20 with KiCad 9.0.9:

| Capability | Path |
|---|---|
| CLI | `/home/jiangjincheng/.local/bin/kicad-cli` |
| GUI | `/home/jiangjincheng/.local/bin/kicad` (requires a desktop session) |
| Pcbnew | `/home/jiangjincheng/.local/bin/pcbnew` |
| KiCad Python | `/home/jiangjincheng/.local/bin/kicad-python` (`pcbnew` 9.0.9) |
| MCP server | `/home/jiangjincheng/.local/bin/kicad-mcp-server` |
| MCP config | `/home/jiangjincheng/.pi/agent/mcp.json` |

Verify before use:

```bash
command -v kicad-cli
kicad-cli version
kicad-python -c "import pcbnew; print(pcbnew.Version())"
```

The deployment is a user-space installation under
`/home/jiangjincheng/.local/opt/kicad-9.0.9`. The wrappers set
`LD_LIBRARY_PATH`, `PYTHONPATH`, `KICAD_STOCK_DATA_HOME`, and the standard
`KICAD9_*` library paths. Do not call the raw binaries under
`usr/bin` without those variables.

If KiCad or the MCP server is missing, stop and report it. Do not invent a
tool result or silently substitute another EDA tool.

## Prefer the MCP server

The `kicad` MCP server exposes 47 tools. Its exposure is `deferred`, so use
`tool_search` with a query such as `kicad PCB DRC` or `kicad schematic net`
before calling a tool. Tools are named `mcp__kicad__*`.

Common read-only analysis:

| Task | Tool |
|---|---|
| Project/board statistics | `get_pcb_statistics` |
| Schematic metadata | `get_schematic_info` |
| List components | `list_schematic_components` |
| List nets | `list_schematic_nets` |
| List footprints | `list_pcb_footprints` |
| Net routing analysis | `analyze_pcb_nets`, `find_tracks_by_net` |
| Signal integrity | `analyze_pcb_signal_integrity` |
| Power integrity | `analyze_pcb_power_integrity` |
| Netlist export | `generate_netlist` |
| Connection tracing | `trace_netlist_connection`, `trace_hierarchical_connection` |

Validation and export:

| Task | Tool |
|---|---|
| ERC | `run_erc`, `get_erc_violations`, `export_erc_report` |
| DRC | `run_drc`, `get_drc_violations`, `export_drc_report` |
| Gerber + drill | `export_gerber` |
| Schematic image | `export_schematic_svg` |
| PCB image | `render_pcb` |
| 3D model | `export_pcb_3d` |

Project and part operations:

| Task | Tool |
|---|---|
| Create project | `create_kicad_project` |
| Add a library part | `add_component_from_library` |
| Add wires/labels | `add_wire`, `add_label`, `add_global_label`, `add_hierarchical_label` |
| Board outline/layout | `setup_pcb_layout` |
| Part search | `search_parts_registry`, `get_registry_part`, `download_registry_part` |

The full tool list and server configuration are in
[references/mcp.md](references/mcp.md).

## Workflow

1. **Locate the project root.** Find the `.kicad_pro` file and list the
   `.kicad_sch`, `.kicad_pcb`, and library-table files. Work with absolute paths.
2. **Analyze before editing.** Read project statistics, components, nets, and
   footprints first. Record the board dimensions, layer count, net count, and
   any existing ERC/DRC state.
3. **Validate with the project's own rules.** Run ERC and DRC through the MCP
   server or `kicad-cli`. Keep the report next to the project. A clean run is
   evidence about the checks that ran, not a manufacturing release.
4. **Export deliberately.** Put generated Gerber, drill, SVG, PDF, and STEP
   files in a dedicated output directory such as `fabrication/` or `exports/`.
   Do not mix them with source files.
5. **Back up before editing.** Copy the project or create a checkpoint before
   any schematic/PCB mutation. Schematic editing through S-expression tools is
   experimental; prefer the KiCad GUI or a reviewed script for real design work.
6. **Re-run validation after each edit.** Report the exact command/tool, the
   resulting violation count, and any unverified items.

## Safety and claim limits

- Never overwrite a user's KiCad project in place without a backup or explicit
  instruction.
- Do not claim a board is manufacturable because DRC passed. Check the stackup,
  footprints, courtyard, assembly variant, panelization, and fabrication
  constraints separately.
- Do not claim a schematic is functionally correct because ERC passed. ERC does
  not prove circuit function or component values.
- Do not download parts from an arbitrary URL. Use the MCP registry tools, which
  apply host allowlists and extension checks, and inspect the downloaded files.
- Do not open the KiCad GUI over a plain SSH session. GUI automation needs a real
  interactive desktop. Headless analysis and CLI export do not.
- Treat `.kicad_prl`, `.kicad_pro`, and project-local library tables as part of
  the project. Do not delete or regenerate them casually.

## Headless CLI fallback

If the MCP server is temporarily unavailable, use the verified `kicad-cli`
wrapper. Keep the same read-only-first and backup rules.

```bash
# ERC and DRC reports
kicad-cli sch erc --format report --severity-all -o erc.rpt board.kicad_sch
kicad-cli pcb drc --format report --severity-all -o drc.rpt board.kicad_pcb

# Netlist and BOM
kicad-cli sch export netlist --format kicadsexpr -o board.net board.kicad_sch
kicad-cli sch export bom -o bom.csv board.kicad_sch

# Fabrication outputs
kicad-cli pcb export gerbers -o fabrication/ board.kicad_pcb
kicad-cli pcb export drill -o fabrication/ board.kicad_pcb

# Drawings and mechanical exchange
kicad-cli sch export svg -o exports/schematic/ board.kicad_sch
kicad-cli pcb export svg --layers F.Cu,B.Cu,F.Silkscreen,Edge.Cuts \
  -o exports/board.svg board.kicad_pcb
kicad-cli pcb export step --force -o exports/board.step board.kicad_pcb
```

See [references/cli.md](references/cli.md) for verified option details,
including `--exit-code-violations`, layer lists, and STEP options.

## Editing limitations

KiCad has no general Python API for schematic editing. The MCP server edits
S-expressions directly; wires may not form perfect electrical connections and
visual alignment is basic. KiCad does not hot-reload open files. For production
design work, use the GUI and treat MCP edits as assisted drafts that must be
opened, reviewed, and re-validated in KiCad.

The PCB side has a real `pcbnew` API, so read-only PCB analysis and some layout
operations are more reliable than schematic edits. Still verify the result with
`get_pcb_statistics`, `run_drc`, and a rendered image.

## Reporting

When reporting a KiCad task, include:

- the project and files inspected;
- the KiCad and MCP versions;
- commands or tools run;
- ERC/DRC counts by severity and the report paths;
- exported artifact paths and formats;
- edits made, with backup locations;
- what was not verified (electrical function, thermal, EMC, fabrication, etc.).
