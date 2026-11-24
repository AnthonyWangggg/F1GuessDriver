"""Manual local collector: no SSH/network/SQL, no escalation and no raw config/log output."""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path('/opt/f1guessdriver/rolling')
HEX = re.compile(r'^[a-f0-9]{64}$')
SAFE_ID = re.compile(r'^[A-Za-z0-9_-]{1,96}$')
MAX_BYTES = 2 * 1024 * 1024


def digest(body):
    return hashlib.sha256(body).hexdigest()


def read_small(path, maximum=MAX_BYTES):
    if path.is_symlink() or not path.is_file():
        raise ValueError('regular non-symlink file required')
    if path.stat().st_size > maximum:
        raise ValueError('bounded metadata required')
    return path.read_bytes()


def blocked(error):
    return {'status': 'BLOCKED', 'category': type(error).__name__}


def safe_release(root, release):
    if not isinstance(release, str) or not SAFE_ID.fullmatch(release):
        raise ValueError('unsafe release identifier')
    base = root / 'releases' / release
    if base.is_symlink() or base.resolve().parent != (root / 'releases').resolve():
        raise ValueError('release boundary refused')
    return base


def routing(root=ROOT):
    result = {'loadedConfiguration': {'status': 'BLOCKED', 'reason': 'Disk state and a header are not proof of loaded upstream; administrator attestation required.'}}
    try:
        # current itself is the published routing symlink. Resolve it once within routing only.
        current = (root / 'routing/current').resolve(strict=True)
        if current.parent != (root / 'routing').resolve():
            raise ValueError('routing boundary refused')
        state_raw = read_small(current / 'state.json', 16384)
        state = json.loads(state_raw)
        if state.get('slot') not in ['blue', 'green']:
            raise ValueError('invalid slot')
        for key in ['generation', 'server', 'web', 'dataset']:
            if not isinstance(state.get(key), str) or not SAFE_ID.fullmatch(state[key]):
                raise ValueError('invalid routing identifier')
        includes = {}
        upstream = ''
        for name in ['upstream.inc', 'site.inc']:
            body = read_small(current / name, 32768)
            includes[name] = {'sha256': digest(body)}
            if name == 'upstream.inc': upstream = body.decode()
        targets = re.findall(r'\bserver\s+127\.0\.0\.1:(3000|3001)\s*;', re.sub(r'#.*', '', upstream))
        expected = '3000' if state['slot'] == 'blue' else '3001'
        result['diskRouting'] = {'status': 'PASS' if targets == [expected] else 'FAIL', 'activeSlotByDiskState': state['slot'],
            'stateSha256': digest(state_raw), 'generationDigest': digest(state['generation'].encode()), 'includes': includes}
        result['artifacts'] = {}
        for kind in ['web', 'server']:
            release = state[kind]
            base = safe_release(root, release)
            raw = read_small(root / 'manifests' / (release + '.json'))
            manifest = json.loads(raw)
            if manifest.get('id') != release or manifest.get('schema') != 1:
                raise ValueError('manifest identity mismatch')
            files = manifest.get('files')
            if not isinstance(files, dict) or len(files) > 10000:
                raise ValueError('bounded manifest required')
            selected = ['apps/server/dist/index.js'] if kind == 'server' else ['apps/web/dist/index.html']
            if kind == 'web':
                html = read_small(base / selected[0], 65536).decode()
                assets = re.findall(r'(?:src|href)=["\'](/assets/[A-Za-z0-9_.-]+)["\']', html)
                if len(assets) > 16:
                    raise ValueError('asset budget exceeded')
                selected += ['apps/web/dist' + x for x in assets]
            checks = []
            for rel in selected:
                path = base / rel
                if not path.resolve().is_relative_to(base.resolve()):
                    raise ValueError('artifact symlink boundary refused')
                body = read_small(path)
                sha = digest(body)
                checks.append({'file': rel, 'sha256': sha, 'manifestMatches': files.get(rel) == sha})
            source = manifest.get('sourceSha256') or manifest.get('sourceCommit')
            if not isinstance(source, str) or not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', source):
                source = None
            result['artifacts'][kind] = {'status': 'PASS' if all(x['manifestMatches'] for x in checks) else 'FAIL',
                'manifestSha256': digest(raw), 'releaseAliasDigest': digest(release.encode()), 'sourceSha': source,
                'sourceEvidence': 'present-unattested' if source else 'BLOCKED-missing', 'files': checks,
                'runningProcessBinding': 'BLOCKED', 'rollbackCompatibility': 'BLOCKED'}
        # Each slot is independently inspected. A path alias alone never binds the running process.
        result['slots'] = {}
        for slot in ['blue', 'green']:
            try:
                target = (root / 'slots' / slot).resolve(strict=True)
                if target.parent != (root / 'releases').resolve():
                    raise ValueError('slot boundary refused')
                manifest_raw = read_small(root / 'manifests' / (target.name + '.json'))
                manifest = json.loads(manifest_raw)
                if manifest.get('id') != target.name or manifest.get('schema') != 1:
                    raise ValueError('slot manifest mismatch')
                entry_path = target / 'apps/server/dist/index.js'
                if not entry_path.resolve().is_relative_to(target):
                    raise ValueError('slot artifact boundary refused')
                entry = read_small(entry_path)
                files = manifest.get('files')
                if not isinstance(files, dict) or len(files) > 10000:
                    raise ValueError('slot manifest file budget refused')
                entry_matches = files.get('apps/server/dist/index.js') == digest(entry)
                source = manifest.get('sourceSha256') or manifest.get('sourceCommit')
                if not isinstance(source, str) or not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', source): source = None
                result['slots'][slot] = {'status': 'PASS' if entry_matches else 'FAIL', 'releaseAliasDigest': digest(target.name.encode()),
                    'manifestSha256': digest(manifest_raw), 'sourceSha': source,
                    'sourceEvidence': 'present-unattested' if source else 'BLOCKED-missing',
                    'serverEntrySha256': digest(entry),
                    'manifestEntryMatches': entry_matches,
                    'onDiskOnly': True, 'runningProcessBinding': 'BLOCKED', 'compatibility': 'BLOCKED'}
            except (OSError, ValueError) as error:
                result['slots'][slot] = blocked(error)
    except (OSError, ValueError, TypeError, KeyError) as error:
        result['diskEvidence'] = blocked(error)
    return result


def certificate_status():
    try:
        p = subprocess.run(['systemctl', 'show', 'f1guessdriver-renew-health.service', '--no-pager',
            '--property=ActiveState', '--property=Result', '--property=ExecMainStatus', '--property=ExecMainExitTimestamp'],
            capture_output=True, text=True, timeout=5, check=True)
        allowed = {'ActiveState', 'Result', 'ExecMainStatus', 'ExecMainExitTimestamp'}
        values = {k: v for k, v in (x.split('=', 1) for x in p.stdout.splitlines() if '=' in x) if k in allowed}
        # No raw stderr or unexpected values can reach the report.
        if values.get('ActiveState') not in ['active', 'inactive', 'failed', 'activating', 'deactivating']:
            raise ValueError('unsupported service state')
        if values.get('Result') not in ['success', 'exit-code', 'signal', 'timeout', 'resources', 'start-limit-hit', 'oom-kill']:
            raise ValueError('unsupported result category')
        if not re.fullmatch(r'[0-9]{1,3}', values.get('ExecMainStatus', '')):
            raise ValueError('invalid exit code')
        timestamp = values.pop('ExecMainExitTimestamp', '')
        if timestamp and not re.fullmatch(r'[A-Za-z0-9 :+./-]{1,80}', timestamp):
            raise ValueError('invalid timestamp')
        return {'status': 'PASS', 'category': 'certificate-CA-leaf-CRL-margin-monitor', **values,
            'exitTimestamp': timestamp or None, 'failedComponent': 'BLOCKED-no-classification', 'alertDelivery': 'BLOCKED'}
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return blocked(error)


def receipt(path):
    # Only a pre-existing, explicitly approved metadata receipt; never discover/open a dump.
    if not str(path).endswith('.receipt.json'):
        raise ValueError('approved receipt filename required')
    raw = read_small(path, 32768)
    value = json.loads(raw)
    allowed = {'schema', 'status', 'completedAt', 'bytes', 'sha256', 'coverage', 'keyIds', 'roles', 'retentionDays', 'offsiteReceiptPresent'}
    if not isinstance(value, dict) or set(value) - allowed or value.get('schema') != 'backup-receipt-v1' or value.get('status') != 'success':
        raise ValueError('receipt schema refused')
    if not isinstance(value.get('sha256'), str) or not HEX.fullmatch(value['sha256']):
        raise ValueError('existing digest required')
    if not isinstance(value.get('completedAt'), str) or len(value['completedAt']) > 40:
        raise ValueError('timestamp required')
    if datetime.datetime.fromisoformat(value['completedAt'].replace('Z', '+00:00')).tzinfo is None:
        raise ValueError('timezone required')
    if type(value.get('bytes')) is not int or value['bytes'] <= 0:
        raise ValueError('size required')
    if not isinstance(value.get('coverage'), list) or not value['coverage'] or not set(value['coverage']) <= {'database', 'roles', 'acl', 'configuration', 'key-references'}:
        raise ValueError('coverage categories refused')
    if not isinstance(value.get('retentionDays'), int) or not 1 <= value['retentionDays'] <= 3650 or type(value.get('offsiteReceiptPresent')) is not bool:
        raise ValueError('retention metadata required')
    for field in ['keyIds', 'roles']:
        if not isinstance(value.get(field), list) or len(value[field]) > 32 or any(not isinstance(x, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', x) for x in value[field]):
            raise ValueError('references refused')
    return {'status': 'PASS', 'receiptSha256': digest(raw), 'metadata': value,
        'backupBodyRead': False, 'backupHashRecomputed': False, 'restoreProof': 'BLOCKED', 'offsiteIndependentlyVerified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['routing', 'certificate-status', 'backup-receipt'])
    parser.add_argument('--receipt', type=pathlib.Path)
    args = parser.parse_args()
    try:
        if args.mode == 'routing': result = routing()
        elif args.mode == 'certificate-status': result = certificate_status()
        elif args.receipt: result = receipt(args.receipt)
        else: raise ValueError('explicit approved receipt required')
    except (OSError, ValueError, TypeError, KeyError) as error:
        result = blocked(error)
    print(json.dumps(result, ensure_ascii=True, indent=2))
    # Partial missing proof is a non-green result even when readable disk evidence exists.
    return 2 if 'BLOCKED' in json.dumps(result) or 'FAIL' in json.dumps(result) else 0


if __name__ == '__main__':
    raise SystemExit(main())
