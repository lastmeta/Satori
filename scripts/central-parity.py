"""Generate test/fixtures/central-parity.json from the shipped Docker neuron image.

Run (offline, no network):
  docker run --rm -i --network none --entrypoint python \
    satorinet/satori-lite:latest - < scripts/central-parity.py > test/fixtures/central-parity.json

Records, for each float64 (as big-endian hex bits): Python str(float), numpy
str(np.float64) (what engine.py sends as `value`), and the central-lite payload
hash sha256(value + observed_at)[:16] (neuron/engine-lite/engine.py:1052-1058).
"""
import hashlib
import json
import random
import struct
import sys

import numpy as np

fixed = [
    0.0, -0.0, 1.0, -1.0, 100.0, 0.1, 0.2, 0.1 + 0.2, 1 / 3, 2 / 3, 1e-05, 0.0001,
    0.00009999, 0.001, 123456.789, 1e15, 9999999999999998.0, 1e16, 1e17, 1.5e16,
    12345678901234567890.0, 1e21, 1e22, 1e100, 1e-7, 1.23e-10, 5e-324,
    2.2250738585072014e-308, 1.7976931348623157e308, 65000.12, 3.14159,
    1779426055.9544094, 1760000000.123, 1760000000.0, -0.00083, 0.00083,
    float('inf'), float('-inf'), float('nan'),
]
rng = random.Random(20261015)
rand = []
for _ in range(300):
    rand.append(rng.uniform(-1, 1) * 10 ** rng.randint(-12, 22))
for _ in range(100):
    rand.append(struct.unpack('>d', rng.getrandbits(64).to_bytes(8, 'big'))[0])

floats = []
for x in fixed + rand:
    floats.append({
        'bits': struct.pack('>d', x).hex(),
        'py': str(x),
        'np': str(np.float64(x)),
    })

hashes = []
for v, t in [(100.0, 1760000000.123), (1e-05, 1779426055.9544094),
             (65000.12, 1760000000.0), (-0.00083, 1760003600.5)]:
    value, observed_at = str(np.float64(v)), str(float(t))
    hashes.append({
        'value_bits': struct.pack('>d', v).hex(),
        'observed_at_bits': struct.pack('>d', t).hex(),
        'value': value,
        'observed_at': observed_at,
        'hash': hashlib.sha256(f'{value}{observed_at}'.encode()).hexdigest()[:16],
    })

json.dump({
    'source': 'satorinet/satori-lite:latest, python ' + sys.version.split()[0] + ', numpy ' + np.__version__,
    'floats': floats,
    'hashes': hashes,
}, sys.stdout, indent=1)
print()
