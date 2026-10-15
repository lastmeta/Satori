"""bvar parity vectors from namaste_club's own code (src/engine/bvar.js, docs/design/engine.md).

Writes test/fixtures/bvar-parity.json. Needs numpy, pandas and scipy, and the
namaste_club source (read only; nothing is written there):

  python -B scripts/bvar_parity.py ../namaste_club > test/fixtures/bvar-parity.json

For each case (a table of 12 h returns, several series, lag 1) it runs,
unmodified:
  - bvar.train_bvar_model with no time features (bvar.TIME_COLS = []): the
    posterior mean of every equation, the noise sd, and the prior variances
    (caught on their way into np.diag, bvar.py:213);
  - bvar.iterate_forecast: each series' growth after one and two steps from
    a lag vector, with its ±50 % clamp.
"""
import contextlib
import json
import random
import subprocess
import sys
import tempfile
import types
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

NC = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(NC))
sys.modules['config'] = types.SimpleNamespace(MODELS_DIR=Path(tempfile.mkdtemp()))

import bvar  # noqa: E402

bvar.TIME_COLS = []  # no time features (docs/design/engine.md, Deviations)

_diag = np.diag
priors = []


def _catch(v, *a, **kw):
    """np.diag(1 / prior_var) in train_bvar_model: keep prior_var."""
    if getattr(v, 'ndim', 0) == 1:
        priors.append([float(x) for x in 1.0 / v])
    return _diag(v, *a, **kw)


def fit(names, returns, l1, l2):
    priors.clear()
    df = pd.DataFrame(returns, columns=names)
    np.diag = _catch
    try:
        with contextlib.redirect_stdout(sys.stderr):
            m = bvar.train_bvar_model(df, {'lambda1': l1, 'lambda2': l2, 'lag_order': 1})
    finally:
        np.diag = _diag
    return m, [list(p) for p in priors]


def growth(m, names, lag, steps):
    g = bvar.iterate_forecast(m['coefficients'], names, names, {n: [x] for n, x in zip(names, lag)}, [], 1,
                              datetime(2026, 9, 1), time_encoder=lambda t: [], horizon_steps=steps)
    return [float(g[n]) for n in names]


def var_returns(rng, n_rows, A, sd):
    """r_t = A r_{t-1} + N(0, sd): rows of returns, oldest first."""
    k = len(A)
    r = [0.0] * k
    out = []
    for _ in range(n_rows):
        r = [sum(A[i][j] * r[j] for j in range(k)) + rng.gauss(0, sd[i]) for i in range(k)]
        out.append(r)
    return out


def case(name, returns, l1, l2, lag):
    names = [f's{i}' for i in range(len(returns[0]))]
    m, pv = fit(names, returns, l1, l2)
    coef = m['coefficients']  # (features, equations): coef[k, j] = equation j on series k's lag
    return {'name': name, 'lambda1': l1, 'lambda2': l2, 'returns': returns, 'lag': lag, 'expected': {
        'coef': [[float(coef[k, j]) for k in range(len(names))] for j in range(len(names))],  # [equation][lag]
        'sigma2': [float(s) ** 2 for s in m['sigma']],
        'prior': pv,  # [equation][lag]
        'g1': growth(m, names, lag, 1), 'g2': growth(m, names, lag, 2)}}


rng = random.Random(20261015)
A3 = [[0.1, 0.4, 0.0], [0.0, -0.2, 0.0], [0.2, 0.0, 0.3]]
cases = [
    case('3 series, a leading companion', var_returns(rng, 60, A3, [0.02, 0.03, 0.01]), 0.2, 0.5, [0.01, -0.02, 0.005]),
    case('3 series, tight λ1, loose λ2', var_returns(rng, 80, A3, [0.02, 0.03, 0.01]), 0.05, 1.0, [0.03, 0.02, -0.01]),
    case('4 series, 150 rows', var_returns(rng, 150, [[0.0, 0.3, 0.0, -0.2], [0.1, 0.0, 0.0, 0.0], [0.0, 0.0, 0.5, 0.0],
                                                     [0.0, 0.0, 0.2, 0.1]], [0.015, 0.02, 0.05, 0.002]), 0.5, 0.25,
         [0.02, 0.01, -0.03, 0.001]),
    case('2 series, minimum rows (7)', var_returns(rng, 8, [[0.3, 0.2], [0.0, 0.1]], [0.02, 0.02]), 0.1, 0.5, [0.01, 0.01]),
    case('a companion that never moves', [[r[0], r[1], 0.0] for r in var_returns(rng, 40, [[0.2, 0.1], [0.0, 0.0]], [0.02, 0.02])],
         0.2, 0.5, [0.01, 0.02, 0.0]),
    case('a step clamped at ±50 %', var_returns(rng, 30, [[0.5, 0.5], [0.5, 0.5]], [0.3, 0.3]), 0.5, 1.0, [0.9, 0.9]),
]

commit = subprocess.run(['git', '-C', str(NC), 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
print('{"source": %s,\n "cases": [\n  %s\n]}' % (json.dumps(f'namaste_club {commit}, numpy {np.__version__}, pandas {pd.__version__}'),
                                          ',\n  '.join(json.dumps(c) for c in cases)))
