"""Read compact progress only; never send a followup to the measured agent."""
import json
import subprocess
import sys

CODE = r'''
import json
from pathlib import Path
r=Path('/home/jiangjincheng/logos-benchmark-runs/20261019-allcases-discovery-v1')
s=json.loads((r/'status.json').read_text())
out={'finished':s['finished'],'completed':len(s['cases']),'active':s['active']}
if s['active']:
 p=r/s['active']/'evidence/events.jsonl'
 texts=[];errors=[];last=None
 if p.exists():
  for line in p.read_text().splitlines():
   try:item=json.loads(line)
   except ValueError:continue
   last=item.get('elapsed_s');e=item.get('record',{})
   if e.get('type')=='message_end' and e.get('message',{}).get('role')=='assistant':
    t='\n'.join(c.get('text','') for c in e['message'].get('content',[]) if c.get('type')=='text')
    if t:texts.append({'seconds':last,'text':t})
   if e.get('type')=='tool_execution_end' and e.get('isError'):
    errors.append({'seconds':last,'result':str(e.get('result'))[-1500:]})
 out.update(last_event_seconds=last,recent_text=texts[-2:],tool_error_count=len(errors),recent_errors=errors[-2:])
print(json.dumps(out,ensure_ascii=False))
'''

if __name__ == '__main__':
    p=subprocess.run(['ssh','-o','BatchMode=yes','leadhk01','python3 -'],input=CODE.encode(),capture_output=True,timeout=30)
    if p.returncode:raise RuntimeError(p.stderr.decode(errors='replace'))
    result=json.loads(p.stdout)
    if '--errors' not in sys.argv:
        result.pop('recent_errors',None)
        result['recent_text']=result.get('recent_text',[])[-1:]
    print(json.dumps(result,ensure_ascii=False,indent=2))
