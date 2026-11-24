"""Independent Python 3 verifier; fixture only, no network/database/environment reads."""
import hashlib
import json
import struct
import sys
from pathlib import Path

path = Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parent.parent / 'packages/shared/fixtures/bo3-seed-vector.json'
vector = json.loads(path.read_text(encoding='utf-8'))
c = vector['context']
fields = [c[k] for k in ('algorithmVersion', 'seriesId', 'contract', 'difficulty', 'datasetVersion', 'comparisonRulesVersion')] + c['slots']
encoded = b''.join(struct.pack('>I', len(s.encode('utf-8'))) + s.encode('utf-8') for s in fields)
seed = bytes.fromhex(vector['seedHex'])
commitment = hashlib.sha256(b'f1-bo3:commit:v1\0' + encoded + seed).hexdigest()
digest = hashlib.sha256(b'f1-bo3:decision:v1\0' + encoded + seed).hexdigest()
assert len(seed) == 32
assert commitment == vector['commitment']
assert digest == vector['digest']
assert (bytes.fromhex(digest)[0] & 1) == vector.get('seededSlot', vector.get('winnerSlot'))
print('PASS: Python length-prefixed UTF-8 / SHA-256 BO3 vector, including non-ASCII context')
