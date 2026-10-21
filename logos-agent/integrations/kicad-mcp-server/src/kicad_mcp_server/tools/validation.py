"""Design Rule Checking (DRC) and Electrical Rules Check (ERC) tools for KiCad MCP Server."""

import json
import re
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

from ..models.types import DRCError, ERCError
from ..server import mcp
from ..utils.kicad_cli import run_kicad_cli


def _temp_dir() -> Path:
    return Path(tempfile.gettempdir())


def _find_root_schematic(sch_path: Path) -> Path | None:
    """If sch_path is a sub-sheet, return the root schematic instead.

    KiCad convention: root schematic has the same stem as the .kicad_pro file.
    kicad-cli silently drops unnamed local nets when exporting from a sub-sheet,
    so we detect this and redirect to the root schematic.
    """
    pro_files = list(sch_path.parent.glob("*.kicad_pro"))
    if not pro_files:
        return None
    root_sch = pro_files[0].with_suffix(".kicad_sch")
    if root_sch.exists() and root_sch.resolve() != sch_path.resolve():
        return root_sch
    return None


def _collect_violations(data: dict) -> list[dict]:
    """Collect violations from a KiCad ERC/DRC JSON report, any layout.

    KiCad 9 wrote them as a top-level ``violations`` list. KiCad 10 kept that
    for DRC but moved ERC violations into ``sheets[].violations`` — reading
    only the top-level key made every KiCad 10 ERC report look clean ("no
    violations") even when it contained errors. Walk both layouts, and drop
    explicitly excluded (waived) entries.
    """
    collected: list[dict] = []

    top = data.get("violations")
    if isinstance(top, list):
        collected.extend(v for v in top if isinstance(v, dict))

    sheets = data.get("sheets")
    if isinstance(sheets, list):
        for sheet in sheets:
            if not isinstance(sheet, dict):
                continue
            sheet_violations = sheet.get("violations")
            if isinstance(sheet_violations, list):
                collected.extend(v for v in sheet_violations if isinstance(v, dict))

    return [v for v in collected if not v.get("excluded")]


def _report_is_fresh(report: Path, source: Path) -> bool:
    """True when ``report`` exists and is not older than ``source``."""
    try:
        return report.exists() and report.stat().st_mtime >= source.stat().st_mtime
    except OSError:
        return False


async def _generate_erc_report(sch_path: Path, reuse: bool = False) -> tuple[Path | None, str]:
    """Run kicad-cli ERC; return (report_path, error_message).

    report_path is None when the check could not be completed, so callers never
    mistake a failed run for a clean one. Any stale report from an earlier run
    of the same stem is deleted first: otherwise a previous successful run was
    parsed as if it described the current file (a broken schematic could look
    clean). Sub-sheets are redirected to the root schematic.
    """
    root = _find_root_schematic(sch_path) or sch_path
    report = _temp_dir() / (root.stem + "_erc.rpt")

    if reuse and _report_is_fresh(report, root):
        return report, ""

    try:
        report.unlink()
    except OSError:
        pass

    try:
        result = await run_kicad_cli(
            ["sch", "erc", "--format", "json", "--output", str(report), str(root)],
            timeout=180,
        )
    except FileNotFoundError as e:
        if "kicad-cli" in str(e):
            return None, (
                "kicad-cli could not be located on PATH or in the detected KiCad "
                "install directory. Install KiCad 8+ or set KICAD_CLI to the "
                "executable path."
            )
        raise

    stderr_text = result.stderr.decode("utf-8", errors="replace") if result.stderr else ""
    if result.returncode != 0:
        return None, stderr_text.strip() or "kicad-cli sch erc failed"

    if not report.exists():
        return None, (
            "kicad-cli exited cleanly but wrote no report file, so no checks "
            "could be verified. Ensure KiCad 8+ is installed and the schematic "
            "has a matching .kicad_pro project file."
        )
    return report, ""


async def _generate_drc_report(pcb: Path, reuse: bool = False) -> tuple[Path | None, str]:
    """Run kicad-cli DRC; return (report_path, error_message).

    Same contract as _generate_erc_report: report_path is None on failure and a
    stale report is never reused.
    """
    report = _temp_dir() / (pcb.stem + "_drc.rpt")

    if reuse and _report_is_fresh(report, pcb):
        return report, ""

    try:
        report.unlink()
    except OSError:
        pass

    try:
        result = await run_kicad_cli(
            ["pcb", "drc", "--format", "json", "--output", str(report), str(pcb)],
            timeout=300,
        )
    except FileNotFoundError as e:
        if "kicad-cli" in str(e):
            return None, (
                "kicad-cli could not be located on PATH or in the detected KiCad "
                "install directory. Install KiCad 8+ or set KICAD_CLI to the "
                "executable path."
            )
        raise

    stderr_text = result.stderr.decode("utf-8", errors="replace") if result.stderr else ""
    if result.returncode != 0:
        return None, stderr_text.strip() or "kicad-cli pcb drc failed"

    if not report.exists():
        return None, (
            "kicad-cli exited cleanly but wrote no DRC report file, so the "
            "board was not actually checked."
        )
    return report, ""


def _parse_erc_report(report_path: Path) -> list[ERCError]:
    """Parse ERC report file (JSON or XML format).

    Args:
        report_path: Path to ERC report file

    Returns:
        List of ERC errors/warnings
    """
    errors = []
    content = report_path.read_text(encoding="utf-8", errors="replace")

    try:
        data = json.loads(content)
        # KiCad 10 nests ERC violations under sheets[] (KiCad 9 kept them
        # top-level); _collect_violations walks both layouts.
        for v in _collect_violations(data):
            components = []
            for item in v.get("items", []):
                desc = item.get("description", "")
                # Description looks like "Pin U1 of ...": pull the reference.
                # Don't gate on the literal English word "Symbol" — localized
                # KiCad uses other words and the ref would be missed.
                m = re.search(r"\b(?:Pin|Symbol)\s+([A-Za-z]+\d+)", desc)
                if m:
                    components.append(m.group(1))
                    continue
                # Labels/net items carry no reference; surface the label name so
                # a dangling label is actionable instead of "N/A".
                lm = re.search(r"Label\s+'([^']+)'", desc)
                if lm:
                    components.append(f"label:{lm.group(1)}")
            errors.append(
                ERCError(
                    severity=v.get("severity", "error"),
                    type=v.get("type", "unknown"),
                    description=v.get("description", ""),
                    components=components,
                )
            )
        return errors
    except (json.JSONDecodeError, KeyError):
        pass

    # Fallback: XML format
    try:
        root = ET.fromstring(content)
        for violation in root.findall(".//violation"):
            severity = violation.get("severity", "error")
            error_type = violation.get("type", "unknown")
            description = violation.get("description", "")

            components = []
            for comp in violation.findall(".//component"):
                ref = comp.get("ref", "")
                if ref:
                    components.append(ref)

            errors.append(
                ERCError(
                    severity=severity,
                    type=error_type,
                    description=description,
                    components=components,
                )
            )
    except ET.ParseError as e:
        errors.append(
            ERCError(
                severity="error",
                type="parse_error",
                description=f"Failed to parse ERC report: {str(e)}",
                components=[],
            )
        )

    return errors


def _parse_drc_report(report_path: Path) -> list[DRCError]:
    """Parse DRC report file (JSON or XML format).

    Args:
        report_path: Path to DRC report file

    Returns:
        List of DRC errors/warnings
    """
    errors = []
    content = report_path.read_text(encoding="utf-8", errors="replace")

    try:
        data = json.loads(content)
        # DRC keeps a top-level list today, ERC nests per sheet; the collector
        # handles both so a layout change cannot silently report "clean".
        for v in _collect_violations(data):
            x, y = 0.0, 0.0
            items = v.get("items", [])
            if items:
                pos = items[0].get("pos", {})
                x = float(pos.get("x", 0))
                y = float(pos.get("y", 0))

            errors.append(
                DRCError(
                    severity=v.get("severity", "error"),
                    type=v.get("type", "unknown"),
                    description=v.get("description", ""),
                    location=(x, y),
                )
            )
        return errors
    except (json.JSONDecodeError, KeyError):
        pass

    # Fallback: XML format
    try:
        root = ET.fromstring(content)
        for violation in root.findall(".//violation"):
            severity = violation.get("severity", "error")
            error_type = violation.get("type", "unknown")
            description = violation.get("description", "")

            location_elem = violation.find(".//location")
            x = float(location_elem.get("x", "0")) if location_elem is not None else 0.0
            y = float(location_elem.get("y", "0")) if location_elem is not None else 0.0

            errors.append(
                DRCError(
                    severity=severity,
                    type=error_type,
                    description=description,
                    location=(x, y),
                )
            )
    except ET.ParseError as e:
        errors.append(
            DRCError(
                severity="error",
                type="parse_error",
                description=f"Failed to parse DRC report: {str(e)}",
                location=(0.0, 0.0),
            )
        )

    return errors


def _filter_erc_errors(errors: list[ERCError], severity: str = "") -> list[ERCError]:
    """Filter ERC errors by severity.

    Args:
        errors: List of ERC errors
        severity: Severity filter ('error', 'warning', '') for all

    Returns:
        Filtered list of ERC errors
    """
    if not severity:
        return errors

    return [e for e in errors if e.severity == severity]


def _filter_drc_errors(errors: list[DRCError], violation_type: str = "") -> list[DRCError]:
    """Filter DRC errors by type.

    Args:
        errors: List of DRC errors
        violation_type: Type filter (e.g., 'clearance', 'spacing', '') for all

    Returns:
        Filtered list of DRC errors
    """
    if not violation_type:
        return errors

    return [e for e in errors if e.type == violation_type]


@mcp.tool()
async def run_erc(
    schematic_path: str,
) -> str:
    """Run Electrical Rules Check (ERC) on schematic.

    Checks for:
    - Unconnected pins
    - Power conflicts
    - Multiple outputs on same net
    - Pin type mismatches

    Args:
        schematic_path: Path to .kicad_sch file

    Returns:
        ERC report with violations and recommendations
    """
    try:
        sch_path = Path(schematic_path)
        if not sch_path.exists():
            return f"❌ **Schematic file not found:** {schematic_path}"

        # Detect sub-sheet and redirect to root schematic
        subsheet_note = ""
        root_sch = _find_root_schematic(sch_path)
        if root_sch:
            subsheet_note = (
                f"\n\n⚠️ **Note:** `{sch_path.name}` is a hierarchical sub-sheet. "
                f"Switched to root schematic `{root_sch.name}` for complete ERC check."
            )
            sch_path = root_sch

        # ERC report path (sub-sheets are redirected to the root stem inside the
        # helper). A failed run returns None instead of a stale report.
        erc_report_path, erc_failure = await _generate_erc_report(sch_path)

        if erc_report_path is None:
            return f"""❌ **ERC Check Failed**

**Schematic:** {schematic_path}

**Error:**
```
{erc_failure}
```

**Possible causes:**
- KiCad command line tools not available or too old
- Invalid schematic file (run `kicad-cli sch erc` directly to see the parse error)
- Missing project file (.kicad_pro)

**Manual steps:**
1. Open schematic in KiCad Eeschema
2. Run: Inspect → Electrical Rules Checker
3. Export report manually{subsheet_note}"""

        # Parse and format results
        try:
            errors = _parse_erc_report(erc_report_path)

            if not errors:
                return f"""✅ **ERC Check Passed**

**Schematic:** {schematic_path}

No electrical violations detected!{subsheet_note}"""

            # Count by severity
            error_count = sum(1 for e in errors if e.severity == "error")
            warning_count = sum(1 for e in errors if e.severity == "warning")

            # Format violations
            violations_table = "| Severity | Type | Description | Components |\n"
            violations_table += "|----------|------|-------------|------------|\n"

            for error in errors[:20]:  # Limit to first 20
                severity_icon = "❌" if error.severity == "error" else "⚠️"
                components_str = ", ".join(error.components) if error.components else "N/A"
                violations_table += f"| {severity_icon} {error.severity} | {error.type} | {error.description[:50]} | {components_str} |\n"

            if len(errors) > 20:
                violations_table += f"\n*... and {len(errors) - 20} more violations*\n"

            return f"""❌ **ERC Violations Detected**

**Schematic:** {schematic_path}
**Total Violations:** {len(errors)}
- Errors: {error_count}
- Warnings: {warning_count}{subsheet_note}

## Violations

{violations_table}

## Recommendations

1. **Fix all errors** before proceeding to PCB layout
2. Review warnings - some may be acceptable
3. Re-run ERC after fixes
4. Use `get_erc_violations()` for detailed filtering

## Next Steps

- Run `get_erc_violations()` with filters to analyze specific issues
- Fix violations in KiCad Eeschema
- Re-run `run_erc()` to verify fixes"""

        except Exception as e:
            return f"""⚠️ **ERC Report Parse Error**

**Schematic:** {schematic_path}

ERC check completed but failed to parse report.

**Error:** {str(e)}

**Report location:** {erc_report_path}

You can manually inspect the report file or re-run ERC in KiCad GUI.{subsheet_note}"""

    except FileNotFoundError as e:
        # Distinguish kicad-cli missing (raised by subprocess) from a missing
        # schematic file (already checked at the top of the function).
        if "kicad-cli" in str(e):
            return f"""❌ **kicad-cli Not Found**

**Schematic:** {schematic_path}

KiCad's command-line tool (kicad-cli) could not be located on PATH or in the
detected KiCad install directory. Install KiCad 7+ (https://www.kicad.org/),
or point the KICAD_CLI environment variable at the kicad-cli executable."""
        return f"""❌ **File Not Found**

**Schematic:** {schematic_path}

{e}
Please check the file path and try again."""
    except Exception as e:
        import traceback

        return f"""❌ **Unexpected Error**

**Schematic:** {schematic_path}

**Error:** {str(e)}

**Traceback:**
```
{traceback.format_exc()}
```"""


@mcp.tool()
async def run_drc(
    pcb_path: str,
) -> str:
    """Run Design Rules Check (DRC) on PCB.

    Checks for:
    - Clearance violations
    - Track spacing violations
    - Missing connections
    - Pad/footprint overlaps
    - Board edge constraints

    Args:
        pcb_path: Path to .kicad_pcb file

    Returns:
        DRC report with violations and locations
    """
    try:
        pcb = Path(pcb_path)
        if not pcb.exists():
            return f"❌ **PCB file not found:** {pcb_path}"

        # DRC report path; a failed run returns None instead of a stale report.
        drc_report_path, drc_failure = await _generate_drc_report(pcb)

        if drc_report_path is None:
            return f"""❌ **DRC Check Failed**

**PCB:** {pcb_path}

**Error:**
```
{drc_failure}
```

**Possible causes:**
- KiCad command line tools not available or too old
- Invalid PCB file (run `kicad-cli pcb drc` directly to see the parse error)
- Missing design rules

**Manual steps:**
1. Open PCB in KiCad Pcbnew
2. Run: Inspect → Design Rules Checker
3. Export report manually"""

        # Parse and format results
        try:
            errors = _parse_drc_report(drc_report_path)

            if not errors:
                return f"""✅ **DRC Check Passed**

**PCB:** {pcb_path}

No design rule violations detected!"""

            # Count by severity
            error_count = sum(1 for e in errors if e.severity == "error")
            warning_count = sum(1 for e in errors if e.severity == "warning")

            # Group by type
            type_counts = {}
            for error in errors:
                type_counts[error.type] = type_counts.get(error.type, 0) + 1

            # Format violations
            violations_table = "| Severity | Type | Location | Description |\n"
            violations_table += "|----------|------|----------|-------------|\n"

            for error in errors[:20]:  # Limit to first 20
                severity_icon = "❌" if error.severity == "error" else "⚠️"
                x, y = error.location
                violations_table += f"| {severity_icon} {error.severity} | {error.type} | ({x:.2f}, {y:.2f}) | {error.description[:40]} |\n"

            if len(errors) > 20:
                violations_table += f"\n*... and {len(errors) - 20} more violations*\n"

            # Format type summary
            type_summary = "\n## Violation Summary\n\n"
            for vtype, count in sorted(type_counts.items()):
                type_summary += f"- **{vtype}**: {count} violations\n"

            return f"""❌ **DRC Violations Detected**

**PCB:** {pcb_path}
**Total Violations:** {len(errors)}
- Errors: {error_count}
- Warnings: {warning_count}

{type_summary}
## Violations

{violations_table}

## Recommendations

1. **Fix all errors** before manufacturing
2. Review warnings - some may be acceptable
3. Pay attention to clearance violations
4. Re-run DRC after fixes
5. Use `get_drc_violations()` for detailed filtering

## Next Steps

- Run `get_drc_violations()` with filters to analyze specific issues
- Fix violations in KiCad Pcbnew
- Re-run `run_drc()` to verify fixes"""

        except Exception as e:
            return f"""⚠️ **DRC Report Parse Error**

**PCB:** {pcb_path}

DRC check completed but failed to parse report.

**Error:** {str(e)}

**Report location:** {drc_report_path}

You can manually inspect the report file or re-run DRC in KiCad GUI."""

    except FileNotFoundError:
        return f"""❌ **File Not Found**

**PCB:** {pcb_path}

Please check the file path and try again."""
    except Exception as e:
        import traceback

        return f"""❌ **Unexpected Error**

**PCB:** {pcb_path}

**Error:** {str(e)}

**Traceback:**
```
{traceback.format_exc()}
```"""


@mcp.tool()
async def get_erc_violations(
    schematic_path: str,
    severity: str = "",
) -> str:
    """Get filtered ERC violations from schematic.

    Args:
        schematic_path: Path to .kicad_sch file
        severity: Filter by severity ('error', 'warning', '') for all

    Returns:
        Filtered list of ERC violations
    """
    try:
        sch_path = Path(schematic_path)
        if not sch_path.exists():
            return f"❌ **Schematic file not found:** {schematic_path}"

        # Generate (or reuse a fresh) report. Failures come back as None, so a
        # failed run can no longer be mistaken for "no violations".
        erc_report_path, erc_failure = await _generate_erc_report(sch_path, reuse=True)

        if erc_report_path is None:
            return f"""❌ **ERC Check Failed**

**Schematic:** {schematic_path}

**Error:**
```
{erc_failure}
```"""

        errors = _parse_erc_report(erc_report_path)

        if not errors:
            return f"""✅ **No ERC Violations**

**Schematic:** {schematic_path}

No electrical violations detected."""

        # Apply filter
        filtered_errors = _filter_erc_errors(errors, severity)

        if not filtered_errors:
            return f"""✅ **No Matching Violations**

**Schematic:** {schematic_path}
**Filter:** severity = '{severity or 'all'}'

No violations match the specified filter."""

        # Format results
        result = f"""# ERC Violations

**Schematic:** {schematic_path}
**Filter:** severity = '{severity or 'all'}'
**Count:** {len(filtered_errors)}

## Violations

| Severity | Type | Description | Components |
|----------|------|-------------|------------|
"""

        for error in filtered_errors:
            severity_icon = "❌" if error.severity == "error" else "⚠️"
            components_str = ", ".join(error.components) if error.components else "N/A"
            result += f"| {severity_icon} {error.severity} | {error.type} | {error.description} | {components_str} |\n"

        return result

    except Exception as e:
        import traceback

        return f"""❌ **Error**

**Schematic:** {schematic_path}

**Error:** {str(e)}

**Traceback:**
```
{traceback.format_exc()}
```"""


@mcp.tool()
async def get_drc_violations(
    pcb_path: str,
    violation_type: str = "",
) -> str:
    """Get filtered DRC violations from PCB.

    Args:
        pcb_path: Path to .kicad_pcb file
        violation_type: Filter by type (e.g., 'clearance', 'spacing', '') for all

    Returns:
        Filtered list of DRC violations
    """
    try:
        pcb = Path(pcb_path)
        if not pcb.exists():
            return f"❌ **PCB file not found:** {pcb_path}"

        # Generate (or reuse a fresh) report; warnings must NOT be treated as a
        # failed check (that blocked report export for every real board).
        drc_report_path, drc_failure = await _generate_drc_report(pcb, reuse=True)

        if drc_report_path is None:
            return f"""❌ **DRC Check Failed**

**PCB:** {pcb_path}

**Error:**
```
{drc_failure}
```"""

        errors = _parse_drc_report(drc_report_path)

        if not errors:
            return f"""✅ **No DRC Violations**

**PCB:** {pcb_path}

No design rule violations detected."""

        # Apply filter
        filtered_errors = _filter_drc_errors(errors, violation_type)

        if not filtered_errors:
            return f"""✅ **No Matching Violations**

**PCB:** {pcb_path}
**Filter:** type = '{violation_type or 'all'}'

No violations match the specified filter."""

        # Format results
        result = f"""# DRC Violations

**PCB:** {pcb_path}
**Filter:** type = '{violation_type or 'all'}'
**Count:** {len(filtered_errors)}

## Violations

| Severity | Type | Location | Description |
|----------|------|----------|-------------|
"""

        for error in filtered_errors:
            severity_icon = "❌" if error.severity == "error" else "⚠️"
            x, y = error.location
            result += f"| {severity_icon} {error.severity} | {error.type} | ({x:.2f}, {y:.2f}) | {error.description} |\n"

        return result

    except Exception as e:
        import traceback

        return f"""❌ **Error**

**PCB:** {pcb_path}

**Error:** {str(e)}

**Traceback:**
```
{traceback.format_exc()}
```"""


@mcp.tool()
async def export_erc_report(
    schematic_path: str,
    output_path: str = "",
) -> str:
    """Export ERC report to file.

    Args:
        schematic_path: Path to .kicad_sch file
        output_path: Optional output file path (default: schematic_name_erc.txt)

    Returns:
        Confirmation with output file location
    """
    try:
        sch_path = Path(schematic_path)
        if not sch_path.exists():
            return f"❌ **Schematic file not found:** {schematic_path}"

        # Run ERC (reusing a fresh report) — never via the markdown tool, whose
        # ❌/⚠️ prefixes cannot distinguish "violations" from "check failed".
        erc_report_path, erc_failure = await _generate_erc_report(sch_path, reuse=True)

        if erc_report_path is None:
            return f"""❌ **ERC Check Failed**

**Schematic:** {schematic_path}

**Error:**
```
{erc_failure}
```"""

        # Determine output path
        if not output_path:
            output_path = str(sch_path.parent / (sch_path.stem + "_erc_report.json"))

        output = Path(output_path)

        # Create parent directories so an arbitrary output path works
        output.parent.mkdir(parents=True, exist_ok=True)

        import shutil

        shutil.copy(erc_report_path, output)

        errors = _parse_erc_report(output)
        error_count = sum(1 for e in errors if e.severity == "error")
        warning_count = sum(1 for e in errors if e.severity == "warning")

        return f"""✅ **ERC Report Exported**

**Schematic:** {schematic_path}
**Output:** {output} (KiCad ERC JSON)
**Violations:** {len(errors)} total — {error_count} error(s), {warning_count} warning(s)"""

    except Exception as e:
        import traceback

        return f"""❌ **Export Failed**

**Schematic:** {schematic_path}
**Output:** {output_path}

**Error:** {str(e)}

**Traceback:**
```
{traceback.format_exc()}
```"""


@mcp.tool()
async def export_drc_report(
    pcb_path: str,
    output_path: str = "",
) -> str:
    """Export DRC report to file.

    Args:
        pcb_path: Path to .kicad_pcb file
        output_path: Optional output file path (default: pcb_name_drc.txt)

    Returns:
        Confirmation with output file location
    """
    try:
        pcb = Path(pcb_path)
        if not pcb.exists():
            return f"❌ **PCB file not found:** {pcb_path}"

        # Run DRC (reusing a fresh report); warnings are findings, not failures.
        drc_report_path, drc_failure = await _generate_drc_report(pcb, reuse=True)

        if drc_report_path is None:
            return f"""❌ **DRC Check Failed**

**PCB:** {pcb_path}

**Error:**
```
{drc_failure}
```"""

        # Determine output path
        if not output_path:
            output_path = str(pcb.parent / (pcb.stem + "_drc_report.json"))

        output = Path(output_path)

        # Create parent directories so an arbitrary output path works
        output.parent.mkdir(parents=True, exist_ok=True)

        import shutil

        shutil.copy(drc_report_path, output)

        errors = _parse_drc_report(output)
        error_count = sum(1 for e in errors if e.severity == "error")
        warning_count = sum(1 for e in errors if e.severity == "warning")

        return f"""✅ **DRC Report Exported**

**PCB:** {pcb_path}
**Output:** {output} (KiCad DRC JSON)
**Violations:** {len(errors)} total — {error_count} error(s), {warning_count} warning(s)"""

    except Exception as e:
        import traceback

        return f"""❌ **Export Failed**

**PCB:** {pcb_path}
**Output:** {output_path}

**Error:** {str(e)}

**Traceback:**
```
{traceback.format_exc()}
```"""
