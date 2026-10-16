Parity vectors for `src/keys/`, `src/central/` and `src/engine/`. Throwaway keys.

- `profiles.json`: the keys each earlier version of this app stored (its
  `meta` rows), made by that version's own code: the step-1 sealed key,
  `wallet.yaml`/`vault.yaml` with the passphrase as UTF-8 and as Latin-1
  bytes, with and without `nostr.yaml`, Docker imports (kept as given, an old
  vault re-written, a plain-text vault, one with no plain `publicKey`), and a
  setup cut off. `scripts/profile_fixtures.mjs` (run on each commit's `src`;
  the commands are in the script). For the forward migration.
- `identity-parity.json`: made from satorilib (the Docker neuron's code) by
  `scripts/identity_fixtures.py` on branch `draft/v1-full`: words, WIF, pubkey,
  address, scripthash, `wallet.yaml`, Evrmore message signatures; current and
  old vaults with their password and a wrong one; a WIF-only and a mismatched
  file; a Nostr key (for step 5).
- `identity-js.json`: signatures, a `wallet.yaml` and a `vault.yaml` made by
  this JS code, which satorilib accepted
  (`scripts/identity_crossverify.py` on `draft/v1-full`).
- `satorilib-edges.json`: edge cases from satorilib's own code
  (`scripts/satorilib_edges.py`, run against the satorilib source with
  Docker's package versions): a vault whose password is Latin-1 (pycryptodome
  turns a str password into Latin-1 bytes), the plain-text vault satorilib
  saves when the password is outside Latin-1, and a signature flagged
  uncompressed with what python-evrmorelib verifies it against.
- `engine-parity.json`: 10 series and what namaste_club's own code makes of
  them (lag 1, one stream, no time features): φ, the first lag, g1/g2, the
  backtest weight, t1 and t2. Made by `scripts/engine_parity.py` from the
  namaste_club source (read only), with numpy and pandas in a scratch venv.
- `bvar-parity.json`: 6 tables of 12 h returns (2–4 series, 7–150 rows, every
  λ grid edge, a series that never moves, a step at the ±50 % clamp) and what
  namaste_club's `train_bvar_model` and `iterate_forecast` make of them (no
  time features): every equation's posterior mean, σ² and prior variances,
  and each series' growth after one and two steps. Made by
  `scripts/bvar_parity.py` the same way.
- `nostr-parity.json` (the fields, tags and signatures; our content is compact JSON, not these bytes): Satori's Nostr events (`_pred` 34601, its 34600
  announcement and tombstone, the 34602 subscribe and unsubscribe, a 10002)
  built by satorilib's own `SatoriNostr` methods (`origin/base-upgrade`) and
  signed by nostr-sdk 0.45 with the `nostr` key above, the clock pinned; Lite's
  `_numericObservationValue` on 17 values; the relay uuid Lite pins in
  `neuron/tests/test_relay_ids.py`. Made by `scripts/nostr_vectors.py`.
- `nostr-live.json`: two 34601 events as `ws://satorian.satorinet.io:7777`
  served them (a read-only REQ, 2026-10-15): a free price stream and a Base
  bridge stream whose value is a dict.
