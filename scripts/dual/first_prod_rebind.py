"""Reviewed first-PROD metadata transactions. Caller owns deployment.lock."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import uuid

import first_prod as fp
import release as ops

MODULES = ('first_prod.py', 'release.py', 'bootstrap.py', 'first_prod_rebind.py', 'first_prod_smoke.py')
ACTIONS = ('rebind-plan', 'recover-rebind', 'abort-rebind', 'reopen-internal')


def digest_bytes(body):
    return hashlib.sha256(body).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def controller_bundle():
    return digest_bytes(b''.join(n.encode() + b'\0' + (ops.LIB / n).read_bytes() + b'\0' for n in MODULES))


def sync_dir(path):
    if os.name == 'posix':
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)


def private_dir(path):
    if path.exists() or path.is_symlink():
        ops.require(path.is_dir() and not path.is_symlink() and fp.private_file(path), 'Unsafe private directory')
    else:
        path.mkdir(mode=0o700)
        path.chmod(0o700)
        sync_dir(path.parent)


def replace_private(path, body, exclusive=False):
    """Atomic, fsynced bytes; exclusive snapshots never overwrite an older audit."""
    ops.require(path.parent.is_dir() and not path.parent.is_symlink() and not path.is_symlink(), 'Unsafe metadata path')
    if exclusive and path.exists():
        ops.require(fp.private_file(path) and path.read_bytes() == body, 'Sealed snapshot drift')
        return
    temp = path.with_name('.' + path.name + '-' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('xb') as stream:
            stream.write(body)
            temp.chmod(0o600)
            stream.flush(); os.fsync(stream.fileno())
        if exclusive:
            os.link(temp, path)  # Atomic create-if-absent, including across process death.
            temp.unlink()
        else:
            os.replace(temp, path)
        sync_dir(path.parent)
    finally:
        if temp.exists(): temp.unlink()


def pending():
    return fp.home() / 'plan-rebind-pending.json'


def identity_digest(cfg):
    """Immutable initialized-resource identity, excluding mutable player data."""
    import pwd
    ops.check_target(cfg, 'prod')
    env = ops.ETC / 'prod.env'
    ops.require(not env.is_symlink() and fp.private_file(env), 'Unsafe PROD environment')
    user = pwd.getpwnam('f1dg3_prod')
    ops.require(user.pw_uid > 0 and user.pw_shell == '/usr/sbin/nologin', 'PROD system user changed')
    journal = ops.live_journal(cfg['pgPort'], 'prod')
    ops.require(len(journal) == 15 and journal == ops.journal(ops.version(fp.VERSION) / 'runtime'), 'PROD migrations drifted')
    facts = json.loads(ops.sql(cfg['pgPort'], 'f1dg3_prod', """
      BEGIN READ ONLY;
      SELECT json_build_object(
        'cluster',(SELECT system_identifier::text FROM pg_control_system()),
        'database',(SELECT oid FROM pg_database WHERE datname=current_database()),
        'app',(SELECT oid FROM pg_roles WHERE rolname='f1dg3_prod_app'),
        'owner',(SELECT oid FROM pg_roles WHERE rolname='f1dg3_prod_owner'),
        'eligible',(SELECT count(*) FROM driver_stats WHERE eligible AND dataset_version='f1-2026-10-08-994df511b40814a5'),
        'points',(SELECT rule_summary FROM points_rule_activations WHERE version='points-v1'));
      ROLLBACK;
    """))
    ops.require(facts['eligible'] == 784 and facts['points'] ==
                'daily-v2:success=1;match-v2-bo3:win=3,loss=-1;floor=0', 'PROD initialization changed')
    return digest_bytes(encode({'facts': facts, 'journal': journal, 'envSha256': ops.digest(env),
                               'user': [user.pw_uid, user.pw_gid, user.pw_shell],
                               'prod': cfg['prod'], 'pgPort': cfg['pgPort'], 'version': fp.VERSION}))


def internal_only(s):
    ops.require(s.get('initialized') is True and s.get('version') == fp.VERSION and
                s.get('phase') == 'INTERNAL_EDGE' and not s.get('exposurePossible'), 'Rebind requires initialized INTERNAL_EDGE')
    ops.require(not any((fp.home() / n).exists() or (fp.home() / n).is_symlink()
                        for n in ('pending.json', 'edge-pending.json')), 'Other deployment transaction pending')
    ops.require(fp.link_value() == fp.OLD, 'Public route changed')


def review_path(name):
    path = Path(name)
    ops.require(path.parent == ops.ETC / 'prod-review' and
                re.fullmatch(r'[a-z][a-z0-9-]*\.json', path.name), 'Review path must be a private prod-review JSON')
    return path


def read_bound(path, expected):
    fp.private_json(path)
    body = path.read_bytes()
    ops.require(ops.HEX.fullmatch(expected) and digest_bytes(body) == expected, 'Review digest mismatch')
    return body


def canonical():
    return {'plan': ops.ETC / 'prod-review/first-prod.json',
            'authorization': ops.ETC / 'prod-review/authorization.json',
            'state': fp.home() / 'first-prod.json'}


def validate_pair(plan, auth, sha, cfg):
    fp.validate_plan(plan, cfg)
    ops.require(set(auth) == {'format', 'planSha256', 'grants', 'rollbackDataWindowApproval'} and
                auth.get('format') == 'first-prod-authorization-v1' and auth.get('planSha256') == sha and
                isinstance(auth.get('grants'), dict) and not auth.get('rollbackDataWindowApproval'), 'Invalid internal authorization')
    ops.require(all(plan['approvals'].get(k) == v for k, v in auth['grants'].items()), 'Authorization reference mismatch')


def new_evidence(plan, req):
    fp.evidence(plan)
    pub = fp.private_json(Path(plan['publicationReceipt']))
    ops.require(pub.get('candidateSha256') == req['candidateSha256'] and
                pub.get('candidateFiles') == req['candidateFiles'] and
                pub.get('publicScopeApproval') == req['publicScopeApproval'] and
                pub.get('controllerBundleSha256') == req['controllerBundleSha256'] and
                pub.get('gitCommit') == fp.COMMIT, 'New publication/controller scope mismatch')


def transaction_root():
    path = fp.home() / 'plan-rebind-audit'
    if path.exists() or path.is_symlink(): private_dir(path)
    return path


def load_transaction(expected):
    marker = fp.private_json(pending())
    ops.require(marker['requestSha256'] == expected and ops.HEX.fullmatch(marker['manifestSha256']), 'Different pending rebind')
    folder = transaction_root() / expected
    manifest = json.loads(read_bound(folder / 'manifest.json', marker['manifestSha256']))
    req = json.loads(read_bound(folder / 'request.json', expected))
    ops.require(set(manifest['snapshots']) == {side + '-' + name + '.json'
                for side in ('old', 'new') for name in ('plan', 'authorization', 'state', 'backup', 'publication')},
                'Incomplete rebind snapshots')
    for name, sha in manifest['snapshots'].items():
        ops.require(re.fullmatch(r'(old|new)-(plan|authorization|state|backup|publication)\.json', name), 'Invalid snapshot name')
        read_bound(folder / name, sha)
    return folder, manifest, req


def verify_tuple(folder, manifest, direction):
    for key, path in canonical().items():
        ops.require(not path.is_symlink() and fp.private_file(path) and ops.digest(path) in
                    (manifest['snapshots']['old-' + key + '.json'], manifest['snapshots']['new-' + key + '.json']),
                    'Canonical metadata drift; do not overwrite')
        if direction:
            ops.require(ops.digest(path) == manifest['snapshots'][direction + '-' + key + '.json'], 'Committed tuple drift')


def finish(folder, manifest, req, abort=False):
    expected = digest_bytes((folder / 'request.json').read_bytes())
    committed = (folder / 'committed.json').exists()
    aborted = (folder / 'aborted.json').exists()
    if committed or aborted:
        ops.require(not (committed and aborted) and not (committed and abort), 'Committed rebind cannot be aborted')
        verify_tuple(folder, manifest, 'new' if committed else 'old')
        receipt = fp.private_json(folder / ('committed.json' if committed else 'aborted.json'))
        ops.require(receipt['requestSha256'] == expected and receipt['result'] ==
                    ('COMMITTED' if committed else 'ABORTED'), 'Commit receipt drift')
    else:
        verify_tuple(folder, manifest, None)
        # The only accepted states are exact archived old/new bytes, both still EDGE.
        internal_only(fp.state())
        ops.require(identity_digest(ops.config()) == req['identitySha256'] and
                    controller_bundle() == req['controllerBundleSha256'], 'Resource/controller identity drift')
        if abort:
            ops.require('abort-rebind' in req['operations'], 'Separate abort approval required')
            replace_private(folder / 'abort-requested.json', encode({'requestSha256': expected}), exclusive=True)
        abort = (folder / 'abort-requested.json').exists()
        if abort:
            ops.require('abort-rebind' in req['operations'] and
                        fp.private_json(folder / 'abort-requested.json') == {'requestSha256': expected}, 'Abort decision drift')
        if not abort:
            new_evidence(json.loads((folder / 'new-plan.json').read_text()), req)
        direction = 'old' if abort else 'new'
        for key, path in canonical().items():
            body = (folder / (direction + '-' + key + '.json')).read_bytes()
            if path.read_bytes() != body: replace_private(path, body)
        receipt = {'format': 'first-prod-rebind-receipt-v1', 'result': 'ABORTED' if abort else 'COMMITTED',
                   'requestSha256': expected, 'oldPlanSha256': req['oldPlanSha256'],
                   'newPlanSha256': req['newPlanSha256'], 'phase': 'INTERNAL_EDGE', 'recordedAt': fp.now()}
        replace_private(folder / ('aborted.json' if abort else 'committed.json'), encode(receipt), exclusive=True)
    pending().unlink()
    sync_dir(pending().parent)
    return receipt


def rebind(cfg, expected, action):
    ops.require(ops.HEX.fullmatch(expected), 'Exact rebind request SHA required')
    if pending().exists() or pending().is_symlink():
        ops.require(action in ('recover-rebind', 'abort-rebind'), 'Interrupted rebind: explicitly recover-rebind or abort-rebind')
        folder, manifest, req = load_transaction(expected)
        ops.require(action in req['operations'], 'Rebind operation not approved')
        return finish(folder, manifest, req, action == 'abort-rebind')
    ops.require(action == 'rebind-plan', 'No pending rebind to recover/abort')
    body = read_bound(ops.ETC / 'prod-review/rebind-request.json', expected)
    req = json.loads(body)
    keys = {'format', 'oldPlanSha256', 'oldAuthorizationSha256', 'oldStateSha256',
            'newPlanFile', 'newPlanSha256', 'newAuthorizationFile', 'newAuthorizationSha256',
            'controllerBundleSha256', 'identitySha256', 'approvedGrants', 'operations',
            'approvalReference', 'candidateSha256', 'candidateFiles', 'publicScopeApproval'}
    ops.require(set(req) == keys and req['format'] == 'first-prod-rebind-v1' and
                re.fullmatch(r'[A-Za-z0-9_.-]{4,100}', req['approvalReference']) and
                set(req['operations']) <= {'rebind-plan', 'recover-rebind', 'abort-rebind'} and
                'rebind-plan' in req['operations'] and ops.HEX.fullmatch(req['candidateSha256']) and
                isinstance(req['candidateFiles'], int) and req['candidateFiles'] > 0, 'Invalid exact rebind authorization')
    folder = transaction_root() / expected
    if (folder / 'committed.json').exists():
        read_bound(folder / 'request.json', expected)
        manifest = fp.private_json(folder / 'manifest.json')
        verify_tuple(folder, manifest, 'new')
        return fp.private_json(folder / 'committed.json')  # Read-only repeat, no service or audit rewrite.
    ops.require(not (folder / 'aborted.json').exists(), 'Aborted request cannot be reused')
    paths = canonical()
    old = {k: read_bound(p, req['old' + k.capitalize() + 'Sha256']) for k, p in paths.items()}
    old_plan, old_auth, old_state = (json.loads(old[k]) for k in ('plan', 'authorization', 'state'))
    internal_only(old_state)
    ops.require(old_state['planSha256'] == req['oldPlanSha256'], 'Old lifecycle/plan mismatch')
    validate_pair(old_plan, old_auth, req['oldPlanSha256'], cfg)
    new = {'plan': read_bound(review_path(req['newPlanFile']), req['newPlanSha256']),
           'authorization': read_bound(review_path(req['newAuthorizationFile']), req['newAuthorizationSha256'])}
    new_plan, new_auth = json.loads(new['plan']), json.loads(new['authorization'])
    validate_pair(new_plan, new_auth, req['newPlanSha256'], cfg)
    ops.require(new_auth['grants'] == req['approvedGrants'] and
                set(new_auth['grants']) <= set(old_auth['grants']), 'Rebind cannot expand effective grants')
    for key in ('points-activation', 'synthetic-smoke'):
        ops.require(new_auth['grants'].get(key) == old_auth['grants'].get(key), 'Existing points/synthetic scope must not change')
    ops.require(controller_bundle() == req['controllerBundleSha256'] and
                identity_digest(cfg) == req['identitySha256'] and
                old_state.get('resourceIdentitySha256',req['identitySha256']) == req['identitySha256'],
                'Resource/controller identity mismatch')
    fp.artifact()
    new_evidence(new_plan, req)
    snapshots = {side + '-' + key + '.json': value for side, items in [('old', old), ('new', new)] for key, value in items.items()}
    new_state = {**old_state, 'planSha256': req['newPlanSha256'],
                 'resourceIdentitySha256':req['identitySha256'],
                 'controllerBundleSha256':req['controllerBundleSha256'], 'rebindRequestSha256':expected}
    snapshots['new-state.json'] = encode(new_state)
    for side, plan in [('old', old_plan), ('new', new_plan)]:
        for key, field in [('backup', 'backupReceipt'), ('publication', 'publicationReceipt')]:
            snapshots[side + '-' + key + '.json'] = read_bound(Path(plan[field]), plan[field + 'Sha256'])
    manifest = {'requestSha256': expected, 'snapshots': {n: digest_bytes(b) for n, b in snapshots.items()}}
    private_dir(transaction_root()); private_dir(folder)
    replace_private(folder / 'request.json', body, exclusive=True)
    for name, value in snapshots.items(): replace_private(folder / name, value, exclusive=True)
    replace_private(folder / 'manifest.json', encode(manifest), exclusive=True)
    replace_private(pending(), encode({'requestSha256': expected, 'manifestSha256': digest_bytes(encode(manifest))}), exclusive=True)
    return finish(folder, manifest, req)


def reopen(cfg, expected):
    """Invalidate only unpublished internal acceptance when new evidence is needed."""
    req = json.loads(read_bound(ops.ETC / 'prod-review/reopen-request.json', expected))
    ops.require(set(req) == {'format', 'planSha256', 'authorizationSha256', 'stateSha256', 'identitySha256', 'approvalReference'} and
                req['format'] == 'first-prod-reopen-v1' and
                re.fullmatch(r'[A-Za-z0-9_.-]{4,100}', req['approvalReference']), 'Separate reopen approval required')
    ops.require(not pending().exists() and not any((fp.home() / n).exists() for n in ('pending.json', 'edge-pending.json')),
                'Pending transaction prevents reopen')
    ops.require(fp.link_value() == fp.OLD and identity_digest(cfg) == req['identitySha256'], 'Reopen identity/public route drift')
    folder = transaction_root() / ('reopen-' + expected)
    if (folder / 'new-state.json').exists() and canonical()['state'].read_bytes() == (folder / 'new-state.json').read_bytes():
        return {'result': 'INTERNAL_EDGE', 'requestSha256': expected}
    sbody = read_bound(canonical()['state'], req['stateSha256']); s = json.loads(sbody)
    plan = json.loads(read_bound(canonical()['plan'],req['planSha256']))
    auth = json.loads(read_bound(canonical()['authorization'],req['authorizationSha256']))
    validate_pair(plan,auth,req['planSha256'],cfg)
    ops.require(s.get('phase') == 'INTERNAL_READY' and s.get('initialized') and not s.get('exposurePossible') and
                s.get('version') == fp.VERSION and s.get('planSha256') == req['planSha256'] and
                ops.digest(canonical()['plan']) == req['planSha256'], 'Only unpublished INTERNAL_READY may reopen')
    new = {k: v for k, v in s.items() if k not in ('internalAcceptance', 'internalVerifiedAt')}
    new['phase'] = 'INTERNAL_EDGE'
    private_dir(transaction_root()); private_dir(folder)
    replace_private(folder / 'request.json', encode(req), exclusive=True)
    replace_private(folder / 'old-state.json', sbody, exclusive=True)
    replace_private(folder / 'new-state.json', encode(new), exclusive=True)
    replace_private(canonical()['state'], encode(new))
    return {'result': 'INTERNAL_EDGE', 'requestSha256': expected}
