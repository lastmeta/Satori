# Prod central does not serve Base config or merkle proofs

**Status:** open · **Blocks:** merkle claim against prod · **Fix in:** central deploy

## Finding (verified by live probe, 2026-10-14)

- `https://network.satorinet.io/api/v1/base/config` → 404.
- `https://network.satorinet.io/api/v1/merkle/proof/{address}` → 404.
- Both exist in the local repo (`central/src/api/v1/endpoints/base.py:15-19`,
  `central/src/api/v1/endpoints/merkle.py:26-45`, commit de7d460) and are served by
  `https://central2.satorinet.io`.

Docker neurons on prod silently fall back to hard-coded DEFAULTS
(`neuron/neuron-lite/satorineuron/base_config.py:20-36,66-88`).

## Fix

Deploy central with those routers. Consider adding `relayerUrl` and
`indexerUrl` to the base config payload (today only in
`contract/satori-ui/src/contracts/addresses.ts:231-236`).

## Browser workaround

Bundle the addresses; let the user choose central (prod / central2) in
Settings.
