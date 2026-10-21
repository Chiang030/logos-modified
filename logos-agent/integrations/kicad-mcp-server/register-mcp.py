#!/usr/bin/env python3
"""Register the vendored kicad-mcp-server fork with the Pi runtime.

Merges (never replaces) a `kicad` entry into the Pi MCP configuration, so an
existing server such as `solidcraft` survives. The entry points at this fork's
launcher, not at a pip-installed copy.

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

FORK_DIR = Path(__file__).resolve().parent
LAUNCHER = FORK_DIR / "bin" / "kicad-mcp-server"

ENTRY = {
    "command": str(LAUNCHER),
    "timeout": 300,
    "exposure": "deferred",
    "description": (
        "KiCad 原理图/PCB 分析、ERC/DRC、网表追踪、Gerber/SVG/STEP 导出与元件库检索；"
        "KiCad 任务使用 kicad 技能。"
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
    data.setdefault("mcpServers", {})
    return data


def render(data: dict) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=None, help="Path to mcp.json")
    parser.add_argument("--dry-run", action="store_true", help="Print, do not write")
    parser.add_argument("--remove", action="store_true", help="Remove the kicad entry")
    args = parser.parse_args(argv)

    config = args.config or default_config()
    if not LAUNCHER.is_file():
        print(f"error: launcher missing: {LAUNCHER}", file=sys.stderr)
        return 2
    if not LAUNCHER.stat().st_mode & 0o111:
        print(f"error: launcher not executable: {LAUNCHER}", file=sys.stderr)
        return 2

    try:
        data = load(config)
    except json.JSONDecodeError as exc:
        print(f"error: {config} is not valid JSON ({exc}); not touching it", file=sys.stderr)
        return 3

    servers = data["mcpServers"]
    if args.remove:
        if servers.pop("kicad", None) is None:
            print(f"nothing to remove: no kicad entry in {config}")
            return 0
    else:
        servers["kicad"] = dict(ENTRY)

    output = render(data)
    json.loads(output)  # guard: never write something the runtime cannot parse

    if args.dry_run:
        print(f"# {config} (dry run, not written)")
        print(output, end="")
        return 0

    if config.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = config.with_suffix(f".json.bak-{stamp}")
        shutil.copy2(config, backup)
        print(f"backup: {backup}")
    else:
        config.parent.mkdir(parents=True, exist_ok=True)

    config.write_text(output, encoding="utf-8")
    verb = "removed from" if args.remove else "registered in"
    print(f"kicad MCP server {verb} {config}")
    print("restart the LOGOS session for the change to take effect")
    return 0


if __name__ == "__main__":
    sys.exit(main())
