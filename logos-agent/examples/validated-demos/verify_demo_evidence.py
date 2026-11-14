"""Check all retained evidence offline using only Python's standard library."""
from pathlib import Path
import json
import re
import runpy


def require(condition: bool, message: str) -> None:
    """Fail explicitly; validation is not disabled by Python optimization flags."""
    if not condition:
        raise RuntimeError(message)


def main() -> None:
    """Validate positive/negative solver evidence and circuit connectivity without writes."""
    root = Path(__file__).resolve().parent
    structure = runpy.run_path(str(root / 'structure/structure_demo.py'))['validate']
    cfd = runpy.run_path(str(root / 'air-pipe/check_cfd_reports.py'))['validate']
    kicad = runpy.run_path(str(root / 'kicad-led/check_kicad_full.py'))['validate']
    result = structure(root / 'structure/results')
    require(bool(result['passed']), 'Structural benchmark must pass')
    try:
        structure(root / 'structure/attempts/wrong-section')
    except RuntimeError:
        pass
    else:
        raise RuntimeError('Wrong-section structural attempt must fail')
    strict = cfd(root / 'air-pipe/results/strict/reports.json')
    fine = cfd(root / 'air-pipe/results/fine-stable/reports.json')
    failed = cfd(root / 'air-pipe/attempts/fine-failed/reports.json')
    require(bool(strict['passed']) and bool(fine['passed']), 'Both accepted CFD reports must pass')
    require(not bool(failed['passed']), 'Unconverged CFD attempt must fail')
    change = abs(fine['pressure_gradient_Pa_per_m'] - strict['pressure_gradient_Pa_per_m']) / fine['pressure_gradient_Pa_per_m']
    require(change < 0.01, 'Two-grid pressure-gradient change exceeds 1%')
    for name in ['strict', 'fine-stable']:
        text = (root / f'air-pipe/results/{name}/run.txt').read_text(encoding='utf-8')
        require('solution is converged' in text, f'{name}: convergence evidence missing')
        records = re.findall(r'^\s*\d+\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+\d+:\d+:\d+', text, re.MULTILINE)
        require(bool(records) and all(float(value) <= 1e-8 for value in records[-1]), f'{name}: final residuals exceed 1e-8')
    kicad(root / 'kicad-led/results')
    early_erc = json.loads((root / 'kicad-led/attempts/erc-first.json').read_text(encoding='utf-8'))
    early_parity = json.loads((root / 'kicad-led/attempts/drc-parity.json').read_text(encoding='utf-8'))
    require(any(sheet['violations'] for sheet in early_erc['sheets']), 'First ERC failure evidence missing')
    require(bool(early_parity['schematic_parity']), 'First parity failure evidence missing')
    print(json.dumps({'passed': True, 'structure_relative_error': result['relative_EB_error'], 'cfd_two_grid_relative_change': change, 'negative_attempts_rejected': True, 'solver_started': False}, indent=2))


if __name__ == '__main__':
    main()
