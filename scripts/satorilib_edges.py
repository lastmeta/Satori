"""Edge-case parity vectors from satorilib's own code (throwaway keys).

Writes test/fixtures/satorilib-edges.json. Needs python-evrmorelib, mnemonic,
pycryptodome and PyYAML (Docker's versions), and the satorilib source:

  python scripts/satorilib_edges.py /path/to/satorilib/src > test/fixtures/satorilib-edges.json

Modules satorilib imports but the key code never calls (numpy, pandas, ...)
are stubbed.
"""
import base64, hashlib, json, os, sys, tempfile, types

sys.path.insert(0, sys.argv[1])


class _Stub(types.ModuleType):
    def __getattr__(self, k):
        if k.startswith('__'):
            raise AttributeError(k)
        return type(k, (), {'__init__': lambda s, *a, **kw: None})


for _ in range(40):
    try:
        from satorilib.wallet.evrmore.identity import EvrmoreIdentity
        break
    except ModuleNotFoundError as e:
        sys.modules[e.name] = _Stub(e.name)
        sys.modules[e.name].__path__ = []
from satorilib.wallet.identity import IdentityBase
from satorilib.utils import secret
from evrmore import SelectParams
from evrmore.wallet import CEvrmoreSecret, P2PKHEvrmoreAddress
from evrmore.signmessage import signMessage, verifyMessage, EvrmoreMessage

tmp = tempfile.mkdtemp()


def make(label, name, password=None):
    """A wallet/vault file through Docker's own generate + save path."""
    entropy = hashlib.sha256(label.encode()).digest()
    orig = IdentityBase.generateEntropy
    IdentityBase.generateEntropy = staticmethod(lambda: entropy)
    try:
        ident = EvrmoreIdentity(os.path.join(tmp, name), password=password)
    finally:
        IdentityBase.generateEntropy = orig
    return entropy, ident, open(os.path.join(tmp, name)).read()


from importlib.metadata import version
import platform
out = {
    'about': 'Edge cases checked against satorilib (scripts/satorilib_edges.py). Throwaway keys.',
    'generator': {'python': platform.python_version(), 'packages': {
        p: version(p) for p in ['python-evrmorelib', 'mnemonic', 'pycryptodome', 'PyYAML']}},
}

# The vault password goes into PBKDF2 as Latin-1 (pycryptodome tobytes), not UTF-8.
entropy, ident, text = make('satori-edges-latin1', 'latin1.yaml', 'pässwörd')
out['latin1Vault'] = {'password': 'pässwörd', 'entropy': base64.b64encode(entropy).decode(),
                      'address': ident.address, 'yaml': text}

# A password outside Latin-1 cannot be encoded: satorilib's encryptWallet swallows
# the error and saves the vault in plain text.
try:
    secret.encrypt('x', 'p€ss')
    error = None
except Exception as e:
    error = f'{type(e).__name__}: {e}'
_, _, text = make('satori-edges-euro', 'euro.yaml', 'p€ss')
out['nonLatin1Password'] = {'password': 'p€ss', 'encryptError': error, 'savedYaml': text}

# A signature flagged uncompressed (header 27-30) recovers the uncompressed key:
# it matches the uncompressed pubkey and address only.
SelectParams('mainnet')
key = CEvrmoreSecret.from_secret_bytes(entropy, compressed=False)
keyC = CEvrmoreSecret.from_secret_bytes(entropy, compressed=True)
msg = 'hello'
sig = signMessage(key, EvrmoreMessage(msg)).decode()
check = lambda **kw: verifyMessage(EvrmoreMessage(msg), sig, **kw)
out['uncompressedSignature'] = {
    'message': msg, 'signature': sig,
    'pubkey': keyC.pub.hex(), 'pubkeyUncompressed': key.pub.hex(),
    'address': str(P2PKHEvrmoreAddress.from_pubkey(keyC.pub)),
    'addressUncompressed': str(P2PKHEvrmoreAddress.from_pubkey(key.pub)),
    'verifies': {
        'pubkey': check(pubkey=keyC.pub.hex()),
        'pubkeyUncompressed': check(pubkey=key.pub.hex()),
        'address': check(address=str(P2PKHEvrmoreAddress.from_pubkey(keyC.pub))),
        'addressUncompressed': check(address=str(P2PKHEvrmoreAddress.from_pubkey(key.pub))),
    },
}
print(json.dumps(out, indent=1, ensure_ascii=False))
