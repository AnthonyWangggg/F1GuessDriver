"""Narrow administrator upgrade; no config, systemd, Nginx or application writes."""
import hashlib
import os
from pathlib import Path
import sys

import release as ops

SOURCE = Path(__file__).resolve().parent
SBIN = Path('/usr/local/sbin')
BEFORE = {
    'release.py': '16e8586495ff8abba8e8042a423a6ca1b279ac4c070ae944e2e3798dd04dba6f',
    'bootstrap.py': '7bd68ef5d62196a23e02e3d169e6e7054ae5a464b0017e4c206beaaa3e183d0d',
    'first_prod.py': 'c7df8d39fef3c0056e9fc4dd0a80a8da771ec3501b5b015641ca93afe5875187',
}
UPGRADES = {'first_prod.py': {'273b3ea36c4b358b1baab26ecab4cfa62b70ab2ddde1729de9ec8989aa1cc278'}}
FILES = ('first_prod.py', 'release.py', 'bootstrap.py', 'first_prod_rebind.py', 'first_prod_smoke.py')
WRAPPER = b'#!/bin/sh\nexec /usr/bin/python3 -EsB /usr/local/lib/f1-dual/first_prod.py "$@"\n'


def contents():
    return {name: (SOURCE / name).read_bytes().replace(b'\r\n', b'\n') for name in FILES}


def bundle_digest(files):
    return hashlib.sha256(b''.join(name.encode() + b'\0' + files[name] + b'\0' for name in FILES)).hexdigest()


def trusted(path):
    return path.stat().st_uid == 0 and not path.stat().st_mode & 0o022


def atomic(path, data, mode):
    swap = path.with_name(path.name + '.next')
    if swap.exists() or swap.is_symlink():
        ops.require(swap.is_file() and not swap.is_symlink() and trusted(swap) and swap.read_bytes() == data,
                    'Interrupted installer temporary file differs; retain evidence: ' + str(swap))
    else:
        with swap.open('xb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
    swap.chmod(mode)
    os.replace(swap, path)
    if os.name == 'posix':
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)


def install(expected):
    files = contents()
    ops.require(expected == bundle_digest(files), 'Reviewed tool bundle SHA mismatch')
    marker = ops.ROOT / 'state/prod/plan-rebind-pending.json'
    ops.require(not marker.exists() and not marker.is_symlink(), 'Recover pending plan rebind before controller upgrade')
    wrapper = SBIN / 'f1-dual-first-prod'
    ops.require(ops.LIB.is_dir() and SBIN.is_dir() and trusted(ops.LIB) and trusted(SBIN), 'Existing trusted dual host required')
    # Validate all destinations first. Accept exact new bytes for an interrupted retry.
    for name, body in files.items():
        p = ops.LIB / name
        ops.require(name not in ('release.py','bootstrap.py') or p.is_file(), 'Audited controller missing: ' + name)
        if p.exists() or p.is_symlink():
            ops.require(not p.is_symlink() and p.is_file() and trusted(p) and (p.read_bytes() == body or
                        (name in BEFORE and ops.digest(p) == BEFORE[name]) or
                        ops.digest(p) in UPGRADES.get(name,set())), 'Controller drift: ' + name)
    if wrapper.exists() or wrapper.is_symlink():
        ops.require(not wrapper.is_symlink() and trusted(wrapper) and wrapper.read_bytes() == WRAPPER, 'Wrapper drift')
    # Prevalidate all backup targets before replacing even the first module.
    backups = {}
    for name, body in files.items():
        p = ops.LIB / name
        if p.exists() and p.read_bytes() != body:
            previous = ops.digest(p)
            suffix = ('.prod02d-before' if previous == BEFORE.get(name) else '.prod02f-before-' + previous) if name == 'first_prod.py' else '.prod01a-before'
            old = p.with_name(p.name + suffix)
            if old.exists() or old.is_symlink():
                ops.require(not old.is_symlink() and trusted(old) and ops.digest(old) == previous, 'Old controller backup drift')
            backups[name] = old
    for name, body in files.items():
        p = ops.LIB / name
        if p.exists() and p.read_bytes() == body: continue
        if p.exists():
            old = backups[name]
            if old.exists():
                ops.require(not old.is_symlink() and ops.digest(old) == ops.digest(p), 'Old controller backup drift')
            else:
                with old.open('xb') as stream: stream.write(p.read_bytes())
                old.chmod(0o600)
        atomic(p, body, 0o644)
    if not wrapper.exists(): atomic(wrapper, WRAPPER, 0o755)


def main(args):
    if args == ['--digest']:
        print(bundle_digest(contents())); return
    ops.require(len(args) == 2 and args[0] == '--apply' and ops.HEX.fullmatch(args[1]), 'Use --digest | --apply BUNDLE_SHA')
    ops.require(os.geteuid() == 0, 'Administrator only')
    with ops.locked(): install(args[1])
    print('First-PROD controller installed; no services or runtime configuration changed.')


if __name__ == '__main__':
    os.umask(0o077)
    try: main(sys.argv[1:])
    except (OSError, RuntimeError, ValueError):
        print('Controller install stopped; inspect exact files; no implicit service operations.', file=sys.stderr)
        sys.exit(1)
