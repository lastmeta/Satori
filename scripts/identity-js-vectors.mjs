// Write test/fixtures/identity-js.json: JS-made Evrmore signatures and a
// JS-exported Docker vault, for satorilib to check:
//   node scripts/identity-js-vectors.mjs && sh scripts/identity_fixtures.sh verify
import { readFileSync, writeFileSync } from 'node:fs';
import { signMessage } from '../src/identity/keys.js';
import { exportDockerWallet } from '../src/identity/docker.js';

const dir = new URL('../test/fixtures/', import.meta.url);
const fx = JSON.parse(readFileSync(new URL('identity-parity.json', dir)));
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
const signatures = fx.vectors.flatMap((v) => v.signatures.map(({ message }) => ({
  pubkey: v.pubkey, address: v.address, message, signature: signMessage(hex(v.entropyHex), message),
})));
const v = fx.vectors[0];
const password = 'js-export-pass';
const out = {
  about: 'Made by scripts/identity-js-vectors.mjs; satorilibVerified is set by scripts/identity_crossverify.py. Throwaway keys.',
  signatures,
  vault: { password, address: v.address, pubkey: v.pubkey, yaml: await exportDockerWallet(hex(v.entropyHex), { password }) },
  wallet: { address: v.address, yaml: await exportDockerWallet(hex(v.entropyHex)) },
  satorilibVerified: null,
};
writeFileSync(new URL('identity-js.json', dir), JSON.stringify(out, null, 2) + '\n');
console.log('wrote identity-js.json:', signatures.length, 'signatures');
