"""Collect completed cases and summarize observed RPC metrics without inventing scores."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import re

ROOT=Path(__file__).resolve().parents[1]
SUITE=ROOT/'runs/20261019-allcases-discovery-v1'
REMOTE='/home/jiangjincheng/logos-benchmark-runs/20261019-allcases-discovery-v1'

def remote(code,timeout=120):
    p=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','leadhk01','python3 -'],input=code.encode(),capture_output=True,timeout=timeout)
    if p.returncode:raise RuntimeError(p.stderr.decode(errors='replace'))
    return json.loads(p.stdout)

def load(path, default=None):
    if not path.exists():return default
    try:return json.loads(path.read_text(encoding='utf-8'))
    except (ValueError,UnicodeError):return default

def metrics(folder):
    e=folder/'collected/evidence';w=folder/'collected/workspace'
    s=load(e/'run-summary.json',{})
    stats=load(e/'get_session_stats.json',{})
    events=[]
    if (e/'events.jsonl').exists():
        for line in (e/'events.jsonl').read_text(encoding='utf-8').splitlines():
            try:events.append(json.loads(line))
            except ValueError:pass
    counts=Counter();errors=[];assistant=[];requests=[];toolstarts={};seconds=0
    for item in events:
        event=item.get('record',{});kind=event.get('type');now=item.get('elapsed_s')
        if kind=='tool_execution_start':counts[event.get('toolName')]+=1;toolstarts[event.get('toolCallId')]=now
        if kind=='tool_execution_end':
            if event.get('toolCallId') in toolstarts:seconds+=now-toolstarts[event['toolCallId']]
            if event.get('isError'):errors.append({'elapsed_s':now,'tool':event.get('toolName'),'tool_call_id':event.get('toolCallId'),'result':event.get('result')})
        if kind=='message_end' and event.get('message',{}).get('role')=='assistant':assistant.append(event['message'])
        if kind=='extension_ui_request' and event.get('method') in ['input','confirm','select','editor']:requests.append(event)
    usage={k:sum(a.get('usage',{}).get(k,0) for a in assistant) for k in ['input','output','cacheRead','cacheWrite','reasoning','totalTokens']}
    outputs=load(w/'results.json')
    issues=load(w/'issues.json')
    needs=load(w/'needs_input.json')
    controller_artifact=load(e/'artifact-manifest.json',[])
    artifact=load(folder/'collected/collection-manifest.json',controller_artifact)
    controller_mismatches=[]
    for a in controller_artifact:
        p=w/a['path']
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=a['sha256']:controller_mismatches.append(a['path'])
    checks=[]
    for a in artifact:
        p=w/a['path']
        ok=p.is_file() and not p.is_symlink() and p.resolve().is_relative_to(w.resolve())
        checks.append({'path':a['path'],'match':ok and hashlib.sha256(p.read_bytes()).hexdigest()==a['sha256'],'bytes':a['bytes']})
    transfer={'all_match':bool(checks) and all(a['match'] for a in checks),'manifest_source':'post_cleanup_collection_manifest' if (folder/'collected/collection-manifest.json').exists() else 'controller_manifest','controller_manifest_mismatches':controller_mismatches,'files':checks}
    (folder/'transfer-verification.json').write_text(json.dumps(transfer,indent=2),encoding='utf-8')
    result={'case_id':folder.name,'execution':{'settled':s.get('settled'),'aborted':s.get('aborted'),'timed_out':s.get('timed_out'),'controller_error':s.get('controller_error'),'interactive_request_count':len(requests),'needs_input_artifact':needs is not None},'agent_reported_status':outputs.get('status') if isinstance(outputs,dict) else None,'independent_accuracy_status':'NOT_EVALUATED','agent_wall_seconds':s.get('agent_wall_seconds'),'total_wall_seconds':s.get('total_wall_seconds'),'sampled_peak_tree_rss_mib':s.get('max_sampled_tree_rss_kib',0)/1024,'child_user_cpu_seconds':s.get('child_user_cpu_seconds'),'child_system_cpu_seconds':s.get('child_system_cpu_seconds'),'assistant_turns':len(assistant),'tools':dict(counts),'tool_calls':sum(counts.values()),'tool_error_count':len(errors),'tool_seconds_sum':seconds,'tokens':usage,'runtime_estimated_cost_usd':stats.get('cost'),'actual_billed_cost_usd':None,'model_id':s.get('initial_state',{}).get('model',{}).get('id'),'thinking_level':s.get('initial_state',{}).get('thinkingLevel'),'artifact_count':len(artifact),'artifact_bytes':sum(a['bytes'] for a in artifact),'transfer_verified':transfer['all_match'],'agent_reported_issues':issues,'needs_input':needs,'tool_errors':errors,'controller_followups':s.get('controller_followups'),'human_interventions':s.get('human_interventions'),'cleanup':load(folder/'collected/cleanup.json')}
    result['event_estimated_cost_usd']=sum(a.get('usage',{}).get('cost',{}).get('total',0) for a in assistant)
    result['controller_artifact_manifest_mismatches']=controller_mismatches
    result['collection_manifest_source']=transfer['manifest_source']
    result['controller_wall_seconds']=s.get('total_wall_seconds')
    result['agent_reported_physics_metrics']=outputs.get('metrics') if isinstance(outputs,dict) else None
    result['agent_reported_convergence']=outputs.get('convergence') if isinstance(outputs,dict) else None
    result['agent_reported_limitations']=outputs.get('limitations') if isinstance(outputs,dict) else None
    result['delivery_presence_checks']={name:(w/name).is_file() for name in ['results.json','issues.json','report.md']}
    native=[]
    for pattern in ['*.rst','*.db','*.mechdb','*.cas.h5','*.dat.h5']:
        native.extend(p.relative_to(w).as_posix() for p in w.rglob(pattern) if 'final' in p.relative_to(w).parts)
    result['delivered_final_native_files']=sorted(native)
    result['native_presence_caveat']='File presence alone does not establish reopenability, convergence or physical accuracy; see review.json and independent audits.'
    result['usage_coverage']='session_statistics_and_observed_events' if stats else 'observed_completed_messages_only; interrupted_request_usage_may_be_missing'
    freeze=load(folder/'freeze.json',{})
    result['frozen_local_inputs_unchanged']={name:hashlib.sha256((folder/name).read_bytes()).hexdigest()==freeze.get(name) for name in ['prompt.md','run-config.json']}
    result['provided_assets_unchanged']={name:(w/'input'/name).is_file() and hashlib.sha256((w/'input'/name).read_bytes()).hexdigest()==meta['sha256'] for name,meta in freeze.get('assets',{}).items()}
    result['event_counts']=dict(Counter(item.get('record',{}).get('type') for item in events))
    result['model_error_count']=len(s.get('model_errors',[]))
    result['session_statistics']=stats or None
    result['first_visible_text_seconds']=next((item['elapsed_s'] for item in events if item.get('record',{}).get('assistantMessageEvent',{}).get('type')=='text_delta'),None)
    result['final_assistant_text']='\n'.join(part.get('text','') for part in assistant[-1].get('content',[]) if part.get('type')=='text') if assistant else None
    timed={}
    for path in w.rglob('*.txt'):
        if not any(word in path.name.lower() for word in ['time','resource']):continue
        text=path.read_text(encoding='utf-8',errors='replace')
        found=re.search(r'Elapsed \(wall clock\) time \(h:mm:ss or m:ss\): (\S+)',text)
        if not found:continue
        digest=hashlib.sha256(path.read_bytes()).hexdigest()
        if digest in timed:
            timed[digest]['identical_record_paths'].append(path.relative_to(w).as_posix());continue
        seconds=0
        for field in found[1].split(':'):seconds=seconds*60+float(field)
        row={'identical_record_paths':[path.relative_to(w).as_posix()],'wall_seconds':seconds}
        for key,pattern in [('user_cpu_seconds',r'User time \(seconds\): ([\d.]+)'),('system_cpu_seconds',r'System time \(seconds\): ([\d.]+)'),('max_rss_kib',r'Maximum resident set size \(kbytes\): (\d+)'),('exit_status',r'Exit status: (\d+)')]:
            match=re.search(pattern,text);row[key]=float(match[1]) if match else None
        timed[digest]=row
    result['saved_backend_timing_records']=list(timed.values())
    result['stage_timing_limit']='Backend process timings and RPC tool durations are measured; a process/tool can span multiple stages. Identical timing files are grouped, not asserted to be distinct invocations. No complete independent per-stage wall-clock instrumentation.'
    result['resource_coverage_limit']='Controller samples the observed Logos descendant process tree. Detached/reparented Fluent/MPI processes can escape that tree; GNU-time around a Python launcher need not cover native solver descendants. RSS sums can double-count shared pages. These values are partial sampled measurements, not complete solver resource accounting.'
    (folder/'metrics.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--status-only',action='store_true');args=parser.parse_args()
    code="""import json
from pathlib import Path
r=Path(%r)
s=json.loads((r/'status.json').read_text())
if s.get('active'):
 p=r/s['active']/'controller.log'
 s['active_log_tail']=p.read_text(errors='replace').splitlines()[-3:] if p.exists() else []
print(json.dumps(s))
""" % REMOTE
    status=remote(code)
    (SUITE/'remote-status.json').write_text(json.dumps(status,indent=2),encoding='utf-8')
    if args.status_only:
        print(json.dumps({'finished':status['finished'],'completed':len(status['cases']),'active':status['active'],'active_log_tail':status.get('active_log_tail'),'last_completed':status['cases'][-1] if status['cases'] else None},ensure_ascii=False));return
    for row in status['cases']:
        cid=row['case_id'];folder=SUITE/cid
        if (folder/'collected').exists():continue
        code="""import tarfile,json,hashlib
from pathlib import Path
r=Path(%r); c=r/%r; dest=c/'collected.tar.gz'
w=c/'workspace'
manifest=[{'path':p.relative_to(w).as_posix(),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(w.rglob('*')) if p.is_file() and not p.is_symlink()]
(c/'collection-manifest.json').write_text(json.dumps(manifest,indent=2))
with tarfile.open(dest,'w:gz') as t:
 for name in ['evidence','workspace','cleanup.json','controller.log','collection-manifest.json']:
  p=c/name
  if p.exists():t.add(p,arcname=name)
print(json.dumps({'archive':str(dest),'bytes':dest.stat().st_size}))
""" % (REMOTE,cid)
        remote(code,timeout=600)
        archive=folder/'collected.tar.gz'
        subprocess.run(['scp','-q','leadhk01:'+REMOTE+'/'+cid+'/collected.tar.gz',str(archive)],check=True,timeout=900)
        target=folder/'collected';target.mkdir()
        with tarfile.open(archive) as t:
            members=t.getmembers()
            for entry in members:
                p=(target/entry.name).resolve()
                if not p.is_relative_to(target.resolve()) or entry.issym() or entry.islnk() or not(entry.isfile() or entry.isdir()):
                    raise ValueError('Unsafe archive member: '+entry.name)
            t.extractall(target)
        print('COLLECTED '+cid,flush=True)
    all_metrics=[load(SUITE/row['case_id']/'metrics.json') or metrics(SUITE/row['case_id']) for row in status['cases'] if (SUITE/row['case_id']/'collected').exists()]
    index={'suite_id':status['suite_id'],'finished':status['finished'],'active':status['active'],'cases':[{'case_id':m['case_id'],'status':m['agent_reported_status'],'settled':m['execution']['settled'],'tool_errors':m['tool_error_count'],'wall_seconds':m['agent_wall_seconds'],'tokens':m['tokens']['totalTokens'],'estimated_cost_usd':m['runtime_estimated_cost_usd'],'accuracy':m['independent_accuracy_status'],'transfer_verified':m['transfer_verified']} for m in all_metrics]}
    (SUITE/'metrics-index.json').write_text(json.dumps(index,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(index,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
