#!/usr/bin/env bash
# Bounded read-only probes; no privileged commands or configuration edits.
set -u
if ! command -v bwrap >/dev/null 2>&1; then
  printf '%s\n' 'bubblewrap is not available on PATH.'
  exit 1
fi
if ! command -v timeout >/dev/null 2>&1; then
  printf '%s\n' 'timeout is required to bound these probes.'
  exit 1
fi
bwrap --version
printf '%s\n' 'Probe 1: full namespaces'
timeout 10s bwrap --unshare-all --die-with-parent \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --symlink usr/bin /bin --proc /proc --dev /dev --tmpfs /tmp /usr/bin/true
full_status=$?
printf 'Probe 1 exit: %s\n' "$full_status"
printf '%s\n' 'Probe 2: namespaces without network isolation'
timeout 10s bwrap --unshare-user --unshare-pid --unshare-ipc --unshare-uts \
  --die-with-parent --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --symlink usr/bin /bin --proc /proc --dev /dev --tmpfs /tmp /usr/bin/true
basic_status=$?
printf 'Probe 2 exit: %s\n' "$basic_status"
printf '%s\n' 'Passing probes does not prove Agent isolation or solver compatibility.'
if [ "$full_status" -ne 0 ] || [ "$basic_status" -ne 0 ]; then exit 1; fi
