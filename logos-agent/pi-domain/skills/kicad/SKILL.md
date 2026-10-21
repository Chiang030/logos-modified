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

Verified on the Linux server on 2026-10-21. **Two KiCad installations coexist**
and the toolchain mixes them, so a version claim is only evidence when it
names the executable:

| Capability | Path | Version |
|---|---|---|
| CLI (the one actually used) | `/usr/bin/kicad-cli` (Ubuntu 24.04 package) | 10.0.7 |
| CLI, user-space alternative | `~/.local/bin/kicad9-cli` | 9.0.9 |
| Pcbnew / Python API | `/usr/bin/python3 -c "import pcbnew"` | 10.0.7 |
| Pcbnew, user-space alternative | `~/.local/bin/kicad9-python` | 9.0.9 |
| GUI (needs a desktop session) | `~/.local/bin/kicad9` | 9.0.9 |
| MCP server (LOGOS-owned) | `logos-agent/integrations/kicad-mcp-server/bin/kicad-mcp-server` | 47 tools |
| MCP server source (fork) | `logos-agent/integrations/kicad-mcp-server/src` | patched 2026-10-21 |
| MCP config | `~/.pi/agent/mcp.json` (`exposure: deferred`, written by `register-mcp.py`) | - |
| Host install (legacy) | `~/.local/bin/kicad-mcp-server` → `~/.local/opt/kicad-mcp-server/src` | 仅作 fallback / 对照 |

`~/.local/bin/kicad-cli` and `~/.local/bin/kicad-python` from earlier notes **do
not exist** — do not reference them. Verify before use:

```bash
command -v kicad-cli && kicad-cli version                      # expect 10.0.7
/usr/bin/python3 -c "import pcbnew; print(pcbnew.Version())"   # expect 10.0.7
~/.local/bin/kicad9-cli version                                # 9.0.9, older stack
python3 logos-agent/integrations/kicad-mcp-server/tests/test_fork_regressions.py
```

**The KiCad MCP server is part of LOGOS**: the patched source lives in the repo
(`integrations/kicad-mcp-server/`), is shipped in the release archive, and is
what `~/.pi/agent/mcp.json` points at. When it must change, edit the fork and
re-run its two test scripts — do not patch the legacy host install, and do not
re-point `mcp.json` at a pip-installed copy (two editable installs of the same
package shadow each other; that is how the "ERC always passes" bug survived a
local patch on this host).

The launcher keeps the user-space 9.0.9 prefix on `LD_LIBRARY_PATH` /
`PYTHONPATH` when it exists, so in-process `pcbnew` is 9.0.9 while `kicad-cli`
children are 10.0.7. The tools tolerate that mix, but say so in reports.

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

## Forked server: patches (2026-10-21) and residual limits

LOGOS vendors the server at `logos-agent/integrations/kicad-mcp-server/` (source
fork of Seeed `kicad-mcp-server` 0.1.0; provenance and patch list in its
`NOTICE`). Registration into the Pi runtime:

```bash
python3 logos-agent/integrations/kicad-mcp-server/register-mcp.py --dry-run
python3 logos-agent/integrations/kicad-mcp-server/register-mcp.py
```

Fixed in the fork; covered by `integrations/kicad-mcp-server/tests/test_fork_regressions.py` (29 checks) and
`integrations/kicad-mcp-server/tests/mcp_stdio_smoke.py` (14 checks over real MCP stdio):

| Was | Now |
|---|---|
| ERC read only top-level `violations` (KiCad 9 layout); KiCad 10 nests them in `sheets[]`, so every real ERC looked clean | `_collect_violations()` walks both layouts and skips excluded entries |
| A failed run could be answered from a stale `/tmp` report | the report is deleted before each run; helper returns `None` + message on failure |
| `export_drc_report` refused any board carrying warnings | only a failed run blocks export; parent directories are created |
| `export_erc_report` used the sub-sheet stem and required an existing dir | root stem, `mkdir(parents=True)` |
| `add_wire` with more than 2 points wrote an unloadable schematic | splits into 2-point segments, rejects degenerate input |
| derived symbols (`extends`) gave components with 0 pins | `_flatten_symbol_extends()` inherits parent geometry, applies child overrides |
| `trace_netlist_connection` crashed on multi-pin components | formatter handles the per-net pin lists |
| `get_symbol_details` always reported position (0,0) | instance `(at ...)` parsed independent of file layout |
| new projects produced 6 library warnings each | `create_kicad_project` writes project-local `sym-lib-table`/`fp-lib-table` when the newest global table is empty (absolute paths — not portable) |
| a dangling label showed `N/A` in the ERC table | the label name is surfaced (`label:TESTNET`) |

Still not trustworthy — do not over-claim:

- ERC says nothing about circuit function or component values.
- `detect_pin_conflicts` does not flag a dangling local label.
- `analyze_pcb_power_integrity` only reports GND copper zones.
- Schematic edits are still S-expression drafts: after every edit, re-run ERC
  (or `get_erc_violations`) and confirm the file loads before claiming success.
- The ERC/DRC JSON report format is KiCad's; `.rpt` files written by the tools
  are JSON, not text. Parse them, do not `grep` for prose.

After changing anything under `integrations/kicad-mcp-server/src`, run the fork
tests and restart the LOGOS session — the MCP server is spawned once per session
and does not reload. (A change to the legacy host install under
`~/.local/opt/kicad-mcp-server/src` has no effect while `mcp.json` points at the
fork.)

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

If the MCP server is temporarily unavailable, use `/usr/bin/kicad-cli`
(10.0.7) directly. Keep the same read-only-first and backup rules. Pass
`--severity-all` so warnings are not filtered away, and remember that KiCad 10
writes ERC reports as JSON whose violations live under `sheets[].violations`.

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

Schematic tools now flatten derived (`extends`) symbols and split multi-point
wires correctly, but they still write S-expressions: after each edit, run ERC
and confirm the file loads (`kicad-cli sch erc`). A parse failure shows up as a
bare "Failed to load schematic", so treat that message as a file defect, not a
missing-tool problem.

## Reporting

When reporting a KiCad task, include:

- the project and files inspected;
- the executable paths and versions (`kicad-cli` path + `kicad-cli version`,
  `pcbnew.Version()`), because two KiCad installs coexist on this host;
- commands or tools run;
- ERC/DRC counts by severity and the report paths;
- exported artifact paths and formats;
- edits made, with backup locations;
- what was not verified (electrical function, thermal, EMC, fabrication, etc.).
