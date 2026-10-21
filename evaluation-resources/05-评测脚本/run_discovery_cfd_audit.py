"""Run a bounded independent CFD audit on a completed case and collect small evidence."""
import argparse
import subprocess
import tarfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SUITE=ROOT/'runs/20261019-allcases-discovery-v1'
REMOTE='/home/jiangjincheng/logos-benchmark-runs/20261019-allcases-discovery-v1'

def main():
    p=argparse.ArgumentParser();p.add_argument('case',choices=['A01','A02','A03','A04','A06']);args=p.parse_args()
    code=r'''
from pathlib import Path
import json,os,signal,subprocess,tarfile,sys
r=Path(REMOTE);cid=CASE
s=json.loads((r/'status.json').read_text())
assert cid in [x['case_id'] for x in s['cases']], 'Agent case must finish before independent audit'
dest=r/cid
with (dest/'audit-launch.log').open('wb') as log:
 p=subprocess.Popen(['/home/jiangjincheng/logos-server-20261009/logos-server/logos-agent/integrations/.venv/bin/python',str(r/'audit_discovery_fluent.py'),str(r),'--cases',cid],cwd=r,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 try:p.wait(timeout=480)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
sys.path.insert(0,str(r))
from suite_worker import cleanup
a=dest/'independent-cfd-audit';a.mkdir(exist_ok=True)
(a/'cleanup.json').write_text(json.dumps(cleanup(a)))
(a/'launcher-status.json').write_text(json.dumps({'exit_code':p.returncode}))
with tarfile.open(dest/'cfd-audit-small.tar.gz','w:gz') as t:
 for f in a.rglob('*'):
  if f.is_file() and f.suffix in ['.json','.trn','.log']:t.add(f,arcname=str(f.relative_to(dest)))
 t.add(dest/'audit-launch.log',arcname='independent-cfd-audit/audit-launch.log')
print(json.dumps({'case':cid,'audit_status':json.loads((a/'status.json').read_text()) if (a/'status.json').exists() else None,'exit_code':p.returncode}))
'''.replace('Path(REMOTE)',f'Path({REMOTE!r})').replace('cid=CASE',f'cid={args.case!r}')
    subprocess.run(['ssh','-o','BatchMode=yes','leadhk01','python3 -'],input=code.encode(),check=True)
    folder=SUITE/args.case;archive=folder/'cfd-audit-small.tar.gz'
    subprocess.run(['scp','-q','leadhk01:'+REMOTE+'/'+args.case+'/cfd-audit-small.tar.gz',str(archive)],check=True)
    with tarfile.open(archive) as t:
        for entry in t.getmembers():
            if not (folder/entry.name).resolve().is_relative_to(folder.resolve()) or entry.issym() or entry.islnk():raise ValueError('Unsafe audit archive')
        t.extractall(folder,filter='data')

if __name__=='__main__':main()
