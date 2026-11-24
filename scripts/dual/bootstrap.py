import base64
import gzip
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys

sys.dont_write_bytecode = True
import release as ops

HISTORY = ("seasons drivers constructors driver_aliases constructor_aliases races race_results "
           "driver_seasons driver_constructor_stints pole_audits race_poles dataset_versions "
           "driver_stats driver_career_timelines").split()
LEGACY = ("daily_submissions daily_guesses daily_entries daily_rate_limits daily_challenges "
          "match_guesses match_memberships match_players match_requests match_rate_limits "
          "match_queue matches").split()
ACTIVE = "f1-2026-10-08-994df511b40814a5"
POLES = "f1-2026-10-08-2190d6c32d9f664f"
LEGACY_VERSION = "f1-2026-10-08-f46cf6e4723d322d"
POINTS = "daily-v2:success=1;match-v2-bo3:win=3,loss=-1;floor=0"


def scram(password):
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 4096)
    client = hmac.digest(salted, b"Client Key", "sha256")
    stored = hashlib.sha256(client).digest()
    server = hmac.digest(salted, b"Server Key", "sha256")
    b64 = lambda b: base64.b64encode(b).decode()
    return f"SCRAM-SHA-256$4096:{b64(salt)}${b64(stored)}:{b64(server)}"


def install_dirs(environments=ops.ENVIRONMENTS):
    for relative, mode in (("", 0o755), ("work", 0o711), ("versions", 0o755),
                           ("state", 0o755), ("backups", 0o700), ("accepted", 0o700),
                           ("source-index", 0o700)):
        path = ops.ROOT / relative
        path.mkdir(exist_ok=True)
        path.chmod(mode)
    (ops.ETC / "migrations").mkdir(exist_ok=True)
    for env in environments:
        for path, mode in [(ops.state_dir(env), 0o755), (ops.ROOT / "backups" / env, 0o700)]:
            path.mkdir(exist_ok=True)
            path.chmod(mode)
        if subprocess.run(["id", "-u", ops.db(env)], capture_output=True).returncode != 0:
                ops.run("/usr/sbin/useradd", "--system", "--user-group", "--no-create-home", "--shell",
                    "/usr/sbin/nologin", ops.db(env))
    if subprocess.run(["id", "-u", "f1dg3_build"], capture_output=True).returncode != 0:
        ops.run("/usr/sbin/useradd", "--system", "--user-group", "--no-create-home", "--shell",
                "/usr/sbin/nologin", "f1dg3_build")
    unit = Path("/etc/systemd/system/f1-dual@.service")
    source = ops.LIB / unit.name
    if unit.exists():
        ops.require(unit.read_bytes() == source.read_bytes(), "Existing unit differs")
    else:
        ops.run("install", "-m", "0644", str(source), str(unit))
    ops.run("systemctl", "daemon-reload")


def import_bridge(cfg, env, runtime, bridge, expected):
    ops.require(ops.HEX.fullmatch(expected) and ops.digest(bridge) == expected,
                "Certified bridge SHA256 mismatch")
    with gzip.open(bridge, "rb") as stream:
        data = stream.read(128 * 1024 * 1024 + 1)
    ops.require(len(data) <= 128 * 1024 * 1024, "Bridge too large")
    value = json.loads(data)
    ops.require(value["format"] == "certified-history-bridge-v1" and
                value["sourceCollation"] == "Chinese (Simplified)_China.936" and
                [row["name"] for row in value["tables"]] == HISTORY,
                "Certified history allowlist mismatch")
    order = value["legacyOrder"]
    ops.require(len(order) == len(set(order)) == 881, "Invalid legacy order")
    delimiter = "$bridge_" + secrets.token_hex(12) + "$"
    block = "$verify_" + secrets.token_hex(12) + "$"

    def literal(value):
        ops.require(delimiter not in value and block not in value, "Invalid bridge payload")
        return delimiter + value + delimiter

    statements = ["BEGIN;", "SET LOCAL TIME ZONE 'UTC';"]
    for row in value["tables"]:
        name = row["name"]
        body = row["body"]
        ops.require(hashlib.sha256(body.encode()).hexdigest() == row["sha256"], f"{name} digest")
        statements.append(f"""
          INSERT INTO public.{name}
          SELECT * FROM jsonb_populate_recordset(NULL::public.{name}, {literal(body)}::jsonb);
          DO {block} BEGIN
            IF (SELECT count(*) FROM public.{name}) <> {int(row["rows"])} OR
               (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"), '[]')::text
                FROM public.{name} t) <> {literal(body)} THEN
              RAISE EXCEPTION 'Certified history differs: {name}';
            END IF;
          END {block};
        """)
    baseline = ops.load(runtime / "reports/pole-audit/legacy-baseline.json")
    legacy_order = literal(json.dumps(order))
    statements.append(f"""
      SET LOCAL TIME ZONE 'Asia/Shanghai';
      DO {block} BEGIN
        IF (SELECT count(*) FROM driver_stats
            WHERE dataset_version='{LEGACY_VERSION}') <> 881
        OR (SELECT md5(jsonb_agg(to_jsonb(s)-'pole_positions' ORDER BY o.ordinality)::text)
            FROM driver_stats s JOIN jsonb_array_elements_text({legacy_order}::jsonb)
            WITH ORDINALITY o(driver_id, ordinality) USING (driver_id)
            WHERE dataset_version='{LEGACY_VERSION}') IS DISTINCT FROM {literal(baseline["stats_hash"])}
        OR (SELECT md5((to_jsonb(d)-'rules_version'-'pole_audit_id')::text)
            FROM dataset_versions d WHERE version='{LEGACY_VERSION}') IS DISTINCT FROM {literal(baseline["metadata_hash"])}
        OR (SELECT count(*) FROM driver_stats JOIN dataset_versions ON version=dataset_version
            WHERE version='{ACTIVE}' AND eligible AND validation_status='valid' AND rules_version='v3') <> 784
        OR (SELECT count(*) FROM race_poles JOIN dataset_versions ON pole_audit_id=audit_id
            WHERE version='{POLES}' AND validation_status='valid') <> 1165
        OR (SELECT count(*) FROM race_poles JOIN dataset_versions ON pole_audit_id=audit_id
            JOIN races ON races.id=race_poles.race_id WHERE version='{POLES}' AND is_indy500) <> 11 THEN
          RAISE EXCEPTION 'Certified counts or legacy fingerprint mismatch';
        END IF;
      END {block};
      COMMIT;
    """)
    ops.sql(cfg["pgPort"], ops.db(env), "\n".join(statements))


def initialize(cfg, env, release_id, bridge_sha, points_approval):
    if env == "prod":
        from first_prod import initialize_guard
        initialize_guard(cfg, release_id, bridge_sha, points_approval)
    port = cfg["pgPort"]
    target = ops.db(env)
    role = target + "_app"
    owner = target + "_owner"
    runtime, _ = ops.verify(release_id)
    bridge = ops.ETC / "certified-history.json.gz"
    ops.require(ops.HEX.fullmatch(bridge_sha) and ops.digest(bridge) == bridge_sha,
                "Certified bridge SHA256 mismatch")
    ops.require(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{2,79}", points_approval),
                "Explicit points activation approval reference required")
    ops.require(cfg[env].get("syntheticSessionApproval"), "Authorize synthetic identity smoke first")
    envfile = ops.ETC / (env + ".env")
    ops.require(not envfile.exists(), "Environment already initialized")
    ops.require(ops.sql(port, "postgres", "SHOW server_version_num;")[:2] == "18",
                "Certified import needs PostgreSQL 18")
    ops.require(ops.sql(port, "postgres", f"""
      SELECT EXISTS(SELECT FROM pg_database WHERE datname='{target}')
          OR EXISTS(SELECT FROM pg_roles WHERE rolname IN ('{role}','{owner}'));
    """) == "f", "Existing database or roles; inspect prior bootstrap before continuing")
    migrations = ops.migration_files(runtime)
    ops.require(len(migrations) == 15 and migrations[-1][2].stem == "0014_account_no_email",
                "Bootstrap requires the reviewed initial 15-migration bundle")
    ops.sql(port, "postgres", f"""
      CREATE ROLE {owner} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      CREATE ROLE {role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
      CREATE DATABASE {target} TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C';
      REVOKE ALL ON DATABASE {target} FROM PUBLIC;
    """)
    try:
        statements = [f"""
          BEGIN;
          REVOKE ALL ON SCHEMA public FROM PUBLIC;
          GRANT USAGE, CREATE ON SCHEMA public TO {owner};
          CREATE SCHEMA drizzle AUTHORIZATION {owner};
          SET LOCAL ROLE {owner};
          CREATE TABLE drizzle.__drizzle_migrations (
            id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
          );
        """]
        for sha, stamp, path in migrations:
            statements.extend((path.read_text(encoding="utf-8"),
                               f"INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES ('{sha}',{stamp});"))
        statements.extend(("DROP TABLE " + ", ".join("public." + name for name in LEGACY) + " RESTRICT;",
                           f"RESET ROLE; REVOKE CREATE ON SCHEMA public FROM {owner}; COMMIT;"))
        ops.sql(port, target, "\n".join(statements))
        ops.require(ops.live_journal(port, env) == ops.journal(runtime), "Bootstrap journal mismatch")
        import_bridge(cfg, env, runtime, bridge, bridge_sha)
        grants = f"""
            GRANT CONNECT ON DATABASE {target} TO {role};
            GRANT USAGE ON SCHEMA public TO {role};
            GRANT SELECT ON drivers,driver_aliases,constructors,constructor_aliases,
              driver_stats,dataset_versions,driver_career_timelines TO {role};
            GRANT SELECT,INSERT,UPDATE ON game_sessions TO {role};
            GRANT SELECT,INSERT ON game_guesses TO {role};
        """
        for template in ("identity-fresh-roles", "modes-roles", "points-roles", "bo3-roles"):
            grants += (runtime / f"deploy/{template}.sql.example").read_text().replace("f1_app", role)
        ops.sql(port, target, "BEGIN;\n" + grants + "\nCOMMIT;")
        ops.sql(port, target, (runtime / "deploy/v3-migration-owner.sql.example").read_text()
                .replace("f1_v3_migrator", owner))
        password = secrets.token_hex(32)
        ops.sql(port, target, f"""
          INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by)
          VALUES ('points-v1',clock_timestamp(),'{POINTS}','{points_approval}');
          ALTER ROLE {role} LOGIN PASSWORD '{scram(password)}';
        """)
        other = ops.db("prod" if env == "stg" else "stg")
        ops.require(ops.sql(port, target, f"""
          SELECT NOT has_schema_privilege('{role}','public','CREATE')
           AND NOT has_table_privilege('{role}','points_ledger','UPDATE,DELETE,TRUNCATE')
           AND NOT EXISTS(SELECT FROM pg_database WHERE
             datname='{other}' AND has_database_privilege('{role}',oid,'CONNECT'))
           AND NOT EXISTS(SELECT FROM pg_roles WHERE rolname='{other}_app'
             AND has_database_privilege(rolname,current_database(),'CONNECT'));
        """) == "t", "Unexpected runtime privileges or cross-environment CONNECT")
        settings = cfg[env]
        database_url = "postgresql://" + f"{role}:{password}@127.0.0.1:{port}/{target}"
        values = {"DATABASE_URL": database_url, "IDENTITY_ENCRYPTION_KEY": secrets.token_hex(32),
                  "NODE_ENV": "production", "HOST": "127.0.0.1", "PORT": settings["port"],
                  "GAME_DATASET_VERSION": ACTIVE, "ALLOWED_ORIGINS": "https://" + settings["domain"],
                  "COOKIE_SECURE": "true", "TRUST_PROXY": "loopback"}
        for feature in ("IDENTITY", "POINTS", "MODES_ENTRY", "QUICK_V2", "DAILY_V2", "BO3", "BO3_RECOVERY"):
            values[feature + "_ENABLED"] = "true"
        if env == "stg":
            values["F1_STG_LOOPBACK_WEB"] = "true"
        with envfile.open("x") as stream:
            stream.write("".join(f"{key}={value}\n" for key, value in values.items()))
        print(json.dumps({"status": "INITIALIZED", "environment": env, "database": target,
                          "seedSha256": bridge_sha, "version": release_id}))
    except Exception:
        ops.sql(port, "postgres", f"ALTER ROLE {role} NOLOGIN;")
        raise


def enable_edge(cfg, env):
    ops.require(env != "prod", "First PROD edge uses f1-dual-first-prod; preserve legacy services")
    item = cfg[env]
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", item["port"]))
    if env == "prod":
        receipt = ops.active("stg")
        ops.require(receipt.get("result") == "PASS", "First STG acceptance is required")
        runtime, manifest = ops.verify(receipt["version"])
        ops.publication_ready(runtime, manifest)
        ops.require(ops.load(ops.ETC / "old-review/isolation-receipt.json")["version"] == receipt["version"],
                    "First production cutover must match the isolated legacy deployment plan")
        ops.check_target(cfg, env)
    else:
        for path in (ops.ETC / "stg.htpasswd", ops.ETC / "stg-smoke.curl"):
            ops.require(path.is_file(), "Set up STG access control first")
    existing = ops.run("nginx", "-T", stdout=subprocess.PIPE, text=True).stdout
    names = re.findall(r"(?m)^\s*server_name\s+([^;]+);", existing)
    ops.require(not any(item["domain"] in line.split() for line in names), "Nginx hostname already configured")
    candidate = Path("/etc/nginx/conf.d") / f"f1-dual-{env}.conf"
    ops.require(not candidate.exists(), "Edge config already exists")
    body = (ops.LIB / "nginx.conf.example").read_text()
    auth = 'auth_basic "Driver Guess STG"; auth_basic_user_file /etc/f1-dual/stg.htpasswd;' if env == "stg" else ""
    for key, value in {"DOMAIN": item["domain"], "ENV": env, "PORT": item["port"], "AUTH": auth}.items():
        body = body.replace(f"@{key}@", str(value))
    # Test the candidate together with the currently active config before installing it.
    candidate.with_suffix(".preflight").write_text(body)
    test_config = ops.ROOT / "nginx-preflight.conf"
    config = Path("/etc/nginx/nginx.conf").read_text()
    try:
        anchor = "include /etc/nginx/conf.d/*.conf;"
        ops.require(config.count(anchor) == 1, "Review this host's Nginx include layout")
        test_config.write_text(config.replace(anchor, anchor + f"\ninclude {candidate.with_suffix('.preflight')};"))
        ops.run("nginx", "-t", "-c", str(test_config))
        candidate.with_suffix(".preflight").rename(candidate)
        try:
            ops.run("nginx", "-t")
            ops.run("systemctl", "reload", "nginx")
        except Exception:
            candidate.unlink()
            ops.run("nginx", "-t")
            ops.run("systemctl", "reload", "nginx")
            raise
    finally:
        test_config.unlink(missing_ok=True)
        candidate.with_suffix(".preflight").unlink(missing_ok=True)


def main(args):
    if args == ["--help"] or not args:
        print("bootstrap: prepare-stg | build COMMIT LOCK_SHA SOURCE_SHA | init ENV RELEASE BRIDGE_SHA POINTS_APPROVAL | activate-stg RELEASE | edge ENV | backup-old INVENTORY_SHA | isolate-old MANIFEST_SHA RELEASE")
        return
    ops.require(os.geteuid() == 0, "Bootstrap is an administrator operation")
    cfg = ops.config()
    if args in (["prepare"], ["prepare-stg"]):
        ops.ROOT.mkdir(mode=0o755, exist_ok=True)
        with ops.locked():
            install_dirs(("stg",) if args == ["prepare-stg"] else ops.ENVIRONMENTS)
        return
    with ops.locked():
        action, *values = args
        if action == "build" and len(values) == 3:
            print(ops.build(cfg, *values))
        elif action == "init" and len(values) == 4 and values[0] in ops.ENVIRONMENTS:
            initialize(cfg, *values)
        elif action == "activate-stg" and len(values) == 1:
            release, = values
            ops.check_target(cfg, "stg")
            ops.recover(cfg, "stg")
            runtime, _ = ops.verify(release)
            old = ops.active("stg")
            ops.compatible(cfg, "stg", release, runtime, old.get("version"), apply=True)
            ops.activate(cfg, "stg", release, old, None, action)
            ops.service("stg", "restart")
            ops.smoke(cfg, "stg", release)
            print(json.dumps({"status": "STG_RESTART_SMOKE_PASS", "version": release}))
        elif action == "edge" and len(values) == 1 and values[0] in ops.ENVIRONMENTS:
            enable_edge(cfg, *values)
        elif action == "isolate-old" and len(values) == 2:
            from isolate import isolate_old
            isolate_old(cfg, *values)
        elif action == "backup-old" and len(values) == 1:
            from isolate import backup_old
            backup_old(cfg, *values)
        else:
            raise RuntimeError("Invalid bootstrap invocation")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main(sys.argv[1:])
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"Bootstrap stopped: {error}", file=sys.stderr)
        sys.exit(1)
