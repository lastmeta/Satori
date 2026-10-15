"""Generate identity parity fixtures from the real satorilib (Docker neuron code).

Throwaway keys only: every secret is sha256 of a fixed label.

Run inside the shipped Docker image (python-evrmorelib, mnemonic, pycryptodome,
eth-account, nostr_sdk at Docker's versions) with the local satorilib source
copied over the image's copy:

  sh scripts/identity_fixtures.sh

Writes /out/identity-parity.json.
"""
import sys
sys.path.insert(0, '/satorilib')

import base64
import hashlib
import json
import os
import tempfile

import yaml
import satorilib
from satorilib.wallet.identity import IdentityBase
from satorilib.wallet.evrmore.identity import EvrmoreIdentity
from satorilib.wallet.ethereum.wallet import EthereumWallet
from satorilib.utils import secret
from satorilib import config

assert satorilib.__file__.startswith('/satorilib/'), satorilib.__file__

PASSWORD = 'fixture-pass-1'
WRONG = 'fixture-wrong-pass'
MESSAGES = [
    '',
    'hello',
    '1760486400',
    'Satori ✓ ünïcödé',
    'x' * 300,  # varint 0xfd prefix
]
tmp = tempfile.mkdtemp()


def sha(label: str) -> bytes:
    return hashlib.sha256(label.encode()).digest()


def leading_zero() -> tuple:
    i = 0
    while True:
        label = f'satori-identity-fixture-zero-{i}'
        if sha(label)[0] == 0:
            return label, sha(label)
        i += 1


def make(entropy: bytes, path: str, password=None) -> EvrmoreIdentity:
    """Create a wallet/vault file through Docker's own generate+save path."""
    orig = IdentityBase.generateEntropy
    IdentityBase.generateEntropy = staticmethod(lambda: entropy)
    try:
        return EvrmoreIdentity(path, password=password)
    finally:
        IdentityBase.generateEntropy = orig


def read(path: str) -> str:
    with open(path) as f:
        return f.read()


labels = [
    ('satori-browser-parity-vector-1', sha('satori-browser-parity-vector-1')),
    ('satori-identity-fixture-1', sha('satori-identity-fixture-1')),
    ('satori-identity-fixture-2', sha('satori-identity-fixture-2')),
    leading_zero(),
]

vectors = []
for n, (label, entropy) in enumerate(labels):
    path = os.path.join(tmp, f'wallet{n}.yaml')
    ident = make(entropy, path)
    assert ident._entropy == entropy
    sigs = []
    for m in MESSAGES:
        sig = ident.sign(m)
        assert ident.verify(m, sig)
        sigs.append({'message': m, 'signature': sig.decode()})
    vectors.append({
        'label': label,
        'entropyHex': entropy.hex(),
        'entropy': ident._entropyStr,
        'words': ident.words,
        'wif': ident.privkey,
        'pubkey': ident.pubkey,
        'address': ident.address,
        'scripthash': ident.scripthash,
        'ethAddress': EthereumWallet.generateAccount(entropy).address,
        'walletYaml': read(path),
        'signatures': sigs,
    })

# Current vault: encrypted entropy, privateKey, words (Docker's save path).
v = vectors[1]
vpath = os.path.join(tmp, 'vault-current.yaml')
make(bytes.fromhex(v['entropyHex']), vpath, password=PASSWORD)
reopened = EvrmoreIdentity(vpath, password=PASSWORD)
assert reopened.address == v['address'] and reopened.isDecrypted

wrong = EvrmoreIdentity(vpath, password=WRONG)
assert wrong.isEncrypted  # Python swallows the bad password

# Old vault: publicKey, scripthash and evr.address were encrypted too.
o = vectors[2]
opath = os.path.join(tmp, 'vault-old.yaml')
config.put(
    data=secret.encryptMapValues(
        content={
            'entropy': o['entropy'],
            'words': o['words'],
            'privateKey': o['wif'],
            'publicKey': o['pubkey'],
            'scripthash': o['scripthash'],
            'evr': {'address': o['address']},
        },
        password=PASSWORD,
        keys=['entropy', 'privateKey', 'words', 'publicKey', 'scripthash', 'address']),
    path=opath)
old = EvrmoreIdentity(opath, password=PASSWORD)
assert old.address == o['address'] and old.pubkey == o['pubkey'] and old.isDecrypted
old_yaml = yaml.safe_load(read(opath))
assert len(old_yaml['publicKey']) != 66 and len(old_yaml['scripthash']) != 64
assert len(old_yaml['evr']['address']) > 34

# WIF-only wallet (Docker load case 2).
w = vectors[3]
wpath = os.path.join(tmp, 'wallet-wif.yaml')
config.put(data={
    'privateKey': w['wif'], 'publicKey': w['pubkey'],
    'scripthash': w['scripthash'], 'evr': {'address': w['address']}}, path=wpath)
# satorilib's case 2 calls _generatePrivateKey() with no entropy and raises
# (TypeError in CEvrmoreSecret.from_secret_bytes), so Docker cannot load this.
try:
    EvrmoreIdentity(wpath)
    wif_python = 'loads'
except TypeError as e:
    wif_python = f'raises TypeError: {e}'

# Mismatch: fixture-2's file with fixture-1's publicKey.
mismatch = yaml.safe_load(vectors[2]['walletYaml'])
mismatch['publicKey'] = vectors[1]['pubkey']

# Nostr key, written as start.py:_initNostrKeys does.
from nostr_sdk import Keys
nsecret = sha('satori-nostr-fixture-1').hex()
keys = Keys.parse(nsecret)
npub = keys.public_key().to_hex().lower()
nostr_yaml = yaml.dump({'pubkey_hex': npub, 'secret_hex': keys.secret_key().to_hex().lower()},
                       default_flow_style=False)


def version(mod):
    from importlib.metadata import version as v
    try:
        return v(mod)
    except Exception:
        return None


out = {
    'about': 'Generated by scripts/identity_fixtures.py from satorilib (Docker neuron code). Throwaway keys.',
    'generator': {
        'image': os.environ.get('FIXTURE_IMAGE', 'satorinet/satori-lite:latest'),
        'python': sys.version.split()[0],
        'packages': {p: version(p) for p in [
            'python-evrmorelib', 'mnemonic', 'pycryptodome', 'eth-account', 'nostr-sdk', 'PyYAML']},
    },
    'vectors': vectors,
    'vaults': {
        'password': PASSWORD,
        'wrongPassword': WRONG,
        'current': {'vector': 1, 'yaml': read(vpath)},
        'old': {'vector': 2, 'yaml': read(opath)},
    },
    'wifOnly': {'vector': 3, 'yaml': read(wpath), 'python': wif_python},
    'mismatch': {'vector': 2, 'yaml': yaml.dump(mismatch, default_flow_style=False), 'fields': ['publicKey']},
    'nostr': {'secretHex': nsecret, 'pubkeyHex': npub, 'yaml': nostr_yaml},
}
with open('/out/identity-parity.json', 'w') as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('wrote identity-parity.json:', len(vectors), 'vectors')
