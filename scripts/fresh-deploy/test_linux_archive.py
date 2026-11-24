import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'archive_check', Path(__file__).with_name('check-linux-archive.py')
)
archive_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive_check)


class ArchiveTest(unittest.TestCase):
    def inspect(self, extra):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / 'fixture.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                for folder in ('apps', 'apps/server', 'apps/server/dist', 'apps/web', 'apps/web/dist'):
                    entry = tarfile.TarInfo(folder)
                    entry.type = tarfile.DIRTYPE
                    tar.addfile(entry)
                runtime = [('apps/server/dist/index.js', b''), ('apps/web/dist/index.html', b'')]
                for name, value in runtime + extra:
                    entry = tarfile.TarInfo(name)
                    if isinstance(value, str):
                        entry.type = tarfile.SYMTYPE
                        entry.linkname = value
                        tar.addfile(entry)
                    else:
                        entry.size = len(value)
                        tar.addfile(entry, io.BytesIO(value))
            return archive_check.inspect(archive, 'x86_64')

    def test_regular_archive_and_pnpm_style_link(self):
        header = b'\x7fELF\x02\x01' + bytes(12) + b'\x3e\x00'
        self.assertEqual(self.inspect([
            ('apps/server/dist/addon.node', header),
            ('apps/web/dist/dependency', '../../server/dist/addon.node'),
        ]), (9, 1, 1))

    def test_reject_unsafe_path_or_link_and_private_file(self):
        for name, value in [('../out', b''), ('.', 'apps'), ('.env', b''),
                            ('apps/link', '../../out'), ('apps/link', 'alias/../web'),
                            ('apps/link', 'missing'), ('apps/link', 'link')]:
            with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                self.inspect([(name, value)])

    def test_reject_wrong_native_architecture(self):
        header = b'\x7fELF\x02\x01' + bytes(12) + b'\xb7\x00'
        with self.assertRaisesRegex(ValueError, 'wrong native module architecture'):
            self.inspect([('apps/server/dist/addon.node', header)])


if __name__ == '__main__':
    unittest.main()
