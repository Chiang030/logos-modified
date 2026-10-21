"""Create a project-local sim environment with the LOGOS source forks."""
import os
from pathlib import Path
import subprocess
import sys
import venv

root = Path(__file__).resolve().parent
environment = root / ".venv"
if not environment.exists(): venv.create(environment, with_pip=True)
python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
subprocess.run([str(python), "-m", "pip", "install", "-e", str(root / "sim-cli"),
                "-e", str(root / "plugins/mechanical"), "-e", str(root / "plugins/workbench"), "pytest"], check=True)
# KiCad MCP server fork: optional (ECAD work only) and it brings its own
# dependencies, so a failure must not break the simulation install. Without it
# the launcher falls back to any existing interpreter that has the packages.
kicad = root / "kicad-mcp-server"
if subprocess.run([str(python), "-m", "pip", "install", "-e", str(kicad)]).returncode != 0:
    print("warning: kicad-mcp-server fork not installed; "
          "integrations/kicad-mcp-server/bin/kicad-mcp-server will reuse an existing interpreter",
          file=sys.stderr)
