# LOGOS sim integration

Core: user-supplied `C:/Users/37491/Downloads/sim-cli-main.zip`, package version 0.3.9.
Mechanical: user asset `sim_plugin_mechanical-0.1.6-py3-none-any.whl`.
Workbench: PyPI `sim-plugin-workbench==0.1.2` wheel, downloaded for editable source integration.
Upstream licenses remain under core `LICENSE` and each plugin's `upstream-license/` directory.

Local plugin versions are `0.1.6+logos.1` / `0.1.2+logos.1`. This is a LOGOS-maintained fork of the sim integration, independent of `vendor/pi/`.

Run `python setup.py` from this directory or `npm --prefix logos-agent run sim:setup` from the repository root. Python 3.10+ is required; the current local environment uses Python 3.11. The environment is isolated in `.venv` and is ignored by Git. Setup installs core and both plugins editable, with their SDK dependencies.

See [tool contracts and limitations](../docs/simulation-tool.md). Existing source changes are picked up by the sim CLI; restart an already-running sim server to reload its imports. Remote machines require deployment of these modified sources; upgrading the local LOGOS adapter does not patch a remote sim server.

Validation: 57 focused Python tests plus 10 subtests pass; 8 Node tests pass. CLI doctor reports both local plugins healthy. A synthetic installation passed the real Pi tools → CLI discovery → ID selection → probe path. No licensed Ansys solver was launched and no user GUI/project was modified during validation. Linux discovery was tested with Linux path fixtures on the Windows test host, not on a live Linux solver installation.
