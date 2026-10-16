// Central's login signature: EIP-191 personal_sign by the identity, as central
// verifies it (central base-upgrade f4d72f5, src/utils/auth.py
// verify_wallet_signature) and Satori Lite signs it (satorilib 5028913).
// Checked against central's own vector and, independently, with viem.
import { describe, expect, test, vi } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hexToBytes, verifyMessage } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import { loginSignature } from './login.js';
import { createCentral } from './index.js';
import { loadKeys } from '../keys/index.js';
import { publicKey, evmAddress } from '../keys/keys.js';

vi.setConfig({ testTimeout: 60_000 }); // shared box; noble builds tables on first use

// Central's vector (base-upgrade f4d72f5), checked live on central2 2026-10-16.
const V = {
  key: '0x544bcf3860d915aead54c850d463a95295138b2dd3306e7b5bedfcd16b3274d3',
  pubkey: '03a3a5a386e0b6af81e54dac571961f68a6d37183f41f39a297feea28ae8add34a',
  address: '0x2F66D2d1DfA3cbF191dd26394d3b241C90B57E74',
  message: 'satori central eip191 login test 2026-10-16',
  signature: '0xd76997c6e1d644a32f7831b26092a8bd7b94ce654f82580ee16bf6378523ed4d552aec5cd3694719f7e2dcb8c7fe7076eabe3a787ae1c15cdce69f2c6ab970111b',
};
const HALF_N = secp256k1.CURVE.n / 2n;
/** The Ethereum address of a compressed pubkey (hex), by viem: what central compares the recovered signer with. */
const addressOf = (pubkey) => publicKeyToAddress(`0x${secp256k1.ProjectivePoint.fromHex(pubkey).toHex(false)}`);

describe("central's login signature: EIP-191", () => {
  test("central's vector, exactly (RFC 6979)", () => {
    const key = hexToBytes(V.key);
    expect(publicKey(key)).toBe(V.pubkey);
    expect(evmAddress(V.pubkey)).toBe(V.address);
    expect(addressOf(V.pubkey)).toBe(V.address);
    expect(loginSignature(key, V.message)).toBe(V.signature);
  });

  test.each(['c-0', '', 'a challenge, 1792160000.25', 'ünïcödé 密码 🔑'])('the form central takes, viem verifies it: %j', async (message) => {
    const key = hexToBytes(V.key);
    const sig = loginSignature(key, message);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/); // r ‖ s ‖ v
    expect(['1b', '1c']).toContain(sig.slice(-2)); // v = 27 or 28
    expect(BigInt(`0x${sig.slice(66, 130)}`) <= HALF_N).toBe(true); // low s
    expect(loginSignature(key, message)).toBe(sig); // deterministic
    expect(await verifyMessage({ address: V.address, message, signature: sig })).toBe(true);
    expect(await verifyMessage({ address: V.address, message: `${message}!`, signature: sig })).toBe(false);
  });
});

describe('login against a central that checks EIP-191 itself (viem verifyMessage)', () => {
  const BASE = 'https://central.test';
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  /** challenge → login (EIP-191 by the wallet-pubkey's address, else 401) → the batch, with the token. */
  function centralChecking() {
    const logins = [];
    const fetch = vi.fn(async (url, { method = 'GET', headers = {} } = {}) => {
      const path = `${method} ${url.slice(BASE.length)}`;
      if (path === 'GET /api/v1/auth/challenge') return json(200, { challenge: 'b1e5c0de-challenge' });
      if (path === 'POST /api/v1/auth/login') {
        const ok = /^0x[0-9a-fA-F]{130}$/.test(headers.signature) && await verifyMessage({
          address: addressOf(headers['wallet-pubkey']), message: headers.message, signature: headers.signature,
        }).catch(() => false); // recovers no key: central answers 401 too
        logins.push({ ...headers, ok });
        return ok ? json(200, { access_token: 'jwt', expires_in: 3600 }) : json(401, { detail: 'Invalid signature' });
      }
      if (path === 'POST /api/v1/predictions/batch' && headers.authorization === 'Bearer jwt') return json(200, { successful: 1 });
      return json(401, { detail: 'no' });
    });
    return { fetch, logins };
  }
  // The identity as the app holds it: the record's plain-text key, through loadKeys (the vault is not opened).
  const identity = loadKeys({ v: 1, identity: V.key.slice(2), nostr: '11'.repeat(32),
    vault: { pubkey: publicKey(new Uint8Array(32).fill(2)), data: '' } }).identity;

  test("the app's identity logs in and its batch is taken", async () => {
    const { fetch, logins } = centralChecking();
    const central = createCentral({ url: BASE, fetch, identity, version: '0.1.0' });
    expect(await central.submitPredictions([{ stream_uuid: 'u' }])).toEqual({ successful: 1 });
    expect(logins).toEqual([{ 'wallet-pubkey': V.pubkey, message: 'b1e5c0de-challenge',
      signature: loginSignature(hexToBytes(V.key), 'b1e5c0de-challenge'), ok: true }]);
  });

  test('a tampered signature, or another key\'s, is refused (401)', async () => {
    const sig = identity.signCentralLogin('b1e5c0de-challenge');
    for (const signCentralLogin of [
      () => `${sig.slice(0, 10)}${sig[10] === '0' ? '1' : '0'}${sig.slice(11)}`,
      () => loginSignature(new Uint8Array(32).fill(3), 'b1e5c0de-challenge'),
    ]) {
      const { fetch, logins } = centralChecking();
      const central = createCentral({ url: BASE, fetch, identity: { pubkey: V.pubkey, signCentralLogin }, version: '0.1.0' });
      await expect(central.submitPredictions([])).rejects.toMatchObject({ status: 401, detail: 'Invalid signature' });
      expect(logins.map((l) => l.ok)).toEqual([false]);
    }
  });
});
