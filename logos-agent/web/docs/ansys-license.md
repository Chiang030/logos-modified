# ANSYS license manager boot service

The optional installer scripts/install-ansys-license.py installs the vendor
license manager as a systemd service. It requires an existing installation and
its existing license configuration; it does not install, generate, or alter
licenses. Run it with sudo and an explicit installation owner:

```sh
sudo python3 scripts/install-ansys-license.py --directory <licensing-directory> --user <installation-owner>
systemctl status logos-ansys-license.service
```

The service starts after network readiness and the installation mount, uses
the vendor start/stop scripts as the non-root owner, restarts on process failure,
and is enabled for system boot. Check both lmgrd and ansyslmd with the installed
lmutil lmstat command; an active manager alone does not prove vendor readiness
or a successful solver license checkout.

If a stale vendor lock prevents startup, verify there is no vendor process and
no process holds the exact lock before preserving it under a backup name. Do
not remove a live lock or change license contents to resolve a startup error.
