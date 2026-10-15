"""Engine parity vectors from namaste_club's own code (src/engine/, docs/design/engine.md).

Writes test/fixtures/engine-parity.json. Needs numpy, pandas and scipy, and the
namaste_club source (read only; nothing is written there):

  python -B scripts/engine_parity.py ../namaste_club > test/fixtures/engine-parity.json

For each series it runs, unmodified:
  - models.create_dataset: 12 h buckets, percent-change returns (a stub storage
    serves the points, as the neuron database would);
  - bvar.train_bvar_model with lag 1, one stream and no time features
    (bvar.TIME_COLS = []): phi = the posterior mean;
  - pool.Pool._gather_market_state (compiled alone from pool.py): the first lag;
  - bvar.iterate_forecast: g1 (one step) and g2 (two steps);
  - calibration.weight_from_errors and calibration.blend, with pool.py's guards.
The weight's rolling backtest is this app's deviation (namaste_club logs live
forecasts instead), so it is rebuilt here from the same calls on each origin's
truncated history. Series have no gaps and no first lag older than 24 h, where
this app deliberately differs.
"""
import ast
import contextlib
import json
import random
import statistics
import subprocess
import sys
import tempfile
import types
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

NC = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(NC))
sys.modules['config'] = types.SimpleNamespace(MODELS_DIR=Path(tempfile.mkdtemp()))

STEP = 43200
HOLDOUT = 28  # models.py:552


class Storage:
    """satoriengine's EngineStorageManager, serving one stream's points."""
    points = []

    @classmethod
    def getInstance(cls):
        return cls()

    def hasStreamData(self, uuid):
        return bool(self.points)

    def getStreamData(self, uuid):
        df = pd.DataFrame({'ts': [t for t, _ in self.points], 'value': [v for _, v in self.points],
                           'hash': '', 'provider': ''})
        return df.set_index('ts')


for name in ('satoriengine', 'satoriengine.veda', 'satoriengine.veda.storage'):
    sys.modules[name] = types.ModuleType(name)
sys.modules['satoriengine.veda.storage'].EngineStorageManager = Storage

import bvar  # noqa: E402
import calibration  # noqa: E402
import models  # noqa: E402

bvar.TIME_COLS = []  # no time features (docs/design/engine.md, Deviations)

# pool.Pool._gather_market_state, compiled alone (pool.py imports the whole pool)
_tree = ast.parse((NC / 'pool.py').read_text())
_fn = next(n for n in ast.walk(_tree) if isinstance(n, ast.FunctionDef) and n.name == '_gather_market_state')
_ns = {'sys': sys, 'Path': Path}
exec(compile(ast.Module(body=[_fn], type_ignores=[]), 'pool.py', 'exec'), _ns)
gather_market_state = _ns['_gather_market_state']

STREAM = [{'uuid': 's', 'name': 'y'}]
HP = {'lambda1': 0.2, 'lambda2': 0.5, 'lag_order': 1}  # bvar.py:88-91


def quiet(fn, *a, **kw):
    with contextlib.redirect_stdout(sys.stderr):
        return fn(*a, **kw)


def fit(points):
    """namaste_club's phi on these points, or None below its minimum data."""
    Storage.points = points
    try:
        df = quiet(models.create_dataset, STREAM)
        model = quiet(bvar.train_bvar_model, df.drop(columns=['timestamp']), dict(HP))
    except (ValueError, RuntimeError):
        return None
    return model['coefficients']


def growth(coefficients, r0, steps):
    g = bvar.iterate_forecast(coefficients, ['y'], ['y'], {'y': [r0]}, [], 1, datetime(2026, 9, 1),
                              time_encoder=lambda t: [], horizon_steps=steps)
    return g['y']


def submitted(last, g, w):
    if not np.isfinite(g) or g <= 0:  # pool.py:1005-1006
        g = 1.0
    val = calibration.blend(last, g, w)
    return val if np.isfinite(val) and val > 0 else last  # pool.py:1015-1016


def buckets(points):
    s = pd.Series([v for _, v in points], index=pd.to_datetime([t for t, _ in points], unit='s'))
    s = s.resample('12h').last().dropna()  # models.py:262-266
    return [int(t.timestamp()) // STEP for t in s.index], list(s.values)


def weight(points):
    b, v = buckets(points)
    L = len(b) - 1
    me, pe = [], []
    for o in range(max(2, L - 1 - HOLDOUT), L - 1):
        upto = [p for p in points if p[0] // STEP <= b[o]]
        coef = fit(upto)
        if coef is None:
            continue
        r_o = v[o] / v[o - 1] - 1
        g2 = growth(coef, r_o, 2)
        a = v[o + 2]
        me.append(abs(v[o] * g2 - a) / abs(a))
        pe.append(abs(v[o] - a) / abs(a))
    if len(me) < calibration.MIN_SAMPLES:
        return calibration.DEFAULT_WEIGHT, len(me)
    return calibration.weight_from_errors(statistics.median(me), statistics.median(pe)), len(me)


def case(name, points):
    last = points[-1][1]
    coef = fit(points)
    if coef is None:
        return {'name': name, 'points': points, 'expected': {'model': 'naive', 't1': last, 't2': last}}
    Storage.points = points
    _, history = quiet(gather_market_state, None, STREAM, 1)
    r0 = history['y'][0]
    g1, g2 = growth(coef, r0, 1), growth(coef, r0, 2)
    w, n = weight(points)
    return {'name': name, 'points': points, 'expected': {
        'model': 'bar1', 'phi': float(coef[0, 0]), 'weight': float(w), 'samples': n,
        'r0': r0, 'g1': float(g1), 'g2': float(g2),
        't1': float(submitted(last, g1, w)), 't2': float(submitted(last, g2, w))}}


T0 = int(datetime(2026, 9, 1, tzinfo=timezone.utc).timestamp())


def grid(values):
    """One point per 12 h bucket at its boundary - 1 s (regrid_history.py's convention)."""
    return [[T0 + (k + 1) * STEP - 1, float(x)] for k, x in enumerate(values)]


def ar_prices(rng, n, phi, sd, p0=100.0):
    out, r, p = [], 0.0, p0
    for _ in range(n):
        out.append(p)
        r = phi * r + rng.gauss(0, sd)
        p *= 1 + r
    return out


rng = random.Random(20261015)
zig = [100, 101, 100, 102, 101, 103, 102, 104, 103, 105]
cases = [
    case('zigzag', grid(zig)),
    case('compound 1%', grid([100 * 1.01 ** k for k in range(40)])),
    case('zigzag, then 110 an hour on', grid(zig[:9]) + [[grid(zig[:9])[-1][0] + 3600, 110.0]]),
    case('7 buckets', grid(zig[:7])),
    case('8 buckets', grid(zig[:8])),
    case('constant', grid([5.0] * 30)),
    case('ar 0.4, 60 buckets', grid(ar_prices(rng, 60, 0.4, 0.02))),
    case('ar -0.3, 120 buckets', grid(ar_prices(rng, 120, -0.3, 0.03))),
    case('random walk, 300 buckets', grid(ar_prices(rng, 300, 0.0, 0.015, 60000.0))),
]
# Points every ~11 h (central polled every 11 h), several per bucket now and then.
t, pts, p, r = T0 + 600, [], 2500.0, 0.0
for _ in range(150):
    pts.append([t, p])
    r = 0.25 * r + rng.gauss(0, 0.02)
    p *= 1 + r
    t += 11 * 3600 + rng.randint(-1200, 1200)
cases.append(case('polled every ~11 h', pts))

commit = subprocess.run(['git', '-C', str(NC), 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
print('{"source": %s,\n "cases": [\n  %s\n]}' % (json.dumps(f'namaste_club {commit}, numpy {np.__version__}, pandas {pd.__version__}'),
                                          ',\n  '.join(json.dumps(c) for c in cases)))
