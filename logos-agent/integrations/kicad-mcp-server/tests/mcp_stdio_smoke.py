#!/usr/bin/env python3
"""End-to-end smoke test for the LOGOS kicad-mcp-server fork.

Spawns `bin/kicad-mcp-server` over real MCP stdio (the same way the Pi runtime
does), builds a throw-away KiCad project through the server's own tools, and
asserts behavior that only the patched fork provides. Using behavior instead of
module paths also proves the launcher runs the fork, not another install.

    python3 integrations/kicad-mcp-server/tests/mcp_stdio_smoke.py
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

FORK_DIR = Path(__file__).resolve().parents[1]
LAUNCHER = FORK_DIR / "bin" / "kicad-mcp-server"

RESULTS: list[tuple[str, str, str]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    RESULTS.append(("PASS" if passed else "FAIL", name, detail))


def skip(name: str, why: str) -> None:
    RESULTS.append(("SKIP", name, why))


async def main() -> int:
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
    except ImportError as exc:  # pragma: no cover - environment dependent
        print(f"SKIP: MCP client library unavailable ({exc})")
        return 0

    if not LAUNCHER.is_file():
        print(f"FAIL: launcher missing: {LAUNCHER}")
        return 1

    info = subprocess.run(
        [str(LAUNCHER), "--logos-info"], capture_output=True, text=True, timeout=120
    )
    check(
        "launcher loads the fork source, not another install",
        str(FORK_DIR / "src") in info.stdout,
        info.stdout.strip().replace("\n", " | "),
    )

    tmp = Path(tempfile.mkdtemp(prefix="kicad-smoke-"))
    project = tmp / "smoke"

    async def call(session, tool: str, **kwargs) -> str:
        result = await session.call_tool(tool, kwargs)
        return "\n".join(c.text for c in result.content if getattr(c, "text", None))

    try:
        params = StdioServerParameters(command=str(LAUNCHER), args=[])
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()

                tools = await session.list_tools()
                names = {tool.name for tool in tools.tools}
                check("server exposes the KiCad tool set", len(names) >= 45, f"n={len(names)}")
                for required in ("run_erc", "export_drc_report", "add_wire", "trace_netlist_connection"):
                    check(f"tool present: {required}", required in names)

                created = await call(
                    session, "create_kicad_project", project_path=str(project), project_name="smoke"
                )
                check("create_kicad_project succeeds", created.startswith("# ✅"), created.splitlines()[0])

                schematic = str(project / "smoke.kicad_sch")
                added = await call(
                    session,
                    "add_component_from_library",
                    file_path=schematic,
                    library_name="Device",
                    symbol_name="R",
                    reference="R1",
                    value="10k",
                    footprint="Resistor_SMD:R_0805_2012Metric",
                    x=100,
                    y=80,
                )
                check("add_component_from_library succeeds", added.startswith("✅"), added.splitlines()[0])

                wire = await call(
                    session, "add_wire", file_path=schematic, points=[[10, 10], [20, 10], [20, 15]]
                )
                check("add_wire splits multi-point input", "2 segment" in wire, wire)

                erc = await call(session, "run_erc", schematic_path=schematic)
                check(
                    "run_erc reports unconnected pins instead of passing",
                    "ERC Violations Detected" in erc and "pin_not_connected" in erc,
                    erc.splitlines()[0],
                )

                report_path = tmp / "reports" / "nested" / "erc.json"
                exported = await call(
                    session,
                    "export_erc_report",
                    schematic_path=schematic,
                    output_path=str(report_path),
                )
                check("export_erc_report creates nested dirs", exported.startswith("✅"), exported.splitlines()[0])
                check("exported ERC report exists", report_path.exists(), str(report_path))
                if report_path.exists():
                    data = json.loads(report_path.read_text(encoding="utf-8"))
                    check("exported ERC report is KiCad JSON", "sheets" in data or "violations" in data)

                pcb = str(project / "smoke.kicad_pcb")
                drc_out = tmp / "drc.json"
                drc = await call(
                    session, "export_drc_report", pcb_path=pcb, output_path=str(drc_out)
                )
                check("export_drc_report is not blocked", drc.startswith("✅"), drc.splitlines()[0])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    for status, name, detail in RESULTS:
        print(f"{status:<4} {name}" + (f"  [{detail}]" if detail else ""))
    failed = sum(1 for status, _, _ in RESULTS if status == "FAIL")
    skipped = sum(1 for status, _, _ in RESULTS if status == "SKIP")
    print(f"\n{len(RESULTS) - failed - skipped} passed, {failed} failed, {skipped} skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
