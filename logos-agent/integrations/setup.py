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
