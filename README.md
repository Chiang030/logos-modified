# LOGOS server deployment

This bundle includes LOGOS and its Pi source foundation. It is an installable
source distribution, not an offline binary. No Git/submodule checkout is
required. Node.js >=22.19 is required; Python 3.10+ (3.11 recommended) and venv
support are required for the simulation tools. Initial setup needs internet.

## Linux installation

No system/global installation is required. If dependencies are already present,
launch directly from any project folder:

```bash
bash /path/to/logos-server/start.sh
```

For a fresh server, prepare dependencies once:

```bash
npm --prefix /path/to/logos-server/logos-agent run pi:setup
python3 /path/to/logos-server/logos-agent/integrations/setup.py # optional simulation tools
cp /path/to/logos-server/logos-agent/.env.example /path/to/logos-server/logos-agent/.env
```

Fill the `.env` file locally. `start.sh` never installs dependencies and preserves
your current project directory. `install.sh` below is an optional convenience
script for the same preparation plus a shortcut, not a required system install.

```bash
tar -xzf logos-server-20261009.tar.gz
cd logos-server
bash install.sh --with-sim --shortcut
nano logos-agent/.env
```

`--with-sim` installs the local sim core, Mechanical/Workbench plugins and their
SDK dependencies. Omit it for chat/file tools only. `--shortcut` creates a
symlink in `~/.local/bin`, preserving any existing entry. Add that directory to
PATH if needed; no shell startup file is edited automatically.

Start in the workspace you want LOGOS to use:

```bash
cd /path/to/your/project
~/.local/bin/logos
# Or, when ~/.local/bin is on PATH:
logos
# Direct entry if no shortcut was installed:
/path/to/logos-server/bin/logos
```

The entry preserves your working directory and discovers its AGENTS.md. Product
prompts, Skills and `.env` are located relative to the installed LOGOS package.
There is no development-workspace AGENTS.md at the deployment root.

## Windows

After unzipping, run `npm --prefix logos-agent run pi:setup`, optionally
`python logos-agent/integrations/setup.py`, and copy `.env.example` to `.env`.
Run the package's absolute `logos.cmd` path from the desired project folder.
Windows virtual environments and node_modules are never copied to Linux.

## Included and excluded

Included: current CLI, character logo, prompts, eight product Skills, simulation
tools and patched sim sources, complete Pi source, package locks and upstream
licenses. Excluded: real `.env`, API keys, installed dependencies, virtual
environments, Git history, operation logs and host-specific caches. Configure
credentials on the server. Dependency versions may vary by OS; installation is
not a claim of licensed solver availability or 2026 R1 compatibility.

The capability matrix starts without verified combinations. Probe the server's
own installations. Linux discovery is covered by path fixtures; actual Linux
Ansys, licensing, GUI attachment and physical acceptance require server tests.
For GUI control, start sim serve from an interactive desktop; SSH alone does
not provide a desktop session. Redeploy/restart remote sim servers to load the
patched source. No solver or user project is launched by installation checks.
