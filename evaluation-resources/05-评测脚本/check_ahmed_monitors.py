"""Recompute A02 monitor metrics from delivered numerical series, without changing them."""
import csv
import json
import math
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
CASE=ROOT/'runs/20261019-allcases-discovery-v1/A02'

def rows(p):
    with p.open(encoding='utf-8-sig',newline='') as f:
        return [{k:float(v) for k,v in row.items()} for row in csv.DictReader(f)]

def main():
    w=CASE/'collected/workspace/final';e=rows(w/'engineering_monitor.csv');r=rows(w/'residual_monitor.csv')
    window=e[-100:];out={'rows':len(e),'residual_rows':len(r),'last_iteration':e[-1]['iteration'],'window_count':len(window),'sampling':'last 100 delivered engineering rows; peak-to-peak divided by absolute mean','all_finite':all(math.isfinite(v) for row in e+r for v in row.values()),'engineering_iterations_unique':len({x['iteration'] for x in e})==len(e),'residual_iterations_unique':len({x['iteration'] for x in r})==len(r),'final':e[-1],'final_residuals':r[-1]}
    for field in ['Cd','drag_N']:
        a=[x[field] for x in window];mean=sum(a)/len(a)
        out[field+'_last100_relative_range']=(max(a)-min(a))/abs(mean) if mean else None
    end=e[-1]
    out['mass_imbalance_fraction']=abs(end['mass_in_kg_s']+end['mass_out_kg_s'])/abs(end['mass_in_kg_s'])
    out['Cd_from_force']=end['drag_N']/(0.5*1.225*30**2*0.11203202)
    out['Cd_force_difference']=abs(out['Cd_from_force']-end['Cd'])
    out['all_residuals_le_1e_4']=all(v<=1e-4 for k,v in r[-1].items() if k!='iteration')
    out['mass_balance_pass']=out['mass_imbalance_fraction']<=0.001
    out['drag_stability_pass']=len(window)==100 and out['drag_N_last100_relative_range'] is not None and out['drag_N_last100_relative_range']<=0.01
    out['converged_under_reviewed_rules']=out['all_residuals_le_1e_4'] and out['mass_balance_pass'] and out['drag_stability_pass']
    out['limitations']='Verifies delivered time series only. Native saved reports and configuration are checked separately. No independent aerodynamic accuracy reference.'
    (CASE/'monitor-review.json').write_text(json.dumps(out,indent=2),encoding='utf-8')
    print(json.dumps(out,indent=2))

if __name__=='__main__':main()
