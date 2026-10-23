// The app's keys, in its own record, meta `keys` (docs/design/keys.md, docs/design/wallets.md):
//   { v: 1, alias: hex, nostr: hex, wallet: { pubkey, kdf, cipher, data }, link: { message, signature } }
// alias  — plain text on purpose: the app signs on its own (central's login, the Base batch);
// nostr  — plain text on purpose: it signs the Nostr events on its own; random, not derived;
// wallet — sealed with the passphrase (wallet.js), holds the funds; its public key in clear,
//          so its Base address shows while locked;
// link   — the wallet's EIP-191 signature of its link to the alias (linkMessage), sent with every register;
//          made whenever the wallet is in hand (newKeys, an Unlock without one).
// An earlier version's wallet, until its next Unlock: wallet: { pubkey | null, yaml } (Docker's text).
//
//   const record = await newKeys({ alias?, wallet, nostr? }, passphrase)   // create, restore, import
//   const secrets = await readDockerFiles({ aliasText, walletText, password, nostrText? })  // import: translate
//   const record = await recordFromRows({ aliasYaml, walletYaml, nostrYaml? })  // migration 7: earlier rows
//   const { alias, nostr, wallet } = loadKeys(record)   // alias: a signer; wallet: { pubkey, evmAddress }
//   const { wallet, record } = await unlockWallet(record, passphrase)   // record: store it (an upgrade), or null
//   await withPassphrase(record, passphrase, (wallet) => …)   // the wallet for one use (Send), wiped after it
//   await backupKeys(record, which, passphrase)   // Backup: the passphrase each time, unlocked or not
//   signer: pubkey, evmAddress, signDigest(hash), backup() → { words, privateKey }, lock();
//           the alias's also signCentralLogin(challenge) (EIP-191, central's login: src/central/login.js);
//           the wallet's also signLink(aliasAddress) → the record's link
export { generateSecret, secretFromWords, wordsOf, publicKey, evmAddress } from './keys.js';
export { MIN_PASSPHRASE, passphraseOk } from './wallet.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { checkKey, generateSecret, publicKey, wordsOf, evmAddress, signDigest, privateKeyHex } from './keys.js';
import { sealSecret, openSecret, checkNewPassphrase } from './wallet.js';
import { readKeyFile, readNostrYaml, secrecy, walletPubkey } from './docker.js';
import { loginSignature } from '../central/login.js';
import { generateNostrSecret, nostrPubkey, nsec } from '../nostr/event.js';

export const RECORD_VERSION = 1;
/** The largest Dockerized Neuron file read (bytes): satorilib's are under 2 KB; a bigger one is refused before parsing. */
export const IMPORT_MAX = 65_536;
const HEX64 = /^[0-9a-f]{64}$/;
const PUBKEY = /^0[23][0-9a-f]{64}$/;

const sameKey = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
const notSame = (x, y) => {
  if (sameKey(x, y)) throw new Error('The alias and the wallet must not be the same key.');
};

/** A signer over a 32-byte secret; lock() wipes it. `login`: central's login signature, EIP-191 (the alias's). */
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
  else s.signLink = (aliasAddress, issued) => linkOf(live(), aliasAddress, issued);
  return s;
}

/** The text a wallet signs to link its alias for the Satori Network (docs/design/wallets.md#the-satori-network-register-login-and-the-link). */
export const linkMessage = ({ alias, wallet, issued }) =>
  `Satori: link this alias to my wallet\nalias: ${alias}\nwallet: ${wallet}\nissued: ${issued}`;

/** The link, signed by the wallet's secret: { message, signature } (EIP-191, as central's login). */
function linkOf(walletSecret, aliasAddress, issued = Math.floor(Date.now() / 1000)) {
  const message = linkMessage({ alias: aliasAddress, wallet: evmAddress(publicKey(walletSecret)), issued });
  return { message, signature: loginSignature(walletSecret, message) };
}

const nostrOf = (secret) => {
  try {
    return { secret, pubkey: nostrPubkey(secret) };
  } catch {
    throw new Error('Not a Nostr secret key (64 hex characters).');
  }
};

/**
 * A new record: the wallet (and an alias and a Nostr key, random when not given), sealed with a new passphrase;
 * `created`: when (unix seconds), Home's first day (docs/design/health.md#the-day-strip).
 */
export async function newKeys({ alias = generateSecret(), wallet, nostr = generateNostrSecret() }, passphrase) {
  checkNewPassphrase(passphrase);
  notSame(checkKey(alias), checkKey(wallet));
  nostrOf(nostr);
  const created = Math.floor(Date.now() / 1000);
  return { v: RECORD_VERSION, created, alias: bytesToHex(alias), nostr,
    wallet: { pubkey: publicKey(wallet), ...await sealSecret(wallet, passphrase) },
    link: linkOf(wallet, evmAddress(publicKey(alias)), created) };
}

/**
 * A Dockerized Neuron's files and its wallet password → the secrets, to seal
 * with this app's passphrase (newKeys). wallet.yaml must be plain text and
 * vault.yaml encrypted (files in the wrong slots are named as such); refuses a
 * wrong password, a watch-only file and a file whose stored public key, words
 * or private key are not its key's. nostr.yaml is optional (undefined: none).
 * @returns {Promise<{alias: Uint8Array, wallet: Uint8Array, nostr?: string}>}
 */
export async function readDockerFiles({ aliasText, walletText, password, nostrText }) {
  const named = (name, fn) => {
    try { return fn(); } catch (err) { throw new Error(err.message.startsWith(name) ? err.message : `${name}: ${err.message}`); }
  };
  for (const [name, text] of [['The alias file', aliasText], ['The wallet file', walletText], ['The Nostr file', nostrText]]) {
    // UTF-8 never has fewer bytes than UTF-16 units: a long text is refused before it is encoded
    const t = String(text ?? '');
    if (t.length > IMPORT_MAX || new TextEncoder().encode(t).length > IMPORT_MAX) throw new Error(`${name}: over 64 KB, so not a Docker file.`);
  }
  const [a, w] = [named('The alias file', () => secrecy(aliasText)), named('The wallet file', () => secrecy(walletText))];
  if (a === 'encrypted' && w === 'plain') {
    throw new Error('The files are swapped: the alias file is the unencrypted one, the wallet file the encrypted one.');
  }
  if (a === 'encrypted' || a === 'mixed') {
    throw new Error('The alias file: this file is encrypted, so it is a wallet file. Choose the unencrypted alias file.');
  }
  if (w === 'plain' || w === 'mixed') {
    throw new Error('The wallet file: this file is not encrypted, so it is not a wallet. Choose the encrypted wallet file.');
  }
  const nostr = nostrText ? named('The Nostr file', () => readNostrYaml(nostrText)).secret : undefined;
  const read = async (name, text, opts) => {
    try {
      const r = await readKeyFile(text, opts);
      if (r.mismatches.length) throw new Error(`stored ${r.mismatches.join(', ')} do not match its key`);
      return r.secret;
    } catch (err) {
      throw new Error(`${name}: ${err.message}`);
    }
  };
  const alias = await read('The alias file', aliasText);
  const wallet = await read('The wallet file', walletText, { password: String(password ?? '') });
  notSame(alias, wallet);
  return { alias, wallet, nostr };
}

/**
 * This app's earlier rows (wallet.yaml, vault.yaml and nostr.yaml texts) → the
 * record, at load (migration 7). The alias and the Nostr key are plain text,
 * so they are translated now (a new Nostr key when there was none, as the load
 * before step 5 made one); the wallet needs the passphrase, so its text is kept
 * until its next Unlock (unlockWallet), its public key in clear when it had one.
 */
export async function recordFromRows({ aliasYaml, walletYaml, nostrYaml }) {
  const id = await readKeyFile(aliasYaml);
  if (id.mismatches.length) throw new Error(`The stored alias's ${id.mismatches.join(', ')} do not match its key.`);
  return { v: RECORD_VERSION, alias: bytesToHex(id.secret),
    nostr: nostrYaml ? readNostrYaml(nostrYaml).secret : generateNostrSecret(),
    wallet: { pubkey: walletPubkey(walletYaml), yaml: walletYaml } };
}

function checkRecord(r) {
  if (!r || typeof r !== 'object') throw new Error('No keys stored.');
  if (r.v > RECORD_VERSION) throw new Error(`These keys were stored by a newer version of the app (record ${r.v}).`);
  if (r.v !== RECORD_VERSION || !HEX64.test(r.alias) || !HEX64.test(r.nostr)) throw new Error('The stored keys are not readable.');
  const v = r.wallet ?? {};
  const sealed = typeof v.data === 'string' && PUBKEY.test(v.pubkey);
  const legacy = typeof v.yaml === 'string' && (v.pubkey === null || PUBKEY.test(v.pubkey));
  if (!sealed && !legacy) throw new Error('The stored wallet is not readable.');
  if (r.link != null && !(typeof r.link.message === 'string' && typeof r.link.signature === 'string')) throw new Error('The stored link is not readable.');
  return r;
}

/** The record's keys: the alias's signer, the Nostr key, the wallet's public key and Base address (null until an old wallet's Unlock). */
export function loadKeys(record) {
  const r = checkRecord(record);
  const pubkey = r.wallet.pubkey ?? null;
  return {
    alias: signer(checkKey(hexToBytes(r.alias)), { login: true }),
    nostr: nostrOf(r.nostr),
    wallet: { pubkey, evmAddress: pubkey && evmAddress(pubkey) },
    link: r.link ?? null,
  };
}

/**
 * Unlock: the wallet's secret into memory. A wrong passphrase → 'Wrong
 * passphrase'. A wallet in an earlier version's form (Docker's vault.yaml text)
 * is opened as that version did (the passphrase's Latin-1, else UTF-8 bytes;
 * a plain-text one needs a new passphrase that meets the rule), sealed in this
 * app's format with the same passphrase, and that is checked by opening it
 * again. A record without a link gets one (linkOf). `record` is then the record to store, else null.
 * @returns {Promise<{wallet: ReturnType<typeof signer>, record: object | null}>}
 */
export async function unlockWallet(record, passphrase) {
  const r = checkRecord(record);
  const pass = String(passphrase ?? '');
  if (typeof r.wallet.data === 'string') {
    const secret = await openSecret(r.wallet, pass);
    if (publicKey(secret) !== r.wallet.pubkey) throw new Error('The stored wallet does not match its public key.');
    const linked = withLink(r, secret);
    return { wallet: signer(secret), record: linked === r ? null : linked };
  }
  const plain = secrecy(r.wallet.yaml) === 'plain';
  if (plain) checkNewPassphrase(pass);
  const { secret, pubkey, mismatches } = await readKeyFile(r.wallet.yaml, plain ? {} : { password: pass, encodings: ['latin1', 'utf8'] });
  if (mismatches.length || (r.wallet.pubkey && pubkey !== r.wallet.pubkey)) {
    secret.fill(0);
    throw new Error('Wrong passphrase');
  }
  const sealed = await sealSecret(secret, pass);
  const again = await openSecret(sealed, pass);
  const same = sameKey(again, secret);
  again.fill(0); // the check's copy of the wallet's secret
  if (!same) {
    secret.fill(0);
    throw new Error('Re-encrypting the wallet failed; it was kept as it was.');
  }
  return { wallet: signer(secret), record: withLink({ ...r, wallet: { pubkey, ...sealed } }, secret) };
}

/** The record with its link, made now from the wallet's secret when it has none. */
const withLink = (r, secret) => (r.link ? r : { ...r, link: linkOf(secret, evmAddress(publicKey(hexToBytes(r.alias)))) });

export const PASSPHRASE_NEEDED = "The wallet's passphrase is needed: it is asked each time.";

/**
 * The wallet opened from the passphrase for one use: fn(wallet), then it is wiped, whether fn succeeds or throws. Each
 * call pays the passphrase's derivation (~0.3 s), unlocked or not, so a wallet left unlocked can't show its words or
 * send funds without the passphrase (docs/design/keys.md#backup). An earlier version's wallet is opened as at Unlock and
 * not stored again here (its next Unlock does).
 */
export async function withPassphrase(record, passphrase, fn) {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error(PASSPHRASE_NEEDED);
  const { wallet } = await unlockWallet(record, passphrase);
  try {
    return await fn(wallet);
  } finally {
    wallet.lock();
  }
}

const BACKUP_KEYS = ['alias', 'wallet', 'nostr'];

/**
 * Backup, from the passphrase each time: 'alias' | 'wallet' → { words, privateKey }; 'nostr' → { nsec, secret };
 * null or undefined → { alias, wallet, nostr }. The alias and the Nostr key are stored unencrypted, but they are
 * private keys: they are shown only to someone who knows the passphrase too.
 */
export async function backupKeys(record, which, passphrase) {
  if (which != null && !BACKUP_KEYS.includes(which)) {
    throw new Error("Name the key: 'alias', 'wallet' or 'nostr' (or nothing, for all three).");
  }
  return withPassphrase(record, passphrase, (wallet) => {
    const { alias, nostr } = loadKeys(record);
    try {
      const all = { alias: alias.backup(), wallet: wallet.backup(), nostr: { nsec: nsec(nostr.secret), secret: nostr.secret } };
      return which == null ? all : all[which];
    } finally {
      alias.lock();
    }
  });
}
