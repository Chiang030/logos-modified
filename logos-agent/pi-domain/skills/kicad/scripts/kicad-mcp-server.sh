#!/bin/sh
set -eu

KICAD_ROOT="$HOME/.local/opt/kicad-9.0.9"
MCP_ROOT="$HOME/.local/opt/kicad-mcp-server-mixelpixx-2.8.2"
MCP_VENV="$HOME/.local/opt/kicad-mcp-mixelpixx-venv"

export PATH="$HOME/.local/bin:$PATH"
export LD_LIBRARY_PATH="$KICAD_ROOT/usr/lib/x86_64-linux-gnu:$KICAD_ROOT/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PYTHONPATH="$KICAD_ROOT/usr/lib/python3/dist-packages${PYTHONPATH:+:$PYTHONPATH}"
export KICAD_PYTHON="$MCP_VENV/bin/python"
export KICAD9_SYMBOL_DIR="$KICAD_ROOT/usr/share/kicad/symbols"
export KICAD9_FOOTPRINT_DIR="$KICAD_ROOT/usr/share/kicad/footprints"
export KICAD9_TEMPLATE_DIR="$KICAD_ROOT/usr/share/kicad/template"
export KICAD_AUTO_LAUNCH=false
export KICAD_GUI_DRIVER_ENABLE=0
export NODE_ENV=production
export LOG_LEVEL=warn

exec node "$MCP_ROOT/dist/index.js" "$@"
