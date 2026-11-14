#!/usr/bin/env bash
# Requires an existing KiCad CLI and a Python interpreter that imports pcbnew.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python="${KICAD_PYTHON:-python3}"
cli="${KICAD_CLI:-kicad-cli}"
command -v "$python" >/dev/null
command -v "$cli" >/dev/null
root="$(mktemp -d "${TMPDIR:-/tmp}/logos-kicad-XXXXXXXX")"
printf 'Output directory: %s\n' "$root"
"$cli" version > "$root/version.txt"
# The first board uses the historical intermediate numbering. The second step
# maps it exactly once to the standard LED numbering (1=K, 2=A).
"$python" "$here/kicad_led.py" "$root/intermediate"
"$python" "$here/kicad_full.py" "$root/full" "$root/intermediate/led.kicad_pcb"
"$cli" sch erc --format json --exit-code-violations -o "$root/full/erc.json" "$root/full/led.kicad_sch"
"$cli" sch export netlist --format kicadxml -o "$root/full/led.xml" "$root/full/led.kicad_sch"
"$cli" pcb drc --schematic-parity --format json --exit-code-violations -o "$root/full/drc-parity.json" "$root/full/led.kicad_pcb"
"$cli" pcb export gerbers -o "$root/full/gerbers/" "$root/full/led.kicad_pcb"
"$cli" pcb export drill -o "$root/full/drill/" "$root/full/led.kicad_pcb"
"$cli" pcb export step --board-only -o "$root/full/led.step" "$root/full/led.kicad_pcb"
"$python" "$here/check_kicad_full.py" "$root/full"
printf 'Completed ERC, netlist, PCB parity, manufacturing exports: %s/full\n' "$root"
