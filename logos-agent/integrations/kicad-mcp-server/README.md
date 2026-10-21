# kicad-mcp-server (LOGOS fork)

LOGOS-owned source fork of [Seeed Studio's `kicad-mcp-server`](https://github.com/Seeed-Studio/kicad-mcp-server)
0.1.0, patched for KiCad 9/10 and for behavior LOGOS relies on. Provenance,
license, and the full patch list: [`NOTICE`](NOTICE).

This fork is the **only** KiCad MCP server LOGOS should run. Do not point the
agent at a separately pip-installed copy: two editable installs of the same
package import from whichever path wins, which is how the "ERC always passes"
bug survived a patch on this host.

## Layout

| Path | Content |
|---|---|
| `src/kicad_mcp_server/` | patched server source (the code that runs) |
| `bin/kicad-mcp-server` | launcher used by `~/.pi/agent/mcp.json` |
| `register-mcp.py` | merges the launcher into `~/.pi/agent/mcp.json` (idempotent, backs up) |
| `tests/test_fork_regressions.py` | offline checks for every LOGOS patch (29 checks) |
| `tests/mcp_stdio_smoke.py` | end-to-end checks over real MCP stdio (14 checks) |
| `docs/`, `upstream-tests/` | unmodified upstream content |

## Runtime requirements

The launcher needs a Python that can import `mcp`, `fastmcp`, `kicad_skip`,
`pydantic`. It probes, in order:

1. `$LOGOS_KICAD_PYTHON`;
2. `integrations/.venv/bin/python` (created by `integrations/setup.py`);
3. `~/.local/opt/kicad-mcp-venv/bin/python` (host install used so far);
4. `python3` on `PATH`.

`pcbnew` is optional: without it, project creation and PCB analysis fall back to
the `kicad-cli` / system-`python3` path that upstream already implements. If a
user-space KiCad prefix exists at `~/.local/opt/kicad-9.0.9`, the launcher adds
its library paths so in-process `pcbnew` keeps working.

## Use

```bash
# check the fork without touching any config
python3 integrations/kicad-mcp-server/tests/test_fork_regressions.py

# register it for the Pi runtime (backs up ~/.pi/agent/mcp.json first)
python3 integrations/kicad-mcp-server/register-mcp.py --dry-run
python3 integrations/kicad-mcp-server/register-mcp.py
```

Restart the LOGOS session afterwards; the MCP server is spawned once per session.

## Updating from upstream

1. Copy the new upstream `src/`, `docs/`, `tests/` into place.
2. Re-apply or re-verify the patches listed in `NOTICE` (they are small and
   covered by `tests/test_fork_regressions.py`).
3. Run both test scripts, then `register-mcp.py --dry-run` and restart.
