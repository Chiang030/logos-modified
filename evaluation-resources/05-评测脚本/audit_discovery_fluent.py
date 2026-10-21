"""Reopen each final CFD case/data pair and inspect the saved solver state."""
import argparse
import json
from pathlib import Path
import time


def main():
    import ansys.fluent.core as pyfluent
    p=argparse.ArgumentParser();p.add_argument('suite',type=Path);p.add_argument('--cases',nargs='+',default=['A01','A02','A03','A04','A06']);args=p.parse_args()
    for cid in args.cases:
        root=args.suite/cid;work=root/'workspace';audit=root/'independent-cfd-audit'
        if audit.exists():print(cid+' audit already exists',flush=True);continue
        audit.mkdir()
        cases=[f for f in sorted(work.rglob('*.cas.h5')) if not any(x in f.relative_to(work).parts for x in ['attempts','reruns'])]
        final=[f for f in cases if 'final' in f.relative_to(work).parts]
        if final:cases=final
        available=[str(f.relative_to(work)) for f in cases]
        if cid=='A03':
            selected=[f for f in cases if str(f.relative_to(work)) in ['final/model.cas.h5','final/steady.cas.h5','final/step050.cas.h5']]
            if selected:cases=selected
        pairs=sum(f.with_name(f.name.replace('.cas.h5','.dat.h5')).exists() for f in cases)
        status={'case_id':cid,'case_files_found':len(available),'case_files_selected':len(cases),'selection_note':'A03 audits steady, final, and step050 post-adaptation checkpoints; other intermediate checkpoints are preserved but not all reopened','available_case_files':available,'pairs_selected':pairs,'models':[],'accuracy_status':'NO_INDEPENDENT_CONVERGED_REFERENCE'}
        solver=None
        try:
            if not cases:
                status['status']='NO_NATIVE_CASE';continue
            solver=pyfluent.launch_fluent(fluent_path='/srv/shared/ansys_inc/v261/fluent/bin/fluent',mode='solver',dimension=3,precision='double',processor_count=1,ui_mode='no_gui',cwd=str(audit),start_timeout=90)
            for i,path in enumerate(cases):
                has_data=path.with_name(path.name.replace('.cas.h5','.dat.h5')).exists()
                start=time.monotonic();r={'case_file':str(path.relative_to(work)),'has_paired_data':has_data,'read_ok':False}
                try:
                    if has_data:solver.settings.file.read_case_data(file_name=str(path))
                    else:solver.settings.file.read_case(file_name=str(path))
                    r['read_ok']=True
                    solver.settings.mesh.check()
                    dump={'general':solver.settings.setup.general.get_state(),'models':solver.settings.setup.models.get_state(),'materials':solver.settings.setup.materials.get_state(),'boundary_conditions':solver.settings.setup.boundary_conditions.get_state(),'cell_zone_conditions':solver.settings.setup.cell_zone_conditions.get_state(),'reference_values':solver.settings.setup.reference_values.get_state(),'residual_monitor':solver.settings.solution.monitor.residual.get_state(),'report_definitions':solver.settings.solution.report_definitions.get_state()}
                    (audit/f'model-{i:02d}-state.json').write_text(json.dumps(dump,default=str,indent=2))
                    reports=[]
                    for kind,items in dump['report_definitions'].items():
                        if kind=='time':continue
                        if isinstance(items,dict):reports.extend(name for name,value in items.items() if isinstance(value,dict))
                    try:
                        r['recomputed_reports']=solver.settings.solution.report_definitions.compute(report_defs=reports) if reports and has_data else None
                    except Exception as e:r['report_compute_error']=type(e).__name__+': '+str(e)
                    r['state_file']=f'model-{i:02d}-state.json'
                except Exception as e:r['error']=type(e).__name__+': '+str(e)
                r['seconds']=time.monotonic()-start;status['models'].append(r)
                (audit/'status.json').write_text(json.dumps(status,default=str,indent=2))
                print(cid+' '+json.dumps({'file':r['case_file'],'read_ok':r['read_ok']}),flush=True)
        except Exception as e:status['audit_error']=type(e).__name__+': '+str(e)
        finally:
            if solver:
                try:solver.exit()
                except Exception as e:status['close_error']=str(e)
            (audit/'status.json').write_text(json.dumps(status,default=str,indent=2))

if __name__=='__main__':main()
