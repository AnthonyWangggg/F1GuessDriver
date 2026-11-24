"""Quarantine only the exact reviewed old edge pointers and stop listed old units."""

import json
from pathlib import Path
import os
import subprocess

import release as ops


def backup_old(cfg, expected):
    directory = ops.ETC / "old-review"
    inventory = directory / "inventory.json"
    ops.require(ops.HEX.fullmatch(expected) and ops.digest(inventory) == expected,
                "Use the reviewed inventory SHA256")
    source = ops.load(inventory)
    ops.require(source["mode"] == "READ_ONLY" and source["database"] == "f1guess_prod",
                "Unexpected legacy database")
    output = ops.ROOT / "backups" / ("legacy-" + expected[:12])
    output.mkdir(mode=0o700)
    archive = output / "database.dump"
    with archive.open("xb") as stream:
        ops.run(*ops.pg_args(cfg["pgPort"]), "pg_dump", "--format=custom", "-d", source["database"],
                stdout=stream, timeout=600)
    ops.verify_backup(archive, "SELECT count(*) FROM public.driver_stats;")
    # Archive only exact inventoried project paths. Directories are not recursively copied.
    cfg_archive = output / "configuration.tar"
    paths = []
    for name, metadata in source["paths"].items():
        path = Path(name)
        if not name.startswith(("/etc/f1guessdriver/", "/etc/nginx/", "/etc/systemd/system/f1guessdriver")):
            continue
        if metadata.get("present") is False:
            continue
        info = path.lstat()
        ops.require(info.st_ino == metadata["inode"] and info.st_dev == metadata["dev"] and
                    (os.readlink(path) if path.is_symlink() else None) == metadata["link"],
                    f"Inventoried config changed: {path}")
        paths.append(str(path.relative_to("/")))
    ops.require(paths, "No old configuration paths in reviewed inventory")
    ops.run("tar", "--create", "--no-recursion", "--file", str(cfg_archive), "-C", "/", "--", *paths)
    ops.run("tar", "--compare", "--file", str(cfg_archive), "-C", "/")
    ops.save(output / "receipt.json", {"inventorySha256": expected,
             "databaseRestoredSeparately": True, "configBackupVerified": True,
             "databaseSha256": ops.digest(archive), "configSha256": ops.digest(cfg_archive)})
    print(str(output / "receipt.json"))


def isolate_old(cfg, expected, release):
    directory = ops.ETC / "old-review"
    manifest = directory / "isolation.json"
    ops.require(ops.HEX.fullmatch(expected) and ops.digest(manifest) == expected,
                "Exact user-approved isolation manifest SHA256 required")
    value = ops.load(manifest)
    ops.require(set(value) == {"inventorySha256", "restoreProofSha256", "approval", "nginxLinks", "units", "version"},
                "Unexpected isolation manifest fields")
    stg = ops.active("stg")
    ops.require(value["version"] == release == stg.get("version") and stg.get("result") == "PASS",
                "Isolation requires the exact STG-verified replacement")
    runtime, release_manifest = ops.verify(release)
    ops.publication_ready(runtime, release_manifest)
    ops.check_target(cfg, "prod")
    ops.compatible(cfg, "prod", release, runtime)
    for key, filename in (("inventorySha256", "inventory.json"), ("restoreProofSha256", "restore-proof.json")):
        ops.require(ops.digest(directory / filename) == value[key], f"Reviewed {filename} does not match")
    proof = ops.load(directory / "restore-proof.json")
    for field in ("databaseRestoredSeparately", "configBackupVerified", "noSharedDependencies"):
        ops.require(proof.get(field) is True, f"Missing verified {field}")
    ops.require(isinstance(value["approval"], str) and len(value["approval"]) >= 4,
                "Record the user's exact isolation approval")
    backup = ops.ROOT / "backups" / ("legacy-" + value["inventorySha256"][:12])
    receipt = ops.load(backup / "receipt.json")
    ops.require(receipt["inventorySha256"] == value["inventorySha256"] and
                receipt["databaseRestoredSeparately"] and receipt["configBackupVerified"] and
                ops.digest(backup / "database.dump") == receipt["databaseSha256"] and
                ops.digest(backup / "configuration.tar") == receipt["configSha256"],
                "Legacy backup or verification receipt does not match")
    allowed_links = {"f1guessdriver-public-p4f", "f1guessdriver-internal-crl-v1"}
    allowed_units = {"f1guessdriver-p4d.service", "f1guessdriver-backup.service",
                     "f1guessdriver-backup.timer"} | {
        f"{prefix}@{slot}.service" for prefix in ("f1guessdriver", "f1guessdriver-v3")
        for slot in ("blue", "green")
    }
    inventory = ops.load(directory / "inventory.json")
    links = []
    for name, target in value["nginxLinks"].items():
        ops.require(name in allowed_links and isinstance(target, str), "Unlisted old Nginx resource")
        path = Path("/etc/nginx/sites-enabled") / name
        ops.require(inventory["paths"][str(path)]["link"] == target and
                    path.is_symlink() and os.readlink(path) == target, "Old Nginx link changed")
        links.append(path)
    units = value["units"]
    ops.require(len(units) == len(set(units)) and set(units) <= allowed_units and (units or links),
                "Invalid old unit or Nginx list")
    for unit in units:
        ops.require(inventory["units"][unit]["LoadState"] == "loaded",
                    f"Unit was absent from reviewed inventory: {unit}")
        ops.require(ops.run("systemctl", "show", "-p", "LoadState", "--value", unit,
                            capture_output=True, text=True).stdout.strip() == "loaded",
                    f"Old unit changed: {unit}")
    quarantine = Path("/etc/nginx") / ("f1-dual-old-" + expected[:12])
    quarantine.mkdir(mode=0o700)
    ops.run("nginx", "-t")
    moved = []
    try:
        for path in links:
            path.rename(quarantine / path.name)
            moved.append(path)
        ops.run("nginx", "-t")
        ops.run("systemctl", "reload", "nginx")
    except Exception:
        for path in reversed(moved):
            (quarantine / path.name).rename(path)
        ops.run("nginx", "-t")
        ops.run("systemctl", "reload", "nginx")
        raise
    # Put the backup timer ahead of writers in the approved unit list.
    for unit in units:
        ops.run("systemctl", "disable", "--now", unit)
    ops.save(directory / "isolation-receipt.json",
             {"status": "ISOLATED", "manifestSha256": expected, "version": release, "quarantine": str(quarantine)})
    print(json.dumps({"status": "ISOLATED", "quarantine": str(quarantine)}))
