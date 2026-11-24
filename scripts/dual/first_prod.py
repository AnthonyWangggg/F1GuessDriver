"""Explicit first-PROD lifecycle. Install separately; no SSH or implicit cleanup."""

import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import uuid

import release as ops

COMMIT = '7e46530e99a6475f77aa5d9028e8620fc9d5656b'
SHA = 'e7d2cb53eb47b073a97ce5c2e7d5f7c375c77509ced96d6611e0277ba764dea7'
VERSION = COMMIT + '-' + SHA
LOCK = '70ec722148538b101278fd9a9c0217d93bc8fb3f67b50f3fc2e077d6cc5e4167'
SEED = '075d09067a10401a07c6533f537c3e2c90f4aa8d7479372f10cedfdf150dc327'
TEMPLATE_SHA = 'f8ef5f68a9b5ee48fa92d1a2ccbec2c907e66d05c082173542ec785a82f01d87'
NGINX = Path('/etc/nginx')
UNIT = Path('/etc/systemd/system/f1-dual@.service')
OLD = '/etc/nginx/sites-available/f1guessdriver-public-p4f'
ACTIONS = ('prepare-prod', 'init-prod', 'internal-edge', 'activate-internal', 'synthetic-smoke',
           'recover-internal', 'cutover', 'rollback-edge', 'recover-edge')
BINDING_ACTIONS = ('rebind-plan', 'recover-rebind', 'abort-rebind', 'reopen-internal')


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def home():
    return ops.state_dir('prod')


def state():
    p = home() / 'first-prod.json'
    return ops.load(p) if p.exists() else {}


def save_state(value, phase, **fields):
    value = {**value, **fields, 'phase': phase, 'updatedAt': now()}
    ops.save(home() / 'first-prod.json', value)
    return value


def validate_plan(value, cfg):
    ops.require(set(value) == {'format', 'version', 'artifactSha256', 'lockSha256', 'approvals',
                             'backupReceipt', 'backupReceiptSha256', 'publicationReceipt',
                             'publicationReceiptSha256', 'rollbackDataWindowApproval'}, 'Unexpected plan fields')
    ops.require(value['format'] == 'first-prod-v1' and value['version'] == VERSION and
                value['artifactSha256'] == SHA and value['lockSha256'] == LOCK, 'Only audited STG-06 is allowed')
    ops.require(cfg['prod']['port'] == 3101 and cfg['stg']['port'] == 3100 and cfg['pgPort'] == 5432 and
                cfg['prod']['domain'] == 'f1driverguess.online', 'Audited host layout differs')
    ops.require(isinstance(value['approvals'], dict) and set(value['approvals']) <=
                set(ACTIONS + ('points-activation', 'synthetic-smoke')), 'Invalid action approvals')
    for reference in value['approvals'].values():
        ops.require(isinstance(reference, str) and re.fullmatch(r'[A-Za-z0-9_.-]{4,100}', reference), 'Invalid approval reference')
    for field in ('backupReceipt', 'publicationReceipt'):
        p = Path(value[field])
        ops.require(p.is_absolute() and p.parent == ops.ETC / 'prod-review' and
                    re.fullmatch(r'[a-z][a-z0-9-]*\.json', p.name), 'Receipt must be in prod-review')
        ops.require(ops.HEX.fullmatch(value[field + 'Sha256']), 'Invalid receipt SHA')
    ref = value['rollbackDataWindowApproval']
    ops.require(isinstance(ref, str) and (ref == '' or re.fullmatch(r'[A-Za-z0-9_.-]{4,100}', ref)), 'Invalid data-window approval')


def private_file(path):
    s = path.stat()
    return s.st_uid == 0 and s.st_mode & 0o077 == 0


def private_json(path):
    ops.require(path.is_file() and not path.is_symlink(), 'Expected regular review file')
    ops.require(private_file(path), 'Review file must be root-owned and private')
    return ops.load(path)


def plan(cfg, expected, action):
    marker = home() / 'plan-rebind-pending.json'
    ops.require(not marker.exists() and not marker.is_symlink(), 'Recover pending plan rebind first')
    p = ops.ETC / 'prod-review/first-prod.json'
    ops.require(ops.HEX.fullmatch(expected) and ops.digest(p) == expected, 'Exact reviewed plan SHA required')
    v = private_json(p)
    validate_plan(v, cfg)
    auth = private_json(ops.ETC / 'prod-review/authorization.json')
    ops.require(auth.get('format') == 'first-prod-authorization-v1' and auth.get('planSha256') == expected and
                isinstance(auth.get('grants'), dict), 'Separate action authorization required')
    # References in the immutable plan reserve names; the separately installed grant
    # record can authorize initialization now and cutover later, without rebinding state.
    v['approvals'] = {k: ref for k, ref in v['approvals'].items() if auth['grants'].get(k) == ref}
    v['rollbackDataWindowApproval'] = auth.get('rollbackDataWindowApproval', '')
    ops.require(isinstance(v['rollbackDataWindowApproval'], str) and
                (not v['rollbackDataWindowApproval'] or re.fullmatch(r'[A-Za-z0-9_.-]{4,100}', v['rollbackDataWindowApproval'])),
                'Invalid rollback authorization')
    ops.require(action in v['approvals'], 'Separate approval required for ' + action)
    if action == 'recover-edge' and auth.get('edgeRecoveryBackup'):
        # Fresh proof for the already-approved forward transaction only; never initial cutover.
        tx = private_json(home() / 'edge-pending.json')
        replacement = auth['edgeRecoveryBackup']
        ops.require(tx['planSha256'] == expected and tx['operation'] == 'cutover' and
                    replacement.get('approvalReference') == auth['grants'][action], 'Recovery-only backup approval mismatch')
        from first_prod_rebind import review_path
        review_path(replacement['path'])
        ops.require(ops.HEX.fullmatch(replacement['sha256']), 'Invalid recovery proof SHA')
        v['_recoveryBackup'] = replacement
    return v


def artifact():
    runtime, manifest = ops.verify(VERSION)
    ops.require(manifest['commit'] == COMMIT and manifest['sha256'] == SHA and
                manifest['lockSha256'] == LOCK, 'Pinned manifest mismatch')
    accepted = ops.load(ops.ROOT / 'accepted' / (VERSION + '.json'))
    ops.require(accepted.get('result') == 'PASS' and accepted.get('environment') == 'stg' and
                accepted.get('version') == VERSION and accepted.get('sha256') == SHA, 'Exact STG acceptance missing')
    ops.publication_ready(runtime, manifest)
    return runtime


def initialize_guard(cfg, release, seed, points):
    s = state()
    expected = s.get('planSha256', '')
    v = plan(cfg, expected, 'init-prod')
    ops.require(s.get('phase') == 'PREPARED' and release == VERSION and seed == SEED and
                v['approvals'].get('points-activation') == points and
                v['approvals'].get('synthetic-smoke') == cfg['prod'].get('syntheticSessionApproval') and
                bool(cfg['prod'].get('syntheticSessionApproval')), 'PROD initialization/points/synthetic approval mismatch')
    artifact()
    evidence(v)


def evidence(v):
    """These receipts are independently reviewed, never invented by this executor."""
    values = {}
    for field in ('backupReceipt', 'publicationReceipt'):
        override = v.get('_recoveryBackup') if field == 'backupReceipt' else None
        p = Path(override['path'] if override else v[field])
        ops.require(ops.digest(p) == (override['sha256'] if override else v[field + 'Sha256']), 'Reviewed evidence changed: ' + field)
        values[field] = private_json(p)
    b = values['backupReceipt']
    ops.require(b.get('format') == 'prod01-backup-proof-v1' and b.get('status') == 'PASS' and b.get('sourceDatabase') == 'f1guess_prod' and
                b.get('databaseRestoredSeparately') is True and b.get('configBackupVerified') is True and
                b.get('rolesAndIdentityKeysVerified') is True and b.get('snapshotFingerprintsMatch') is True and
                b.get('isolatedSocketOnly') is True, 'Full independent legacy restore proof required')
    timestamp = datetime.datetime.fromisoformat(b['verifiedAt'])
    age = datetime.datetime.now(datetime.timezone.utc) - timestamp
    ops.require(0 <= age.total_seconds() <= 86400, 'Backup proof must be no more than 24 hours old')
    base = ops.ROOT / 'backups' / 'legacy-prod01'
    for key in ('database', 'configuration'):
        item = b[key]
        p = Path(item['path'])
        ops.require(p.parent.parent == base and re.fullmatch(r'[A-Za-z0-9-]{8,80}', p.parent.name) and
                    p.name == ('database.dump' if key == 'database' else 'configuration.tar') and
                    not p.is_symlink() and p.is_file() and p.resolve().is_relative_to(base.resolve()) and
                    private_file(p) and
                    ops.digest(p) == item['sha256'], 'Backup archive absent, unsafe or changed')
    pub = values['publicationReceipt']
    ops.require(pub.get('format') == 'prod01-publication-proof-v1' and pub.get('version') == VERSION and
                pub.get('artifactSha256') == SHA and pub.get('lockSha256') == LOCK and
                pub.get('result') == 'PASS' and pub.get('fullGatePassed') is True and
                bool(pub.get('publicScopeApproval')), 'Separate full publication proof required')


def prepare_prod(cfg):
    """Do not chmod shared directories, prepare STG, create DBs, or reload systemd."""
    ops.require((ops.ROOT / 'versions').is_dir() and ops.ETC.is_dir(), 'Existing dual host required')
    unit = UNIT
    ops.require(unit.is_file() and unit.read_bytes() == (ops.LIB / unit.name).read_bytes(), 'Existing shared unit differs')
    ops.require(not (ops.ETC / 'prod.env').exists() and not (home() / 'active').exists(), 'PROD already initialized')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 3101))
    # Validate every pre-existing target before the first mutation.
    for p, mode in ((home(), 0o755), (ops.ROOT / 'backups/prod', 0o700)):
        if p.exists() or p.is_symlink():
            ops.require(p.is_dir() and not p.is_symlink() and p.stat().st_uid == 0 and
                        p.stat().st_mode & 0o777 == mode, 'Unexpected existing PROD directory')
    import pwd
    try:
        user = pwd.getpwnam('f1dg3_prod')
        ops.require(user.pw_shell == '/usr/sbin/nologin' and user.pw_uid != 0, 'Unexpected existing PROD user')
    except KeyError:
        ops.run('/usr/sbin/useradd', '--system', '--user-group', '--no-create-home',
                '--shell', '/usr/sbin/nologin', 'f1dg3_prod')
    for path, mode in ((home(), 0o755), (ops.ROOT / 'backups/prod', 0o700)):
        if path.exists():
            ops.require(path.is_dir() and not path.is_symlink() and path.stat().st_uid == 0 and
                        path.stat().st_mode & 0o777 == mode, 'Unexpected existing PROD directory')
        else:
            path.mkdir(mode=mode)
            # mkdir's requested mode is filtered by the administrator's 0077 umask.
            # Only this newly created, verified PROD directory is adjusted.
            path.chmod(mode)


def edge_path(internal):
    return NGINX / ('conf.d/f1-dual-prod-internal.conf' if internal else 'sites-available/f1-dual-prod.conf')


def render(internal):
    body = (ops.LIB / 'nginx.conf.example').read_text()
    ops.require(hashlib.sha256(body.encode()).hexdigest() == TEMPLATE_SHA, 'Reviewed Nginx template changed')
    for key, val in {'DOMAIN': 'f1driverguess.online', 'ENV': 'prod', 'PORT': '3101', 'AUTH': ''}.items():
        body = body.replace('@' + key + '@', val)
    # Bind internal HTTPS to IPv4 loopback only. Same Host/Origin, distinct transport port.
    if internal:
        body = body.replace('listen 443 ssl;', 'listen 127.0.0.1:9443 ssl;').replace('    listen [::]:443 ssl;\n', '')
    return body


def old_link():
    return NGINX / 'sites-enabled/f1guessdriver-public-p4f'


def link_value():
    p = old_link()
    ops.require(p.is_symlink(), 'Public link must remain a symlink')
    return os.readlink(p)


def protected():
    """Dependencies deliberately outside the one public pointer transaction."""
    paths = [NGINX / 'conf.d/f1guessdriver-rolling-upstream.conf',
             NGINX / 'sites-enabled/f1guessdriver-internal-crl-v1', Path(OLD),
             Path('/opt/f1guessdriver/rolling/routing/current/upstream.inc'),
             Path('/opt/f1guessdriver/rolling/routing/current/site.inc')]
    result = {}
    for p in paths:
        ops.require(p.is_file(), 'Missing preserved internal dependency')
        result[str(p)] = {'sha256': ops.digest(p), 'link': os.readlink(p) if p.is_symlink() else None}
    return result


def write_candidate(internal):
    p = edge_path(internal)
    body = render(internal)
    if p.exists():
        ops.require(not p.is_symlink() and p.read_text() == body, 'Candidate drift')
    else:
        # Internal conf must not be picked up by nginx until preflight has passed.
        p = p.with_suffix('.candidate')
        ops.require(not p.exists(), 'Stale candidate: inspect before continuing')
        with p.open('x') as stream:
            stream.write(body)
        p.chmod(0o644)
    return p


def nginx_test(*extra):
    result = ops.run('nginx', '-t', *extra, capture_output=True)
    ops.require(not re.search(rb'conflicting server name|duplicate', result.stderr or b'', re.I),
                'Nginx candidate contains conflicting listeners/hostnames')


def preflight(candidate, internal):
    """Test a complete candidate graph; never modify old target or nginx.conf."""
    conf = (NGINX / 'nginx.conf').read_text()
    conf_anchor = 'include /etc/nginx/conf.d/*.conf;'
    sites_anchor = 'include /etc/nginx/sites-enabled/*;'
    ops.require(conf.count(conf_anchor) == conf.count(sites_anchor) == 1, 'Review Nginx include layout')
    confs = sorted((NGINX / 'conf.d').glob('*.conf'))
    sites = sorted((NGINX / 'sites-enabled').iterdir())
    includes = lambda paths: '\n'.join('include ' + str(p) + ';' for p in paths)
    # For tests NGINX is a temporary directory; live anchors stay explicit.
    conf = conf.replace(conf_anchor, includes([p for p in confs if p != edge_path(True)]) +
                        ('\ninclude ' + str(candidate) + ';' if internal else
                         ('\ninclude ' + str(edge_path(True)) + ';' if edge_path(True).exists() else '')))
    conf = conf.replace(sites_anchor, includes([p for p in sites if internal or p != old_link()]) +
                        ('' if internal else '\ninclude ' + str(candidate) + ';'))
    temp = home() / 'nginx-preflight.conf'
    # Durable known path under the deployment lock; do not follow operator-created symlinks.
    ops.require(not temp.is_symlink(), 'Unsafe preflight path')
    temp.write_text(conf)
    nginx_test('-c', str(temp))


def internal_edge():
    ops.require(link_value() == OLD, 'Public entry already changed')
    p = write_candidate(True)
    preflight(p, True)
    if p != edge_path(True): os.replace(p, edge_path(True))
    nginx_test()
    ops.run('systemctl', 'reload', 'nginx', capture_output=True)


def startup_write(folder, name, body):
    with (folder / name).open('xb') as stream:
        stream.write(body)
    (folder / name).chmod(0o600)


def startup_diagnostics(folder, since, prefix=''):
    result = {}
    for name, args in (
        ('journal', ['journalctl', '-u', 'f1-dual@prod.service', '--since', '@' + str(int(since)),
                     '--no-pager', '-o', 'json']),
        ('systemd', ['systemctl', 'show', 'f1-dual@prod.service',
                     '-p', 'ActiveState,SubState,MainPID,NRestarts,Result,ExecMainStatus']),
        ('ports', ['ss', '-ltnp', 'sport = :3101']),
    ):
        try:
            output = subprocess.run(args, capture_output=True, timeout=5)
            startup_write(folder, prefix + name + '.stdout', output.stdout or b'')
            startup_write(folder, prefix + name + '.stderr', output.stderr or b'')
            result[name + 'ExitCode'] = output.returncode
        except (OSError, subprocess.SubprocessError) as error:
            result[name + 'CaptureError'] = type(error).__name__
    return result


def wait_ready(cfg, timeout=60, interval=1):
    """Wait for this one start, not a restart loop. Evidence never contains cookies."""
    ops.require(cfg['prod']['port'] == 3101 and 0 < timeout <= 60 and interval == 1,
                'Invalid startup readiness bounds')
    started = time.monotonic()
    since = time.time()
    deadline = started + timeout
    folder = home() / ('startup-' + uuid.uuid4().hex)
    folder.mkdir(mode=0o700)
    folder.chmod(0o700)
    record = {'startedAt': now(), 'sinceEpoch': since, 'evidenceDirectory': str(folder),
              'timeoutSeconds': timeout, 'attempts': []}
    initial_pid = None
    restarts = None

    def finish(result, reason):
        record.update(result=result, reason=reason, elapsedSeconds=time.monotonic() - started)
        if result != 'PASS':
            # Capture this start before release.activate performs its existing cleanup.
            record.update(startup_diagnostics(folder, since))
        startup_write(folder, 'readiness.json', json.dumps(record, sort_keys=True).encode())
        if result != 'PASS':
            raise RuntimeError(reason + '; private startup evidence: ' + str(folder))
        return record

    def service_state():
        nonlocal initial_pid, restarts
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            finish('FAIL', 'Startup readiness timed out')
        output = ops.run('systemctl', 'show', 'f1-dual@prod.service',
                         '-p', 'ActiveState,SubState,MainPID,NRestarts,Result,ExecMainStatus',
                         capture_output=True, text=True, timeout=min(2, remaining)).stdout
        state = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
        record['lastServiceState'] = state
        pid = state.get('MainPID', '')
        count = state.get('NRestarts', '')
        if (state.get('ActiveState') not in ('active', 'activating') or
                state.get('SubState') in ('auto-restart', 'failed', 'dead') or
                state.get('Result') not in ('success', '') or
                not pid.isdigit() or int(pid) <= 0 or not count.isdigit()):
            finish('FAIL', 'PROD service exited or failed during startup')
        if initial_pid is None:
            initial_pid, restarts = pid, count
        if pid != initial_pid or count != restarts:
            finish('FAIL', 'PROD service restarted during startup')

    try:
        while time.monotonic() < deadline:
            service_state()
            attempt = {'elapsedSeconds': time.monotonic() - started, 'probes': []}
            record['attempts'].append(attempt)
            ready = True
            for route in ('/api/health', '/api/ready'):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return finish('FAIL', 'Startup readiness timed out')
                limit = min(2, remaining)
                try:
                    output = ops.run('curl', '--silent', '--show-error', '--noproxy', '*',
                                     '--proto', '=http', '--connect-timeout', str(min(1, limit)),
                                     '--max-time', str(limit), '--output', '/dev/null',
                                     '--write-out', '%{http_code}', 'http://127.0.0.1:3101' + route,
                                     capture_output=True, timeout=limit)
                    code = output.stdout.decode().strip()
                    status = {'path': route, 'httpStatus': code, 'exitCode': 0}
                except subprocess.CalledProcessError as error:
                    status = {'path': route, 'httpStatus': '000', 'exitCode': error.returncode}
                    if error.returncode not in (7, 28, 52, 56):
                        attempt['probes'].append(status)
                        return finish('FAIL', 'Unrecoverable startup probe error')
                except subprocess.TimeoutExpired:
                    status = {'path': route, 'httpStatus': '000', 'timeout': True}
                attempt['probes'].append(status)
                service_state()
                if status['httpStatus'] != '200':
                    ready = False
                    if status['httpStatus'] not in ('000', '502', '503', '504'):
                        return finish('FAIL', 'Unrecoverable startup HTTP response')
            service_state()
            if ready and time.monotonic() < deadline:
                return finish('PASS', 'Health and readiness passed for the same running process')
            remaining = deadline - time.monotonic()
            if remaining > 0:
                time.sleep(min(interval, remaining))
        return finish('FAIL', 'Startup readiness timed out')
    except (OSError, subprocess.SubprocessError) as error:
        return finish('FAIL', 'Startup inspection failed: ' + type(error).__name__)


def probe(cfg, internal, synthetic):
    startup = wait_ready(cfg) if internal else None
    try:
        return https_probe(cfg, internal, synthetic)
    except Exception as error:
        if startup:
            folder = Path(startup['evidenceDirectory'])
            failure = {'result': 'FAIL', 'phase': 'HTTPS', 'failureType': type(error).__name__,
                       **startup_diagnostics(folder, startup['sinceEpoch'], 'https-')}
            if isinstance(error, subprocess.CalledProcessError):
                failure['exitCode'] = error.returncode
                # Never persist a session response body or cookie headers here.
                startup_write(folder, 'https-client.stderr', error.stderr or b'')
            startup_write(folder, 'https-failure.json', json.dumps(failure).encode())
        raise


def https_probe(cfg, internal, synthetic):
    domain = cfg['prod']['domain']
    options = ['curl', '--silent', '--show-error', '--noproxy', '*', '--fail', '--max-time', '10',
               '--proto', '=https', '--resolve', domain + ':443:127.0.0.1']
    if internal: options += ['--connect-to', domain + ':443:127.0.0.1:9443']
    url = 'https://' + domain

    def get(path, extra=()):
        raw = ops.run(*options, *extra, '--write-out', '\n%{http_code}', url + path, capture_output=True).stdout
        body, status = raw.rsplit(b'\n', 1)
        ops.require(status == b'200', 'Expected HTTP 200')
        return body

    ops.require(get('/.f1-deploy-version').decode().strip() == VERSION, 'HTTPS version mismatch')
    for path in ('/', '/api/health', '/api/ready', '/api/runtime-readiness', '/api/v3/quick/options', '/favicon.svg', '/favicon.ico'):
        ops.require(bool(get(path)), 'Empty HTTP response')
    page = get('/').decode()
    asset = re.search(r'src="(/assets/[A-Za-z0-9._-]+\.js)"', page)
    ops.require(asset and get(asset[1]), 'Static asset unavailable')
    pid = ops.run('systemctl', 'show', '--value', '-p', 'MainPID', 'f1-dual@prod.service',
                  capture_output=True, text=True).stdout.strip()
    ops.require(pid.isdigit() and int(pid) > 0 and
                os.path.samefile('/proc/' + pid + '/cwd', ops.version(VERSION) / 'runtime'), 'PROD PID/runtime mismatch')
    if synthetic:
        ops.require(cfg['prod'].get('syntheticSessionApproval'), 'Synthetic write approval missing')
        ops.check_target(cfg, 'prod')
        from first_prod_smoke import ensure_jar, record_identity
        jar = ensure_jar(cfg, 'a')
        ops.require(not jar.is_symlink(), 'Unsafe cookie jar')
        if jar.exists():
            ops.require(jar.stat().st_uid == 0 and jar.stat().st_mode & 0o077 == 0, 'Cookie jar must be private')
        extra = ('--cookie', str(jar), '--cookie-jar', str(jar))
        a = json.loads(get('/api/v3/modes/session', extra))
        b = json.loads(get('/api/v3/modes/session', extra))
        ops.require(a == b and a.get('contract') == 'modes-v1' and a.get('principalId') and
                    a.get('csrfToken'), 'Synthetic session/final permissions failed')
        record_identity(cfg, 'a', a['principalId'])
        ops.require(isinstance(json.loads(get('/api/v3/quick/active', extra)), dict), 'Practice query failed')


def activate_internal(cfg):
    ops.require(link_value() == OLD and edge_path(True).is_file(), 'Internal edge required before activation')
    runtime = artifact()
    ops.check_target(cfg, 'prod')
    ops.compatible(cfg, 'prod', VERSION, runtime)
    smoke = lambda c, e, r: probe(c, True, True)
    ops.recover(cfg, 'prod', smoke_fn=smoke)
    old = ops.active('prod')
    ops.require(not old or old.get('version') == VERSION, 'Cannot adopt a different PROD')
    if old.get('version') == VERSION:
        probe(cfg, True, True)
    else:
        backup = ops.backup(cfg, 'prod')
        ops.activate(cfg, 'prod', VERSION, old, backup, 'first-prod-internal', smoke_fn=smoke)
    return ops.active('prod')


def probe_old(cfg):
    """No session creation on the old database. This is deliberately not account acceptance."""
    domain = cfg['prod']['domain']
    for path in ('/', '/api/health'):
        code = ops.run('curl', '--silent', '--show-error', '--noproxy', '*', '--fail', '--max-time', '10',
                       '--proto', '=https', '--resolve', domain + ':443:127.0.0.1',
                       '--output', '/dev/null', '--write-out', '%{http_code}',
                       'https://' + domain + path, capture_output=True).stdout
        ops.require(code == b'200', 'Old HTTPS/health verification failed; inspect rollback state')


def transaction(cfg, value, expected, action):
    s = state()
    ops.require(s.get('planSha256') == expected and s.get('version') == VERSION, 'Lifecycle plan mismatch')
    pending_path = home() / 'edge-pending.json'
    if pending_path.exists():
        ops.require(action == 'recover-edge', 'Interrupted edge operation: explicitly recover-edge')
        tx = ops.load(pending_path)
        ops.require(tx['planSha256'] == expected, 'Pending plan mismatch')
        ops.require(tx['operation'] in value['approvals'], 'Original operation approval missing')
    else:
        ops.require(action != 'recover-edge', 'No pending edge operation')
        rollback = action == 'rollback-edge'
        if rollback:
            ops.require(s['phase'] in ('PUBLIC_VERIFIED', 'PUBLIC_UNVERIFIED') and
                        value['rollbackDataWindowApproval'], 'Explicit maintenance/data-window approval required; no lossless DB rollback')
            target = OLD
        else:
            ops.require(s['phase'] == 'INTERNAL_READY' and s.get('internalAcceptance', {}).get('version') == VERSION,
                        'Internal acceptance required')
            artifact()
            ops.check_target(cfg, 'prod')
            evidence(value)
            probe(cfg, True, True)
            target = str(edge_path(False))
        candidate = Path(target) if rollback else write_candidate(False)
        if not rollback:
            preflight(candidate, False)
            if candidate != edge_path(False): os.replace(candidate, edge_path(False))
        else:
            # Test old graph before changing the one pointer.
            preflight(candidate, False)
        tx = {'planSha256': expected, 'operation': action, 'from': link_value(), 'to': target,
              'protected': protected(), 'createdAt': now(), 'exposurePossible': s.get('exposurePossible', False)}
        ops.require(tx['from'] == (str(edge_path(False)) if rollback else OLD), 'Public pointer drift')
        ops.save(pending_path, tx)  # Write ahead: SIGKILL never loses rollback/forward targets.
    ops.require(tx['operation'] in ('cutover', 'rollback-edge') and
                tx['from'] == (OLD if tx['operation'] == 'cutover' else str(edge_path(False))) and
                tx['to'] == (str(edge_path(False)) if tx['operation'] == 'cutover' else OLD), 'Invalid transaction targets')
    ops.require(protected() == tx['protected'], 'Preserved internal dependencies changed')
    ops.require(link_value() in (tx['from'], tx['to']), 'Public pointer changed outside transaction')
    if tx['operation'] == 'rollback-edge':
        ops.require('rollback-edge' in value['approvals'] and value['rollbackDataWindowApproval'], 'Rollback approval missing')
    try:
        # Re-test after interruption. Any new target or runtime drift fails closed.
        if tx['operation'] == 'cutover':
            tx['step'] = 'VERIFY_FORWARD_PREREQUISITES'; ops.save(pending_path, tx)
            artifact()
            ops.check_target(cfg, 'prod')
            evidence(value)
            if value.get('_recoveryBackup'):
                tx['recoveryBackup'] = value['_recoveryBackup']
                ops.save(pending_path, tx)
            ops.require(edge_path(False).read_text() == render(False), 'Public candidate drift')
        preflight(Path(tx['to']), False)
        tx['step'] = 'SWITCH_POINTER'; ops.save(pending_path, tx)
        ops.link(old_link(), tx['to'])
        tx['step'] = 'VALIDATE_LIVE'; ops.save(pending_path, tx)
        nginx_test()
        # Once reload is attempted, real writes may have arrived. Never auto-revert to old DB.
        s = save_state(s, 'PUBLIC_UNVERIFIED', exposurePossible=True)
        tx['step'] = 'RELOAD'; ops.save(pending_path, tx)
        ops.run('systemctl', 'reload', 'nginx', capture_output=True)
        tx['step'] = 'VERIFY_HTTPS'; ops.save(pending_path, tx)
        if tx['operation'] == 'cutover': probe(cfg, False, True)
        else: probe_old(cfg)
        ops.require(protected() == tx['protected'], 'Preserved internal dependency drift')
        s = save_state(s, 'ROLLED_BACK' if tx['operation'] == 'rollback-edge' else 'PUBLIC_VERIFIED',
                       edgeTransaction=tx, rollbackDataWindowApproval=value['rollbackDataWindowApproval'])
        pending_path.unlink()
        return s
    except Exception as error:
        # Leave config/pending intact; nginx may still be serving either generation.
        # Explicit recovery completes the recorded direction, never changes databases.
        tx['failureType'] = type(error).__name__; tx['failedAt'] = now()
        # require() messages are fixed controller diagnostics, unlike subprocess
        # exception arguments which may include private transport/SQL details.
        reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        tx['failureReason'] = reason
        ops.save(pending_path, tx)
        raise RuntimeError('Edge operation interrupted at ' + tx.get('step', 'PREFLIGHT') +
                           ': ' + reason + '; retain both databases/services; inspect and use recover-edge') from None


def execute(cfg, value, expected, action):
    s = state()
    if action == 'prepare-prod':
        if s:
            ops.require(s.get('planSha256') == expected and s.get('version') == VERSION, 'Existing lifecycle differs')
            return s  # No repeated user creation, chmod, or service operation.
        artifact()
        prepare_prod(cfg)
        return save_state({'version': VERSION, 'planSha256': expected}, 'PREPARED')
    ops.require(s.get('planSha256') == expected, 'Prepare with the same reviewed plan first')
    if s.get('resourceIdentitySha256') and action in ('activate-internal','synthetic-smoke','recover-internal','cutover','recover-edge'):
        from first_prod_rebind import identity_digest, controller_bundle
        ops.require(identity_digest(cfg)==s['resourceIdentitySha256'] and
                    controller_bundle()==s['controllerBundleSha256'], 'Bound PROD/controller identity changed')
    if action == 'synthetic-smoke':
        ops.require(s.get('phase') == 'INTERNAL_READY', 'Internal acceptance required before business smoke')
        evidence(value)
        from first_prod_smoke import run
        return run(cfg, value)
    if action == 'recover-internal':
        ops.require(s.get('phase') in ('INTERNAL_EDGE', 'INTERNAL_READY') and not s.get('exposurePossible') and
                    link_value() == OLD and not (home() / 'edge-pending.json').exists(), 'Not an unpublished internal recovery')
        pending = home() / 'pending.json'
        ops.require(pending.is_file() and not pending.is_symlink(), 'No interrupted internal release')
        prior = private_json(pending).get('old')
        if prior:
            target = Path(prior)
            ops.require(target.parent == home() and re.fullmatch(r'generation-[a-f0-9]{32}', target.name) and
                        private_json(target / 'receipt.json').get('version') == VERSION, 'Unknown internal recovery target')
        artifact(); ops.check_target(cfg, 'prod')
        ops.recover(cfg, 'prod', smoke_fn=lambda c,e,r: probe(c,True,True))
        reduced = {k:v for k,v in s.items() if k not in ('internalAcceptance','internalVerifiedAt')}
        return save_state(reduced, 'INTERNAL_EDGE')
    if action == 'activate-internal':
        ops.require(not (home() / 'pending.json').exists(), 'Explicit recover-internal required before activation')
    if action in ('activate-internal', 'cutover', 'recover-edge'):
        ops.require(value['approvals'].get('synthetic-smoke') == cfg['prod'].get('syntheticSessionApproval') and
                    bool(cfg['prod'].get('syntheticSessionApproval')), 'Synthetic approval mismatch')
    if (home() / 'edge-pending.json').exists() or action in ('cutover', 'rollback-edge', 'recover-edge'):
        if action == 'cutover' and s['phase'] == 'PUBLIC_VERIFIED' and not (home() / 'edge-pending.json').exists():
            ops.require(link_value() == str(edge_path(False)), 'Public pointer drift')
            probe(cfg, False, False)
            return s
        if action == 'rollback-edge' and s['phase'] == 'ROLLED_BACK' and not (home() / 'edge-pending.json').exists():
            ops.require(link_value() == OLD, 'Old pointer drift')
            return s
        return transaction(cfg, value, expected, action)
    ops.require(s['phase'] in ('PREPARED', 'INTERNAL_EDGE', 'INTERNAL_READY'), 'Public lifecycle cannot return to internal activation')
    if action == 'internal-edge':
        internal_edge()
        return save_state(s, s['phase'] if s['phase'] == 'INTERNAL_READY' else 'INTERNAL_EDGE')
    if action == 'init-prod':
        ops.require(s['phase'] == 'PREPARED', 'PROD initialization is not repeatable; inspect existing database')
        from bootstrap import initialize
        initialize(cfg, 'prod', VERSION, SEED, value['approvals'].get('points-activation', ''))
        ops.check_target(cfg, 'prod')
        return save_state(s, 'PREPARED', initialized=True)
    ops.require(action == 'activate-internal' and s['phase'] in ('INTERNAL_EDGE', 'INTERNAL_READY'), 'Internal edge not prepared')
    evidence(value)
    receipt = activate_internal(cfg)
    return save_state(s, 'INTERNAL_READY', internalAcceptance=receipt, internalVerifiedAt=now())


def main(args):
    if args == ['--help']:
        print('f1-dual-first-prod ACTION PLAN_SHA256 | status')
        return
    ops.require(os.geteuid() == 0, 'Administrator only')
    ops.require(args in (['status'], ['rebind-identity']) or
                (len(args) == 2 and args[0] in ACTIONS + BINDING_ACTIONS), 'Invalid first-PROD invocation')
    cfg = ops.config()
    with ops.locked():  # Same nonblocking flock as STG/release/bootstrap/rollback.
        if args == ['status']:
            print(json.dumps({'state': state(), 'pending': (home() / 'edge-pending.json').exists(),
                              'rebindPending': (home() / 'plan-rebind-pending.json').exists()}))
        elif args == ['rebind-identity']:
            from first_prod_rebind import identity_digest, controller_bundle
            print(json.dumps({'identitySha256':identity_digest(cfg),'controllerBundleSha256':controller_bundle()}))
        elif args[0] in BINDING_ACTIONS:
            from first_prod_rebind import rebind, reopen
            print(json.dumps(reopen(cfg,args[1]) if args[0]=='reopen-internal' else rebind(cfg,args[1],args[0])))
        else:
            action, expected = args
            v = plan(cfg, expected, action)
            print(json.dumps(execute(cfg, v, expected, action)))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main(sys.argv[1:])
    except RuntimeError as error:
        print('First PROD stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # Never print SQL arguments, environment values, cookies, or parsed response bodies.
        print('First PROD stopped; inspect private state/receipts; no implicit retry or legacy cleanup.', file=sys.stderr)
        sys.exit(1)
