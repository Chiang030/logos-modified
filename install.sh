#!/bin/sh
set -eu
logos_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
logos_with_sim=0
logos_shortcut=0
for logos_option in "$@"; do
  case "$logos_option" in
    --with-sim) logos_with_sim=1 ;;
    --shortcut) logos_shortcut=1 ;;
    *) echo "Usage: bash install.sh [--with-sim] [--shortcut]" >&2; exit 2 ;;
  esac
done
command -v node >/dev/null || { echo "Install Node.js >=22.19 first." >&2; exit 1; }
command -v npm >/dev/null || { echo "Install npm first." >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<19)){console.error("Node.js >=22.19 required");process.exit(1)}'
npm --prefix "$logos_root/logos-agent" run pi:setup
if [ "$logos_with_sim" = 1 ]; then
  command -v python3 >/dev/null || { echo "Install Python 3.10+ and python3-venv first." >&2; exit 1; }
  python3 "$logos_root/logos-agent/integrations/setup.py"
fi
if [ ! -f "$logos_root/logos-agent/.env" ]; then
  (umask 077; cp "$logos_root/logos-agent/.env.example" "$logos_root/logos-agent/.env")
fi
chmod +x "$logos_root/bin/logos"
if [ "$logos_shortcut" = 1 ]; then
  logos_shortcut_dir="${LOGOS_SHORTCUT_DIR:-$HOME/.local/bin}"
  mkdir -p "$logos_shortcut_dir"
  if [ -e "$logos_shortcut_dir/logos" ] || [ -L "$logos_shortcut_dir/logos" ]; then
    echo "Existing shortcut preserved: $logos_shortcut_dir/logos"
  else
    ln -s "$logos_root/bin/logos" "$logos_shortcut_dir/logos"
    echo "Shortcut created: $logos_shortcut_dir/logos (add this directory to PATH if needed)"
  fi
fi
"$logos_root/bin/logos" --help >/dev/null
echo "Installed. Fill logos-agent/.env, then run $logos_root/bin/logos from your project directory."
