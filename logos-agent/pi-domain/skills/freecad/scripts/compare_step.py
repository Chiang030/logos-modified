"""Symmetric-difference comparison of two BREP shapes (independent oracle).

Run with freecadcmd (sys.argv[2:] carries the script args):

  freecadcmd compare_step.py <actual.step> <expected.step> [rel_tol]

rel_tol (default 0.001 = 0.1%) is the allowed symmetric-difference volume
relative to the expected volume. Prints where the difference sits (bbox of
the two cut remainders) and a final VERDICT line.

Independent of the tool that produced either file: this is the second
opinion, not a self-check. Units follow the files (STEP is usually mm).
"""

import sys

import Part

ARGS = sys.argv[2:]


def finish(code):
    # freecadcmd discards buffered stdout on SystemExit; flush first so
    # the verdict lines and the exit code both reach the caller.
    sys.stdout.flush()
    sys.exit(code)


def main():
    if len(ARGS) < 2:
        print("usage: freecadcmd compare_step.py <actual> <expected> [rel_tol]")
        finish(2)
    actual_path, expected_path = ARGS[0], ARGS[1]
    rel_tol = float(ARGS[2]) if len(ARGS) > 2 else 0.001

    try:
        actual = Part.read(actual_path)
        expected = Part.read(expected_path)
    except Exception as exc:
        print(f"ERROR: import failed: {exc}")
        finish(1)

    for name, shape in (("actual", actual), ("expected", expected)):
        if not shape.Solids:
            print(f"VERDICT: FAIL - {name} has no solids (faceted/open shell?); "
                  "heal_convert.py can make a solid, or compare solids you exported")
            finish(1)
        if not shape.isValid():
            print(f"VERDICT: FAIL - {name} shape invalid, heal before comparing")
            finish(1)

    actual_extra = actual.cut(expected)
    expected_extra = expected.cut(actual)
    symdiff = actual_extra.Volume + expected_extra.Volume
    expected_volume = expected.Volume
    rel = symdiff / expected_volume if expected_volume else float("inf")

    print(f"actual volume:   {actual.Volume:.3f}")
    print(f"expected volume: {expected_volume:.3f}")
    print(f"symmetric difference: {symdiff:.3f} ({rel:.4%} of expected, "
          f"tolerance {rel_tol:.4%})")

    remainder = actual_extra.fuse(expected_extra)
    if remainder.Volume > 0:
        bb = remainder.BoundBox
        print(f"difference sits at X[{bb.XMin:.3f},{bb.XMax:.3f}] "
              f"Y[{bb.YMin:.3f},{bb.YMax:.3f}] Z[{bb.ZMin:.3f},{bb.ZMax:.3f}]")

    if rel <= rel_tol:
        print(f"VERDICT: PASS - shapes agree within {rel_tol:.4%}")
        finish(0)
    print(f"VERDICT: FAIL - shapes differ by {rel:.4%}, above {rel_tol:.4%}")
    finish(1)


try:
    main()
except SystemExit:
    raise
except Exception as exc:  # freecadcmd swallows script exceptions and exits 0
    print(f"ERROR: {exc}")
    finish(1)
