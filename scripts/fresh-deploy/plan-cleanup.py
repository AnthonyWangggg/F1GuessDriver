"""Render an exact cleanup review from a separately collected inventory."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
sys.dont_write_bytecode = True
from inventory import DATABASE, PATHS, ROLES, UNITS

GROUPS = {
    "paths": set(PATHS) - {
        "/opt/f1guessdriver/releases", "/opt/f1guessdriver/rolling",
        "/opt/f1guessdriver/rolling/releases", "/opt/f1guessdriver/rolling/slots",
        "/opt/f1guessdriver/rolling/routing",
        "/etc/f1guessdriver/v3-20261110",
        "/var/backups/f1guessdriver/encrypted", "/var/backups/f1guessdriver/keys",
        "/var/backups/f1guessdriver/v3-app-keys-20261110",
    },
    "units": set(UNITS),
    "databases": {DATABASE},
    "roles": set(ROLES),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    if not args.manifest:
        print(json.dumps({"mode": "DRY_RUN", "state": "INVENTORY_REQUIRED",
                          "candidates": {k: sorted(v) for k, v in GROUPS.items()}}, indent=2))
        return
    raw = args.manifest.read_bytes()
    data = json.loads(raw)
    if set(data) != {"inventorySha256", "restoreProofSha256", "resources"}:
        parser.error("unexpected manifest fields")
    for key in ("inventorySha256", "restoreProofSha256"):
        if not isinstance(data[key], str) or not re.fullmatch(r"[a-f0-9]{64}", data[key]):
            parser.error(f"{key} must bind a reviewed evidence file")
    resources = data["resources"]
    if set(resources) != set(GROUPS):
        parser.error("unexpected resource groups")
    for group, entries in resources.items():
        if (
            not isinstance(entries, list) or not all(isinstance(value, str) for value in entries)
            or len(set(entries)) != len(entries) or not set(entries) <= GROUPS[group]
        ):
            parser.error(f"unlisted or duplicate {group} target")
    print(json.dumps({
        "mode": "DRY_RUN", "state": "AWAITING_DELETION_APPROVAL",
        "manifestSha256": hashlib.sha256(raw).hexdigest(),
        "resources": resources,
        "sequence": [
            "Verify fresh inventory, ownership, shared references and external restore proof",
            "Fence traffic and stop exact project writers and timers",
            "Quarantine exact project paths on the same filesystem",
            "Drop only the bound database without FORCE after zero sessions",
            "Check cross-database role dependencies; detach approved references before DROP ROLE",
            "Verify all expected absences, then separately approve any quarantine purge",
        ],
    }, indent=2))


if __name__ == "__main__":
    main()
