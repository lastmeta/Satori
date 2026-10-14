# ElectrumX over WSS: one host down, not advertised

**Status:** open · **Kind:** fixable, minor · **Fix in:** ElectrumX operators · **Matters for:** Evrmore balances and sends (later)

Browsers cannot open the raw TCP/TLS sockets satorilib uses on 50001/50002
(`satorilib/src/satorilib/electrumx/electrumx.py:103-116`,
`satorilib/src/satorilib/electrumx/connection.py:56`). WSS on 50004 works
(probed 2026-10-14): `electrumx1.satorinet.io`, `electrum1-mainnet.evrmorecoin.org`,
`electrum2-mainnet.evrmorecoin.org` completed the upgrade with valid
certificates and answered `blockchain.headers.subscribe`.

Gaps:

- `evrx-1.satoriog.com:50004` timed out; fix or drop it from the list.
- Only `electrumx1.satorinet.io` advertises a wss service in `server.features`;
  the evrmorecoin.org hosts serve it without advertising it. Set `SERVICES` to
  include `wss://:50004` so clients can discover it.
