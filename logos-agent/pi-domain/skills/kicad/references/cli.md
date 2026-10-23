# Verified kicad-cli reference

All commands below were checked against KiCad 9.0.9 on the LOGOS server. Use the
wrapper `~/.local/bin/kicad-cli`, not the raw binary.

## Schematic

### ERC

```bash
kicad-cli sch erc --format report --severity-all -o erc.rpt board.kicad_sch
kicad-cli sch erc --format json --severity-error --exit-code-violations \
  -o erc.json board.kicad_sch
```

Options include `--severity-all`, `--severity-error`, `--severity-warning`,
`--severity-exclusions`, `--units mm|in|mils`, and
`--exit-code-violations`.

### Netlist

```bash
kicad-cli sch export netlist --format kicadsexpr -o board.net board.kicad_sch
kicad-cli sch export netlist --format kicadxml -o board.xml board.kicad_sch
```

Formats: `kicadsexpr`, `kicadxml`, `cadstar`, `orcadpcb2`, `spice`,
`spicemodel`, `pads`, `allegro`.

### BOM

```bash
kicad-cli sch export bom -o bom.csv board.kicad_sch
kicad-cli sch export bom --fields "Reference,Value,Footprint,${QUANTITY},${DNP}" \
  --labels "Refs,Value,Footprint,Qty,DNP" \
  --group-by "Value,Footprint" -o bom.csv board.kicad_sch
```

### Drawings

```bash
kicad-cli sch export pdf -o exports/board.pdf board.kicad_sch
kicad-cli sch export svg -o exports/schematic/ board.kicad_sch
kicad-cli sch export svg --black-and-white --exclude-drawing-sheet \
  -o exports/schematic_bw/ board.kicad_sch
```

## PCB

### DRC

```bash
kicad-cli pcb drc --format report --severity-all -o drc.rpt board.kicad_pcb
kicad-cli pcb drc --format json --schematic-parity --exit-code-violations \
  -o drc.json board.kicad_pcb
```

`--schematic-parity` checks the PCB against the schematic. This is separate
from ERC and DRC.

### Gerber and drill

```bash
kicad-cli pcb export gerbers -o fabrication/ board.kicad_pcb
kicad-cli pcb export gerbers --layers F.Cu,B.Cu,F.Silkscreen,B.Silkscreen,Edge.Cuts \
  -o fabrication/ board.kicad_pcb
kicad-cli pcb export drill -o fabrication/ board.kicad_pcb
kicad-cli pcb export drill --format excellon --excellon-units mm \
  --generate-map --generate-report -o fabrication/ board.kicad_pcb
```

Gerber layer names are untranslated KiCad layer names such as `F.Cu`, `B.Cu`,
`F.Mask`, `B.Mask`, `F.Silkscreen`, `B.Silkscreen`, and `Edge.Cuts`.

### Mechanical and preview

```bash
kicad-cli pcb export svg --layers F.Cu,B.Cu,F.Silkscreen,Edge.Cuts \
  -o exports/board.svg board.kicad_pcb
kicad-cli pcb export step --force -o exports/board.step board.kicad_pcb
kicad-cli pcb export step --force --board-only --no-components \
  -o exports/board_outline.step board.kicad_pcb
kicad-cli pcb export stl --force -o exports/board.stl board.kicad_pcb
kicad-cli pcb export pdf --layers F.Cu,B.Cu,Edge.Cuts \
  -o exports/board.pdf board.kicad_pcb
kicad-cli pcb export pos --format csv -o exports/board-pos.csv board.kicad_pcb
```

STEP export options include `--no-dnp`, `--subst-models`, `--board-only`,
`--cut-vias-in-body`, `--include-tracks`, `--include-pads`, `--include-zones`,
and `--fuse-shapes`. Use `--force` only when overwriting is intended.

### Other manufacturing formats

```bash
kicad-cli pcb export ipc2581 -o exports/board.xml board.kicad_pcb
kicad-cli pcb export ipcd356 -o exports/board.d356 board.kicad_pcb
kicad-cli pcb export odb -o exports/odb board.kicad_pcb
kicad-cli pcb export gencad -o exports/board.gc board.kicad_pcb
```

## Notes

- Run from the project root or pass absolute paths.
- Keep generated artifacts in a dedicated directory.
- Check `kicad-cli <group> <command> --help` when a version-specific option is
  uncertain; do not guess.
- ERC/DRC reports are evidence about the checks that ran, not a manufacturing
  release.
