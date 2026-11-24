"""Local, no SSH tests: real temp filesystem + injected command failures."""
import contextlib
import datetime
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

import bootstrap
import first_prod as fp
import install_first_prod as installer
import release as ops

CFG = {'pgPort': 5432, 'stg': {'port': 3100}, 'prod': {
    'port': 3101, 'domain': 'f1driverguess.online', 'syntheticSessionApproval': 'approved-smoke'}}
PLAN_SHA = 'a' * 64


class FirstProdTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.nginx = self.root / 'nginx'
        for path in ['state/prod', 'etc/prod-review', 'lib', 'backups/legacy-prod01/20261123-test', 'versions']:
            (self.root / path).mkdir(parents=True)
        for path in ['conf.d', 'sites-available', 'sites-enabled']:
            (self.nginx / path).mkdir(parents=True)
        patches = patch.multiple(ops, ROOT=self.root, ETC=self.root/'etc', LIB=self.root/'lib')
        patches.start(); self.addCleanup(patches.stop)
        p = patch.object(fp, 'NGINX', self.nginx); p.start(); self.addCleanup(p.stop)
        # Test paths replace the one permitted absolute old target; no remote shell.
        p = patch.object(fp, 'OLD', str(self.nginx/'sites-available/f1guessdriver-public-p4f'))
        p.start(); self.addCleanup(p.stop)
        self.targets = {}
        if os.name == 'nt':
            # Windows without symlink privilege: model only atomic pointer operations.
            def link(path, target):
                path.write_text(str(target)); self.targets[str(path)] = str(target)
            p = patch.multiple(ops, link=link, pointer_target=lambda path: self.targets.get(str(path)))
            p.start(); self.addCleanup(p.stop)
            p = patch.object(fp, 'link_value', side_effect=lambda: self.targets[str(fp.old_link())])
            p.start(); self.addCleanup(p.stop)
        ops.link(fp.old_link(), fp.OLD)
        Path(fp.OLD).write_text('old public server')
        (self.nginx/'nginx.conf').write_text('events {}\nhttp { include /etc/nginx/conf.d/*.conf; include /etc/nginx/sites-enabled/*; }')
        (self.root/'lib/nginx.conf.example').write_bytes((Path(__file__).parents[2]/'deploy/dual/nginx.conf.example').read_bytes())
        self.value = {'format':'first-prod-v1', 'version':fp.VERSION, 'artifactSha256':fp.SHA,
                      'lockSha256':fp.LOCK, 'approvals':{k:'approved-'+k for k in fp.ACTIONS},
                      'backupReceipt':str(ops.ETC/'prod-review/backup.json'), 'backupReceiptSha256':'b'*64,
                      'publicationReceipt':str(ops.ETC/'prod-review/publication.json'), 'publicationReceiptSha256':'c'*64,
                      'rollbackDataWindowApproval':''}
        self.value['approvals'].update({'points-activation':'approved-points','synthetic-smoke':'approved-smoke'})
        fp.save_state({'version':fp.VERSION,'planSha256':PLAN_SHA},'INTERNAL_READY',
                      internalAcceptance={'version':fp.VERSION, 'result':'PASS'})
        self.calls=[]

    def commands(self, *args, **kwargs):
        self.calls.append(args)
        return subprocess.CompletedProcess(args,0,stdout=b'')

    def guards(self):
        stack=contextlib.ExitStack()
        for name in ['artifact','evidence','probe','probe_old']:
            stack.enter_context(patch.object(fp,name))
        stack.enter_context(patch.object(fp,'protected',return_value={'internal':'unchanged'}))
        stack.enter_context(patch.object(ops,'check_target'))
        stack.enter_context(patch.object(ops,'run',side_effect=self.commands))
        return stack

    def test_plan_pins_version_port_and_receipt_location(self):
        fp.validate_plan(self.value,CFG)
        for key,bad in [('version','b'*40+'-'+'b'*64),('artifactSha256','0'*64),
                        ('lockSha256','0'*64),('backupReceipt',str(self.root/'unreviewed.json'))]:
            with self.subTest(key=key),self.assertRaises(RuntimeError):
                fp.validate_plan({**self.value,key:bad},CFG)
        with self.assertRaisesRegex(RuntimeError,'layout'):
            fp.validate_plan(self.value,{**CFG,'prod':{**CFG['prod'],'port':3000}})

    def test_internal_template_never_listens_publicly(self):
        text=fp.render(True)
        self.assertIn('listen 127.0.0.1:9443 ssl;',text)
        self.assertNotIn('listen 443',text)
        self.assertNotIn('listen [::]',text)
        self.assertIn('127.0.0.1:3101',text)
        self.assertNotIn('f1guess_active',text)
        self.assertNotIn('/stg/',text)

    def test_template_drift_is_rejected_before_writing_nginx(self):
        (ops.LIB/'nginx.conf.example').write_text('unreviewed proxy_pass')
        with self.assertRaisesRegex(RuntimeError,'template changed'):fp.write_candidate(True)
        self.assertFalse(fp.edge_path(True).exists())

    def test_cutover_success_is_one_pointer_no_old_service_changes(self):
        with self.guards(): result=fp.execute(CFG,self.value,PLAN_SHA,'cutover')
        self.assertEqual(result['phase'],'PUBLIC_VERIFIED')
        self.assertEqual(fp.link_value(),str(fp.edge_path(False)))
        self.assertFalse((fp.home()/'edge-pending.json').exists())
        self.assertEqual(Path(fp.OLD).read_text(),'old public server')
        self.assertFalse(any('stop' in c or 'disable' in c or 'restart' in c for c in self.calls))
        test=next(i for i,c in enumerate(self.calls) if c[:2]==('nginx','-t'))
        reload=next(i for i,c in enumerate(self.calls) if c[:3]==('systemctl','reload','nginx'))
        self.assertLess(test,reload)

    def test_preflight_failure_never_switches_or_reloads(self):
        with self.guards(),patch.object(fp,'preflight',side_effect=RuntimeError('invalid nginx')):
            with self.assertRaisesRegex(RuntimeError,'invalid nginx'):fp.execute(CFG,self.value,PLAN_SHA,'cutover')
        self.assertEqual(fp.link_value(),fp.OLD)
        self.assertFalse(any('reload' in c for c in self.calls))

    def test_nginx_success_exit_with_conflicting_hostname_warning_is_rejected(self):
        with patch.object(ops,'run',return_value=subprocess.CompletedProcess([],0,stdout=b'',stderr=b'conflicting server name')):
            with self.assertRaisesRegex(RuntimeError,'conflicting'):fp.nginx_test()

    def test_reload_failure_keeps_pending_no_automatic_old_db_return(self):
        with self.guards(),patch.object(ops,'run',side_effect=lambda *a,**k:
            (_ for _ in ()).throw(RuntimeError('reload failed')) if 'reload' in a else self.commands(*a,**k)):
            with self.assertRaisesRegex(RuntimeError,'interrupted'):fp.execute(CFG,self.value,PLAN_SHA,'cutover')
        self.assertEqual(fp.link_value(),str(fp.edge_path(False)))
        self.assertEqual(fp.state()['phase'],'PUBLIC_UNVERIFIED')
        self.assertTrue((fp.home()/'edge-pending.json').exists())
        with self.guards():
            with self.assertRaisesRegex(RuntimeError,'explicitly recover'):fp.execute(CFG,self.value,PLAN_SHA,'cutover')
            result=fp.execute(CFG,self.value,PLAN_SHA,'recover-edge')
        self.assertEqual(result['phase'],'PUBLIC_VERIFIED')

    def test_crash_after_journal_before_link_recovers_forward(self):
        real=ops.link
        with self.guards(),patch.object(ops,'link',side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):fp.execute(CFG,self.value,PLAN_SHA,'cutover')
        self.assertEqual(fp.link_value(),fp.OLD)
        self.assertTrue((fp.home()/'edge-pending.json').exists())
        with self.guards(),patch.object(ops,'link',side_effect=real):
            result=fp.execute(CFG,self.value,PLAN_SHA,'recover-edge')
        self.assertEqual(result['phase'],'PUBLIC_VERIFIED')

    def test_post_reload_business_failure_never_auto_rolls_back(self):
        def probe(c,internal,synthetic):
            if not internal:raise RuntimeError('business error')
        with self.guards(),patch.object(fp,'probe',side_effect=probe):
            with self.assertRaisesRegex(RuntimeError,'interrupted'):fp.execute(CFG,self.value,PLAN_SHA,'cutover')
        self.assertEqual(fp.link_value(),str(fp.edge_path(False)))
        self.assertTrue(fp.state()['exposurePossible'])

    def test_public_repeat_is_read_only_probe_and_no_reload(self):
        with self.guards():fp.execute(CFG,self.value,PLAN_SHA,'cutover')
        self.calls.clear()
        with self.guards() as g: result=fp.execute(CFG,self.value,PLAN_SHA,'cutover')
        self.assertEqual(result['phase'],'PUBLIC_VERIFIED')
        self.assertFalse(self.calls)

    def test_rollback_requires_explicit_data_visibility_approval(self):
        with self.guards():fp.execute(CFG,self.value,PLAN_SHA,'cutover')
        with self.guards(),self.assertRaisesRegex(RuntimeError,'data-window'):
            fp.execute(CFG,self.value,PLAN_SHA,'rollback-edge')
        self.value['rollbackDataWindowApproval']='approved-maintenance-new-data-invisible'
        with self.guards():result=fp.execute(CFG,self.value,PLAN_SHA,'rollback-edge')
        self.assertEqual(result['phase'],'ROLLED_BACK')
        self.assertEqual(fp.link_value(),fp.OLD)
        self.assertTrue(result['exposurePossible'])
        self.assertTrue(fp.edge_path(False).exists())
        self.calls.clear()
        with self.guards():fp.execute(CFG,self.value,PLAN_SHA,'rollback-edge')
        self.assertFalse(self.calls)

    def test_no_internal_acceptance_or_wrong_plan_or_protected_drift(self):
        with self.guards():
            with self.assertRaisesRegex(RuntimeError,'same reviewed plan'):fp.execute(CFG,self.value,'d'*64,'cutover')
            fp.save_state(fp.state(),'PREPARED')
            with self.assertRaisesRegex(RuntimeError,'Internal acceptance'):fp.execute(CFG,self.value,PLAN_SHA,'cutover')

    def test_synthetic_permission_mismatch_fails_before_effects(self):
        with self.guards(),self.assertRaisesRegex(RuntimeError,'Synthetic approval'):
            fp.execute({**CFG,'prod':{**CFG['prod'],'syntheticSessionApproval':''}},self.value,PLAN_SHA,'cutover')
        self.assertFalse(self.calls)

    def test_init_guard_checks_separate_points_seed_and_synthetic_approval(self):
        fp.save_state(fp.state(),'PREPARED')
        with patch.object(fp,'plan',return_value=self.value),patch.object(fp,'artifact'),patch.object(fp,'evidence'):
            fp.initialize_guard(CFG,fp.VERSION,fp.SEED,'approved-points')
            for version,seed,points in [(fp.VERSION,'0'*64,'approved-points'),(fp.VERSION,fp.SEED,'unapproved')]:
                with self.assertRaises(RuntimeError):fp.initialize_guard(CFG,version,seed,points)

    def test_prepare_repeat_does_not_touch_resources(self):
        fp.save_state(fp.state(),'PREPARED')
        with patch.object(fp,'prepare_prod') as prepare:
            fp.execute(CFG,self.value,PLAN_SHA,'prepare-prod')
            prepare.assert_not_called()

    def test_prepare_dispatch_never_calls_stg_or_shared_install(self):
        (fp.home()/'first-prod.json').unlink()
        with patch.object(fp,'artifact'),patch.object(fp,'prepare_prod') as prepare,patch.object(bootstrap,'install_dirs') as shared:
            fp.execute(CFG,self.value,PLAN_SHA,'prepare-prod')
        prepare.assert_called_once_with(CFG); shared.assert_not_called()

    def test_existing_prod_edge_entry_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError,'first-prod'):bootstrap.enable_edge(CFG,'prod')

    def test_cli_uses_same_lock_and_approval_before_action(self):
        events=[]
        @contextlib.contextmanager
        def locked():
            events.append('lock');yield;events.append('unlock')
        with patch.object(ops.os,'geteuid',return_value=0,create=True),patch.object(ops,'config',return_value=CFG),\
             patch.object(ops,'locked',side_effect=locked),patch.object(fp,'plan',side_effect=lambda *a:events.append('approval') or self.value),\
             patch.object(fp,'execute',side_effect=lambda *a:events.append('execute') or {}),contextlib.redirect_stdout(io.StringIO()):
            fp.main(['prepare-prod',PLAN_SHA])
        self.assertEqual(events,['lock','approval','execute','unlock'])

    def test_release_prod_blocked_during_first_lifecycle_stg_unaffected(self):
        with patch.object(ops.os,'geteuid',return_value=0,create=True),patch.object(ops,'config',return_value=CFG),\
             patch.object(ops,'locked',return_value=contextlib.nullcontext()),patch.object(ops,'check_target') as target:
            with self.assertRaisesRegex(RuntimeError,'not publicly verified'):ops.main(['prod',fp.VERSION])
            target.assert_not_called()

    def proof_files(self):
        base=ops.ROOT/'backups/legacy-prod01/20261123-test'
        for name in ['database.dump','configuration.tar']:(base/name).write_bytes(b'archive-test-only')
        b={'format':'prod01-backup-proof-v1','status':'PASS','sourceDatabase':'f1guess_prod',
           'databaseRestoredSeparately':True,'configBackupVerified':True,'rolesAndIdentityKeysVerified':True,
           'snapshotFingerprintsMatch':True,'isolatedSocketOnly':True,'verifiedAt':fp.now(),
           'database':{'path':str(base/'database.dump'),'sha256':ops.digest(base/'database.dump')},
           'configuration':{'path':str(base/'configuration.tar'),'sha256':ops.digest(base/'configuration.tar')}}
        pub={'format':'prod01-publication-proof-v1','version':fp.VERSION,'artifactSha256':fp.SHA,
             'lockSha256':fp.LOCK,'result':'PASS','fullGatePassed':True,'publicScopeApproval':'approved-public-scope'}
        ops.save(Path(self.value['backupReceipt']),b)
        ops.save(Path(self.value['publicationReceipt']),pub)
        for field in ['backupReceipt','publicationReceipt']:self.value[field+'Sha256']=ops.digest(Path(self.value[field]))
        return b,pub

    def test_backup_proof_hash_permissions_and_publication_gate(self):
        b,pub=self.proof_files()
        with patch.object(fp,'private_file',return_value=True):fp.evidence(self.value)
        with patch.object(fp,'private_file',return_value=False),self.assertRaisesRegex(RuntimeError,'private'):
            fp.evidence(self.value)
        Path(b['database']['path']).write_bytes(b'corrupted')
        with patch.object(fp,'private_file',return_value=True),self.assertRaisesRegex(RuntimeError,'archive'):
            fp.evidence(self.value)

    def test_stale_restore_or_fake_publication_is_blocked(self):
        b,pub=self.proof_files()
        b['verifiedAt']=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=2)).isoformat()
        ops.save(Path(self.value['backupReceipt']),b)
        self.value['backupReceiptSha256']=ops.digest(Path(self.value['backupReceipt']))
        with patch.object(fp,'private_file',return_value=True),self.assertRaisesRegex(RuntimeError,'24 hours'):
            fp.evidence(self.value)
        self.proof_files()
        pub['fullGatePassed']=False
        ops.save(Path(self.value['publicationReceipt']),pub)
        self.value['publicationReceiptSha256']=ops.digest(Path(self.value['publicationReceipt']))
        with patch.object(fp,'private_file',return_value=True),self.assertRaisesRegex(RuntimeError,'publication'):
            fp.evidence(self.value)

    def test_action_authorization_can_be_granted_in_stages_without_changing_plan(self):
        path=ops.ETC/'prod-review/first-prod.json'
        ops.save(path,self.value)
        expected=ops.digest(path)
        auth={'format':'first-prod-authorization-v1','planSha256':expected,
              'grants':{'prepare-prod':self.value['approvals']['prepare-prod']},'rollbackDataWindowApproval':''}
        authpath=ops.ETC/'prod-review/authorization.json'
        ops.save(authpath,auth)
        with patch.object(fp,'private_file',return_value=True):
            fp.plan(CFG,expected,'prepare-prod')
            with self.assertRaisesRegex(RuntimeError,'Separate approval'):fp.plan(CFG,expected,'cutover')
            auth['grants']['cutover']=self.value['approvals']['cutover'];ops.save(authpath,auth)
            fp.plan(CFG,expected,'cutover')
        self.assertEqual(ops.digest(path),expected)

    def test_lock_contention_has_no_side_effects(self):
        with patch.object(ops.os,'geteuid',return_value=0,create=True),patch.object(ops,'config',return_value=CFG),\
             patch.object(ops,'locked',side_effect=RuntimeError('Another deployment holds lock')),patch.object(fp,'execute') as execute:
            with self.assertRaisesRegex(RuntimeError,'holds lock'):fp.main(['cutover',PLAN_SHA])
            execute.assert_not_called()

    def test_interrupted_recovery_rejects_candidate_or_internal_dependency_drift(self):
        with self.guards(),patch.object(ops,'link',side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):fp.execute(CFG,self.value,PLAN_SHA,'cutover')
        with self.guards(),patch.object(fp,'protected',return_value={'internal':'changed'}),self.assertRaisesRegex(RuntimeError,'dependencies changed'):
            fp.execute(CFG,self.value,PLAN_SHA,'recover-edge')
        fp.edge_path(False).write_text('tampered')
        with self.guards(),self.assertRaisesRegex(RuntimeError,'interrupted'):
            fp.execute(CFG,self.value,PLAN_SHA,'recover-edge')

    def test_prepare_creates_only_prod_and_never_touches_stg_or_database(self):
        # The directory created by the fixture is the only shared-existing check.
        # chmod is reliable on Unix; Windows's mode reporting differs, so use a new target.
        (fp.home()/'first-prod.json').unlink();fp.home().rmdir()
        unit=self.root/'unit.service';unit.write_text('existing-shared-unit')
        (ops.LIB/unit.name).write_bytes(unit.read_bytes())
        stg=self.root/'state/stg';stg.mkdir();(stg/'marker').write_text('unchanged')
        pwd=types.SimpleNamespace(getpwnam=lambda name:(_ for _ in ()).throw(KeyError(name)))
        with patch.object(fp,'UNIT',unit),patch.dict('sys.modules',{'pwd':pwd}),patch.object(fp.socket,'socket'),\
             patch.object(ops,'run',side_effect=self.commands),patch.object(ops,'sql') as sql:
            fp.prepare_prod(CFG)
        self.assertTrue(fp.home().is_dir());self.assertTrue((ops.ROOT/'backups/prod').is_dir())
        self.assertEqual((stg/'marker').read_text(),'unchanged');sql.assert_not_called()
        self.assertEqual(len(self.calls),1)
        self.assertEqual(self.calls[0][-1],'f1dg3_prod')
        self.assertEqual(self.calls[0][0],'/usr/sbin/useradd')

    @unittest.skipIf(os.name == 'nt', 'Requires real POSIX umask and permission bits')
    def test_prepare_under_private_umask_keeps_only_runtime_state_public(self):
        previous = os.umask(0o077)
        try:
            self.test_prepare_creates_only_prod_and_never_touches_stg_or_database()
        finally:
            os.umask(previous)
        self.assertEqual(fp.home().stat().st_mode & 0o777, 0o755)
        self.assertEqual((ops.ROOT/'backups/prod').stat().st_mode & 0o777, 0o700)

    def test_startup_wait_failure_keeps_existing_activation_cleanup(self):
        with patch.object(ops,'service') as service,patch.object(ops,'recover') as recover,\
             patch.object(fp,'wait_ready',side_effect=RuntimeError('Startup readiness timed out')):
            with self.assertRaisesRegex(RuntimeError,'timed out'):
                ops.activate(CFG,'prod',fp.VERSION,{},'backup','first-prod-internal',
                             smoke_fn=lambda c,e,r:fp.probe(c,True,True))
        service.assert_called_once_with('prod','restart')
        recover.assert_called_once()

    def test_https_failure_keeps_existing_activation_cleanup(self):
        with patch.object(ops,'service') as service,patch.object(ops,'recover') as recover,\
             patch.object(fp,'wait_ready',return_value=None),\
             patch.object(fp,'https_probe',side_effect=RuntimeError('HTTPS version mismatch')):
            with self.assertRaisesRegex(RuntimeError,'version mismatch'):
                ops.activate(CFG,'prod',fp.VERSION,{},'backup','first-prod-internal',
                             smoke_fn=lambda c,e,r:fp.probe(c,True,True))
        service.assert_called_once_with('prod','restart')
        recover.assert_called_once()

    def test_legacy_receipt_cannot_replace_exact_stg_acceptance(self):
        path=ops.ROOT/'accepted';path.mkdir()
        ops.save(path/(fp.VERSION+'.json'),{'environment':'stg','result':'PASS','version':fp.VERSION,'sha256':'0'*64})
        with patch.object(ops,'verify',return_value=(self.root,{'commit':fp.COMMIT,'sha256':fp.SHA,'lockSha256':fp.LOCK})),\
             patch.object(ops,'publication_ready') as public:
            with self.assertRaisesRegex(RuntimeError,'STG acceptance'):fp.artifact()
            public.assert_not_called()

    def test_internal_activation_reuses_artifact_and_prod_backup_without_build_or_migration(self):
        fp.edge_path(True).write_text(fp.render(True))
        receipt={'version':fp.VERSION,'sha256':fp.SHA,'result':'PASS','environment':'prod'}
        with self.guards(),patch.object(ops,'recover') as recover,patch.object(ops,'active',side_effect=[{},receipt]),\
             patch.object(ops,'compatible') as compatible,patch.object(ops,'backup',return_value='verified-backup') as backup,\
             patch.object(ops,'activate') as activate,patch.object(ops,'build') as build:
            result=fp.activate_internal(CFG)
        self.assertEqual(result,receipt)
        backup.assert_called_once_with(CFG,'prod');build.assert_not_called()
        self.assertNotIn('apply',compatible.call_args.kwargs)
        self.assertEqual(activate.call_args.args[1:3],('prod',fp.VERSION))
        self.assertIn('smoke_fn',activate.call_args.kwargs)
        self.assertIn('smoke_fn',recover.call_args.kwargs)

    def test_probe_uses_verified_loopback_https_and_no_cookie_on_read_only_repeat(self):
        calls=[]
        def command(*args,**kwargs):
            calls.append(args)
            if args[0]=='systemctl':return subprocess.CompletedProcess(args,0,stdout='123')
            url=args[-1]
            body=fp.VERSION.encode() if url.endswith('/.f1-deploy-version') else b'<script src="/assets/test.js"></script>' if url.endswith('/') else b'{}'
            return subprocess.CompletedProcess(args,0,stdout=body+b'\n200')
        with patch.object(fp,'wait_ready',return_value=None),patch.object(ops,'run',side_effect=command),patch.object(os.path,'samefile',return_value=True):
            fp.probe(CFG,True,False)
        curl=[c for c in calls if c[0]=='curl']
        self.assertTrue(curl)
        self.assertTrue(all('--connect-to' in c and 'f1driverguess.online:443:127.0.0.1:9443' in c for c in curl))
        self.assertFalse(any('--insecure' in c or '-k' in c or '--cookie' in c or '/session' in c[-1] for c in curl))

    def test_internal_restart_failure_uses_internal_probe_for_pointer_recovery(self):
        # Exercise the shared activate implementation, not an implementation mirror.
        with patch.object(ops,'service',side_effect=RuntimeError('restart failed')),patch.object(ops,'recover') as recover:
            cb=lambda *a:None
            with self.assertRaisesRegex(RuntimeError,'restart failed'):
                ops.activate(CFG,'prod',fp.VERSION,{},'backup','first-prod-internal',smoke_fn=cb)
        self.assertIs(recover.call_args.kwargs['smoke_fn'],cb)

    def test_stg_release_still_works_while_prod_is_internal(self):
        with patch.object(ops.os,'geteuid',return_value=0,create=True),patch.object(ops,'config',return_value=CFG),\
             patch.object(ops,'locked',return_value=contextlib.nullcontext()),patch.object(ops,'check_target') as target,\
             patch.object(ops,'recover'),patch.object(ops,'build',return_value=fp.VERSION) as build,\
             patch.object(ops,'verify',return_value=(self.root,{})),patch.object(ops,'compatible'),patch.object(ops,'activate') as activate:
            ops.main(['stg',fp.COMMIT,fp.LOCK,'0'*64])
        target.assert_called_once_with(CFG,'stg');build.assert_called_once()
        self.assertEqual(activate.call_args.args[1],'stg')

    def test_installer_is_narrow_idempotent_and_refuses_drift(self):
        source=self.root/'tools';source.mkdir()
        sbin=self.root/'sbin';sbin.mkdir()
        before={}
        for name in installer.FILES:
            (source/name).write_bytes(b'# new '+name.encode()+b'\r\n')
            if name in installer.BEFORE:
                p=ops.LIB/name;p.write_bytes(b'# old '+name.encode())
                before[name]=ops.digest(p)
        with patch.object(installer,'SOURCE',source),patch.object(installer,'SBIN',sbin),\
             patch.object(installer,'BEFORE',before),patch.object(installer,'trusted',return_value=True):
            digest=installer.bundle_digest(installer.contents())
            with self.assertRaisesRegex(RuntimeError,'bundle SHA'):installer.install('0'*64)
            installer.install(digest);installer.install(digest)
            self.assertEqual((sbin/'f1-dual-first-prod').read_bytes(),installer.WRAPPER)
            self.assertEqual((ops.LIB/'release.py.prod01a-before').read_bytes(),b'# old release.py')
            self.assertEqual((ops.LIB/'first_prod.py.prod02d-before').read_bytes(),b'# old first_prod.py')
            (ops.LIB/'bootstrap.py').write_text('# changed outside installer')
            with self.assertRaisesRegex(RuntimeError,'Controller drift'):installer.install(digest)
        self.assertFalse((ops.ETC/'prod.env').exists())

    def test_installer_interruption_preserves_backups_and_can_finish_exact_bundle(self):
        source=self.root/'tools';source.mkdir();sbin=self.root/'sbin';sbin.mkdir();before={}
        for name in installer.FILES:
            (source/name).write_bytes(b'# new '+name.encode())
            if name in installer.BEFORE:
                path=ops.LIB/name;path.write_bytes(b'# old '+name.encode());before[name]=ops.digest(path)
        original=installer.atomic
        def interrupted(path,body,mode):
            original(path,body,mode)
            if path.name=='first_prod.py':raise KeyboardInterrupt('installer process death')
        with patch.object(installer,'SOURCE',source),patch.object(installer,'SBIN',sbin),\
             patch.object(installer,'BEFORE',before),patch.object(installer,'trusted',return_value=True):
            digest=installer.bundle_digest(installer.contents())
            marker=ops.state_dir('prod')/'plan-rebind-pending.json';marker.write_text('{}')
            with self.assertRaisesRegex(RuntimeError,'pending plan rebind'):installer.install(digest)
            self.assertEqual(ops.digest(ops.LIB/'first_prod.py'),before['first_prod.py']);marker.unlink()
            with patch.object(installer,'atomic',side_effect=interrupted),self.assertRaises(KeyboardInterrupt):installer.install(digest)
            saved=(ops.LIB/'first_prod.py.prod02d-before').read_bytes()
            # Process died after writing a later module's complete temporary file.
            (ops.LIB/'first_prod_rebind.py.next').write_bytes(installer.contents()['first_prod_rebind.py'])
            installer.install(digest)
            self.assertEqual((ops.LIB/'first_prod.py.prod02d-before').read_bytes(),saved)
            for name,body in installer.contents().items():self.assertEqual((ops.LIB/name).read_bytes(),body)
            extra=ops.LIB/'partial.py';extra.with_name('partial.py.next').write_bytes(b'incomplete')
            with self.assertRaisesRegex(RuntimeError,'temporary file differs'):installer.atomic(extra,b'complete',0o644)
            self.assertFalse(extra.exists())


if __name__=='__main__':unittest.main()
