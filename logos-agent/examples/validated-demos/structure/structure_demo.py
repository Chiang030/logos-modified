"""Compare the real MAPDL beam results against independent beam theory."""
import csv
import json
from pathlib import Path


def validate(directory: Path) -> dict[str, float | bool | str]:
    """Read solver CSV, calculate reference values, and enforce balance tolerances."""
    with (directory / "results.csv").open(encoding="utf-8") as stream:
        rows = list(csv.reader(stream))
    displacement, reaction, moment = (float(value) for value in rows[1])
    length, width, height, young, force, poisson = 1.0, 0.02, 0.04, 210e9, 100.0, 0.3
    inertia = width * height**3 / 12
    bending = force * length**3 / (3 * young * inertia)
    shear = force * length / ((5 / 6) * (young / (2 * (1 + poisson))) * width * height)
    error = abs(abs(displacement) - bending) / bending
    balanced = abs(reaction - force) / force <= 0.001 and abs(abs(moment) - force * length) / (force * length) <= 0.001
    result = {"element": "BEAM188, 1D Timoshenko beam, not 3D solid", "tip_uz_m": displacement,
              "root_fz_N": reaction, "root_my_Nm": moment, "euler_bernoulli_tip_m": bending,
              "approx_timoshenko_tip_m": bending + shear, "relative_EB_error": error,
              "nominal_root_bending_stress_Pa": force * length * (height / 2) / inertia,
              "force_and_moment_balanced": balanced, "passed": error <= 0.03 and balanced}
    if not result["passed"]:
        raise RuntimeError("Structural benchmark acceptance failed")
    return result


if __name__ == "__main__":
    import sys
    print(json.dumps(validate(Path(sys.argv[1])), indent=2))
