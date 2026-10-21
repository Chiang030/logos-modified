"""Attach independent review conclusions for cases completed after transport recovery."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / 'runs/20261019-allcases-discovery-v1'


def load(p, default=None):
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else default


def main():
    reviews = {
        'A04': {
            'independent_accuracy_status': 'RAW_RESULTS_AND_NATIVE_REOPEN_VERIFIED_UNCONVERGED',
            'review_findings': [
                {'finding': '45/45 final Fluent case/data pairs reopened and report definitions recomputed successfully.', 'v2': 'Keep native pair reopen as artifact gate; report each checkpoint separately.'},
                {'finding': 'All five backpressure points reached 2500 iterations but strict residual/engineering stability acceptance was 0/5; 150 and 200 Pa also exceeded mass/stability limits.', 'v2': 'Separate execution completion from physical convergence; preserve checkpoint and explicit INCOMPLETE/UNCONVERGED state.'},
                {'finding': 'Original run had h5py/API/surface naming and residual seed-row repairs; direct solver resource timing was added only during rerun.', 'v2': 'Declare missing optional readers, validate zone versus surface names, de-duplicate continuation seeds, and time native solver processes.'},
            ],
        },
        'A06': {
            'independent_accuracy_status': 'NATIVE_CASE_REOPENED_RESULTS_REPRODUCED_WITH_LIMITATIONS',
            'review_findings': [
                {'finding': '4 of 8 selected checkpoints reopened before the audit Fluent session/socket failed; final report quantities were reproduced for the readable checkpoints.', 'v2': 'Bound audit cleanup and record per-file read status; do not treat partial reopen as full audit.'},
                {'finding': 'Flow and structure internal convergence evidence is present, with final node displacement about 4.206e-8 m and volume stress maximum about 4.314e5 Pa.', 'v2': 'Keep flow/structure convergence gates separate and record actual iterations after equation switching.'},
                {'finding': 'Native support reactions were unavailable; stress-integral balance is approximate. Native output is Fluent cas.h5/dat.h5 rather than MAPDL DB/RST.', 'v2': 'Allow native Fluent artifacts, require null reaction plus approximation/limitation, and never interpret zero arrays as zero reactions.'},
            ],
        },
        'A07': {
            'independent_accuracy_status': 'READINESS_INCOMPLETE_MISSING_PHYSICAL_DEFINITION',
            'review_findings': [
                {'finding': 'STEP and MSH assets were inventoried and the STEP header is parseable, but no physical case definition or reference outputs were supplied.', 'v2': 'Stop with needs_input.json after a bounded asset check; do not infer flow, material, boundary conditions, or acceptance thresholds.'},
                {'finding': 'The read-only Fluent check exceeded the 300 s case budget and timed out before a complete readiness report was written.', 'v2': 'Use a separate short asset-inspection timeout (recommended 60 s) and make timeout itself a structured readiness failure.'},
            ],
        },
    }
    for cid, data in reviews.items():
        folder = SUITE / cid
        review = {'case_id': cid, 'independent_accuracy_status': data['independent_accuracy_status'],
                  'review_findings': data['review_findings'], 'review_scope': 'Independent local review of collected native evidence; no frozen accuracy reference for CFD.'}
        (folder / 'review.json').write_text(json.dumps(review, ensure_ascii=False, indent=2), encoding='utf-8')
        metrics = load(folder / 'metrics.json', {})
        metrics['independent_accuracy_status'] = data['independent_accuracy_status']
        metrics['review_status'] = 'REVIEWED'
        (folder / 'metrics.json').write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'reviewed': sorted(reviews)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
