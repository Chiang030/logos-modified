"""Safely continue only pending cases after a supervisor/transport interruption."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent


def owned(root):
    result = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        try:
            cwd = Path(os.readlink(proc / 'cwd'))
            if cwd == root or root in cwd.parents:
                stat = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
                if stat[0] != 'Z':
                    result.append((int(proc.name), stat[19]))
        except OSError:
            pass
    return result


def cleanup(root):
    targets = owned(root)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid, start in targets:
            try:
                stat = (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()
                if stat[19] == start:
                    os.kill(pid, sig)
            except (OSError, ProcessLookupError):
                pass
        if sig == signal.SIGTERM and targets:
            time.sleep(3)
    return {'terminated_run_owned_pids': [p for p, _ in targets], 'remaining': owned(root)}


def main():
    suite = json.loads((ROOT / 'suite.json').read_text())
    status_path = ROOT / 'status.json'
    status = json.loads(status_path.read_text())
    pending = ['A06', 'A07']
    resume = {'started_unix': time.time(), 'cases': [], 'active': None, 'finished': False}

    def save():
        (ROOT / 'resume-status.json').write_text(json.dumps(resume, ensure_ascii=False, indent=2))

    for cid in pending:
        spec = next(x for x in suite['cases'] if x['id'] == cid)
        folder = ROOT / cid
        summary_path = folder / 'evidence' / 'run-summary.json'
        if summary_path.exists():
            resume['cases'].append({'case_id': cid, 'skipped': True, 'reason': 'existing run-summary'})
            continue
        before = owned(folder)
        if before:
            raise RuntimeError(f'{cid} has owned processes before launch: {before}')
        resume['active'] = cid
        save()
        start = time.time()
        with (folder / 'controller.log').open('wb') as log:
            proc = subprocess.Popen([sys.executable, str(folder / 'run_discovery_case.py')], cwd=folder,
                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            timed_out = False
            while proc.poll() is None:
                if time.time() - start > spec['budget_seconds'] + 180:
                    timed_out = True
                    try:
                        os.killpg(proc.pid, signal.SIGTERM)
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait()
                    break
                time.sleep(2)
        clean = cleanup(folder)
        (folder / 'cleanup.json').write_text(json.dumps(clean, indent=2))
        summary = json.loads(summary_path.read_text()) if summary_path.exists() else {}
        row = {'case_id': cid, 'controller_exit': proc.returncode,
               'supervisor_timeout': timed_out, 'wall_seconds': time.time() - start,
               'settled': summary.get('settled', False), 'timed_out': summary.get('timed_out', False),
               'needs_input': summary.get('needs_input', False),
               'controller_error': summary.get('controller_error'), 'cleanup': clean}
        resume['cases'].append(row)
        status.setdefault('cases', []).append(row)
        status['active'] = cid
        status_path.write_text(json.dumps(status, ensure_ascii=False, indent=2))
        save()
        if clean['remaining']:
            resume['halt_reason'] = 'Owned processes remain; no further case launched'
            break
    resume['active'] = None
    resume['finished'] = len(resume['cases']) == len(pending)
    resume['ended_unix'] = time.time()
    status['active'] = None
    status['finished'] = all(any(x.get('case_id') == c for x in status.get('cases', [])) for c in [x['id'] for x in suite['cases']])
    status_path.write_text(json.dumps(status, ensure_ascii=False, indent=2))
    save()
    print(json.dumps(resume, ensure_ascii=False))


if __name__ == '__main__':
    main()
