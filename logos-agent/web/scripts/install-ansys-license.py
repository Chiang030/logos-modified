"""Install an existing ANSYS license manager as a systemd boot service."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import pwd
import subprocess

UNIT_NAME = "logos-ansys-license.service"


def render_unit(directory: Path, username: str) -> str:
    """Build a service using the vendor's existing start and stop scripts."""
    account = pwd.getpwnam(username)
    if account.pw_uid == 0:
        raise ValueError("Select the non-root account that owns the license installation")
    if any(char in str(directory) for char in '\n\r"%'):
        raise ValueError("Unsupported character in the licensing directory")
    return f"""[Unit]
Description=ANSYS license manager managed by LOGOS deployment
Wants=network-online.target
After=network-online.target
RequiresMountsFor={directory}

[Service]
Type=forking
User={username}
WorkingDirectory={directory}
ExecStart={directory}/start_ansyslmd
ExecStop={directory}/stop_ansyslmd
Restart=on-failure
RestartSec=10
LimitNOFILE=10240
TimeoutStartSec=60
TimeoutStopSec=30
KillMode=control-group
UMask=0022

[Install]
WantedBy=multi-user.target
"""


def main() -> None:
    """Validate the installation, then install or preview the system unit."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--print-only", action="store_true")
    args = parser.parse_args()
    directory = args.directory.resolve(strict=True)
    for name in ("start_ansyslmd", "stop_ansyslmd", "linx64/lmgrd", "linx64/lmutil"):
        if not (directory / name).is_file():
            raise FileNotFoundError(directory / name)
    content = render_unit(directory, args.user)
    if args.print_only:
        print(content)
        return
    if os.geteuid() != 0:
        raise PermissionError("Installing a system service requires sudo")
    unit = Path("/etc/systemd/system") / UNIT_NAME
    if unit.exists() and unit.read_text() != content:
        raise FileExistsError(f"Review the existing service before replacing it: {unit}")
    unit.write_text(content)
    unit.chmod(0o644)
    subprocess.run(["systemd-analyze", "verify", str(unit)], check=True)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "--now", UNIT_NAME], check=True)
    subprocess.run(["systemctl", "is-active", UNIT_NAME], check=True)


if __name__ == "__main__":
    main()
