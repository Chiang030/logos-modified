"""Check local frozen inputs, measured artifact hashes, runtime fingerprints and cleanup."""
import hashlib
import json
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
SUITE=ROOT/'runs/20261019-allcases-discovery-v1'

def read(p,default=None):
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else default

def main():
    spec=read(SUITE/'suite.json');rows=[];fingerprints=[];flags=[]
    for case in spec['cases']:
        cid=case['id'];r=SUITE/cid;m=read(r/'metrics.json')
        if not m:continue
        frozen=read(r/'freeze.json');e=r/'collected/evidence';w=r/'collected/workspace'
        checks={n:hashlib.sha256((r/n).read_bytes()).hexdigest()==frozen[n] for n in ['prompt.md','run-config.json']}
        vm=read(e/'version-manifest.json',{})
        fingerprints.append({'case_id':cid,'files':vm.get('files'),'node_version':vm.get('node_version'),'model':m.get('model_id'),'thinking':m.get('thinking_level')})
        manifest=read(r/'collected/collection-manifest.json',read(e/'artifact-manifest.json',[]));bad=[]
        for f in manifest:
            p=w/f['path']
            if not p.is_file() or p.is_symlink() or not p.resolve().is_relative_to(w.resolve()) or hashlib.sha256(p.read_bytes()).hexdigest()!=f['sha256']:bad.append(f['path'])
        cleanup=read(r/'collected/cleanup.json',{})
        rows.append({'case_id':cid,'frozen_inputs_unchanged':all(checks.values()),'artifact_files':len(manifest),'artifact_hash_mismatches':bad,'cleanup':cleanup,'has_review':(r/'review.json').exists()})
        events=e/'events.jsonl'
        if events.exists():
            for line in events.read_text(encoding='utf-8').splitlines():
                try:item=json.loads(line)
                except ValueError:continue
                event=item.get('record',{})
                if event.get('type')!='tool_execution_start':continue
                args=json.dumps(event.get('args',{}),ensure_ascii=False)
                for pattern,kind in [(r'reference_only[/\\]','answer_directory'),(r'20261019-vm002-eff59c04','previous_pilot'),(r'\b(?:curl|wget)\s','external_download_command')]:
                    if re.search(pattern,args):flags.append({'case_id':cid,'elapsed_s':item.get('elapsed_s'),'kind':kind,'tool':event.get('toolName'),'tool_call_id':event.get('toolCallId')})
    same=bool(fingerprints) and all({k:v for k,v in x.items() if k!='case_id'}=={k:v for k,v in fingerprints[0].items() if k!='case_id'} for x in fingerprints)
    report={'cases_checked':len(rows),'expected_cases':len(spec['cases']),'all_collected':len(rows)==len(spec['cases']),'same_recorded_runtime_fingerprint':same,'fingerprint_scope':'Recorded launcher/system prompts/extensions/skill entry files; not a complete repository or environment snapshot','all_frozen_inputs_unchanged':all(x['frozen_inputs_unchanged'] for x in rows),'all_collected_artifact_hashes_match':all(not x['artifact_hash_mismatches'] for x in rows),'all_controller_cleanup_records_empty':all(not x['cleanup'].get('remaining') for x in rows),'cases':rows,'runtime_fingerprints':fingerprints,'access_review':{'scope':'Heuristic scan of recorded tool arguments only; no OS/network sandbox or proof of isolation','flags':flags}}
    drift=[]
    if fingerprints:
        baseline=fingerprints[0]
        for current in fingerprints[1:]:
            before=baseline.get('files') or {};after=current.get('files') or {}
            entry={'case_id':current['case_id'],'baseline_case_id':baseline['case_id'],
                   'added_files':sorted(set(after)-set(before)),
                   'removed_files':sorted(set(before)-set(after)),
                   'changed_files':sorted(k for k in set(before)&set(after) if before[k]!=after[k]),
                   'runtime_fields_changed':{k:{'baseline':baseline.get(k),'current':current.get(k)} for k in ['node_version','model','thinking'] if baseline.get(k)!=current.get(k)}}
            if any(entry[k] for k in ['added_files','removed_files','changed_files','runtime_fields_changed']):drift.append(entry)
    report['runtime_fingerprint_differences']=drift
    (SUITE/'campaign-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k not in ['cases','runtime_fingerprints']},ensure_ascii=False))

if __name__=='__main__':main()
