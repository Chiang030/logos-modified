#!/usr/bin/env bash
# Uses the caller's existing installation and license environment; changes no service.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
solver="${MAPDL_EXECUTABLE:-ansys261}"
if [[ "$solver" == */* ]]; then
  test -x "$solver" || { printf 'MAPDL_EXECUTABLE is not executable\n' >&2; exit 2; }
else
  solver="$(command -v "$solver")" || { printf 'Set MAPDL_EXECUTABLE to your installed MAPDL executable\n' >&2; exit 2; }
fi
command -v timeout >/dev/null || { printf 'GNU timeout is required\n' >&2; exit 2; }
root="$(mktemp -d "${TMPDIR:-/tmp}/logos-structure-XXXXXXXX")"
printf 'Output directory: %s\n' "$root"
cp "$here/structure_demo.dat" "$root/structure_demo.dat"
cd "$root"
# No license endpoint is assigned or queried. Configure licensing outside this example.
export OMP_NUM_THREADS=1
set +e
timeout --signal=TERM --kill-after=15s 540s "$solver" -b -smp -np 1 -j cantilever -i structure_demo.dat -o solve.log > launch.log 2>&1
code=$?
set -e
printf '%s\n' "$code" > exit-code.txt
printf 'solver_exit=%s output=%s\n' "$code" "$root"
exit "$code"
