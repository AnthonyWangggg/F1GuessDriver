"""Real metadata files and crash points; no database, SSH or service operations."""
import contextlib
import datetime
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
import unittest
from unittest.mock import patch

import first_prod as fp
import first_prod_rebind as rb
import install_first_prod as installer
import release as ops

CFG={'pgPort':5432,'stg':{'port':3100},'prod':{'port':3101,'domain':'f1driverguess.online','syntheticSessionApproval':'approved-smoke'}}


class RebindTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
        for name in ('state/prod','etc/prod-review','lib','backups/legacy-prod01','versions'):(self.root/name).mkdir(parents=True)
        for target,name,value in [(ops,'ROOT',self.root),(ops,'ETC',self.root/'etc'),(ops,'LIB',self.root/'lib'),
                                  (ops,'config',lambda:CFG),(fp,'private_file',lambda p:True),
                                  (fp,'link_value',lambda:fp.OLD),(rb,'identity_digest',lambda cfg:'d'*64),
                                  (fp,'artifact',lambda:self.root/'versions')]:
            p=patch.object(target,name,side_effect=value) if callable(value) else patch.object(target,name,value)
            p.start();self.addCleanup(p.stop)
        for name in rb.MODULES:(ops.LIB/name).write_bytes(('# fixture '+name).encode())
        self.bundle=rb.controller_bundle()
        self.oldgrants={'prepare-prod':'approved-prepare','init-prod':'approved-init','internal-edge':'approved-edge',
                        'activate-internal':'approved-activate','points-activation':'approved-points','synthetic-smoke':'approved-smoke'}
        self.oldplan=self.make_plan('old',expired=True)
        self.oldplan['approvals']=dict(self.oldgrants)
        self.write(rb.canonical()['plan'],self.oldplan)
        self.oldsha=ops.digest(rb.canonical()['plan'])
        self.oldauth={'format':'first-prod-authorization-v1','planSha256':self.oldsha,'grants':self.oldgrants,'rollbackDataWindowApproval':''}
        self.write(rb.canonical()['authorization'],self.oldauth)
        self.oldstate={'phase':'INTERNAL_EDGE','initialized':True,'version':fp.VERSION,'planSha256':self.oldsha,'updatedAt':'fixture-preserved'}
        self.write(rb.canonical()['state'],self.oldstate)
        self.newplan=self.make_plan('new')
        self.newplan['approvals']={**self.oldgrants,'cutover':'separate-cutover','recover-edge':'separate-recover',
                                   'rollback-edge':'separate-rollback','recover-internal':'separate-internal-recovery'}
        self.newauth={'format':'first-prod-authorization-v1','planSha256':'','grants':dict(self.oldgrants),'rollbackDataWindowApproval':''}
        self.req={'format':'first-prod-rebind-v1','oldPlanSha256':self.oldsha,
                  'oldAuthorizationSha256':ops.digest(rb.canonical()['authorization']),'oldStateSha256':ops.digest(rb.canonical()['state']),
                  'newPlanFile':str(ops.ETC/'prod-review/next-plan.json'),'newPlanSha256':'',
                  'newAuthorizationFile':str(ops.ETC/'prod-review/next-authorization.json'),'newAuthorizationSha256':'',
                  'controllerBundleSha256':self.bundle,'identitySha256':'d'*64,'approvedGrants':dict(self.oldgrants),
                  'operations':['rebind-plan','recover-rebind','abort-rebind'],'approvalReference':'fixture-owner-approved',
                  'candidateSha256':'b'*64,'candidateFiles':765,'publicScopeApproval':'fixture-public-scope'}
        self.seal()

    def write(self,path,value):rb.replace_private(path,rb.encode(value))

    def make_plan(self,label,expired=False):
        folder=ops.ROOT/'backups/legacy-prod01'/('fixture-'+label+'-20261124');folder.mkdir()
        for name in ('database.dump','configuration.tar'):(folder/name).write_bytes(b'isolated-fixture-only')
        proof={'format':'prod01-backup-proof-v1','status':'PASS','sourceDatabase':'f1guess_prod',
               'databaseRestoredSeparately':True,'configBackupVerified':True,'rolesAndIdentityKeysVerified':True,
               'snapshotFingerprintsMatch':True,'isolatedSocketOnly':True,
               'verifiedAt':(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=2 if expired else 0)).isoformat(),
               'database':{'path':str(folder/'database.dump'),'sha256':ops.digest(folder/'database.dump')},
               'configuration':{'path':str(folder/'configuration.tar'),'sha256':ops.digest(folder/'configuration.tar')}}
        pub={'format':'prod01-publication-proof-v1','version':fp.VERSION,'artifactSha256':fp.SHA,'lockSha256':fp.LOCK,
             'result':'PASS','fullGatePassed':True,'publicScopeApproval':'fixture-public-scope','candidateSha256':'b'*64,
             'candidateFiles':765,'controllerBundleSha256':self.bundle,'gitCommit':fp.COMMIT}
        bp=ops.ETC/'prod-review'/(label+'-backup.json');pp=ops.ETC/'prod-review'/(label+'-publication.json')
        self.write(bp,proof);self.write(pp,pub)
        return {'format':'first-prod-v1','version':fp.VERSION,'artifactSha256':fp.SHA,'lockSha256':fp.LOCK,
                'approvals':{},'backupReceipt':str(bp),'backupReceiptSha256':ops.digest(bp),
                'publicationReceipt':str(pp),'publicationReceiptSha256':ops.digest(pp),'rollbackDataWindowApproval':''}

    def seal(self):
        self.write(Path(self.req['newPlanFile']),self.newplan);self.req['newPlanSha256']=ops.digest(Path(self.req['newPlanFile']))
        self.newauth['planSha256']=self.req['newPlanSha256'];self.write(Path(self.req['newAuthorizationFile']),self.newauth)
        self.req['newAuthorizationSha256']=ops.digest(Path(self.req['newAuthorizationFile']))
        self.write(ops.ETC/'prod-review/rebind-request.json',self.req);self.expected=ops.digest(ops.ETC/'prod-review/rebind-request.json')

    def call(self,action='rebind-plan'):return rb.rebind(CFG,self.expected,action)

    def snapshot(self):return {k:p.read_bytes() for k,p in rb.canonical().items()}

    def assert_no_mutation(self,pattern):
        before=self.snapshot()
        with self.assertRaisesRegex(RuntimeError,pattern):self.call()
        self.assertEqual(before,self.snapshot());self.assertFalse(rb.pending().exists())

    def test_expired_old_proof_can_be_replaced_by_valid_new_pair_and_repeated_read_only(self):
        original=self.snapshot();result=self.call()
        self.assertEqual(result['result'],'COMMITTED');self.assertEqual(fp.state()['phase'],'INTERNAL_EDGE')
        self.assertEqual(fp.state()['planSha256'],self.req['newPlanSha256'])
        self.assertEqual(fp.state()['updatedAt'],'fixture-preserved')
        self.assertEqual(fp.state()['resourceIdentitySha256'],'d'*64)
        folder=rb.transaction_root()/self.expected
        for key,body in original.items():self.assertEqual((folder/('old-'+key+'.json')).read_bytes(),body)
        self.assertFalse(rb.pending().exists())
        with patch.object(rb,'replace_private') as replace:self.assertEqual(self.call(),result)
        replace.assert_not_called()
        self.assertIn('cutover',self.newplan['approvals'])
        self.assertNotIn('cutover',json.loads(rb.canonical()['authorization'].read_text())['grants'])

    def test_new_expired_proof_is_rejected_without_canonical_writes(self):
        p=Path(self.newplan['backupReceipt']);value=ops.load(p)
        value['verifiedAt']=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=2)).isoformat()
        self.write(p,value);self.newplan['backupReceiptSha256']=ops.digest(p);self.seal();self.assert_no_mutation('24 hours')

    def test_failed_restore_or_fake_publication_not_accepted(self):
        for key,value in [('status','FAIL'),('databaseRestoredSeparately',False)]:
            p=Path(self.newplan['backupReceipt']);proof=ops.load(p);original=dict(proof);proof[key]=value;self.write(p,proof)
            self.newplan['backupReceiptSha256']=ops.digest(p);self.seal();self.assert_no_mutation('restore proof')
            self.write(p,original)

    def test_grant_expansion_including_cutover_is_rejected(self):
        self.newauth['grants']['cutover']='separate-cutover';self.req['approvedGrants']=dict(self.newauth['grants']);self.seal()
        self.assert_no_mutation('expand effective grants')

    def test_scope_change_and_receipt_drift_are_rejected(self):
        self.newauth['grants']['synthetic-smoke']='expanded-synthetic-scope'
        self.newplan['approvals']['synthetic-smoke']='expanded-synthetic-scope'
        self.req['approvedGrants']=dict(self.newauth['grants']);self.seal()
        self.assert_no_mutation('points/synthetic scope')
        self.newauth['grants']['synthetic-smoke']='approved-smoke'
        self.newplan['approvals']['synthetic-smoke']='approved-smoke'
        self.req['approvedGrants']=dict(self.newauth['grants']);self.seal()
        Path(self.newplan['publicationReceipt']).write_text('{}')
        self.assert_no_mutation('evidence changed')

    def test_version_database_controller_and_lifecycle_drift_rejected(self):
        self.newplan['version']='other';self.seal();self.assert_no_mutation('audited STG')
        self.newplan['version']=fp.VERSION;self.seal()
        with patch.object(rb,'identity_digest',return_value='e'*64):self.assert_no_mutation('identity mismatch')
        with patch.object(rb,'controller_bundle',return_value='e'*64):self.assert_no_mutation('identity mismatch')
        self.write(rb.canonical()['state'],{**self.oldstate,'phase':'INTERNAL_READY'})
        self.req['oldStateSha256']=ops.digest(rb.canonical()['state']);self.seal();self.assert_no_mutation('INTERNAL_EDGE')

    def test_unknown_pending_protected_public_route_and_unapproved_scope_rejected(self):
        (fp.home()/'pending.json').write_text('{}');self.assert_no_mutation('transaction pending');(fp.home()/'pending.json').unlink()
        with patch.object(fp,'link_value',return_value='new-public'):self.assert_no_mutation('Public route')
        self.req['candidateSha256']='c'*64;self.seal();self.assert_no_mutation('scope mismatch')

    def interrupt(self,target,action='rebind-plan'):
        original=rb.replace_private
        def replace(path,body,**kwargs):
            original(path,body,**kwargs)
            if path==target:raise KeyboardInterrupt('simulated process death after durable write')
        with patch.object(rb,'replace_private',side_effect=replace),self.assertRaises(KeyboardInterrupt):self.call(action)

    def test_partial_commit_blocks_actions_and_explicit_recovery_finishes_same_tuple(self):
        self.interrupt(rb.canonical()['authorization'])
        self.assertTrue(rb.pending().exists());self.assertEqual(fp.state()['planSha256'],self.oldsha)
        with self.assertRaisesRegex(RuntimeError,'pending plan rebind'):fp.plan(CFG,self.req['newPlanSha256'],'activate-internal')
        with self.assertRaisesRegex(RuntimeError,'explicitly recover'):self.call()
        self.assertEqual(self.call('recover-rebind')['result'],'COMMITTED')
        self.assertEqual(fp.state()['planSha256'],self.req['newPlanSha256']);self.assertFalse(rb.pending().exists())

    def test_partial_snapshot_before_pending_is_safe_to_resume(self):
        folder=rb.transaction_root()/self.expected
        self.interrupt(folder/'old-publication.json')
        self.assertFalse(rb.pending().exists());self.assertEqual(fp.state()['planSha256'],self.oldsha)
        self.assertEqual(self.call()['result'],'COMMITTED')

    def test_interrupted_abort_recovers_old_metadata_without_database_restore(self):
        original=self.snapshot();self.interrupt(rb.canonical()['authorization'])
        self.interrupt(rb.canonical()['plan'],'abort-rebind')
        self.assertEqual(self.call('recover-rebind')['result'],'ABORTED')
        self.assertEqual(original,self.snapshot());self.assertFalse(rb.pending().exists())
        with self.assertRaisesRegex(RuntimeError,'cannot be reused'):self.call()

    def test_expiry_during_interruption_blocks_forward_but_authorized_abort_remains_possible(self):
        self.interrupt(rb.canonical()['plan'])
        with patch.object(rb,'new_evidence',side_effect=RuntimeError('Backup proof must be no more than 24 hours old')):
            with self.assertRaisesRegex(RuntimeError,'24 hours'):self.call('recover-rebind')
            self.assertEqual(self.call('abort-rebind')['result'],'ABORTED')
        self.assertEqual(fp.state()['planSha256'],self.oldsha)

    def test_unexpected_partial_file_never_overwritten(self):
        self.interrupt(rb.canonical()['plan']);rb.canonical()['authorization'].write_text('unknown-manual-drift')
        with self.assertRaisesRegex(RuntimeError,'Canonical metadata drift'):self.call('recover-rebind')
        self.assertEqual(rb.canonical()['authorization'].read_text(),'unknown-manual-drift')

    def test_death_after_commit_before_pending_removal_only_cleans_known_marker(self):
        original=Path.unlink
        def unlink(path,*args,**kwargs):
            if path==rb.pending():raise KeyboardInterrupt('death before marker removal')
            return original(path,*args,**kwargs)
        with patch.object(Path,'unlink',unlink),self.assertRaises(KeyboardInterrupt):self.call()
        with patch.object(rb,'new_evidence',side_effect=RuntimeError('expired after commit')):
            self.assertEqual(self.call('recover-rebind')['result'],'COMMITTED')
        self.assertFalse(rb.pending().exists())

    def test_cli_uses_original_lock_before_rebind_and_lock_failure_has_no_effect(self):
        events=[]
        @contextlib.contextmanager
        def lock():events.append('lock');yield;events.append('unlock')
        with patch.object(ops.os,'geteuid',return_value=0,create=True),patch.object(ops,'locked',side_effect=lock),\
             patch.object(rb,'rebind',side_effect=lambda *args:events.append('rebind') or {}),contextlib.redirect_stdout(io.StringIO()):
            fp.main(['rebind-plan',self.expected])
        self.assertEqual(events,['lock','rebind','unlock'])
        before=self.snapshot()
        with patch.object(ops.os,'geteuid',return_value=0,create=True),\
             patch.object(ops,'locked',side_effect=RuntimeError('deployment locked')):
            with self.assertRaisesRegex(RuntimeError,'locked'):fp.main(['rebind-plan',self.expected])
        self.assertEqual(before,self.snapshot())

    def test_reopen_unpublished_ready_allows_fresh_rebind_without_restart_or_new_init(self):
        self.call();s=fp.state();s.update(phase='INTERNAL_READY',internalAcceptance={'version':fp.VERSION},internalVerifiedAt='fixture')
        self.write(rb.canonical()['state'],s)
        req={'format':'first-prod-reopen-v1','planSha256':s['planSha256'],'authorizationSha256':ops.digest(rb.canonical()['authorization']),
             'stateSha256':ops.digest(rb.canonical()['state']),'identitySha256':'d'*64,'approvalReference':'owner-reopen'}
        path=ops.ETC/'prod-review/reopen-request.json';self.write(path,req)
        rb.reopen(CFG,ops.digest(path));self.assertEqual(fp.state()['phase'],'INTERNAL_EDGE')
        self.assertNotIn('internalAcceptance',fp.state());self.assertEqual(fp.state()['planSha256'],s['planSha256'])
        self.assertEqual(rb.reopen(CFG,ops.digest(path))['result'],'INTERNAL_EDGE')

    def test_bundle_contract_matches_installer_modules(self):self.assertEqual(rb.MODULES,installer.FILES)

    def test_real_process_exit_after_authorization_write_recovers_durable_transaction(self):
        child=self.root/'crash.py'
        child.write_text('''import os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import first_prod as fp,first_prod_rebind as rb,release as ops
ops.ROOT=Path(sys.argv[2]);ops.ETC=ops.ROOT/'etc';ops.LIB=ops.ROOT/'lib'
cfg={"pgPort":5432,"stg":{"port":3100},"prod":{"port":3101,"domain":"f1driverguess.online","syntheticSessionApproval":"approved-smoke"}}
ops.config=lambda:cfg
fp.private_file=lambda p:True
fp.link_value=lambda:fp.OLD
fp.artifact=lambda:ops.ROOT/'versions'
rb.identity_digest=lambda cfg:'d'*64
original=rb.replace_private
def crash(path,body,**kw):
    original(path,body,**kw)
    if path==rb.canonical()['authorization']:os._exit(91)
rb.replace_private=crash
rb.rebind(cfg,sys.argv[3],'rebind-plan')
''')
        result=subprocess.run([sys.executable,'-B',str(child),str(Path(__file__).parent.resolve()),str(self.root),self.expected],capture_output=True,timeout=30)
        self.assertEqual(result.returncode,91,result.stderr.decode());self.assertTrue(rb.pending().exists())
        self.assertEqual(fp.state()['planSha256'],self.oldsha)
        self.assertEqual(self.call('recover-rebind')['result'],'COMMITTED')

    def test_complete_lifecycle_rebind_activation_business_cutover_failure_recovery_and_explicit_rollback(self):
        from test_first_prod_smoke import World
        self.call();expected=self.req['newPlanSha256'];world=World()
        nginx=self.root/'nginx'
        for name in ('conf.d','sites-enabled','sites-available'):(nginx/name).mkdir(parents=True)
        (nginx/'nginx.conf').write_text('include /etc/nginx/conf.d/*.conf;\ninclude /etc/nginx/sites-enabled/*;\n')
        (ops.LIB/'nginx.conf.example').write_bytes((Path(__file__).parents[2]/'deploy/dual/nginx.conf.example').read_bytes())
        pointers={};old=self.root/'old-public.conf';old.write_text('preserved old route')
        events=[];fail_reload=[False]
        def command(*args,**kwargs):
            events.append(args)
            if args==('systemctl','reload','nginx') and fail_reload[0]:
                fail_reload[0]=False;raise RuntimeError('injected reload failure')
            return subprocess.CompletedProcess(args,0,stdout=b'',stderr=b'')
        def link(path,target):pointers[str(path)]=str(target)
        def dispatch(action):return fp.execute(CFG,fp.plan(CFG,expected,action),expected,action)
        with contextlib.ExitStack() as stack:
            for target,name,value in [(fp,'NGINX',nginx),(fp,'OLD',str(old)),
                (fp,'link_value',lambda:pointers.get(str(fp.old_link()),str(old))),
                (fp,'protected',lambda:{'old-internal-tls-crl':'unchanged'}),(fp,'probe',lambda *args:None),
                (fp,'probe_old',lambda *args:None),(ops,'link',link),
                (ops,'pointer_target',lambda p:pointers.get(str(p))),
                (ops,'check_target',lambda *args:None),(ops,'compatible',lambda *args:None),
                (ops,'service',lambda *args:events.append(args)),(ops,'backup',lambda *args:'private-new-prod-backup'),
                (ops,'run',command)]:
                stack.enter_context(patch.object(target,name,side_effect=value) if callable(value) else patch.object(target,name,value))
            fp.edge_path(True).write_text(fp.render(True))
            dispatch('activate-internal');self.assertEqual(fp.state()['phase'],'INTERNAL_READY')
            self.assertEqual(events.count(('prod','restart')),1)
            with world.patches():self.assertEqual(dispatch('synthetic-smoke')['result'],'PASS')
            self.assertEqual(world.counts(CFG),{'identities':2,'quick':2,'daily':2,'bo3':1,'ledger':4})
            with self.assertRaisesRegex(RuntimeError,'Separate approval'):dispatch('cutover')
            auth=ops.load(rb.canonical()['authorization'])
            auth['grants'].update(cutover='separate-cutover',**{'recover-edge':'separate-recover','rollback-edge':'separate-rollback'})
            self.write(rb.canonical()['authorization'],auth)
            fail_reload[0]=True
            with self.assertRaisesRegex(RuntimeError,'interrupted at RELOAD'):dispatch('cutover')
            self.assertEqual(fp.state()['phase'],'PUBLIC_UNVERIFIED');self.assertTrue((fp.home()/'edge-pending.json').exists())
            self.assertEqual(fp.link_value(),str(fp.edge_path(False)))
            # The immutable plan's backup expires mid-transaction. A separately approved,
            # recovery-only fresh proof can finish forward without rebinding public state.
            real_datetime=datetime.datetime
            class Later(real_datetime):
                @classmethod
                def now(cls,tz=None):return real_datetime.now(tz)+datetime.timedelta(days=2)
            with patch.object(fp.datetime,'datetime',Later):
                with self.assertRaisesRegex(RuntimeError,'24 hours'):dispatch('recover-edge')
                fresh=self.make_plan('recovery')
                auth['edgeRecoveryBackup']={'path':fresh['backupReceipt'],'sha256':fresh['backupReceiptSha256'],'approvalReference':'separate-recover'}
                self.write(rb.canonical()['authorization'],auth)
                dispatch('recover-edge')
            self.assertEqual(fp.state()['phase'],'PUBLIC_VERIFIED');self.assertFalse((fp.home()/'edge-pending.json').exists())
            self.assertEqual(fp.state()['planSha256'],expected)
            with self.assertRaisesRegex(RuntimeError,'data-window'):dispatch('rollback-edge')
            auth.pop('edgeRecoveryBackup');auth['rollbackDataWindowApproval']='separate-known-data-window'
            self.write(rb.canonical()['authorization'],auth);dispatch('rollback-edge')
            self.assertEqual(fp.state()['phase'],'ROLLED_BACK');self.assertEqual(fp.link_value(),str(old))
            self.assertEqual(events.count(('prod','restart')),1)
            self.assertEqual(world.counts(CFG)['ledger'],4)
            self.assertFalse(any(args[:2]==('prod','stop') for args in events))

    def test_full_fresh_lifecycle_joins_same_initialized_continuation_without_reinitializing(self):
        import bootstrap
        rb.canonical()['state'].unlink()
        value={**self.oldplan,'approvals':self.oldgrants}
        with patch.object(fp,'prepare_prod') as prepare,patch.object(bootstrap,'initialize') as initialize,\
             patch.object(fp,'internal_edge') as internal,patch.object(ops,'check_target'):
            fp.execute(CFG,value,self.oldsha,'prepare-prod');self.assertEqual(fp.state()['phase'],'PREPARED')
            fp.execute(CFG,value,self.oldsha,'init-prod');self.assertIs(fp.state()['initialized'],True)
            fp.execute(CFG,value,self.oldsha,'internal-edge');self.assertEqual(fp.state()['phase'],'INTERNAL_EDGE')
            self.req['oldStateSha256']=ops.digest(rb.canonical()['state']);self.seal()
            self.test_complete_lifecycle_rebind_activation_business_cutover_failure_recovery_and_explicit_rollback()
        prepare.assert_called_once_with(CFG);internal.assert_called_once()
        initialize.assert_called_once_with(CFG,'prod',fp.VERSION,fp.SEED,'approved-points')


if __name__=='__main__':unittest.main()
