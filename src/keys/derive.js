// The alias and the Nostr key, derived from a wallet in the app (docs/design/wallets.md#derived-keys): a BIP-32 master
// from its BIP-39 seed, then
//   the alias      m/44'/60'/1'/0'/i'   (fully hardened: a leaked alias gives nothing above it)
//   the Nostr key  m/44'/1237'/i'/0/0   (NIP-06)
//
//   const { alias, nostr } = keysFromWallet(walletSecret)   // alias: 32 bytes; nostr: hex (keysFromWords: any words)
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { bytesToHex } from '@noble/hashes/utils';
import { wordsOf } from './keys.js';

export const aliasPath = (i = 0) => `m/44'/60'/1'/0'/${i}'`;
export const nostrPath = (i = 0) => `m/44'/1237'/${i}'/0/0`;

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
