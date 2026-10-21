#!/usr/bin/env bash
# deploy-pi-domain.sh — sync pi-domain manifests to the server and (optionally)
# reinstall dependencies safely.
#
# What it syncs: package.json + package-lock.json ONLY. Source changes to
# src/observability or extensions/ are NOT handled here — sync those with an
# explicit rsync/scp of the changed files so nothing is deployed by accident.
#
# Safety rails (in this order):
#   1. remote layout check (pi-domain/src/observability must exist)
#   2. versioned backup of the remote node_modules (kept under ~/pi-domain-backups)
#   3. registry connectivity probe (npm ping) — on failure: skip install,
#      keep the backup, exit non-zero
#   4. npm ci — on failure: restore the backup automatically
#
# Usage:
#   ./deploy-pi-domain.sh <user@host> [remote-logos-root]
#   ./deploy-pi-domain.sh <user@host> [root] --no-install   # manifest sync only
#
# After deploying, run the benchmark package's preflight_remote.py (it now
# verifies the installed dependency line) before starting any run.

set -euo pipefail

TARGET=${1:?usage: deploy-pi-domain.sh <user@host> [remote-logos-root] [--no-install]}
ROOT=${2:-/home/jiangjincheng/logos-server-20261009/logos-server}
if [ "$3" = "--no-install" ] || [ "$ROOT" = "--no-install" ]; then
  if [ "$ROOT" = "--no-install" ]; then ROOT=/home/jiangjincheng/logos-server-20261009/logos-server; fi
  NO_INSTALL=1
fi

LOCAL_AGENT="$(cd "$(dirname "$0")/.." && pwd)"   # logos-agent/
LOCAL_DOMAIN="$LOCAL_AGENT/pi-domain"
REMOTE_DOMAIN="$ROOT/logos-agent/pi-domain"
BACKUP_DIR="\$HOME/pi-domain-backups/node_modules-$(date +%Y%m%d-%H%M%S)"

for f in package.json package-lock.json; do
  [ -f "$LOCAL_DOMAIN/$f" ] || { echo "FAIL: local $f missing"; exit 1; }
done

echo "== 1/5 remote layout =="
ssh "$TARGET" "[ -d '$REMOTE_DOMAIN/src/observability' ] && [ -f '$REMOTE_DOMAIN/package.json' ] \
  || { echo 'FAIL: $REMOTE_DOMAIN not a pi-domain checkout'; exit 1; }
  echo 'node:' \$(node -v); echo 'npm:' \$(npm -v)"

echo "== 2/5 sync manifests =="
scp "$LOCAL_DOMAIN/package.json" "$LOCAL_DOMAIN/package-lock.json" "$TARGET:$REMOTE_DOMAIN/"

if [ "${NO_INSTALL:-0}" = "1" ]; then
  echo "== manifests synced, --no-install: skipping dependency step =="
  echo "next: run preflight_remote.py on the server to verify the installed line"
  exit 0
fi

echo "== 3/5 backup remote node_modules =="
ssh "$TARGET" "mkdir -p \$HOME/pi-domain-backups
  if [ -d '$REMOTE_DOMAIN/node_modules' ]; then cp -a '$REMOTE_DOMAIN/node_modules' '$BACKUP_DIR'; fi
  echo 'backup: $BACKUP_DIR'"

echo "== 4/5 registry connectivity =="
if ! ssh "$TARGET" "cd '$REMOTE_DOMAIN' && npm ping >/dev/null 2>&1"; then
  echo "FAIL: npm registry unreachable from server; node_modules left untouched."
  echo "      backup kept at $BACKUP_DIR (safe to delete)."
  exit 1
fi

echo "== 5/5 npm ci (rollback on failure) =="
if ! ssh "$TARGET" "cd '$REMOTE_DOMAIN' && npm ci --no-fund --no-audit"; then
  echo "npm ci FAILED — restoring backup..."
  ssh "$TARGET" "rm -rf '$REMOTE_DOMAIN/node_modules' && mv '$BACKUP_DIR' '$REMOTE_DOMAIN/node_modules'"
  echo "restored. inspect the failure above before retrying."
  exit 1
fi

echo "deployed. next:"
echo "  1. python3 preflight_remote.py        # version + content-mode checks"
echo "  2. run a SMOKE case with observability_content=full"
echo "  3. confirm Input/Output visible in the Langfuse trace"
