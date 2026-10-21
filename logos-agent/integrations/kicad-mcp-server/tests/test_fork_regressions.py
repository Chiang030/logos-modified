#!/usr/bin/env python3
"""Offline regression checks for the LOGOS kicad-mcp-server fork.

Covers every patch listed in NOTICE. Self-contained: fixtures are generated in a
temporary directory, so it runs on any host with KiCad installed.

    python3 integrations/kicad-mcp-server/tests/test_fork_regressions.py

Exit code 0 means every check passed. `kicad-cli` is optional; checks that need
it are skipped (and reported) when it is missing.
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
sys.path.insert(0, str(FORK_DIR / "src"))

from kicad_mcp_server.parsers.netlist_parser import NetlistParser  # noqa: E402
from kicad_mcp_server.parsers.schematic_parser import SchematicParser  # noqa: E402
from kicad_mcp_server.tools import netlist as netlist_tools  # noqa: E402
from kicad_mcp_server.tools import project as project_tools  # noqa: E402
from kicad_mcp_server.tools import schematic_editor as editor  # noqa: E402
from kicad_mcp_server.tools import validation as validation  # noqa: E402

EMPTY_SCHEMATIC = """(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "0d911911-da14-4f38-8df4-18ae21fa73af")
\t(paper "A4")
\t(title_block
\t\t(title "fixture")
\t\t(date "2026-10-21"))
\t(lib_symbols)
\t(sheet_instances
\t\t(path "/"
\t\t\t(page "1")))
\t(embedded_fonts no)
)
"""

RESULTS: list[tuple[str, str, str]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    RESULTS.append(("PASS" if passed else "FAIL", name, detail))


def skip(name: str, why: str) -> None:
    RESULTS.append(("SKIP", name, why))


def have_kicad_cli() -> bool:
    return shutil.which("kicad-cli") is not None


def kicad_cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["kicad-cli", *args], capture_output=True, text=True, timeout=300)


def fixture_schematic(tmp: Path, name: str = "fixture") -> Path:
    sch = tmp / f"{name}.kicad_sch"
    sch.write_text(EMPTY_SCHEMATIC, encoding="utf-8")
    return sch


# --- 1. ERC report layouts -------------------------------------------------
def check_erc_layouts(tmp: Path) -> None:
    kicad9 = tmp / "v9.json"
    kicad9.write_text(
        json.dumps(
            {
                "violations": [
                    {"severity": "error", "type": "x", "items": [{"description": "Symbol U9 Pin 1"}]}
                ]
            }
        ),
        encoding="utf-8",
    )
    ERRORS_V9 = validation._parse_erc_report(kicad9)
    check("ERC reads KiCad 9 top-level violations", len(ERRORS_V9) == 1)
    check("ERC extracts reference from item", ERRORS_V9[0].components == ["U9"])

    kicad10 = tmp / "v10.json"
    kicad10.write_text(
        json.dumps(
            {
                "included_severities": ["error", "warning"],
                "sheets": [
                    {
                        "path": "/",
                        "violations": [
                            {"severity": "error", "type": "power_pin_not_driven", "items": [{"description": "Symbol U1 Pin 1"}]},
                            {"severity": "warning", "type": "endpoint_off_grid", "items": []},
                            {"severity": "error", "type": "waived", "excluded": True, "items": []},
                        ],
                    },
                    {
                        "path": "/sub",
                        "violations": [
                            {"severity": "error", "type": "label_dangling", "items": [{"description": "Label 'N1'"}]}
                        ],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    ERRORS_V10 = validation._parse_erc_report(kicad10)
    # sheet "/" keeps error + warning (the third entry is excluded), sheet "/sub" keeps 1
    check("ERC reads KiCad 10 sheets[] violations", len(ERRORS_V10) == 3, f"n={len(ERRORS_V10)}")
    severities = sorted(e.severity for e in ERRORS_V10)
    check(
        "ERC keeps every sheet's severities",
        severities == ["error", "error", "warning"],
        str(severities),
    )
    check(
        "ERC drops excluded entries",
        all(e.type != "waived" for e in ERRORS_V10),
    )
    check(
        "ERC surfaces dangling label name",
        any("label:N1" in e.components for e in ERRORS_V10),
    )


# --- 2. DRC report + failure contract --------------------------------------
def check_drc_and_failures(tmp: Path) -> None:
    drc = tmp / "drc.json"
    drc.write_text(
        json.dumps(
            {
                "violations": [
                    {
                        "severity": "warning",
                        "type": "silk_over_copper",
                        "items": [{"pos": {"x": 1.5, "y": 2.5}}],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    parsed = validation._parse_drc_report(drc)
    check("DRC parses top-level violations", len(parsed) == 1)
    check("DRC keeps item location", parsed[0].location == (1.5, 2.5), str(parsed[0].location))

    broken = tmp / "broken.kicad_sch"
    broken.write_text("(kicad_sch (version 20250114) (broken", encoding="utf-8")
    if not have_kicad_cli():
        skip("failed run returns None", "kicad-cli missing")
        return
    report, error = asyncio.run(validation._generate_erc_report(broken))
    check("failed run returns None + message", report is None and bool(error), str(error)[:60])


# --- 3. add_wire ------------------------------------------------------------
def check_add_wire(tmp: Path) -> None:
    sch = fixture_schematic(tmp, "wire")
    message = asyncio.run(editor.add_wire(str(sch), [[10, 10], [20, 10], [20, 15], [15, 15]]))
    text = sch.read_text(encoding="utf-8")
    segments = [ln for ln in text.splitlines() if "wire (pts" in ln]
    check("add_wire reports segments", "3 segment" in message, message)
    check("add_wire writes 3 segments", len(segments) == 3, f"n={len(segments)}")
    check(
        "every wire segment has two points",
        all(ln.count("(xy ") == 2 for ln in segments),
    )
    check("add_wire keeps parentheses balanced", text.count("(") == text.count(")"))

    bad = asyncio.run(editor.add_wire(str(sch), [[5, 5], [5, 5]]))
    check("add_wire rejects degenerate input", bad.startswith("Error"), bad)

    if have_kicad_cli():
        report = tmp / "wire_erc.json"
        proc = kicad_cli("sch", "erc", "--format", "json", "--output", str(report), str(sch))
        check(
            "edited schematic still loads in KiCad",
            proc.returncode == 0 and report.exists(),
            proc.stderr.strip()[:80],
        )


# --- 4. derived symbols -----------------------------------------------------
def check_extends(tmp: Path) -> None:
    from kicad_mcp_server.utils.kicad_version import get_kicad_symbol_dir

    lib_dir = get_kicad_symbol_dir()
    lib = lib_dir / "Regulator_Linear.kicad_sym" if lib_dir else None
    if not lib or not lib.exists():
        skip("extends flattening", "Regulator_Linear library not installed")
        return

    text = lib.read_text(encoding="utf-8", errors="replace")
    flat = editor._flatten_symbol_extends(text, "LP2985-3.3")
    check("extends flattened", flat is not None and "extends" not in flat)
    pins = editor._extract_pins_from_symbol_block(flat)
    check("derived symbol keeps 5 pins", len(pins) == 5, f"n={len(pins)}")
    check("derived definition renamed", '(symbol "LP2985-3.3"' in flat)
    check("parent units renamed", '"LP2985-1.8_' not in flat)

    sch = fixture_schematic(tmp, "derived")
    message = asyncio.run(
        editor.add_component_from_library(
            str(sch), "Regulator_Linear", "LP2985-3.3", "U2", "3V3", "", 120.0, 90.0
        )
    )
    check("derived component inserted", message.startswith("✅"), message.splitlines()[0])
    check("derived component reports 5 pins", "5 pins detected" in message)

    if have_kicad_cli():
        net = tmp / "derived.xml"
        proc = kicad_cli(
            "sch", "export", "netlist", "--format", "kicadxml", "--output", str(net), str(sch)
        )
        if proc.returncode == 0 and net.exists():
            parser = NetlistParser(str(net))
            pins = parser.get_components()["U2"].pins
            check("KiCad netlist keeps 5 derived pins", len(pins) == 5, f"n={len(pins)}")
        else:
            skip("KiCad netlist keeps 5 derived pins", proc.stderr.strip()[:60])


# --- 5. symbol position -----------------------------------------------------
def check_position(tmp: Path) -> None:
    sch = fixture_schematic(tmp, "position")
    asyncio.run(
        editor.add_component_from_library(
            str(sch), "Device", "R", "R9", "1k", "Resistor_SMD:R_0805_2012Metric", 133.5, 77.25
        )
    )
    component = SchematicParser(str(sch)).get_component_by_reference("R9")
    check(
        "symbol position parsed from inline (at ...)",
        component is not None and component.position == (133.5, 77.25),
        str(component.position if component else None),
    )


# --- 6. netlist trace -------------------------------------------------------
def check_netlist_trace(tmp: Path) -> None:
    sch = fixture_schematic(tmp, "trace")
    asyncio.run(
        editor.add_component_from_library(
            str(sch), "Device", "R", "R1", "10k", "Resistor_SMD:R_0805_2012Metric", 100, 80
        )
    )
    asyncio.run(
        editor.add_component_from_library(
            str(sch), "Device", "C", "C1", "100nF", "Capacitor_SMD:C_0805_2012Metric", 100, 100
        )
    )
    for reference, pin, label in (("R1", "1", "VIN"), ("R1", "2", "VOUT"), ("C1", "1", "VOUT")):
        asyncio.run(editor.add_global_label(str(sch), reference, pin, label))

    if not have_kicad_cli():
        skip("netlist trace handles multi-pin nets", "kicad-cli missing")
        return

    net = tmp / "trace.xml"
    proc = kicad_cli("sch", "export", "netlist", "--format", "kicadxml", "--output", str(net), str(sch))
    if proc.returncode != 0 or not net.exists():
        skip("netlist trace handles multi-pin nets", proc.stderr.strip()[:60])
        return

    output = asyncio.run(netlist_tools.trace_netlist_connection(str(net), "R1"))
    check("netlist trace does not crash", not output.startswith("❌"), output.splitlines()[0])
    check("netlist trace lists both nets", "VIN" in output and "VOUT" in output)

    single = asyncio.run(netlist_tools.trace_netlist_connection(str(net), "R1", "2"))
    check("netlist trace single pin", "VOUT" in single and "C1" in single)


# --- 7. project library tables ---------------------------------------------
def check_project_tables(tmp: Path) -> None:
    if project_tools._global_lib_table_is_populated("sym-lib-table"):
        skip("project writes library tables", "host already has a populated global table")
        return
    target = tmp / "proj"
    written = project_tools._write_project_lib_tables(target)
    check("project writes library tables", bool(written), str(written))
    for name in written:
        text = (target / name).read_text(encoding="utf-8")
        check(f"{name} is valid", text.startswith("(") and text.rstrip().endswith(")"))


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="kicad-fork-test-"))
    try:
        check_erc_layouts(tmp)
        check_drc_and_failures(tmp)
        check_add_wire(tmp)
        check_extends(tmp)
        check_position(tmp)
        check_netlist_trace(tmp)
        check_project_tables(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    for status, name, detail in RESULTS:
        print(f"{status:<4} {name}" + (f"  [{detail}]" if detail else ""))
    failed = sum(1 for status, _, _ in RESULTS if status == "FAIL")
    skipped = sum(1 for status, _, _ in RESULTS if status == "SKIP")
    print(f"\n{len(RESULTS) - failed - skipped} passed, {failed} failed, {skipped} skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
