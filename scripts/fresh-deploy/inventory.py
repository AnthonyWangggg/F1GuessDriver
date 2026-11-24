"""Read-only project inventory. Run --observe only in a separately approved window."""

import argparse
import json
import os
from pathlib import Path
import platform
import stat
import subprocess

UNITS = (
    "f1guessdriver-p4d.service",
    "f1guessdriver@blue.service", "f1guessdriver@green.service",
    "f1guessdriver-v3@blue.service", "f1guessdriver-v3@green.service",
    "f1guessdriver-backup.service", "f1guessdriver-backup.timer",
)
PATHS = (
    "/opt/f1guessdriver/releases",
    "/opt/f1guessdriver/releases/public-first-20261014-973cb1c4-prod5",
    "/opt/f1guessdriver/releases/public-web-20261014-03eb3157",
    "/opt/f1guessdriver/rolling",
    "/opt/f1guessdriver/rolling/releases",
    "/opt/f1guessdriver/rolling/releases/driverguess3-20261110-main",
    "/opt/f1guessdriver/rolling/slots",
    "/opt/f1guessdriver/rolling/slots/blue",
    "/opt/f1guessdriver/rolling/slots/green",
    "/opt/f1guessdriver/rolling/routing",
    "/opt/f1guessdriver/rolling/routing/current",
    "/opt/f1guessdriver/rolling/routing/g-v3-20261110",
    "/opt/f1guessdriver/maintenance",
    "/opt/f1guessdriver/controlled-prepare-20261109",
    "/opt/f1guessdriver/controlled-attested-20261109",
    "/etc/nginx/sites-enabled/f1guessdriver-public-p4f",
    "/etc/nginx/sites-enabled/f1guessdriver-internal-crl-v1",
    "/etc/nginx/conf.d/f1guessdriver-rolling-upstream.conf",
    "/etc/systemd/system/f1guessdriver@.service",
    "/etc/systemd/system/f1guessdriver-v3@.service",
    "/etc/systemd/system/f1guessdriver-p4d.service",
    "/etc/systemd/system/f1guessdriver-backup.service",
    "/etc/systemd/system/f1guessdriver-backup.timer",
    "/etc/f1guessdriver/p4d.env",
    "/etc/f1guessdriver/backup.env",
    "/etc/f1guessdriver/v3-20261110",
    "/etc/f1guessdriver/v3-20261110/identity.env",
    "/etc/f1guessdriver/v3-20261110/runtime.env",
    "/etc/f1guessdriver/v3-20261110/blue.env",
    "/etc/f1guessdriver/v3-20261110/green.env",
    "/var/backups/f1guessdriver/encrypted",
    "/var/backups/f1guessdriver/keys",
    "/var/backups/f1guessdriver/v3-app-keys-20261110",
)
DATABASE = "f1guess_prod"
ROLES = (
    "f1guess_app", "f1guess_maint", "f1guess_backup",
    "f1guess_v3_migrate_20261110", "f1guess_v3_app_20261110",
)


def metadata(path):
    try:
        info = Path(path).lstat()
    except FileNotFoundError:
        return {"present": False}
    return {
        "present": True, "mode": oct(info.st_mode), "uid": info.st_uid,
        "gid": info.st_gid, "dev": info.st_dev, "inode": info.st_ino,
        "link": os.readlink(path) if stat.S_ISLNK(info.st_mode) else None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--dry-run", action="store_true")
    action.add_argument("--observe", action="store_true")
    args = parser.parse_args()
    result = {"mode": "DRY_RUN", "paths": PATHS, "units": UNITS, "database": DATABASE, "roles": ROLES}
    if args.observe:
        if platform.system() != "Linux":
            parser.error("observations require a separately authorized Linux host")
        observed_units = {}
        for unit in UNITS:
            result_unit = subprocess.run(
                ["systemctl", "show", "--no-pager", "-p",
                 "Id,LoadState,ActiveState,UnitFileState,FragmentPath,DropInPaths", unit],
                check=False, capture_output=True, text=True, timeout=10,
            )
            fields = dict(
                line.split("=", 1) for line in result_unit.stdout.splitlines() if "=" in line
            )
            if result_unit.returncode and fields.get("LoadState") != "not-found":
                raise SystemExit(f"Cannot establish systemd metadata for {unit}")
            observed_units[unit] = fields
        result.update(mode="READ_ONLY", paths={p: metadata(p) for p in PATHS}, units=observed_units)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
