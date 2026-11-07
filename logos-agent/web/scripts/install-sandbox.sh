#!/usr/bin/env bash
# Administrator-run installation of the narrowly attached user-namespace profile.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Run with sudo. This installs only the LOGOS bwrap copy and its AppArmor profile.'
  exit 1
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
profile="$script_dir/../deploy/logos-web-bwrap.apparmor"
test -f "$profile"
test -x /usr/bin/bwrap
/usr/sbin/apparmor_parser -Q -K "$profile"
install -d -m 0755 /usr/local/libexec
install -o root -g root -m 0755 /usr/bin/bwrap /usr/local/libexec/logos-web-bwrap
install -o root -g root -m 0644 "$profile" /etc/apparmor.d/logos-web-bwrap
/usr/sbin/apparmor_parser -r /etc/apparmor.d/logos-web-bwrap
printf '%s\n' 'LOGOS sandbox launcher installed. Global AppArmor and kernel protections remain enabled.'
