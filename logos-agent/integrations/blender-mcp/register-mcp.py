#!/usr/bin/env python3
"""Register the blender MCP server (uvx mcp-for-blender) with the Pi runtime.

Merges (never replaces) a `blender` entry into the Pi MCP configuration, so
existing servers such as `kicad` and `solidcraft` survive. The entry points
at this integration's launcher, which pins the uvx path and the PyPI mirror.

    python3 register-mcp.py --dry-run    # print the resulting file
    python3 register-mcp.py              # write it, after backing it up
    python3 register-mcp.py --remove     # drop the entry again
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

INTEGRATION_DIR = Path(__file__).resolve().parent
LAUNCHER = INTEGRATION_DIR / "bin" / "blender-mcp-server"

ENTRY = {
    "command": str(LAUNCHER),
    "timeout": 300,
    "exposure": "deferred",
    "description": (
        "Blender 3D 制作与渲染:文字/SVG logo 立体化、金属材质、透明底与深色底 PNG、"
        "转圈 MP4 与 GLB 导出;Blender 及 3D logo 任务使用 blender 技能。"
    ),
}


def default_config() -> Path:
    return Path.home() / ".pi" / "agent" / "mcp.json"


def load(config: Path) -> dict:
    if not config.exists():
        return {"mcpServers": {}}
    text = config.read_text(encoding="utf-8")
    if not text.strip():
        return {"mcpServers": {}}
    data = json.loads(text)
    if not isinstance(data, dict):
        raise SystemExit(f"{config}: expected a JSON object at top level")
    data.setdefault("mcpServers", {})
    return data


def write(config: Path, data: dict) -> None:
    if config.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = config.with_name(f"{config.name}.bak-{stamp}")
        shutil.copy(config, backup)
        print(f"backed up {config} -> {backup}")
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {config}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="print the resulting config and exit")
    parser.add_argument("--remove", action="store_true", help="remove the blender entry instead of adding it")
    parser.add_argument("--config", type=Path, default=default_config(), help="Pi MCP config path")
    args = parser.parse_args()

    if not LAUNCHER.is_file():
        raise SystemExit(f"launcher missing: {LAUNCHER}")
    LAUNCHER.chmod(0o755)

    data = load(args.config)
    servers = data["mcpServers"]

    if args.remove:
        if servers.pop("blender", None) is None:
            print("no blender entry to remove")
            return 0
    else:
        servers["blender"] = ENTRY

    if args.dry_run:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return 0

    write(args.config, data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
