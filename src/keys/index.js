// The neuron's keys, in this app's own record, meta `keys` (docs/design/keys.md):
//   { v: 1, identity: hex, nostr: hex, vault: { pubkey, kdf, cipher, data } }
// identity — plain text on purpose: the neuron signs on its own (central's login, the Base batch);
// nostr    — plain text on purpose: it signs the Nostr events on its own; random, not derived;
// vault    — sealed with the passphrase (vault.js), holds the funds; its public key in clear,
//            so its Base address shows and central's register has it while locked.
// An earlier version's vault, until its next Unlock: vault: { pubkey | null, yaml } (Docker's text).
//
//   const record = await newKeys({ identity?, vault, nostr? }, passphrase)   // create, restore, import
//   const secrets = await readDockerFiles({ walletText, vaultText, password, nostrText? })  // import: translate
//   const record = await recordFromRows({ walletYaml, vaultYaml, nostrYaml? })  // migration 7: earlier rows
//   const { identity, nostr, vault } = loadKeys(record)   // identity: a signer; vault: { pubkey, evmAddress }
//   const { vault, record } = await unlockVault(record, passphrase)   // record: store it (an upgrade), or null
//   signer: pubkey, evmAddress, signDigest(hash), backup() → { words, privateKey }, lock();
//           the identity's also signCentralLogin(challenge) (EIP-191, central's login: src/central/login.js)
export { generateSecret, secretFromWords, wordsOf, publicKey, evmAddress } from './keys.js';
export { MIN_PASSPHRASE, passphraseOk } from './vault.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { checkKey, generateSecret, publicKey, wordsOf, evmAddress, signDigest, privateKeyHex } from './keys.js';
import { sealSecret, openSecret, checkNewPassphrase } from './vault.js';
import { readWallet, readNostrYaml, secrecy, vaultPubkey } from './docker.js';
import { loginSignature } from '../central/login.js';
import { generateNostrSecret, nostrPubkey } from '../nostr/event.js';

export const RECORD_VERSION = 1;
const HEX64 = /^[0-9a-f]{64}$/;
const PUBKEY = /^0[23][0-9a-f]{64}$/;

const sameKey = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
const notSame = (x, y) => {
  if (sameKey(x, y)) throw new Error('The identity and the vault must not be the same key.');
};

/** A signer over a 32-byte secret; lock() wipes it. `login`: central's login signature, EIP-191 (the identity's). */
function signer(secret, { login = false } = {}) {
  const pubkey = publicKey(secret);
  const live = () => {
    if (!secret) throw new Error('Locked');
    return secret;
  };
  const s = {
    pubkey,
    evmAddress: evmAddress(pubkey), // Base (docs/design/base.md#keys-on-base)
    get locked() { return secret === null; },
    /** A Base transaction's signature: the key never leaves this closure. */
    signDigest: (hash) => signDigest(live(), hash),
    /** The 24 words and the private key (0x hex, what a Base wallet imports), for backup. */
    backup: () => ({ words: wordsOf(live()), privateKey: privateKeyHex(live()) }),
    lock() {
      secret?.fill(0);
      secret = null;
    },
  };
  if (login) s.signCentralLogin = (challenge) => loginSignature(live(), challenge); // src/central/login.js
  return s;
}

const nostrOf = (secret) => {
  try {
    return { secret, pubkey: nostrPubkey(secret) };
  } catch {
    throw new Error('Not a Nostr secret key (64 hex characters).');
  }
};

/** A new record: the vault (and an identity and a Nostr key, random when not given), sealed with a new passphrase. */
export async function newKeys({ identity = generateSecret(), vault, nostr = generateNostrSecret() }, passphrase) {
  checkNewPassphrase(passphrase);
  notSame(checkKey(identity), checkKey(vault));
  nostrOf(nostr);
  return { v: RECORD_VERSION, identity: bytesToHex(identity), nostr,
    vault: { pubkey: publicKey(vault), ...await sealSecret(vault, passphrase) } };
}

/**
 * A Dockerized Neuron's files and its vault password → the secrets, to seal
 * with this app's passphrase (newKeys). wallet.yaml must be plain text and
 * vault.yaml encrypted (files in the wrong slots are named as such); refuses a
 * wrong password, a watch-only file and a file whose stored public key, words
 * or private key are not its key's. nostr.yaml is optional (undefined: none).
 * @returns {Promise<{identity: Uint8Array, vault: Uint8Array, nostr?: string}>}
 */
export async function readDockerFiles({ walletText, vaultText, password, nostrText }) {
  const [w, v] = [secrecy(walletText), secrecy(vaultText)];
  if (w === 'encrypted' && v === 'plain') {
    throw new Error('The files are swapped: wallet.yaml is the unencrypted one, vault.yaml the encrypted one.');
  }
  if (w === 'encrypted' || w === 'mixed') {
    throw new Error('wallet.yaml: this file is encrypted, so it is a vault.yaml. Choose the unencrypted wallet.yaml.');
  }
  if (v === 'plain' || v === 'mixed') {
    throw new Error('vault.yaml: this file is not encrypted, so it is not a vault. Choose the encrypted vault.yaml.');
  }
  const nostr = nostrText ? readNostrYaml(nostrText).secret : undefined;
  const read = async (name, text, opts) => {
    try {
      const r = await readWallet(text, opts);
      if (r.mismatches.length) throw new Error(`stored ${r.mismatches.join(', ')} do not match its key`);
      return r.secret;
    } catch (err) {
      throw new Error(`${name}: ${err.message}`);
    }
  };
  const identity = await read('wallet.yaml', walletText);
  const vault = await read('vault.yaml', vaultText, { password: String(password ?? '') });
  notSame(identity, vault);
  return { identity, vault, nostr };
}

/**
 * This app's earlier rows (wallet.yaml, vault.yaml and nostr.yaml texts) → the
 * record, at load (migration 7). The identity and the Nostr key are plain text,
 * so they are translated now (a new Nostr key when there was none, as the load
 * before step 5 made one); the vault needs the passphrase, so its text is kept
 * until its next Unlock (unlockVault), its public key in clear when it had one.
 */
export async function recordFromRows({ walletYaml, vaultYaml, nostrYaml }) {
  const id = await readWallet(walletYaml);
  if (id.mismatches.length) throw new Error(`The stored identity's ${id.mismatches.join(', ')} do not match its key.`);
  return { v: RECORD_VERSION, identity: bytesToHex(id.secret),
    nostr: nostrYaml ? readNostrYaml(nostrYaml).secret : generateNostrSecret(),
    vault: { pubkey: vaultPubkey(vaultYaml), yaml: vaultYaml } };
}

function checkRecord(r) {
  if (!r || typeof r !== 'object') throw new Error('No keys stored.');
  if (r.v > RECORD_VERSION) throw new Error(`These keys were stored by a newer version of the app (record ${r.v}).`);
  if (r.v !== RECORD_VERSION || !HEX64.test(r.identity) || !HEX64.test(r.nostr)) throw new Error('The stored keys are not readable.');
  const v = r.vault ?? {};
  const sealed = typeof v.data === 'string' && PUBKEY.test(v.pubkey);
  const legacy = typeof v.yaml === 'string' && (v.pubkey === null || PUBKEY.test(v.pubkey));
  if (!sealed && !legacy) throw new Error('The stored vault is not readable.');
  return r;
}

/** The record's keys: the identity's signer, the Nostr key, the vault's public key and Base address (null until an old vault's Unlock). */
export function loadKeys(record) {
  const r = checkRecord(record);
  const pubkey = r.vault.pubkey ?? null;
  return {
    identity: signer(checkKey(hexToBytes(r.identity)), { login: true }),
    nostr: nostrOf(r.nostr),
    vault: { pubkey, evmAddress: pubkey && evmAddress(pubkey) },
  };
}

/**
 * Unlock: the vault's secret into memory. A wrong passphrase → 'Wrong
 * passphrase'. A vault in an earlier version's form (Docker's vault.yaml text)
 * is opened as that version did (the passphrase's Latin-1, else UTF-8 bytes;
 * a plain-text one needs a new passphrase that meets the rule), sealed in this
 * app's format with the same passphrase, and that is checked by opening it
 * again: `record` is then the record to store, else null.
 * @returns {Promise<{vault: ReturnType<typeof signer>, record: object | null}>}
 */
export async function unlockVault(record, passphrase) {
  const r = checkRecord(record);
  const pass = String(passphrase ?? '');
  if (typeof r.vault.data === 'string') {
    const secret = await openSecret(r.vault, pass);
    if (publicKey(secret) !== r.vault.pubkey) throw new Error('The stored vault does not match its public key.');
    return { vault: signer(secret), record: null };
  }
  const plain = secrecy(r.vault.yaml) === 'plain';
  if (plain) checkNewPassphrase(pass);
  const { secret, pubkey, mismatches } = await readWallet(r.vault.yaml, plain ? {} : { password: pass, encodings: ['latin1', 'utf8'] });
  if (mismatches.length || (r.vault.pubkey && pubkey !== r.vault.pubkey)) {
    secret.fill(0);
    throw new Error('Wrong passphrase');
  }
  const sealed = await sealSecret(secret, pass);
  if (!sameKey(await openSecret(sealed, pass), secret)) throw new Error('Re-encrypting the vault failed; it was kept as it was.');
  return { vault: signer(secret), record: { ...r, vault: { pubkey, ...sealed } } };
}
