"""Local deployment contract tests. Optional PostgreSQL rehearsal uses a new isolated cluster."""

import io
import contextlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.error import URLError
from urllib.request import urlopen

import bootstrap
import release as ops

REPO = Path(__file__).resolve().parents[2]
OLD = "a" * 40 + "-" + "a" * 64
NEW = "b" * 40 + "-" + "b" * 64
CONFIG = {"pgPort": 55432, "prod": {"domain": "prod.example.test"}}


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        override = patch.multiple(ops, ROOT=self.root, ETC=self.root / "etc")
        override.start()
        self.addCleanup(override.stop)
        if os.name == "nt":
            def file_pointer(path, target):
                temporary = path.with_name(path.name + ".next")
                temporary.write_text(str(target))
                os.replace(temporary, path)
            pointer = patch.multiple(
                ops, link=file_pointer, pointer_target=lambda path: path.read_text() if path.exists() else None,
            )
            pointer.start()
            self.addCleanup(pointer.stop)
        for folder in ("versions", "state/prod", "etc/migrations", "accepted"):
            (self.root / folder).mkdir(parents=True)
        stable = ops.state_dir("prod") / "stable"
        stable.mkdir()
        ops.save(stable / "receipt.json", {"version": OLD})
        ops.link(ops.state_dir("prod") / "active", stable)

    def make_runtime(self, name, commands):
        runtime = ops.version(name) / "runtime"
        directory = runtime / "packages/database/migrations"
        (directory / "meta").mkdir(parents=True)
        entries = []
        for index, command in enumerate(commands):
            tag = f"{index:04d}_test"
            (directory / (tag + ".sql")).write_text(command)
            entries.append({"tag": tag, "when": index + 1})
        ops.save(directory / "meta/_journal.json", {"entries": entries})
        return runtime

    def test_source_archive_rejects_private_files_and_symlinks(self):
        for name, mode in [("apps/server/.env", tarfile.REGTYPE),
                           ("apps/server/dist/index.js", tarfile.REGTYPE),
                           ("scripts/diagnostic/foo", tarfile.REGTYPE),
                           ("apps/link", tarfile.SYMTYPE),
                           ("../outside", tarfile.REGTYPE)]:
            with self.subTest(name=name):
                archive = self.root / "input.tar"
                with tarfile.open(archive, "w") as tar:
                    entry = tarfile.TarInfo(name)
                    entry.type = mode
                    tar.addfile(entry, io.BytesIO())
                with self.assertRaisesRegex(RuntimeError, "Unsafe source"):
                    ops.extract_source(archive, self.root / "source")

    def test_failed_switch_restores_previous_pointer_and_clears_pending(self):
        with patch.object(ops, "service") as service, patch.object(
            ops, "smoke", side_effect=[RuntimeError("HTTP 500"), None]
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTP 500"):
                ops.activate(CONFIG, "prod", NEW, ops.active("prod"), "backup-id", "prod")
        self.assertEqual(ops.active("prod")["version"], OLD)
        self.assertFalse((ops.state_dir("prod") / "pending.json").exists())
        self.assertEqual([args.args[1] for args in service.call_args_list], ["restart", "restart"])

    def test_successful_rollback_preserves_receipt_and_prior_release(self):
        with patch.object(ops, "service"), patch.object(ops, "smoke"), patch.object(
            ops, "run", return_value=subprocess.CompletedProcess([], 0, stdout=b"")
        ):
            ops.activate(CONFIG, "prod", NEW, ops.active("prod"), "backup-id", "prod")
            ops.activate(CONFIG, "prod", OLD, ops.active("prod"), "backup-id", "rollback")
        self.assertEqual(ops.active("prod")["version"], OLD)
        self.assertEqual(ops.active("prod")["previous"], NEW)
        receipts = list(ops.state_dir("prod").glob("generation-*/receipt.json"))
        self.assertEqual(len(receipts), 2)

    def test_prod_requires_stg_receipt_before_compatibility_or_backup(self):
        with patch.object(ops.os, "geteuid", return_value=0, create=True), patch.object(
            ops, "config", return_value=CONFIG
        ), patch.object(ops, "locked", return_value=contextlib.nullcontext()), patch.object(
            ops, "check_target"
        ), patch.object(ops, "verify", return_value=(Path("."), {"sha256": "b" * 64})), patch.object(
            ops, "backup"
        ) as backup:
            ops.save(self.root / "accepted" / (NEW + ".json"), {
                "result": "PASS", "environment": "stg", "version": NEW, "sha256": "c" * 64,
            })
            with self.assertRaisesRegex(RuntimeError, "Exact artifact"):
                ops.main(["prod", NEW])
            backup.assert_not_called()

    def test_only_approved_additive_schema_supports_rollback(self):
        old = self.make_runtime(OLD, ["CREATE TABLE game;"])
        new = self.make_runtime(NEW, ["CREATE TABLE game;", "ALTER TABLE public.game ADD COLUMN note text;"])
        old_journal = ops.journal(old)
        new_journal = ops.journal(new)
        with patch.object(ops, "live_journal", return_value=new_journal):
            with self.assertRaisesRegex(RuntimeError, "Rollback blocked"):
                ops.compatible(CONFIG, "prod", OLD, old, NEW, rollback=True)
            ops.save(ops.ETC / "migrations" / f"prod-{NEW}.json", {
                "from": old_journal, "to": new_journal, "previous": OLD,
            })
            ops.compatible(CONFIG, "prod", OLD, old, NEW, rollback=True)
        with patch.object(ops, "live_journal", side_effect=[old_journal, new_journal]), patch.object(
            ops, "sql", return_value=""
        ) as sql:
            ops.compatible(CONFIG, "prod", NEW, new, OLD, apply=True)
            self.assertIn("SET LOCAL ROLE f1dg3_prod_owner;", sql.call_args.args[2])
        unsafe = new / "packages/database/migrations/0001_test.sql"
        unsafe.write_text("ALTER TABLE public.game DROP COLUMN note;")
        with self.assertRaisesRegex(RuntimeError, "Unsupported"):
            ops.safe_additive(unsafe)

    def test_artifact_sha_mismatch_stops_before_runtime_use(self):
        path = ops.version(NEW)
        path.mkdir()
        (path / "runtime.tar.gz").write_bytes(b"corrupt archive")
        ops.save(path / "manifest.json", {"version": NEW, "sha256": "b" * 64})
        with patch.object(ops, "run") as command:
            with self.assertRaisesRegex(RuntimeError, "Artifact SHA256 mismatch"):
                ops.verify(NEW)
            command.assert_not_called()

    def test_prepare_stg_never_prepares_prod(self):
        with patch.object(ops.os, "geteuid", return_value=0, create=True), patch.object(
            ops, "config", return_value=CONFIG
        ), patch.object(ops, "locked", return_value=contextlib.nullcontext()), patch.object(
            bootstrap, "install_dirs"
        ) as install:
            bootstrap.main(["prepare-stg"])
            install.assert_called_once_with(("stg",))


@unittest.skipUnless(os.getenv("F1_DUAL_TEST_PG_BIN") and os.getenv("F1_DUAL_TEST_BRIDGE"),
                     "Set PostgreSQL bin and reviewed bridge paths for isolated SQL rehearsal")
class PostgreSQLRehearsal(unittest.TestCase):
    def smoke_http(self, settings):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        server = subprocess.Popen(
            ["node", "apps/server/dist/index.js"], cwd=REPO,
            env={**os.environ, **settings, "PORT": str(port)},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            url = f"http://127.0.0.1:{port}"
            for _ in range(40):
                self.assertIsNone(server.poll(), "HTTP process exited")
                try:
                    with urlopen(url + "/api/health", timeout=2) as response:
                        self.assertEqual(response.status, 200)
                    break
                except URLError:
                    time.sleep(0.25)
            for path in ("/api/runtime-readiness", "/api/v3/quick/options", "/api/v3/modes/session"):
                with urlopen(url + path, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    if path.endswith("/session"):
                        self.assertTrue(json.load(response)["principalId"])
        finally:
            server.terminate()
            server.wait(timeout=20)

    def test_fresh_stg_and_prod_and_scram(self):
        pg = Path(os.environ["F1_DUAL_TEST_PG_BIN"])
        bridge = Path(os.environ["F1_DUAL_TEST_BRIDGE"])
        with tempfile.TemporaryDirectory(prefix="f1-dual-test-pg-") as directory:
            root = Path(directory)
            data = root / "pgdata"
            etc = root / "etc"
            etc.mkdir()
            shutil.copyfile(bridge, etc / "certified-history.json.gz")
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            admin = "f1_dual_test_admin"
            pg_run = lambda program, *args, **kwargs: ops.run(
                str(pg / (program + (".exe" if os.name == "nt" else ""))), *args, **kwargs
            )
            pg_run("initdb", "-D", str(data), "-U", admin, "-A", "trust",
                   "--locale=C", "--encoding=UTF8", stdout=subprocess.DEVNULL)
            (data / "pg_hba.conf").write_text(
                f"host all {admin} 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\n"
            )
            try:
                pg_run("pg_ctl", "-D", str(data), "-l", str(root / "postgres.log"),
                       "-o", f"-h 127.0.0.1 -p {port}", "-w", "start")
                cfg = {"pgPort": port}
                for env in ops.ENVIRONMENTS:
                    cfg[env] = {"domain": f"{env}.example.test", "port": 3000 if env == "prod" else 3100,
                                "syntheticSessionApproval": "isolated-test"}

                def query(pg_port, dbname, statement, user=admin, password=None, check=True):
                    self.assertEqual(pg_port, port)
                    return subprocess.run(
                        [str(pg / ("psql.exe" if os.name == "nt" else "psql")), "-XqAt",
                         "-h", "127.0.0.1", "-p", str(port), "-U", user, "-d", dbname,
                         "-w", "-v", "ON_ERROR_STOP=1"], check=check, input=statement, encoding="utf-8",
                        capture_output=True, env={**os.environ, **({"PGPASSWORD": password} if password else {})},
                    )

                def sql(pg_port, dbname, statement):
                    result = query(pg_port, dbname, statement, check=False)
                    self.assertEqual(result.returncode, 0, result.stderr[:2000])
                    return result.stdout.strip()

                # Generic isolated SQL/HTTP fixture; pinned first-PROD authorization is
                # independently exercised in test_first_prod.py, not a live-host grant.
                with patch.multiple(ops, ETC=etc, sql=sql), patch.object(ops, "verify", return_value=(REPO, {})), \
                     patch("first_prod.initialize_guard"):
                    for env in ops.ENVIRONMENTS:
                        bootstrap.initialize(cfg, env, OLD, ops.digest(bridge), "test-only")
                from urllib.parse import urlsplit
                settings = dict(line.split("=", 1) for line in (etc / "stg.env").read_text().splitlines())
                credentials = urlsplit(settings["DATABASE_URL"])
                self.assertEqual(query(port, "f1dg3_stg", "SELECT current_user;",
                                       credentials.username, credentials.password).stdout.strip(), "f1dg3_stg_app")
                rejected = query(port, "f1dg3_prod", "SELECT current_user;",
                                 credentials.username, credentials.password, check=False)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("permission denied for database", rejected.stderr)
                for env in ops.ENVIRONMENTS:
                    with self.subTest(environment=env):
                        self.smoke_http(dict(line.split("=", 1) for line
                                             in (etc / f"{env}.env").read_text().splitlines()))
            finally:
                if (data / "postmaster.pid").exists():
                    pg_run("pg_ctl", "-D", str(data), "-m", "immediate", "-w", "stop")


if __name__ == "__main__":
    unittest.main()
