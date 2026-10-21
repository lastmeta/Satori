"""Generate test/fixtures/nip04-vectors.json: NIP-04 ciphertexts made by nostr-sdk 0.45, the library satorilib's
satori_nostr/encryption.py encrypts paid observations and payments with (Satori Lite has no NIP-44).

Run (throwaway venv; no network):
  python3 -m venv /tmp/nvenv && /tmp/nvenv/bin/pip install nostr-sdk==0.45.0
  /tmp/nvenv/bin/python scripts/nip04_vectors.py > test/fixtures/nip04-vectors.json
With an argument (a JSON file of [{ sender, recipient, ciphertext }]), it decrypts those instead and prints the texts:
the app's own ciphertexts, read by nostr-sdk.
"""
import json
import sys
from importlib.metadata import version

from nostr_sdk import Keys, SecretKey, nip04_decrypt, nip04_encrypt

SENDER = '3' * 63 + '1'
RECIPIENT = 'dd278564ca11c31ffb929b807c65d07a7cb0fddfd26b2d97a91f84ed0b3086e4'
TEXTS = ['101.25', '{"from_pubkey": "ab", "seq_num": 3}', 'Ünïcode ✓ ' + 'x' * 40]


def keys(hex_secret):
    return Keys(SecretKey.parse(hex_secret))


if len(sys.argv) > 1:
    for v in json.load(open(sys.argv[1])):
        print(nip04_decrypt(keys(v['recipient']).secret_key(), keys(v['sender']).public_key(), v['ciphertext']))
    sys.exit()

s, r = keys(SENDER), keys(RECIPIENT)
out = {'nostr_sdk': version('nostr-sdk'), 'sender': SENDER, 'recipient': RECIPIENT,
       'sender_pubkey': s.public_key().to_hex(), 'recipient_pubkey': r.public_key().to_hex(),
       'vectors': [{'text': t, 'ciphertext': nip04_encrypt(s.secret_key(), r.public_key(), t)} for t in TEXTS]}
print(json.dumps(out, indent=1, ensure_ascii=False))
