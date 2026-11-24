import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("plan-cleanup.py")


class CleanupManifestTest(unittest.TestCase):
    def render(self, **resources):
        manifest = {
            "inventorySha256": "a" * 64,
            "restoreProofSha256": "b" * 64,
            "resources": {"paths": [], "units": [], "databases": [], "roles": [], **resources},
        }
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "manifest.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            return subprocess.run(
                [sys.executable, "-B", SCRIPT, "--manifest", str(path)],
                capture_output=True, text=True, check=False,
            )

    def test_exact_objects_produce_only_a_plan(self):
        result = self.render(
            paths=["/opt/f1guessdriver/rolling/slots/blue"],
            units=["f1guessdriver-v3@blue.service"],
            databases=["f1guess_prod"],
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["mode"], "DRY_RUN")
        self.assertEqual(data["state"], "AWAITING_DELETION_APPROVAL")

    def test_shared_or_unknown_objects_never_validate(self):
        for resources in (
            {"paths": ["/opt/f1guessdriver/rolling"]},
            {"paths": ["/etc/nginx"]},
            {"paths": ["/opt/f1guessdriver/rolling/slots/../slots/blue"]},
            {"paths": ["/var/backups/f1guessdriver/keys"]},
            {"units": ["postgresql.service"]},
            {"databases": ["postgres"]},
            {"roles": ["f1guess_app", "f1guess_app"]},
        ):
            with self.subTest(resources=resources):
                result = self.render(**resources)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("unlisted or duplicate", result.stderr)


if __name__ == "__main__":
    unittest.main()
