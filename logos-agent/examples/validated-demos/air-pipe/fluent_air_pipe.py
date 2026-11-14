"""Single-core isolated axisymmetric air-pipe Fluent validation, no service changes."""
from pathlib import Path
import argparse
import json
import math
import os
import shutil
import signal
import time


def mesh(path: Path, nx: int = 160, ny: int = 24) -> None:
    node = lambda i,j: 1+j*(nx+1)+i
    cell = lambda i,j: 1+j*nx+i
    groups = [(2,2,[]),(3,10,[]),(4,5,[]),(5,3,[]),(6,37,[])]
    interior,inlet,outlet,wall,axis = [group[2] for group in groups]
    for j in range(ny):
        for i in range(1,nx): interior.append((node(i,j),node(i,j+1),cell(i-1,j),cell(i,j)))
    for j in range(1,ny):
        for i in range(nx): interior.append((node(i,j),node(i+1,j),cell(i,j),cell(i,j-1)))
    for j in range(ny):
        inlet.append((node(0,j+1),node(0,j),cell(0,j),0))
        outlet.append((node(nx,j),node(nx,j+1),cell(nx-1,j),0))
    for i in range(nx):
        wall.append((node(i+1,ny),node(i,ny),cell(i,ny-1),0))
        axis.append((node(i,0),node(i+1,0),cell(i,0),0))
    lines=['(0 "Isolated air pipe SI mesh")','(2 2)',f'(10 (0 1 {(nx+1)*(ny+1):x} 0 2))',f'(12 (0 1 {nx*ny:x} 0))',f'(13 (0 1 {sum(len(g[2]) for g in groups):x} 0))',f'(10 (1 1 {(nx+1)*(ny+1):x} 1 2)(']
    lines += [f'{i/nx:.15g} {0.005*j/ny:.15g}' for j in range(ny+1) for i in range(nx+1)]
    lines += ['))',f'(12 (1 1 {nx*ny:x} 1 3))']
    first=1
    for zone,bc,faces in groups:
        lines.append(f'(13 ({zone:x} {first:x} {first+len(faces)-1:x} {bc:x} 2)(')
        lines += [' '.join(f'{v:x}' for v in face) for face in faces]
        lines.append('))'); first+=len(faces)
    for zone,kind,name in [(1,'fluid','air'),(2,'interior','interior'),(3,'velocity-inlet','inlet'),(4,'pressure-outlet','outlet'),(5,'wall','wall'),(6,'axis','axis')]:
        lines.append(f'(45 ({zone} {kind} {name})())')
    path.write_text('\n'.join(lines)+'\n')


def main(root: Path, *, nx: int, ny: int, scale: float | None, fluent: str) -> None:
    """Run only in a new directory with the caller's existing license settings."""
    import ansys.fluent.core as pyfluent

    if not hasattr(signal, "SIGALRM"):
        raise RuntimeError("This bounded demonstration runner requires Linux")
    if not (2 <= nx <= 2000 and 2 <= ny <= 200 and nx * ny <= 100000):
        raise ValueError("Grid exceeds the demonstration resource limits")
    if scale is not None and (not math.isfinite(scale) or not 0 < scale <= 1):
        raise ValueError("Time-step scale must be in (0, 1]")
    executable = shutil.which(fluent)
    if executable is None:
        raise FileNotFoundError("Set --fluent or FLUENT_EXECUTABLE to an installed executable")
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    started=time.time(); mesh(root/'pipe.msh', nx, ny)
    solver=None
    def timeout(signum, frame): raise TimeoutError('Own CFD validation reached 10-minute limit')
    signal.signal(signal.SIGALRM,timeout); signal.alarm(600)
    try:
        solver=pyfluent.launch_fluent(fluent_path=executable,dimension=2,precision='double',processor_count=1,mode='solver',ui_mode='no_gui',cwd=str(root),start_timeout=90,cleanup_on_exit=True)
        s=solver.settings
        s.file.read_mesh(file_name=str(root/'pipe.msh'))
        solver.tui.mesh.check()
        s.setup.general.solver.two_dim_space='axisymmetric'
        s.setup.models.viscous.model='laminar'
        print('AIR_STATE',s.setup.materials.fluid['air'].get_state(),flush=True)
        print('INLET_STATE',s.setup.boundary_conditions.velocity_inlet['inlet'].get_state(),flush=True)
        print('METHOD_STATE',s.solution.methods.get_state(),flush=True)
        s.setup.materials.fluid['air'].density.value=1.225
        s.setup.materials.fluid['air'].viscosity.value=1.7894e-5
        s.setup.boundary_conditions.velocity_inlet['inlet'].momentum.velocity.value=0.1
        print('RESIDUAL_STATE',s.solution.monitor.residual.get_state(),flush=True)
        for equation in ['continuity','x-velocity','y-velocity']:
            s.solution.monitor.residual.equations[equation].absolute_criteria=1e-8
        if scale is not None:
            step=s.solution.run_calculation.pseudo_time_settings.time_step_method
            print('PSEUDO_TIME_BEFORE',step.get_state(),flush=True)
            step.time_step_size_scale_factor=scale
            print('PSEUDO_TIME_AFTER',step.get_state(),flush=True)
        s.solution.initialization.hybrid_initialize()
        s.solution.run_calculation.iterate(iter_count=600)
        for name,x in [('p02',0.2),('p08',0.8)]:
            s.results.surfaces.iso_surface[name]={'field':'x-coordinate','iso_values':[x]}
            s.solution.report_definitions.surface[name]={'report_type':'surface-areaavg','field':'pressure','surface_names':[name]}
        for name in ['inlet','outlet']:
            s.solution.report_definitions.flux['mass-'+name]={'report_type':'flux-massflow','boundaries':[name]}
        values=s.solution.report_definitions.compute(report_defs=['p02','p08','mass-inlet','mass-outlet'])
        print('PHYSICAL_REPORTS',values,flush=True)
        (root/'reports.json').write_text(json.dumps(values,indent=2))
        s.file.write_case_data(file_name=str(root/'pipe.cas.h5'))
        print('REPORT_STATE',s.solution.report_definitions.get_state(),flush=True)
        print('SURFACE_COMMANDS',dir(s.results.surfaces),flush=True)
        print('ELAPSED',time.time()-started,flush=True)
    finally:
        signal.alarm(0)
        if solver is not None: solver.exit()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='A new output directory; existing directories are rejected')
    parser.add_argument('nx', nargs='?', type=int, default=160)
    parser.add_argument('ny', nargs='?', type=int, default=24)
    parser.add_argument('scale', nargs='?', type=float, default=None)
    parser.add_argument('--fluent', default=os.environ.get('FLUENT_EXECUTABLE', 'fluent'))
    options = parser.parse_args()
    main(options.output, nx=options.nx, ny=options.ny, scale=options.scale, fluent=options.fluent)
