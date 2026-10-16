# Central's login accepts only Evrmore signatures

**Status:** open · **Kind:** foundation fix (proposal) · **Fix in:** central

## Today (verified on `central` base-upgrade)

Both of central's signature checks take one format, an Evrmore signed message:

- `POST /api/v1/auth/login` (the JWT login every neuron uses):
  `central/src/api/v1/endpoints/auth.py:5` imports
  `from satorilib.wallet.evrmore.verify import verify as evrmore_verify`, and
  `:45` calls `evrmore_verify(message=message, signature=signature, publicKey=wallet_pubkey)`.
- The legacy header auth (`authenticate`, `central/src/main.py:120-170`,
  verify at `:166`), which `get_authenticated_wallet`
  (`central/src/api/dependencies.py:10`) falls back to.

The format (satorilib `wallet/evrmore/verify.py:15-36`, python-evrmorelib
`signmessage.py:39-87`): sha256d of `varint(24) ‖ "Evrmore Signed Message:\n"
‖ varint(len) ‖ utf8(message)`; the signature is base64 of 65 bytes, a header
byte (27 + recovery id, + 4 for a compressed key) and r ‖ s; the recovered
key must equal `wallet-pubkey`.

So every neuron must carry Evrmore message signing to log in, though the
network now runs on Base: the browser neuron shows Base addresses only, and
keeps this format in `src/central/login.js` for this one call.

## Proposal

Accept **EIP-191** (`personal_sign`, what every Ethereum wallet and library
makes) as well, keyed by the same `wallet-pubkey` header, so peers stay keyed
by pubkey and nothing else changes:

- **Message hash:** `keccak256("\x19Ethereum Signed Message:\n" ‖ decimal
  len(message) ‖ message)`.
- **Signature:** `0x` and 130 hex characters: r ‖ s ‖ v (v 27 or 28). Its
  form tells it from the Evrmore one (88 base64 characters), so no new header
  is needed (an explicit `signature-scheme: eip191` header would also do).
- **Check:** recover the address and compare it with the Base address of
  `wallet-pubkey` (keccak256 of the uncompressed key, last 20 bytes).
  `eth-account` is already in `central/requirements.txt:52` and imported
  nowhere: `Account.recover_message(encode_defunct(text=message),
  signature=signature)`.
- **Where:** one helper, e.g. `verify_login(message, signature, pubkey)` in
  `central/src/utils/auth.py`, used at `auth.py:45` and `main.py:166`; the
  Evrmore path stays for Docker neurons.

The challenge (`GET /auth/challenge`) and the rest of the login are
unchanged. Together with [central-login-replayable](central-login-replayable.md)
(make the challenge single-use), the login is then fresh and Base-native.

## What it would remove here

- `loginSignature` and `verifyLoginSignature` in `src/central/login.js`: the
  identity signs with `personal_sign` over the same secp256k1 key (viem and
  `@noble/curves` are already here).
- `centralAddress` too, if register's answer also said the vault by its
  pubkey or Base address (today it returns `wallet_address` and
  `vault_address` in central's own address form only, `central/src/main.py:772-897`),
  which the app compares to show a vault mismatch.

Then the browser neuron has no Evrmore code at all.
