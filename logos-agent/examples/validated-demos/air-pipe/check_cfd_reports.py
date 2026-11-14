"""Check Fluent report-definition output against laminar pipe physics."""
import json
from pathlib import Path
import sys


def validate(path: Path) -> dict:
    raw=json.loads(path.read_text())
    data={key:value for entry in raw for key,value in entry.items()} if isinstance(raw,list) else raw
    def scalar(name: str) -> float:
        value=data[name]
        while isinstance(value,list): value=value[0]
        return float(value)
    gradient=(scalar('p02')-scalar('p08'))/0.6
    inlet,outlet=scalar('mass-inlet'),scalar('mass-outlet')
    result={'pressure_gradient_Pa_per_m':gradient,'analytic_gradient_Pa_per_m':0.572608,'gradient_relative_error':abs(gradient/0.572608-1),'inlet_mass_kg_s':inlet,'outlet_mass_kg_s':outlet,'relative_mass_imbalance':abs(inlet+outlet)/abs(inlet)}
    result['passed']=result['gradient_relative_error']<=0.02 and result['relative_mass_imbalance']<=0.001
    return result


if __name__=='__main__':
    result=validate(Path(sys.argv[1])); print(json.dumps(result,indent=2))
    if not result['passed']: raise SystemExit(1)
