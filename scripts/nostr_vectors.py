"""Generate test/fixtures/nostr-parity.json from satorilib's Nostr client and Satori Lite.

The events are built by satorilib's own SatoriNostr methods (origin/base-upgrade,
dec62db, the client Satori Lite runs) and signed by nostr-sdk 0.45, with the
metadata and observations made as neuron-lite/start.py makes them. Only the
clock is pinned (created_at and the content timestamps), so the ids are fixed.
Lite's `_numericObservationValue` (start.py:1364-1424) is taken from start.py's
source and run on sample values.

Run (throwaway venv; no network, no relay):
  python3 -m venv /tmp/nvenv && /tmp/nvenv/bin/pip install nostr-sdk==0.45.0
  /tmp/nvenv/bin/python scripts/nostr_vectors.py > test/fixtures/nostr-parity.json
Paths default to the sibling checkouts (../satorilib, ../neuron).
"""
import ast
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import uuid
from importlib.metadata import version

from nostr_sdk import Keys, SecretKey, Timestamp

HERE = os.path.dirname(os.path.abspath(__file__))
SATORI = os.path.abspath(os.path.join(HERE, '..', '..'))
SATORILIB = os.environ.get('SATORILIB', os.path.join(SATORI, 'satorilib'))
REF = os.environ.get('SATORILIB_REF', 'origin/base-upgrade')
START = os.environ.get('START_PY', os.path.join(SATORI, 'neuron', 'neuron-lite', 'start.py'))

# The fixture key (test/fixtures/identity-parity.json `nostr`) and a pinned clock.
SECRET = 'dd278564ca11c31ffb929b807c65d07a7cb0fddfd26b2d97a91f84ed0b3086e4'
NOW = 1792073160
PROVIDER = 'e5e6ce948344b1e0178f9ccf49fcb499b4b4f00fc09c7637535ee82fc7bf503d'
WALLET_PUBKEY = '02' + '11' * 32  # an identity's compressed pubkey (shape only)
SOURCE = 'btc-usd-price'
PRED = SOURCE + '_pred'
PRED_CREATED_AT = 1792000000


def satori_nostr_package():
    """satorilib's satori_nostr package at REF, in a temp dir (no integrations)."""
    root = tempfile.mkdtemp()
    pkg = os.path.join(root, 'satori_nostr')
    os.makedirs(pkg)
    open(os.path.join(pkg, '__init__.py'), 'w').close()
    for name in ['client.py', 'models.py', 'dedupe.py', 'encryption.py']:
        src = subprocess.check_output(
            ['git', '-C', SATORILIB, 'show', f'{REF}:src/satorilib/satori_nostr/{name}'])
        with open(os.path.join(pkg, name), 'wb') as f:
            f.write(src)
    sys.path.insert(0, root)
    commit = subprocess.check_output(['git', '-C', SATORILIB, 'rev-parse', '--short', REF]).decode().strip()
    return commit


COMMIT = satori_nostr_package()
from satori_nostr import client as client_mod  # noqa: E402
from satori_nostr.client import SatoriNostr  # noqa: E402
from satori_nostr.models import DatastreamMetadata, DatastreamObservation, SatoriNostrConfig  # noqa: E402

client_mod.time.time = lambda: NOW  # SubscriptionAnnouncement.timestamp = int(time.time())


class Capture(SatoriNostr):
    """The real client with the relay swapped for a list, and created_at pinned."""

    def __init__(self):
        super().__init__(SatoriNostrConfig(keys=SECRET, relay_urls=[]))
        self._running = True
        self._client = object()
        self.sent = []
        self.created_at = NOW

    async def _send_builder(self, builder):
        builder = builder.custom_created_at(Timestamp.from_secs(self.created_at))
        signed = self._keys.sign_event(builder.finalize_unsigned(self._keys.public_key()))
        self.sent.append(json.loads(signed.as_json()))
        return signed


def pred_metadata(pubkey):
    """start.py:3454-3477 (_networkAnnouncePublications) for a `_pred` publication."""
    meta = {'source_stream_name': SOURCE, 'source_provider_pubkey': PROVIDER, 'wallet_pubkey': WALLET_PUBKEY}
    return DatastreamMetadata(
        stream_name=PRED, nostr_pubkey=pubkey, name='Predictions for Bitcoin USD Price', description='',
        encrypted=False, price_per_obs=0, created_at=PRED_CREATED_AT, cadence_seconds=900, tags=[],
        metadata=meta)


def tombstone_metadata(pubkey):
    """start.py:3690-3713 (_tombstoneNow): only stream_name and nostr_pubkey matter."""
    return DatastreamMetadata(
        stream_name=PRED, nostr_pubkey=pubkey, name='', description='', encrypted=False,
        price_per_obs=0, created_at=0, cadence_seconds=None, tags=[])


async def events():
    c = Capture()
    pubkey = c.pubkey()
    out = {}

    async def one(name, coro):
        await coro
        out[name] = c.sent.pop()

    # start.py:3549-3590 (_networkPublishObservation) → client.publish_observation (free stream)
    obs = DatastreamObservation(stream_name=PRED, timestamp=NOW, value='80100.5', seq_num=1)
    await one('prediction', c.publish_observation(obs, pred_metadata(pubkey)))
    await one('announce', c.announce_datastream(pred_metadata(pubkey)))
    await one('tombstone', c.announce_datastream(tombstone_metadata(pubkey), deleted=True))
    await one('subscribe', c.subscribe_datastream(SOURCE, PROVIDER))
    await one('unsubscribe', c.unsubscribe_datastream(SOURCE, PROVIDER))
    await one('relayList', c.publish_relay_list(['ws://satorian.satorinet.io:7777']))
    return pubkey, out


def numeric_observation_value():
    """Lite's _numericObservationValue, taken from start.py's source."""
    tree = ast.parse(open(START).read())
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == '_numericObservationValue')
    fn.decorator_list = []
    ns = {}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), START, 'exec'), ns)
    return ns['_numericObservationValue'], fn.lineno, fn.end_lineno


def main():
    pubkey, built = asyncio.run(events())
    unwrap, first, last = numeric_observation_value()
    cases = [
        '82234', '0.10380000', '32.1', 82234, 80072.5, '-3', 'abc', '', None, True, [1, 2],
        {'chainId': 84532, 'streamId': 1, 'round': 20741, 'raw': '59058240589371161', 'unit': 'raw'},
        {'value': '540.44', 'raw': '213397', 'unit': 'tick'},
        {'raw': '213397', 'unit': 'tick'},
        {'value': None, 'raw': '-7'},
        {'value': 0, 'raw': '9'},
        {'unit': 'raw'},
    ]
    unwrapped = []
    for v in cases:
        r = unwrap(v)
        unwrapped.append({'value': v, 'float': None if r is None else repr(r)})
    print(json.dumps({
        'about': 'Generated by scripts/nostr_vectors.py: events built by satorilib SatoriNostr '
                 f'({REF} {COMMIT}) and signed by nostr-sdk, metadata as neuron-lite/start.py builds it; '
                 f'_numericObservationValue from start.py:{first}-{last}. Throwaway key.',
        'generator': {'python': sys.version.split()[0], 'nostr-sdk': version('nostr-sdk'), 'satorilib': COMMIT},
        'secretHex': SECRET,
        'pubkeyHex': pubkey,
        'now': NOW,
        'events': built,
        'numericValue': unwrapped,
        'relayUuid': {
            # neuron/tests/test_relay_ids.py:23-28 (pinned there) and relay_ids.py
            'provider': '62b18453c2e2d89ebe5c7c91f17360ae2bcae17e58ace0ab33faa9c03c17633f',
            'stream': 'bitcoin_price',
            'uuid': str(uuid.uuid5(uuid.NAMESPACE_DNS,
                                   'satori-relay:62b18453c2e2d89ebe5c7c91f17360ae2bcae17e58ace0ab33faa9c03c17633f:bitcoin_price:')),
            'predUuid': str(uuid.uuid5(uuid.NAMESPACE_DNS,
                                       'satori-relay:62b18453c2e2d89ebe5c7c91f17360ae2bcae17e58ace0ab33faa9c03c17633f:bitcoin_price_pred:')),
        },
    }, indent=1, ensure_ascii=False))


if __name__ == '__main__':
    main()
