"""Independently recompute transient forcing, mass accumulation and cycle differences."""
import bisect
import json
import math
from pathlib import Path
import shlex

ROOT=Path(__file__).resolve().parents[1]
CASE=ROOT/'runs/20261019-allcases-discovery-v1/A03'
DT=2.85596e-5
OMEGA=2200.0

def main():
    path=CASE/'collected/workspace/final/transient-monitor.out'
    rows=[]
    sources=[path]
    continuation=path.parent/'continuation/transient-monitor.out'
    if continuation.exists():sources.append(continuation)
    for source in sources:
        lines=source.read_text(encoding='utf-8').splitlines()
        header=next(shlex.split(s.strip()[1:-1]) for s in lines if s.strip().startswith('('))
        for line in lines:
            parts=line.split()
            if not parts or not parts[0].isdigit():continue
            if len(parts)!=len(header):raise ValueError('Unexpected monitor columns')
            rows.append(dict(zip(header,map(float,parts))))
    bystep={int(x['Time Step']):x for x in rows};steps=sorted(bystep)
    errors=[];balance=[]
    for step in steps:
        row=bystep[step];t=step*DT
        errors.append(abs(row['outlet-pressure']-(0.12*math.sin(OMEGA*t)+0.737)*101325))
        if step-1 in bystep:
            accumulation=(row['domain-mass']-bystep[step-1]['domain-mass'])/DT
            flux=row['inlet-massflow']+row['outlet-massflow']
            balance.append({'step':step,'mass_accumulation_kg_s':accumulation,'net_inward_flux_kg_s':flux,'normalized_residual':abs(accumulation-flux)/abs(row['inlet-massflow']),'immediately_after_adapt_interval':step>25 and (step-1)%25==0})
    period=2*math.pi/OMEGA;times=[s*DT for s in steps];cycles={}
    def interp(t,key):
        i=bisect.bisect_right(times,t)
        if i==0 or i>=len(times):return None
        a,b=times[i-1],times[i];va,vb=bystep[steps[i-1]][key],bystep[steps[i]][key]
        return va+(vb-va)*(t-a)/(b-a)
    if times[-1]>=2*period:
        for key in ['inlet-massflow','outlet-massflow','inlet-pressure','outlet-mach','domain-mass']:
            pairs=[(bystep[s][key],interp(s*DT-period,key)) for s in steps if s*DT>times[-1]-period]
            pairs=[(a,b) for a,b in pairs if b is not None];values=[a for a,b in pairs];delta=[a-b for a,b in pairs]
            span=max(values)-min(values)
            cycles[key]={'samples':len(pairs),'max_absolute_difference':max(map(abs,delta)),'rms_difference':math.sqrt(sum(x*x for x in delta)/len(delta)),'last_cycle_peak_to_peak':span,'rms_difference_over_last_cycle_peak_to_peak':math.sqrt(sum(x*x for x in delta)/len(delta))/span if span else None}
    out={'source':str(path.relative_to(CASE)),'rows':len(rows),'unique_steps':len(steps),'duplicate_step_rows':len(rows)-len(steps),'last_step':steps[-1],'flow_time_s':times[-1],'forcing_period_s':period,'periods_completed':times[-1]/period,'max_outlet_forcing_absolute_error_Pa':max(errors),'mass_balance_max_normalized_residual':max(x['normalized_residual'] for x in balance),'mass_balance_max_excluding_immediately_after_adapt_interval':max(x['normalized_residual'] for x in balance if not x['immediately_after_adapt_interval']),'mass_balance_series':balance,'last_cycle_vs_previous_interpolated':cycles,'limitations':['Mass difference uses first-order time discretization and delivered monitor samples. Adaptation remapping can cause jumps; per-adaptation mass accounting is required to separate them.','No frozen periodic-stability threshold; waveform comparisons are diagnostic, not an accuracy PASS.']}
    out['sources'] = [str(source.relative_to(CASE)) for source in sources]
    (CASE/'monitor-review.json').write_text(json.dumps(out,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in out.items() if k!='mass_balance_series'},indent=2))

if __name__=='__main__':main()
