"""Stateful backend simulator for the exact two-identity production acceptance budget."""
import contextlib
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

import first_prod as fp
import first_prod_smoke as smoke
import release as ops

CFG={'pgPort':5432,'prod':{'port':3101,'domain':'f1driverguess.online','syntheticSessionApproval':'approved-smoke'}}


class World:
    def __init__(self):
        self.ids={'a':str(uuid.UUID(int=1)),'b':str(uuid.UUID(int=2))}
        self.people=set();self.quick={};self.daily={};self.series=None;self.ledger=[]
        self.balances={'a':0,'b':0};self.keys={};self.clock=0;self.positive=[];self.fail_after_quick=False

    def counts(self,cfg):
        return {'identities':len(self.people),'quick':len(self.quick),'daily':len(self.daily),'bo3':int(self.series is not None),'ledger':len(self.ledger)}

    def query(self,cfg,sql):
        if 'points_ledger' in sql:return self.ledger
        actor=next(a for a,p in self.ids.items() if p in sql)
        if "'used'" in sql:return {'used':int(actor in (self.quick if 'game_sessions' in sql else self.daily))}
        return {'answer':'synthetic-driver'}

    def client(self,cfg,actor):
        world=self
        class Client:
            def __init__(self):self.principal=world.ids[actor];self.csrf='synthetic-proof'
            def boot(self):world.people.add(actor);return self
            def send(self,method,path,body=None,origin=None,csrf=True,stale=False):
                if origin or not csrf:return 403,{'error':'blocked'}
                if stale:return 401,{'error':'stale'}
                if method=='POST':
                    key=(actor,body['idempotencyKey'])
                    if key in world.keys:return 200,json.loads(json.dumps(world.keys[key]))
                    result=world.mutate(actor,path,body);world.keys[key]=result
                    if world.fail_after_quick and path=='/api/v3/quick/games':
                        world.fail_after_quick=False
                        raise subprocess.TimeoutExpired('lost HTTP acknowledgement',10)
                    return 200,json.loads(json.dumps(result))
                if path.startswith('/api/v3/quick/games/'):
                    return 200,{'game':world.quick[actor]}
                if path.startswith('/api/v3/bo3/series/'):
                    if world.series['round']['status']=='revealed' and world.series['status']=='active' and world.clock>=world.until:
                        world.series['round']={'id':str(uuid.UUID(int=11)),'number':2,'status':'active'}
                    return 200,json.loads(json.dumps(world.series))
                if path=='/api/v3/me/profile':return 200,{'balance':world.balances[actor],'today':'2026-11-24'}
                if '/activity?' in path:return 200,{'year':2026,'days':[{'actualDelta':world.balances[actor]}],'total':world.balances[actor]}
                return 200,{}
        return Client()

    def mutate(self,actor,path,body):
        self.positive.append((actor,path,body['idempotencyKey']))
        if path=='/api/v3/quick/games':
            if actor in self.quick:raise AssertionError('Second quick game attempted')
            self.quick[actor]={'id':str(uuid.UUID(int=3 if actor=='a' else 4)),'status':'playing'}
            return {'game':dict(self.quick[actor])}
        if path.endswith('/reveal'):
            self.quick[actor]['status']='revealed';return {'game':dict(self.quick[actor])}
        if path=='/api/v3/daily/entries':
            if actor in self.daily:raise AssertionError('Second daily attempted')
            self.daily[actor]=str(uuid.UUID(int=5 if actor=='a' else 6));return {'game':{'id':self.daily[actor]}}
        if '/daily/entries/' in path and path.endswith('/guess'):
            self.balances[actor]+=1;self.ledger.append({'principal':self.ids[actor],'source':'daily-v2','nominal':1,'actual':1,'balance':1})
            return {'state':'won'}
        if path=='/api/v3/bo3/queue':
            if actor=='a':return {'status':'queued'}
            if self.series is not None:raise AssertionError('Second BO3 attempted')
            self.series={'id':str(uuid.UUID(int=9)),'status':'active','round':{'id':str(uuid.UUID(int=10)),'number':1,'status':'active'},'pointsEligibility':None}
            return {'status':'matched','series':json.loads(json.dumps(self.series))}
        if path.endswith('/surrender'):
            if self.series['round']['number']==2:
                self.series.update(status='finished',pointsEligibility='eligible')
                for name,delta in [('a',-1),('b',3)]:
                    self.balances[name]+=delta;self.ledger.append({'principal':self.ids[name],'source':'match-v2-bo3','nominal':delta,'actual':delta,'balance':self.balances[name]})
            else:self.series['round']['status']='revealed';self.until=self.clock+5
            return json.loads(json.dumps(self.series))
        if path.endswith('/heartbeat'):return json.loads(json.dumps(self.series))
        raise AssertionError('Unexpected mutation '+path)

    def patches(self):
        stack=contextlib.ExitStack()
        for target,name,fn in [(smoke,'Http',self.client),(smoke,'counts',self.counts),(smoke,'query',self.query),
                               (smoke,'identity_digest',lambda cfg:'d'*64),
                               (smoke.time,'monotonic',lambda:self.clock),(smoke.time,'sleep',lambda n:setattr(self,'clock',self.clock+n))]:
            stack.enter_context(patch.object(target,name,side_effect=fn))
        return stack


class SmokeTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
        for target,name,value in [(fp,'home',lambda:self.root),(fp,'private_file',lambda p:True),
                                  (fp,'state',lambda:{'phase':'INTERNAL_READY'}),(fp,'link_value',lambda:fp.OLD)]:
            p=patch.object(target,name,side_effect=value);p.start();self.addCleanup(p.stop)
        self.value={'approvals':{'synthetic-smoke':'approved-smoke'}}

    def test_bounded_full_business_flow_and_repeat_do_not_consume_more_resources(self):
        world=World()
        with world.patches():
            first=smoke.run(CFG,self.value);mutations=len(world.positive)
            second=smoke.run(CFG,self.value)
        self.assertEqual(first['counts'],{'identities':2,'quick':2,'daily':2,'bo3':1,'ledger':4})
        self.assertEqual(first,second);self.assertEqual(len(world.positive),mutations)
        self.assertEqual(world.balances,{'a':0,'b':4})

    def test_lost_ack_reuses_persisted_key_without_second_game(self):
        world=World();world.fail_after_quick=True
        with world.patches():
            with self.assertRaises(subprocess.TimeoutExpired):smoke.run(CFG,self.value)
            self.assertEqual(len(world.quick),1)
            result=smoke.run(CFG,self.value)
        self.assertEqual(result['counts']['quick'],2)

    def test_existing_unknown_game_cannot_consume_a_second_actor_slot(self):
        world=World();world.quick['a']={'id':str(uuid.uuid4()),'status':'playing'}
        with world.patches(),self.assertRaisesRegex(RuntimeError,'one-game allowance'):smoke.run(CFG,self.value)
        self.assertEqual(len(world.quick),1)

    def test_finished_bo3_without_progress_refuses_another_queue(self):
        world=World();world.series={'status':'finished'}
        with world.patches(),self.assertRaisesRegex(RuntimeError,'One BO3 already'):smoke.run(CFG,self.value)
        self.assertEqual(sum(p[1]=='/api/v3/bo3/queue' for p in world.positive),0)

    def test_changed_identity_or_wrong_lifecycle_blocks_all_business(self):
        world=World()
        with world.patches(),patch.object(fp,'state',return_value={'phase':'INTERNAL_EDGE'}),self.assertRaisesRegex(RuntimeError,'internally-ready'):
            smoke.run(CFG,self.value)
        self.assertFalse(world.positive)

    def test_cookie_seed_is_persistent_and_orphans_do_not_mint_replacements(self):
        edge=self.root/'edge';edge.write_text('approved')
        owners={'principals':0,'owners':[]}
        with patch.object(fp,'edge_path',return_value=edge),patch.object(fp,'render',return_value='approved'),\
             patch.object(smoke,'counts',return_value={'identities':0}),patch.object(smoke,'owner_map',return_value=owners):
            path=smoke.ensure_jar(CFG,'a');before=path.read_bytes()
            smoke.ensure_jar(CFG,'a');self.assertEqual(before,path.read_bytes())
        path.unlink()
        with patch.object(fp,'edge_path',return_value=edge),patch.object(fp,'render',return_value='approved'),\
             patch.object(smoke,'counts',return_value={'identities':1}),\
             patch.object(smoke,'owner_map',return_value={'principals':1,'owners':[]}):
            with self.assertRaisesRegex(RuntimeError,'Unknown identities'):smoke.ensure_jar(CFG,'a')
        self.assertFalse(path.exists())

    def test_cookie_guard_refuses_route_drift_or_exhausted_identity_budget(self):
        edge=self.root/'edge';edge.write_text('wrong target')
        with patch.object(fp,'edge_path',return_value=edge),patch.object(fp,'render',return_value='approved'),self.assertRaisesRegex(RuntimeError,'route drift'):
            smoke.ensure_jar(CFG,'a')
        edge.write_text('approved')
        with patch.object(fp,'edge_path',return_value=edge),patch.object(fp,'render',return_value='approved'),\
             patch.object(smoke,'counts',return_value={'identities':2}),self.assertRaisesRegex(RuntimeError,'budget'):
            smoke.ensure_jar(CFG,'a')

    def test_existing_controller_identity_can_be_reused_without_reading_real_players(self):
        edge=self.root/'edge';edge.write_text('approved')
        path=smoke.jar_path('a');value='a'*64
        path.write_text('#HttpOnly_f1driverguess.online\tFALSE\t/api\tTRUE\t0\tf1_player\t'+value+'\n')
        with patch.object(fp,'edge_path',return_value=edge),patch.object(fp,'render',return_value='approved'),\
             patch.object(smoke,'owner_map',return_value={'principals':100,'owners':[{'id':str(uuid.uuid4()),'claimed':False}]}) as lookup,\
             patch.object(smoke,'counts',side_effect=AssertionError('Do not inspect unrelated players')):
            self.assertEqual(smoke.ensure_jar(CFG,'a'),path)
        lookup.assert_called_once_with(CFG,hashlib.sha256(value.encode()).hexdigest())

    def test_http_uses_verified_private_transport_and_keeps_csrf_out_of_arguments(self):
        client=smoke.Http(CFG,'a');client.csrf='f'*64
        with patch.object(smoke,'ensure_jar',return_value=self.root/'private.cookies'),\
             patch.object(ops,'run',return_value=subprocess.CompletedProcess([],0,b'{}\n200')) as run:
            client.send('POST','/api/v3/quick/games',{'difficulty':'normal'})
        args=run.call_args.args
        self.assertIn('f1driverguess.online:443:127.0.0.1:9443',args);self.assertIn('--noproxy',args)
        self.assertNotIn('-k',args);self.assertNotIn('f'*64,' '.join(args))
        self.assertIn(('f'*64).encode(),run.call_args.kwargs['input'])


if __name__=='__main__':unittest.main()
