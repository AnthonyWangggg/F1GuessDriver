#!/usr/bin/python3
"""Driver Guess dual-environment release controller. Installed outside the repository."""

import contextlib
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

ROOT = Path("/srv/f1-dual")
ETC = Path("/etc/f1-dual")
LIB = Path("/usr/local/lib/f1-dual")
BIN = "/opt/f1-dual-toolchain/bin"
ENVIRONMENTS = ("stg", "prod")
NAME = re.compile(r"[a-f0-9]{40}-[a-f0-9]{64}")
HEX = re.compile(r"[a-f0-9]{64}")
MAX_SOURCE = 128 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def digest(path):
    hash_ = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hash_.update(chunk)
    return hash_.hexdigest()


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def save(path, data):
    swap = path.with_name(path.name + ".next")
    with swap.open("w", encoding="utf-8") as stream:
        json.dump(data, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(swap, path)


def link(path, target):
    swap = path.with_name(path.name + ".next")
    swap.unlink(missing_ok=True)
    swap.symlink_to(target)
    os.replace(swap, path)


def config():
    path = ETC / "host.json"
    require(path.stat().st_uid == 0 and path.stat().st_mode & 0o077 == 0,
            "Host configuration must be private and root-owned")
    cfg = load(path)
    for env in ENVIRONMENTS:
        item = cfg[env]
        require(re.fullmatch(r"[a-z0-9][a-z0-9.-]+", item["domain"]), "Invalid domain")
        require(type(item["port"]) is int and 1024 <= item["port"] <= 65535, "Invalid port")
    for key in ("domain", "port"):
        require(cfg["stg"][key] != cfg["prod"][key], f"Shared {key}")
    require(type(cfg["pgPort"]) is int and 1024 <= cfg["pgPort"] <= 65535, "Invalid pgPort")
    require(cfg["pgPort"] not in [cfg[env]["port"] for env in ENVIRONMENTS], "Database port collision")
    require(re.fullmatch(r"24\.\d+\.\d+", cfg["nodeVersion"]) and
            HEX.fullmatch(cfg["nodeSha256"]), "Pin Node 24 and its SHA256")
    return cfg


@contextlib.contextmanager
def locked():
    import fcntl

    with (ROOT / "deployment.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("Another deployment or bootstrap is running") from exc
        yield


def db(env):
    require(env in ENVIRONMENTS, "Invalid database environment")
    return f"f1dg3_{env}"


def pg_args(port):
    return ("runuser", "-u", "postgres", "--", "env", "-i", "PATH=/usr/bin:/bin",
            "PGHOST=/var/run/postgresql", f"PGPORT={port}", "PGUSER=postgres")


def sql(port, database, statement):
    return run(*pg_args(port), "psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-d", database,
               input=statement, text=True, encoding="utf-8", stdout=subprocess.PIPE, timeout=300).stdout.strip()


def migration_files(runtime):
    folder = runtime / "packages/database/migrations"
    entries = load(folder / "meta/_journal.json")["entries"]
    result = []
    for entry in entries:
        require(re.fullmatch(r"[0-9]{4}_[a-z0-9_]+", entry["tag"]), "Invalid migration tag")
        path = folder / (entry["tag"] + ".sql")
        result.append((digest(path), int(entry["when"]), path))
    require(result and sorted({row[1] for row in result}) == [row[1] for row in result],
            "Migration timestamps must be ordered and unique")
    return result


def journal(runtime):
    return [[sha, stamp] for sha, stamp, _ in migration_files(runtime)]


def live_journal(port, env):
    return json.loads(sql(port, db(env), """
        SELECT coalesce(json_agg(json_build_array(hash,created_at) ORDER BY id),'[]')
        FROM drizzle.__drizzle_migrations;
    """))


def check_target(cfg, env):
    from urllib.parse import urlsplit

    path = ETC / (env + ".env")
    require(path.stat().st_uid == 0 and path.stat().st_mode & 0o077 == 0,
            "Runtime configuration must be private and root-owned")
    settings = dict(line.split("=", 1) for line in path.read_text().splitlines() if line)
    target = urlsplit(settings["DATABASE_URL"])
    role = db(env) + "_app"
    other = db("prod" if env == "stg" else "stg")
    require(target.scheme == "postgresql" and target.hostname == "127.0.0.1" and
            target.port == cfg["pgPort"] and target.path == "/" + db(env) and
            target.username == role and not target.query and not target.fragment,
            "Runtime DATABASE_URL does not match the isolated database")
    require(settings.get("HOST") == "127.0.0.1" and settings.get("PORT") == str(cfg[env]["port"]) and
            settings.get("ALLOWED_ORIGINS") == "https://" + cfg[env]["domain"] and
            settings.get("COOKIE_SECURE") == "true" and settings.get("NODE_ENV") == "production" and
            HEX.fullmatch(settings.get("IDENTITY_ENCRYPTION_KEY", "")) and
            not settings.get("IDENTITY_KEYRING_JSON"), "Unsafe runtime environment")
    other_path = ETC / (("prod" if env == "stg" else "stg") + ".env")
    if other_path.exists():
        require("IDENTITY_ENCRYPTION_KEY=" + settings["IDENTITY_ENCRYPTION_KEY"] not in
                other_path.read_text().splitlines(), "Shared identity key")
    require(sql(cfg["pgPort"], db(env), f"""
        SELECT rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole
          OR rolreplication OR rolbypassrls OR rolinherit)
        AND NOT has_schema_privilege(rolname,'public','CREATE')
        AND NOT has_table_privilege(rolname,'points_ledger','UPDATE,DELETE,TRUNCATE')
        AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member=pg_roles.oid)
        AND NOT EXISTS (SELECT FROM pg_database WHERE datname='{other}'
          AND has_database_privilege(rolname,oid,'CONNECT'))
        AND NOT EXISTS (SELECT FROM pg_database WHERE datname='f1guess_prod'
          AND has_database_privilege(rolname,oid,'CONNECT'))
        AND NOT EXISTS (SELECT FROM pg_roles other_role WHERE rolname='{other}_app'
          AND has_database_privilege(other_role.oid,current_database(),'CONNECT'))
        AND EXISTS (SELECT FROM pg_class t JOIN pg_roles owner ON t.relowner=owner.oid
          WHERE t.oid='public.identity_principals'::regclass AND owner.rolname='{db(env)}_owner'
          AND NOT owner.rolcanlogin AND NOT owner.rolsuper
          AND NOT has_schema_privilege(owner.oid,'public','CREATE'))
        AND NOT EXISTS (SELECT FROM pg_constraint fk JOIN pg_class t ON t.oid=fk.confrelid
          WHERE fk.contype='f' AND t.relnamespace='public'::regnamespace
          AND NOT has_schema_privilege(t.relowner,t.relnamespace,'USAGE'))
        FROM pg_roles WHERE rolname='{role}';
    """) == "t", "Database role isolation or foreign-key parent permissions failed")


def safe_additive(path):
    # Deliberately narrow. Complex SQL goes through the reviewed maintenance procedure.
    pattern = r"ALTER TABLE public\.[a-z_][a-z_0-9]* ADD COLUMN [a-z_][a-z_0-9]* (text|integer|bigint|boolean|uuid|timestamptz);"
    statements = path.read_text(encoding="utf-8").strip().split("--> statement-breakpoint")
    require(all(re.fullmatch(pattern, s.strip(), re.IGNORECASE) for s in statements),
            "Unsupported automatic migration SQL; use reviewed maintenance procedure")
    return "\n".join(s.strip() for s in statements)


def approval(env, release, previous, actual, expected):
    path = ETC / "migrations" / f"{env}-{release}.json"
    require(path.is_file(), "Migration/rollback compatibility approval required: " + str(path))
    require(load(path) == {"previous": previous, "from": actual, "to": expected},
            "Migration approval does not match the exact transition")


def compatible(cfg, env, release, runtime, previous=None, rollback=False, apply=False):
    port = cfg["pgPort"]
    current = live_journal(port, env)
    expected = journal(runtime)
    if current == expected:
        return
    if rollback:
        try:
            approval(env, previous, release, expected, current)
            require(current[:len(expected)] == expected, "Database is not an additive extension")
            for _, _, path in migration_files(version(previous) / "runtime")[len(expected):]:
                safe_additive(path)
        except RuntimeError as exc:
            raise RuntimeError(
                f"Rollback blocked by schema mismatch. Retain live data; see backup receipts in "
                f"{ROOT}/backups/prod and rehearse restore to a separate database. {exc}"
            ) from exc
        return
    require(previous and current and expected[:len(current)] == current,
            "Journal differs; inspect exact target and migration history")
    approval(env, release, previous, current, expected)
    require(journal(version(previous) / "runtime") == current, "Previous runtime journal differs")
    statements = []
    for sha, stamp, path in migration_files(runtime)[len(current):]:
        statements.extend((safe_additive(path), f"""
            INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ('{sha}',{stamp});
        """))
    if apply:
        checks = json.dumps(current, separators=(",", ":"))
        sql(port, db(env), f"""
            BEGIN;
            SET LOCAL lock_timeout = '5s';
            SET LOCAL statement_timeout = '30s';
            LOCK TABLE drizzle.__drizzle_migrations IN EXCLUSIVE MODE;
            DO $$ BEGIN
              IF (SELECT coalesce(jsonb_agg(jsonb_build_array(hash,created_at) ORDER BY id),'[]')
                  FROM drizzle.__drizzle_migrations) <> '{checks}'::jsonb THEN
                RAISE EXCEPTION 'Migration journal changed';
              END IF;
            END $$;
            SET LOCAL ROLE {db(env)}_owner;
            {"".join(statements)}
            COMMIT;
        """)
        require(live_journal(port, env) == expected, "Migration journal verification failed")


def version(release):
    require(isinstance(release, str) and NAME.fullmatch(release), "Invalid release ID")
    return ROOT / "versions" / release


def verify(release):
    path = version(release)
    manifest = load(path / "manifest.json")
    require(manifest["version"] == release and
            digest(path / "runtime.tar.gz") == release.split("-")[1] == manifest["sha256"],
            "Artifact SHA256 mismatch")
    # The stored tree is root-owned and read-only. Revalidate contents and symlinks.
    run("tar", "--compare", "--gzip", "--file", str(path / "runtime.tar.gz"),
        "--directory", str(path / "runtime"))
    return path / "runtime", manifest


def publication_ready(runtime, manifest):
    inventory = load(runtime / "docs/licenses/dependencies.json")
    require(manifest["publicationPass"] and inventory["lockSha256"] == manifest["lockSha256"] and
            bool(inventory["packages"]) and all(
                item["evidence"] and not re.search("unknown|unlicensed", item["license"], re.I)
                and item.get("versionReviews") and all(
                    row["status"] == "confirmed" for row in item["versionReviews"])
                for item in inventory["packages"]),
            "Publication gate blocked this artifact; unresolved license evidence remains")


def source_allowed(name):
    path = PurePosixPath(name)
    deny = {"node_modules", "dist", "build", "local-private", "local-archive", "release",
            "test-results", "playwright-report", "coverage", "backups", ".git", ".npmrc", ".pnpm-store"}
    return (bool(path.parts) and not path.is_absolute() and ".." not in path.parts and
            not any(p in deny or p.startswith((".env", "diagnostic")) for p in path.parts) and
            not re.search(r"[\\\r\n]|\.(log|trace|webm|pem|key|dump|backup|f1backup|zip|gz)$", name))


def receive(path, expected):
    size = 0
    with path.open("xb") as output:
        while chunk := sys.stdin.buffer.read(1024 * 1024):
            size += len(chunk)
            require(size <= MAX_SOURCE, "Source exceeds size limit")
            output.write(chunk)
    require(digest(path) == expected, "Uploaded source SHA256 mismatch")


def extract_source(archive, source):
    seen = set()
    with tarfile.open(archive, "r:") as tar:
        for member in tar:
            path = PurePosixPath(member.name)
            require(source_allowed(member.name) and path not in seen and
                    (member.isfile() or member.isdir()), f"Unsafe source member: {member.name!r}")
            seen.add(path)
            target = source / path
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as stream, target.open("xb") as output:
                    shutil.copyfileobj(stream, output)


def check_archive_permissions(archive):
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            require(member.uid == 0 and member.gid == 0 and
                    not member.mode & 0o7000 and
                    (member.issym() or not member.mode & 0o222),
                    f"Unsafe runtime ownership or permissions: {member.name!r}")


def build(cfg, commit, lock, source_sha):
    require(platform.system() == "Linux" and 'ID=ubuntu' in
            Path("/etc/os-release").read_text().splitlines(), "Ubuntu builder required")
    require(re.fullmatch(r"[a-f0-9]{40}", commit) and HEX.fullmatch(lock) and
            HEX.fullmatch(source_sha), "Invalid source identifiers")
    require(digest(Path(BIN) / "node") == cfg["nodeSha256"], "Node executable SHA256 mismatch")
    with tempfile.TemporaryDirectory(prefix="build-", dir=ROOT / "work") as work:
        job = Path(work)
        job.chmod(0o711)
        source = job / "source"
        source.mkdir()
        archive = job / "source.tar"
        receive(archive, source_sha)
        with archive.open("rb") as stream:
            archived_commit = run("git", "get-tar-commit-id", stdin=stream,
                                  stdout=subprocess.PIPE, timeout=10).stdout.decode().strip()
        require(archived_commit == commit, "Git archive commit mismatch")
        cache = ROOT / "source-index" / (source_sha + ".json")
        if cache.is_file():
            record = load(cache)
            if record["node"] == cfg["nodeVersion"]:
                _, manifest = verify(record["version"])
                require(manifest["sourceSha256"] == source_sha and manifest["commit"] == commit and
                        manifest["lockSha256"] == lock, "Cached source identity mismatch")
                return manifest["version"]
        extract_source(archive, source)
        require(digest(source / "pnpm-lock.yaml") == lock, "Lock SHA256 mismatch")
        run("chown", "-R", "f1dg3_build:f1dg3_build", str(source))
        run("systemd-run", "--quiet", "--wait", "--pipe", "--collect",
            "--uid=f1dg3_build", "--gid=f1dg3_build",
            f"--working-directory={source}", "--property=NoNewPrivileges=yes",
            "--property=ProtectSystem=strict", f"--property=ReadWritePaths={source}",
            "--property=PrivateTmp=yes", "--property=ProtectHome=yes",
            "--property=InaccessiblePaths=/etc/f1-dual /srv/f1-dual/state /srv/f1-dual/backups /run/postgresql",
            "--property=IPAddressDeny=localhost",
            "--property=IPAddressAllow=127.0.0.53/32",
            "--property=MemoryHigh=900M", "--property=MemoryMax=1300M",
            "--property=MemorySwapMax=128M", "--property=CPUQuota=85%", "--property=Nice=10",
            "--property=RuntimeMaxSec=1200", f"--setenv=PATH={BIN}:/usr/bin:/bin",
            f"--setenv=HOME={source}", "--setenv=NODE_OPTIONS=--max-old-space-size=700",
            "/bin/bash", str(LIB / "build.sh"),
            cfg["nodeVersion"], lock)
        sealed = job / "sealed"
        sealed.mkdir()
        artifact = sealed / "runtime.tar.gz"
        built = source / "runtime.tar.gz"
        require(built.is_file() and not built.is_symlink(), "Missing runtime archive")
        shutil.copyfile(built, artifact)
        sha = digest(artifact)
        release = f"{commit}-{sha}"
        path = version(release)
        if path.exists():
            verify(release)
            return release
        run(sys.executable, str(LIB / "check-linux-archive.py"), str(artifact),
            "--arch", platform.machine())
        check_archive_permissions(artifact)
        runtime = sealed / "runtime"
        runtime.mkdir()
        # Keep archival modes/ownership consistent for tar --compare. The builder creates
        # only root-owned archive entries and removes write bits before taking the archive.
        run("tar", "--extract", "--gzip", "--file", str(artifact), "--directory", str(runtime),
            "--same-permissions", "--no-same-owner")
        require(not any(p.lstat().st_mode & 0o222 for p in runtime.rglob("*") if not p.is_symlink()),
                "Runtime archive contains writable entries")
        save(sealed / "manifest.json", {"version": release, "sha256": sha, "commit": commit,
             "sourceSha256": source_sha, "lockSha256": lock, "node": cfg["nodeVersion"],
             "pnpm": "11.25.0", "publicationPass": (source / "publication-pass").is_file()})
        artifact.chmod(0o444)
        (sealed / "manifest.json").chmod(0o444)
        sealed.chmod(0o555)
        sealed.rename(path)
        verify(release)
        save(cache, {"node": cfg["nodeVersion"], "version": release})
        return release


def state_dir(env):
    return ROOT / "state" / env


def pointer_target(path):
    return os.readlink(path) if path.is_symlink() else None


def active(env):
    target = pointer_target(state_dir(env) / "active")
    return load(Path(target) / "receipt.json") if target else {}


def service(env, operation):
    run("systemctl", operation, f"f1-dual@{env}.service", timeout=65)


def smoke(cfg, env, release):
    settings = cfg[env]
    domain = settings["domain"]
    url = "https://" + domain
    jar = state_dir(env) / "synthetic.cookies"
    # Curl does not reliably report cookie-jar write failures. Keep it on a private path.
    options = ["curl", "--silent", "--show-error", "--fail", "--max-time", "8",
               "--resolve", f"{domain}:443:127.0.0.1"]
    internal = env == "stg" and not Path("/etc/nginx/conf.d/f1-dual-stg.conf").exists()
    if internal:
        url = f"http://localhost:{settings['port']}"
        options[-1] = f"localhost:{settings['port']}:127.0.0.1"
    elif env == "stg":
        options.extend(("--config", str(ETC / "stg-smoke.curl")))
    if not internal:
        marker = run(*options, url + "/.f1-deploy-version", stdout=subprocess.PIPE).stdout
        require(marker.decode().strip() == release, f"{env} Nginx is not serving the selected release")
    for probe in ("/", "/api/health", "/api/runtime-readiness", "/api/v3/quick/options"):
        for attempt in range(12):
            result = subprocess.run([*options, "--output", "/dev/null", "--write-out", "%{http_code}",
                                     url + probe], stdout=subprocess.PIPE)
            if result.returncode == 0 and result.stdout == b"200":
                break
            require(attempt < 11, f"{env} smoke failed at {probe}")
            time.sleep(2)
    if internal:
        pid = run("systemctl", "show", "--value", "-p", "MainPID", "f1-dual@stg.service",
                  text=True, stdout=subprocess.PIPE).stdout.strip()
        require(pid.isdigit() and int(pid) > 0 and
                os.path.samefile(f"/proc/{pid}/cwd", version(release) / "runtime"),
                "STG main PID is not running the selected runtime")
        page = run(*options, url + "/", stdout=subprocess.PIPE).stdout.decode()
        asset = re.search(r'src="(/assets/[A-Za-z0-9._-]+\.js)"', page)
        require(asset and run(*options, url + asset[1], stdout=subprocess.PIPE).stdout,
                "STG static asset probe failed")
    require(settings.get("syntheticSessionApproval"), f"Authorize {env} synthetic session write")
    endpoint = url + "/api/v3/modes/session"
    args = [*options, "--cookie", str(jar), "--cookie-jar", str(jar), endpoint]
    identity = json.loads(run(*args, stdout=subprocess.PIPE).stdout)
    require(identity.get("contract") == "modes-v1" and identity.get("principalId") and
            identity.get("csrfToken"), f"{env} mode session contract failed")
    recovered = json.loads(run(*args, stdout=subprocess.PIPE).stdout)
    require(recovered == identity, f"{env} synthetic session recovery failed")
    practice = json.loads(run(*options, "--cookie", str(jar),
                              url + "/api/v3/quick/active", stdout=subprocess.PIPE).stdout)
    require(isinstance(practice, dict), f"{env} practice API contract failed")


def backup(cfg, env):
    identifier = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    directory = ROOT / "backups" / env
    partial = directory / (identifier + ".partial")
    partial.mkdir(mode=0o700)
    archive = partial / "database.dump"
    with archive.open("xb") as stream:
        run(*pg_args(cfg["pgPort"]), "pg_dump", "--format=custom", "-d", db(env),
            stdout=stream, timeout=600)
    require(archive.stat().st_size > 0, "Empty database backup")
    verify_backup(archive)
    save(partial / "receipt.json", {"id": identifier, "database": db(env), "sha256": digest(archive),
                                   "before": active(env), "validation": "restore in independent socket-only cluster"})
    partial.rename(directory / identifier)
    return identifier


def verify_backup(archive, probe="SELECT count(*) FROM driver_stats, (SELECT count(*) FROM identity_principals) a;"):
    pg = Path("/usr/lib/postgresql/18/bin")
    runner = ("runuser", "-u", "postgres", "--", "env", "-i", "PATH=/usr/bin:/bin")
    with tempfile.TemporaryDirectory(prefix="f1-dual-backup-verify-", dir="/var/tmp") as directory:
        run("chown", "postgres:postgres", directory)
        root = Path(directory)
        data = root / "data"
        cluster = (*runner, str(pg / "pg_ctl"), "-D", str(data))
        connection = ("-h", directory, "-p", "5432", "-U", "postgres", "-d", "postgres")
        run(*runner, str(pg / "initdb"), "-D", str(data), "--auth-local=peer", "--auth-host=reject",
            "--locale=C", "--encoding=UTF8", stdout=subprocess.DEVNULL, timeout=60)
        try:
            run(*cluster, "-w", "-t", "30", "-l", str(root / "postgres.log"),
                "-o", f"-c listen_addresses='' -c unix_socket_directories={directory}", "start",
                timeout=40, stdout=subprocess.DEVNULL)
            with archive.open("rb") as stream:
                run(*runner, str(pg / "pg_restore"), *connection, "--single-transaction",
                    "--no-owner", "--no-privileges", "--exit-on-error", stdin=stream, timeout=900)
            run(*runner, str(pg / "psql"), "-XqAt", *connection, "-v", "ON_ERROR_STOP=1",
                "-c", probe,
                stdout=subprocess.DEVNULL, timeout=30)
        finally:
            if (data / "postmaster.pid").exists():
                run(*cluster, "-m", "immediate", "-w", "stop", timeout=40, stdout=subprocess.DEVNULL)


def recover(cfg, env, smoke_fn=None):
    base = state_dir(env)
    pending = base / "pending.json"
    if not pending.exists():
        return
    old = load(pending)["old"]
    pointer = base / "active"
    if old:
        link(pointer, old)
        service(env, "restart")
        (smoke_fn or smoke)(cfg, env, active(env)["version"])
    else:
        service(env, "stop")
        pointer.unlink(missing_ok=True)
    pending.unlink()


def activate(cfg, env, release, old, backup_id, action, smoke_fn=None):
    base = state_dir(env)
    generation = base / ("generation-" + uuid.uuid4().hex)
    generation.mkdir(mode=0o755)
    generation.chmod(0o755)
    link(generation / "current", version(release) / "runtime")
    marker = generation / "version.txt"
    marker.write_text(release + "\n", encoding="ascii")
    marker.chmod(0o444)
    receipt = {"action": action, "result": "PASS", "environment": env, "version": release,
               "sha256": release.split("-")[1], "previous": old.get("version"),
               "backup": backup_id, "url": (
                   f"http://127.0.0.1:{cfg[env]['port']}" if env == "stg" and
                   not Path("/etc/nginx/conf.d/f1-dual-stg.conf").exists()
                   else "https://" + cfg[env]["domain"]),
               "time": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    pointer = base / "active"
    pending = base / "pending.json"
    save(pending, {"old": pointer_target(pointer)})
    try:
        link(pointer, generation)
        started = time.time()
        service(env, "restart")
        (smoke_fn or smoke)(cfg, env, release)
        logs = run("journalctl", "-u", f"f1-dual@{env}.service", "--since", f"@{int(started)}",
                   "--no-pager", "-o", "json", stdout=subprocess.PIPE).stdout.splitlines()
        for line in logs:
            entry = json.loads(line)
            match = re.search(r'"level"\s*:\s*(\d+)', entry.get("MESSAGE", ""))
            require(int(entry.get("PRIORITY", 6)) > 3 and (not match or int(match[1]) < 50),
                    f"New service errors; inspect journalctl -u f1-dual@{env}.service")
        service(env, "enable")
        save(generation / "receipt.json", receipt)
    except Exception:
        recover(cfg, env, smoke_fn=smoke_fn)
        raise
    pending.unlink()
    if env == "stg":
        save(ROOT / "accepted" / (release + ".json"), receipt)
    print(json.dumps(receipt), flush=True)


def main(args):
    require(os.geteuid() == 0, "Use the installed privileged controller")
    require((len(args) == 4 and args[0] == "stg") or (len(args) == 2 and args[0] == "prod") or
            (len(args) == 1 and args[0] in ("status", "rollback")), "Invalid deployment invocation")
    action = args[0]
    cfg = config()
    with locked():
        if action == "status":
            print(json.dumps({env: {"release": active(env), "pending": (state_dir(env) / "pending.json").exists()}
                              for env in ENVIRONMENTS}))
            return
        env = "stg" if action == "stg" else "prod"
        first = state_dir("prod") / "first-prod.json"
        if env == "prod" and first.exists():
            require(load(first).get("phase") == "PUBLIC_VERIFIED" and
                    not (state_dir("prod") / "edge-pending.json").exists(),
                    "First PROD is not publicly verified; use the explicit first-PROD controller")
        check_target(cfg, env)
        recover(cfg, env)
        old = active(env)
        if action == "rollback":
            release = old.get("previous")
            runtime, _ = verify(release)
            compatible(cfg, env, release, runtime, old["version"], rollback=True)
            activate(cfg, env, release, old, old.get("backup"), action)
            return
        release = build(cfg, *args[1:]) if env == "stg" else args[1]
        runtime, manifest = verify(release)
        if env == "prod":
            accepted = load(ROOT / "accepted" / (release + ".json"))
            require(accepted["result"] == "PASS" and accepted["environment"] == "stg" and
                    accepted["version"] == release and accepted["sha256"] == manifest["sha256"],
                    "Exact artifact has not passed STG")
            publication_ready(runtime, manifest)
        if old.get("version") == release:
            smoke(cfg, env, release)
            if env == "stg":
                save(ROOT / "accepted" / (release + ".json"), old)
            print(json.dumps(old))
            return
        compatible(cfg, env, release, runtime, old.get("version"))
        backup_id = backup(cfg, env) if env == "prod" else None
        if backup_id:
            print(f"Verified backup: {backup_id}", flush=True)
        compatible(cfg, env, release, runtime, old.get("version"), apply=True)
        activate(cfg, env, release, old, backup_id, action)


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main(sys.argv[1:])
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"Deploy stopped: {error}", file=sys.stderr)
        sys.exit(1)
