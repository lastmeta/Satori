"""Check JS output with the real satorilib: JS signatures verify, and the
JS-exported wallet.yaml / vault.yaml load in Docker's EvrmoreIdentity.
Run via: sh scripts/identity_fixtures.sh verify (sets satorilibVerified)."""
import sys
sys.path.insert(0, '/satorilib')

import json
import os
import tempfile

import satorilib
from satorilib.wallet.evrmore.identity import EvrmoreIdentity
from satorilib.wallet.evrmore.verify import verify

assert satorilib.__file__.startswith('/satorilib/'), satorilib.__file__
path = '/out/identity-js.json'
d = json.load(open(path))
tmp = tempfile.mkdtemp()

sigs = all(
    verify(message=s['message'], signature=s['signature'], publicKey=s['pubkey'])
    and verify(message=s['message'], signature=s['signature'], address=s['address'])
    for s in d['signatures'])
# negative control: a signature must not verify for a different message
s0 = d['signatures'][0]
assert not verify(message=s0['message'] + '!', signature=s0['signature'], publicKey=s0['pubkey'])


def loads(text, password=None):
    p = os.path.join(tmp, f'{len(os.listdir(tmp))}.yaml')
    open(p, 'w').write(text)
    return EvrmoreIdentity(p, password=password)


v = loads(d['vault']['yaml'], d['vault']['password'])
vault = v.isDecrypted and v.address == d['vault']['address'] and v.pubkey == d['vault']['pubkey']
w = loads(d['wallet']['yaml'])
wallet = w.isDecrypted and w.address == d['wallet']['address']
d['satorilibVerified'] = {'signatures': sigs, 'vault': vault, 'wallet': wallet}
json.dump(d, open(path, 'w'), indent=2, ensure_ascii=False)
open(path, 'a').write('\n')
print('satorilibVerified:', d['satorilibVerified'])
sys.exit(0 if sigs and vault and wallet else 1)
