// The alias and the Nostr key, derived from the wallet (docs/design/wallets.md#derived-keys): a BIP-32 master from the
// wallet's BIP-39 seed (a wallet in the app) or from a connected wallet's signature of a fixed text, then
//   the alias      m/44'/60'/1'/0'/i'   (fully hardened: a leaked alias gives nothing above it)
//   the Nostr key  m/44'/1237'/i'/0/0   (NIP-06)
//
//   const { alias, nostr } = keysFromWallet(walletSecret)   // alias: 32 bytes; nostr: hex (keysFromWords: any words)
//   const { alias, nostr } = keysFromSignature(signature)   // null: not a 65-byte signature
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { getAddress } from 'viem';
import { wordsOf } from './keys.js';

export const aliasPath = (i = 0) => `m/44'/60'/1'/0'/${i}'`;
export const nostrPath = (i = 0) => `m/44'/1237'/${i}'/0/0`;

/** The text a connected wallet signs to make the app's keys: fixed (no time), so the same wallet signs it the same way. */
export const keysText = (address) => `Satori: make this app's keys\nwallet: ${getAddress(address)}`;

function fromMaster(master, i) {
  const at = (path) => {
    const k = master.derive(path).privateKey;
    if (!k) throw new Error(`No key at ${path}.`);
    return k;
  };
  return { alias: at(aliasPath(i)), nostr: bytesToHex(at(nostrPath(i))) };
}

/** A wallet in the app: its 24 words' BIP-39 seed (no extra passphrase) is the master. */
export const keysFromWallet = (walletSecret, i = 0) => keysFromWords(wordsOf(walletSecret), i);

/** BIP-39 words (any length) → their keys. */
export function keysFromWords(words, i = 0) {
  const seed = mnemonicToSeedSync(words);
  try {
    return fromMaster(HDKey.fromMasterSeed(seed), i);
  } finally {
    seed.fill(0);
  }
}

/** A connected wallet's signature of keysText (0x hex, 65 bytes) → HKDF-SHA256 → the master; null for another length. */
export function keysFromSignature(signature, i = 0) {
  const sig = hexToBytes(String(signature).replace(/^0x/, ''));
  if (sig.length !== 65) return null; // a smart-contract wallet's: not a key's own signature
  const seed = hkdf(sha256, sig, utf8ToBytes('satori'), utf8ToBytes('satori keys v1'), 64);
  try {
    return fromMaster(HDKey.fromMasterSeed(seed), i);
  } finally {
    seed.fill(0);
  }
}
