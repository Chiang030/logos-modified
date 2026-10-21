#!/usr/bin/env bash
set -Eeuo pipefail
# Run once as root by the administrator. No broad recursive write permission is granted.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${ANSYS_ROOT:-/srv/shared/ansys_inc}"
GROUP="${ANSYS_GROUP:-ansys-users}"
LIC="$ROOT/shared_files/licensing"
getent group "$GROUP" >/dev/null || groupadd --system "$GROUP"
setfacl -Rm "g:$GROUP:rx,m::rx" "$LIC/linx64" "$LIC/license_files"
setfacl -m "g:$GROUP:rwx,m::rwx" "$LIC"
setfacl -m "g:$GROUP:rw,m::rw" "$LIC/license.log"
setfacl -d -m "g:$GROUP:rw,m::rw" "$LIC"
install -m 0755 "$SCRIPT_DIR/ansys-license" /usr/local/sbin/ansys-license
cat >/etc/sudoers.d/ansys-license <<SUDO
$GROUP ALL=(root) NOPASSWD: /usr/local/sbin/ansys-license start, /usr/local/sbin/ansys-license stop, /usr/local/sbin/ansys-license restart, /usr/local/sbin/ansys-license status, /usr/local/sbin/ansys-license check
SUDO
chmod 0440 /etc/sudoers.d/ansys-license
visudo -cf /etc/sudoers.d/ansys-license
