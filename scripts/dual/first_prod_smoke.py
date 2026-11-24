"""Bounded synthetic HTTP acceptance for unpublished PROD; never writes SQL."""
import datetime
import hashlib
import json
from pathlib import Path
import secrets
import subprocess
import time
import uuid

import first_prod as fp
import release as ops
from first_prod_rebind import encode, replace_private, identity_digest


def query(cfg, statement):
    ops.require(ops.db('prod') == 'f1dg3_prod' and cfg['pgPort'] == 5432 and cfg['prod']['port'] == 3101,
                'Synthetic target must be new PROD only')
    return json.loads(ops.sql(cfg['pgPort'], 'f1dg3_prod', 'BEGIN READ ONLY; ' + statement + '; ROLLBACK;'))


def identifier(value):
    return str(uuid.UUID(value))


def jar_path(actor):
    ops.require(actor in ('a','b'), 'Only two synthetic actors')
    return fp.home() / ('first-prod-synthetic.cookies' if actor == 'a' else 'first-prod-synthetic-b.cookies')


def token(path):
    if not path.exists(): return None
    ops.require(not path.is_symlink() and fp.private_file(path), 'Unsafe synthetic cookie jar')
    rows = []
    for line in path.read_text().splitlines():
        parts = line.removeprefix('#HttpOnly_').split('\t')
        if len(parts) == 7 and parts[5] == 'f1_player':
            ops.require(parts[0] == 'f1driverguess.online' and parts[2] == '/api' and
                        parts[3] == 'TRUE' and ops.HEX.fullmatch(parts[6]), 'Unexpected synthetic cookie scope')
            rows.append(parts[6])
    ops.require(len(rows) == 1, 'Missing or duplicate synthetic owner cookie; do not create a replacement')
    return rows[0]


def owner_map(cfg, owner_hash=None):
    if owner_hash: ops.require(ops.HEX.fullmatch(owner_hash), 'Invalid synthetic owner hash')
    where=" WHERE owner_hash='"+owner_hash+"'" if owner_hash else ''
    return query(cfg, "SELECT json_build_object('principals',(SELECT count(*) FROM identity_principals),"
                     "'owners',coalesce((SELECT json_agg(json_build_object('hash',owner_hash,'id',principal_id,"
                     "'claimed',claimed_account_id IS NOT NULL)) FROM identity_owners"+where+"),'[]'::json))")


def ensure_jar(cfg, actor):
    """Seed a persistent token BEFORE HTTP: interrupted bootstrap cannot mint another identity."""
    ops.require(cfg['prod'].get('syntheticSessionApproval'), 'Explicit synthetic grant required')
    ops.require(fp.edge_path(True).read_text()==fp.render(True), 'Internal route drift; no synthetic writes')
    path = jar_path(actor)
    current = token(path)
    if current:
        mapped = owner_map(cfg,hashlib.sha256(current.encode()).hexdigest())['owners']
        if mapped:
            ops.require(len(mapped) == 1 and not mapped[0]['claimed'], 'Synthetic identity was claimed')
            return path  # Existing controller identity remains usable after public traffic begins.
    ops.require(counts(cfg)['identities']<2,'Unknown identities or exhausted two-identity budget')
    owners = owner_map(cfg)
    known = {hashlib.sha256(t.encode()).hexdigest() for t in (token(jar_path('a')),token(jar_path('b'))) if t}
    ops.require(owners['principals'] == len(owners['owners']) and len(owners['owners']) < 2 and
                all(r['hash'] in known and not r['claimed'] for r in owners['owners']),
                'Unknown identities or exhausted two-identity budget; do not bootstrap')
    if actor == 'b': ops.require(len(owners['owners']) == 1, 'Reuse controller actor before creating second actor')
    else: ops.require(not owners['owners'], 'Missing controller cookie with existing identities; stop')
    if not current:
        value = secrets.token_hex(32)
        # Netscape jar; never prints raw tokens or places them in process arguments.
        body = '# Netscape HTTP Cookie File\n#HttpOnly_f1driverguess.online\tFALSE\t/api\tTRUE\t0\tf1_player\t' + value + '\n'
        replace_private(path,body.encode(),exclusive=True)
    return path


def record_identity(cfg, actor, principal):
    principal = identifier(principal)
    value = token(jar_path(actor))
    mapped = owner_map(cfg,hashlib.sha256(value.encode()).hexdigest())['owners']
    ops.require(len(mapped) == 1 and mapped[0]['id'] == principal and not mapped[0]['claimed'], 'Synthetic principal mismatch')
    path = fp.home() / ('synthetic-identity-' + actor + '.json')
    record = {'label':'first-prod-synthetic-'+actor,'principalId':principal,
              'approvalReference':cfg['prod']['syntheticSessionApproval']}
    replace_private(path,encode(record),exclusive=True)


class Http:
    def __init__(self,cfg,actor):
        self.cfg,self.actor,self.csrf = cfg,actor,None

    def send(self,method,path,body=None,origin=None,csrf=True,stale=False):
        ops.require(path.startswith('/api/') and '?' not in path.split('?')[0] and '\n' not in path, 'Unexpected API path')
        jar=ensure_jar(self.cfg,self.actor)
        headers={'Origin':origin or 'https://f1driverguess.online','Content-Type':'application/json',
                 'x-f1-mode-contract':'match-v2-bo3' if '/bo3/' in path else 'quick-v2' if '/quick/' in path else 'daily-v2',
                 'x-f1-identity-contract':'identity-v1','x-f1-game-contract':'v3'}
        if csrf and self.csrf:headers['x-f1-csrf']=self.csrf
        if stale:headers['Cookie']='f1_player='+token(jar)+'; f1_account='+('0'*64)
        config=['request = '+json.dumps(method)]+['header = '+json.dumps(k+': '+v) for k,v in headers.items()]
        if body is not None:config.append('data = '+json.dumps(json.dumps(body)))
        output=ops.run('curl','--silent','--show-error','--noproxy','*','--max-time','10','--proto','=https',
                       '--resolve','f1driverguess.online:443:127.0.0.1','--connect-to','f1driverguess.online:443:127.0.0.1:9443',
                       '--cookie',str(jar),'--cookie-jar',str(jar),'--config','-',
                       '--write-out','\n%{http_code}','https://f1driverguess.online'+path,
                       input=('\n'.join(config)+'\n').encode(),capture_output=True,timeout=12).stdout
        raw,code=output.rsplit(b'\n',1)
        return int(code),json.loads(raw)

    def boot(self):
        code,result=self.send('GET','/api/v3/modes/session')
        ops.require(code==200 and result['contract']=='modes-v1','Synthetic bootstrap failed')
        record_identity(self.cfg,self.actor,result['principalId'])
        self.csrf=result['csrfToken'];self.principal=identifier(result['principalId'])
        return self


def counts(cfg):
    return query(cfg,"SELECT json_build_object('identities',(SELECT count(*) FROM identity_principals),"
                     "'quick',(SELECT count(*) FROM game_sessions),'daily',(SELECT count(*) FROM daily_v2_entries),"
                     "'bo3',(SELECT count(*) FROM bo3_series),'ledger',(SELECT count(*) FROM points_ledger))")


def run(cfg,value):
    ops.require(fp.state().get('phase')=='INTERNAL_READY' and fp.link_value()==fp.OLD and
                value['approvals'].get('synthetic-smoke')==cfg['prod'].get('syntheticSessionApproval'),
                'Unpublished internally-ready PROD and exact synthetic grant required')
    identity=identity_digest(cfg)
    path=fp.home()/'synthetic-smoke-progress.json'
    progress=fp.private_json(path) if path.exists() else {'format':'first-prod-bounded-smoke-v1','version':fp.VERSION,
                'identitySha256':identity,'approval':cfg['prod']['syntheticSessionApproval'],'steps':{}}
    ops.require(progress['identitySha256']==identity and progress['version']==fp.VERSION and
                progress['approval']==cfg['prod']['syntheticSessionApproval'],'Smoke identity/scope drift')
    def save():replace_private(path,encode(progress))
    def limits():
        c=counts(cfg)
        ops.require(c['identities']<=2 and c['quick']<=2 and c['daily']<=2 and c['bo3']<=1,'Synthetic quota exceeded; stop')
        return c
    limits();save()
    clients={name:Http(cfg,name).boot() for name in ('a','b')}
    for client in clients.values():
        old=client.principal;client.boot();ops.require(client.principal==old,'Identity restoration failed')
    def get(client,route):
        code,body=client.send('GET',route);ops.require(code==200,'Synthetic GET failed: '+route);return body
    def post(name,client,route,body):
        current=limits()
        encoded=encode({'route':route,'body':body});fingerprint=hashlib.sha256(encoded).hexdigest()
        step=progress['steps'].get(name)
        if step:
            ops.require(step['requestSha256']==fingerprint,'Smoke operation changed; never consume another quota')
            if 'response' in step:return step['response']
        else:
            # A new key may consume a slot; a persisted pending key may only replay that same operation.
            if route in ('/api/v3/quick/games','/api/v3/daily/entries'):
                kind='quick' if '/quick/' in route else 'daily'
                sql=("SELECT json_build_object('used',count(*)) FROM game_sessions g JOIN identity_owners o ON o.owner_hash=g.owner_hash WHERE o.principal_id='"
                     if kind=='quick' else "SELECT json_build_object('used',count(*)) FROM daily_v2_entries WHERE principal_id='")
                ops.require(current[kind]<2 and query(cfg,sql+client.principal+"'")['used']==0,
                            'This actor already consumed its one-game allowance')
            if route=='/api/v3/bo3/queue':ops.require(current['bo3']==0,'One BO3 already exists; never enqueue another')
            step={'key':str(uuid.uuid4()),'requestSha256':fingerprint,'route':route}
            progress['steps'][name]=step;save()  # Durable idempotency key before sending, including across process death.
        code,result=client.send('POST',route,{**body,'idempotencyKey':step['key']})
        ops.require(code==200,'Synthetic POST failed: '+route)
        step['response']=result;save()
        return result
    for actor,client in clients.items():
        # Negative mutations must be rejected before a game is created.
        for name,kw in [('origin',{'origin':'https://invalid.example'}),('csrf',{'csrf':False})]:
            before=limits();code,_=client.send('POST','/api/v3/quick/games',
                                {'difficulty':'normal','idempotencyKey':str(uuid.uuid4())},**kw)
            ops.require(code==403 and limits()==before,'Origin/CSRF protection failed')
        before=limits();code,body=client.send('GET','/api/v3/me/profile',stale=True)
        ops.require((code==401 or (code==200 and body.get('person',{}).get('principalId')==client.principal and
                    body['person'].get('kind')=='guest')) and limits()==before,'Stale synthetic cookie mapped incorrectly')
        quick=post(actor+'-quick',client,'/api/v3/quick/games',{'difficulty':'normal'})
        gid=identifier(quick['game']['id'])
        terminal=post(actor+'-reveal',client,'/api/v3/quick/games/'+gid+'/reveal',{})
        ops.require(terminal['game']['status']=='revealed','Quick reveal did not settle')
        ops.require(get(client,'/api/v3/quick/games/'+gid)['game']['status']=='revealed','Quick refresh lost terminal state')
        get(client,'/api/games/'+gid+'/answer-profile')
        daily=post(actor+'-daily',client,'/api/v3/daily/entries',{'difficulty':'normal'})
        entry=identifier(daily['game']['id'])
        # Read only this registered synthetic entry's answer; never expose it in output or use arbitrary user games.
        answer=query(cfg,"SELECT json_build_object('answer',c.answer_driver_id) FROM daily_v2_entries e "
                         "JOIN daily_v2_challenges c ON c.id=e.challenge_id WHERE e.id='"+entry+"' AND e.principal_id='"+client.principal+"'")['answer']
        won=post(actor+'-daily-guess',client,'/api/v3/daily/entries/'+entry+'/guess',{'driverId':answer})
        ops.require(won['state']=='won','Daily did not settle success')
    a,b=clients['a'],clients['b']
    post('queue-a',a,'/api/v3/bo3/queue',{'difficulty':'normal'})
    pair=post('queue-b',b,'/api/v3/bo3/queue',{'difficulty':'normal'})
    ops.require(pair['status']=='matched','BO3 did not match')
    sid=identifier(pair['series']['id']);deadline=time.monotonic()+30
    while True:
        series=get(a,'/api/v3/bo3/series/'+sid)
        if series['status']=='finished':break
        ops.require(time.monotonic()<deadline,'Bounded BO3 acceptance timed out; do not create another series')
        rid=identifier(series['round']['id'])
        if series['round']['status']=='active':
            for actor,client in clients.items():post('heartbeat-'+actor+'-'+rid,client,'/api/v3/bo3/series/'+sid+'/heartbeat',{'roundId':rid})
            post('surrender-'+rid,a,'/api/v3/bo3/series/'+sid+'/surrender',{'roundId':rid,'confirmed':True})
        time.sleep(1)
    ops.require(series['pointsEligibility']=='eligible','BO3 reward ineligible')
    for actor,client in clients.items():
        profile=get(client,'/api/v3/me/profile')
        ops.require(profile['balance']==(0 if actor=='a' else 4),'Unexpected actual points balance')
        get(client,'/api/v3/me/history')
        year=datetime.datetime.fromisoformat(profile['today']).year
        activity=get(client,'/api/v3/profiles/'+client.principal+'/activity?year='+str(year))
        ops.require(activity['year']==year and sum(d['actualDelta'] for d in activity['days'])==activity['total'],
                    'Annual activity response inconsistent')
        get(client,'/api/v3/leaderboards/total')
    ledger=query(cfg,"SELECT coalesce(json_agg(json_build_object('principal',principal_id,'source',source_kind,"
                     "'nominal',nominal_delta,'actual',actual_delta,'balance',balance_after)),'[]'::json) FROM points_ledger "
                     "WHERE principal_id IN ('"+a.principal+"','"+b.principal+"')")
    ops.require(len(ledger)==4 and sorted(x['actual'] for x in ledger)==[-1,1,1,3],'Actual ledger deltas do not match approved rules')
    final=limits();ops.require(final=={'identities':2,'quick':2,'daily':2,'bo3':1,'ledger':4},'Unexpected synthetic data counts')
    progress.update(result='PASS',counts=final,ledger=ledger,completedAt=fp.now(),legacyCookieScope='Synthetic stale token only; real-user cookie not accessed')
    save()
    return {'result':'PASS','scope':'new f1dg3_prod only','counts':final,'balances':{'a':0,'b':4},'auditFile':str(path)}
