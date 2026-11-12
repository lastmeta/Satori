// Sub-wallets (docs/design/wallets.md#sub-wallets): words from Satori's mobile app or Satori GO (BIP-39, then BIP-44
// Evrmore) hold more keys than the one Import made: receive m/44'/175'/0'/0/i and change m/44'/175'/0'/1/i. The record's
//   hd: { kdf, cipher, data, words: 12 | 24, xpub, first, at: null | { change, index }, count }
// keeps the words sealed with the passphrase (to switch), and in clear the account's xpub, the import's own key (`first`),
// which key the wallet is now (`at`, null: `first`) and how many of each chain are listed, so the rows show and more are
// derived without the passphrase.
//
//   const hd = await sealWords(words, passphrase)        // Import of words
//   const view = subWallets(hd)                          // { at, count, rows: [{ n, kind, index, path, evrmore, address, inUse }] }
//   const secret = await secretAt(hd, n, passphrase)     // row n's key, from the words ('Wrong passphrase')
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { createBase58check } from '@scure/base';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { checkKey, secretFromText, publicKey, evmAddress, STANDARD_PATH } from './keys.js';
import { sealSecret, openSecret } from './wallet.js';

export const ACCOUNT = "m/44'/175'/0'"; // BIP-44, Evrmore's coin type 175: what Satori's mobile app and Satori GO use
export const MORE = 10; // listed at first, and added by "Derive 20 more", of each chain
const b58 = createBase58check(sha256);
const PUBKEY = /^0[23][0-9a-f]{64}$/;

/** An Evrmore (P2PKH) address of a compressed public key: base58check of version 33 and hash160, as those apps show it. */
export const evrmoreAddress = (pubkeyHex) => b58.encode(Uint8Array.of(33, ...ripemd160(sha256(hexToBytes(pubkeyHex)))));

const pathOf = ({ change, index }) => `${ACCOUNT}/${change}/${index}`;
/** Row n → which key: 0 the import's own (null), then Receive 0, Change 0, Receive 1, … */
const atOf = (n) => (n === 0 ? null : { change: (n - 1) % 2, index: Math.floor((n - 1) / 2) });
/** Which row a key is (`at`, null: the import's own). */
export const rowOf = (at) => (at ? 1 + 2 * at.index + at.change : 0);

/** Import's words (cleaned: keys.js keyFromText) → the record's `hd`, the words sealed with the wallet's passphrase. */
export async function sealWords(words, passphrase) {
  const bytes = utf8ToBytes(words);
  const seed = mnemonicToSeedSync(words);
  const first = secretFromText(words);
  try {
    return { ...await sealSecret(bytes, passphrase), words: words.split(' ').length,
      xpub: HDKey.fromMasterSeed(seed).derive(ACCOUNT).publicExtendedKey, first: publicKey(first), at: null, count: MORE };
  } finally {
    [bytes, seed, first].forEach((b) => b.fill(0));
  }
}

/** A stored `hd` as sealWords makes it (the record's check). */
export const hdOk = (h) => !!h && typeof h.data === 'string' && h.kdf?.name === 'PBKDF2' && h.cipher?.name === 'AES-GCM'
  && (h.words === 12 || h.words === 24) && /^xpub[1-9A-HJ-NP-Za-km-z]{107}$/.test(h.xpub) && PUBKEY.test(h.first)
  && Number.isSafeInteger(h.count) && h.count >= MORE
  && (h.at === null || ((h.at?.change === 0 || h.at?.change === 1) && Number.isSafeInteger(h.at.index) && h.at.index >= 0 && h.at.index < h.count));

/** Each row's public key, from the xpub (no passphrase): the import's own first, then receive and change alternating. */
function pubkeys(hd) {
  const account = HDKey.fromExtendedKey(hd.xpub);
  const chains = [account.deriveChild(0), account.deriveChild(1)];
  const out = [hd.first];
  for (let i = 0; i < hd.count; i++) for (const c of chains) out.push(bytesToHex(c.deriveChild(i).publicKey));
  return out;
}

/** The Sub-wallets card's list, or null (not imported from words). path: null for 24 words' own key (no path). */
export function subWallets(hd) {
  if (!hd) return null;
  const inUse = rowOf(hd.at);
  return { at: hd.at, count: hd.count, rows: pubkeys(hd).map((pubkey, n) => {
    const at = atOf(n);
    return { n, kind: !at ? 'import' : at.change ? 'change' : 'receive', index: at?.index ?? null,
      path: at ? pathOf(at) : hd.words === 12 ? STANDARD_PATH : null, evrmore: evrmoreAddress(pubkey), address: evmAddress(pubkey), inUse: n === inUse };
  }) };
}

/** Which key row n is (null: the import's own), or a throw: not listed. */
export function rowAt(hd, n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 * hd.count) throw new Error(`No sub-wallet ${n}: rows 0 to ${2 * hd.count}.`);
  return atOf(n);
}

/** Row n's secret, from the words opened with the passphrase; it must be the key the row shows. */
export async function secretAt(hd, n, passphrase) {
  const at = rowAt(hd, n);
  const bytes = await openSecret(hd, passphrase); // 'Wrong passphrase'
  const words = new TextDecoder().decode(bytes);
  bytes.fill(0);
  let secret;
  if (!at) secret = secretFromText(words);
  else {
    const seed = mnemonicToSeedSync(words);
    try {
      secret = checkKey(HDKey.fromMasterSeed(seed).derive(pathOf(at)).privateKey);
    } finally {
      seed.fill(0);
    }
  }
  if (publicKey(secret) !== pubkeys({ ...hd, count: at ? at.index + 1 : 0 })[n]) {
    secret.fill(0);
    throw new Error('The stored sub-wallets do not match their words.');
  }
  return secret;
}
