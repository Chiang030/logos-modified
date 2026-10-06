"""Runtime capability inspection for the modeling agent."""

import json
import shutil

from langchain_core.tools import tool


@tool
def inspect_runtime_capabilities() -> str:
    """Inspect whether supported local solver and post-processing commands exist."""
    commands = {
        "precice": "precice-config",
        "openfoam": "foamRun",
        "calculix": "ccx",
        "gmsh": "gmsh",
        "paraview_python": "pvpython",
    }
    capabilities = {
        name: {"available": bool(path := shutil.which(command)), "path": path}
        for name, command in commands.items()
    }
    return json.dumps(capabilities, ensure_ascii=False, sort_keys=True)
