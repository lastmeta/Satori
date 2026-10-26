// The app's keys, in its own record, meta `keys` (docs/design/keys.md, docs/design/wallets.md):
//   { v: 1, alias: hex, nostr: hex, from, retired?, wallet: { pubkey, kdf, cipher, data }, link: { message, signature } }
// alias  — not behind the passphrase on purpose: the app signs on its own (central's login, the Base batch);
// nostr  — the same: it signs the Nostr events on its own;
// from   — where those two came from (docs/design/wallets.md#derived-keys): 'wallet' (derived from the wallet in the
//          app), 'signature' (from a connected wallet's signature of keysText), 'random' (a connected wallet whose
//          signatures differ; an earlier record, until its next Unlock); retired: the keys they replaced;
// wallet — sealed with the passphrase (wallet.js), holds the funds; its public key in clear,
//          so its Base address shows while locked;
// link   — the wallet's EIP-191 signature of its link to the alias (linkMessage), sent with every register;
//          made whenever the wallet is in hand (newKeys, an Unlock without one).
// An earlier version's wallet, until its next Unlock: wallet: { pubkey | null, yaml } (Docker's text).
//
//   const record = await newKeys({ wallet }, passphrase)   // create, restore, import: the alias and Nostr key derived
//   const { wallet } = await readDockerFiles({ walletText, password })  // import: translate
//   const record = await recordFromRows({ aliasYaml, walletYaml, nostrYaml? })  // migration 7: earlier rows
//   const record = connectedRecord({ address, rdns, name, signLink, signKeys })   // Connect: the wallet stays in its app
//   const { alias, nostr, wallet } = loadKeys(record)   // alias: a signer; wallet: { pubkey, evmAddress, connected }
//   const { wallet, record } = await unlockWallet(record, passphrase)   // record: store it (an upgrade), or null
//   await withPassphrase(record, passphrase, (wallet) => …)   // the wallet for one use (Send), wiped after it
//   await backupKeys(record, which, passphrase)   // Backup: the passphrase each time, unlocked or not
//   signer: pubkey, evmAddress, signDigest(hash), backup() → { words, privateKey }, lock();
//           the alias's also signCentralLogin(challenge) (EIP-191, central's login: src/central/login.js);
//           the wallet's also signLink(aliasAddress) → the record's link
export { generateSecret, secretFromWords, secretFromText, wordsOf, publicKey, evmAddress } from './keys.js';
export { MIN_PASSPHRASE, passphraseOk } from './wallet.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { checkKey, generateSecret, publicKey, wordsOf, evmAddress, signDigest, privateKeyHex } from './keys.js';
import { sealSecret, openSecret, checkNewPassphrase } from './wallet.js';
import { readKeyFile, readNostrYaml, secrecy, walletPubkey } from './docker.js';
import { loginSignature } from '../central/login.js';
import { generateNostrSecret, nostrPubkey, nsec } from '../nostr/event.js';
import { keysFromWallet, keysFromSignature, keysText } from './derive.js';

export const RECORD_VERSION = 1;
/** The largest Dockerized Neuron file read (bytes): satorilib's are under 2 KB; a bigger one is refused before parsing. */
export const IMPORT_MAX = 65_536;
const HEX64 = /^[0-9a-f]{64}$/;
const PUBKEY = /^0[23][0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

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

/** The alias and the Nostr key derived from a wallet's secret (docs/design/wallets.md#derived-keys). */
function derivedFrom(wallet) {
  const { alias, nostr } = keysFromWallet(wallet);
  notSame(alias, wallet);
  return { alias, nostr };
}

/**
 * A new record: the wallet sealed with a new passphrase, its alias and Nostr key derived from it;
 * `created`: when (unix seconds), Home's first day (docs/design/health.md#the-day-strip).
 */
export async function newKeys({ wallet }, passphrase) {
  checkNewPassphrase(passphrase);
  checkKey(wallet);
  const { alias, nostr } = derivedFrom(wallet);
  try {
    const created = Math.floor(Date.now() / 1000);
    return { v: RECORD_VERSION, created, alias: bytesToHex(alias), nostr, from: 'wallet',
      wallet: { pubkey: publicKey(wallet), ...await sealSecret(wallet, passphrase) },
      link: linkOf(wallet, evmAddress(publicKey(alias)), created) };
  } finally {
    alias.fill(0);
  }
}

/**
 * A connected wallet's keys: its signature of keysText, asked twice; the same 65 bytes both times → derived from it,
 * else random (its signatures differ, or it is a smart-contract wallet's). `signKeys(text)` → a signature.
 */
async function connectedKeys(address, signKeys) {
  const text = keysText(address);
  const [a, b] = [await signKeys(text), await signKeys(text)];
  const k = a.toLowerCase() === b.toLowerCase() ? keysFromSignature(a) : null;
  return k ? { ...k, from: 'signature' } : { alias: generateSecret(), nostr: generateNostrSecret(), from: 'random' };
}

/**
 * A connected wallet's record (docs/design/wallets.md#a-connected-wallet): its alias and Nostr key (connectedKeys:
 * `signKeys`), the wallet's address and how to find it again (its EIP-6963 rdns and name), and the link the wallet signs
 * now: `signLink(message)` → the signature (the wallet app asks the person; src/keys/connect.js signText checks it).
 */
export async function connectedRecord({ address, rdns, name, signLink, signKeys }) {
  const { alias, nostr, from } = await connectedKeys(address, signKeys);
  try {
    const created = Math.floor(Date.now() / 1000);
    const message = linkMessage({ alias: evmAddress(publicKey(alias)), wallet: address, issued: created });
    const signature = await signLink(message);
    return { v: RECORD_VERSION, created, alias: bytesToHex(alias), nostr, from,
      wallet: { kind: 'connected', address, rdns, name }, link: { message, signature } };
  } finally {
    alias.fill(0);
  }
}

/**
 * A Dockerized Neuron's wallet file and its password → the wallet's secret, to seal with this app's passphrase
 * (newKeys, which derives the alias and the Nostr key: the install's own are not kept). The file must be encrypted
 * (an alias file is named as such); refuses a wrong password, a watch-only file and a file whose stored public key,
 * words or private key are not its key's.
 * @returns {Promise<{wallet: Uint8Array}>}
 */
export async function readDockerFiles({ walletText, password }) {
  const t = String(walletText ?? '');
  // UTF-8 never has fewer bytes than UTF-16 units: a long text is refused before it is encoded
  if (t.length > IMPORT_MAX || new TextEncoder().encode(t).length > IMPORT_MAX) throw new Error('The wallet file: over 64 KB, so not a Docker file.');
  let w;
  try { w = secrecy(t); } catch (err) { throw new Error(`The wallet file: ${err.message}`); }
  if (w === 'plain' || w === 'mixed') {
    throw new Error('The wallet file: this file is not encrypted, so it is the alias file. Choose the encrypted wallet file.');
  }
  try {
    const r = await readKeyFile(t, { password: String(password ?? '') });
    if (r.mismatches.length) throw new Error(`stored ${r.mismatches.join(', ')} do not match its key`);
    return { wallet: r.secret };
  } catch (err) {
    throw new Error(`The wallet file: ${err.message}`);
  }
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
  const connected = v.kind === 'connected' && ADDRESS.test(v.address ?? '') && typeof v.rdns === 'string';
  if (!sealed && !legacy && !connected) throw new Error('The stored wallet is not readable.');
  if (r.link != null && !(typeof r.link.message === 'string' && typeof r.link.signature === 'string')) throw new Error('The stored link is not readable.');
  return r;
}

/** The record's keys: the alias's signer, the Nostr key, the wallet's public key and Base address (null until an old wallet's Unlock). */
export function loadKeys(record) {
  const r = checkRecord(record);
  const pubkey = r.wallet.pubkey ?? null;
  const connected = r.wallet.kind === 'connected' ? { rdns: r.wallet.rdns, name: r.wallet.name } : null;
  return {
    alias: signer(checkKey(hexToBytes(r.alias)), { login: true }),
    nostr: nostrOf(r.nostr),
    wallet: { pubkey, evmAddress: connected ? r.wallet.address : pubkey && evmAddress(pubkey), connected },
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
  if (r.wallet.kind === 'connected') throw new Error(CONNECTED);
  const pass = String(passphrase ?? '');
  if (typeof r.wallet.data === 'string') {
    const secret = await openSecret(r.wallet, pass);
    if (publicKey(secret) !== r.wallet.pubkey) throw new Error('The stored wallet does not match its public key.');
    const linked = withLink(withDerived(r, secret), secret);
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
  return { wallet: signer(secret), record: withLink(withDerived({ ...r, wallet: { pubkey, ...sealed } }, secret), secret) };
}

/**
 * The record with the alias and the Nostr key derived from the wallet (an earlier record's random ones: retired, kept
 * in `retired`, and a new link, since the alias changed); the record itself when they already are.
 */
function withDerived(r, secret) {
  if (r.from === 'wallet') return r;
  const { alias, nostr } = derivedFrom(secret);
  try {
    const at = Math.floor(Date.now() / 1000);
    const retired = [...(r.retired ?? []), { alias: r.alias, nostr: r.nostr, at }];
    const { link: _old, ...rest } = r;
    return { ...rest, alias: bytesToHex(alias), nostr, from: 'wallet', retired };
  } finally {
    alias.fill(0);
  }
}

/** The record with its link, made now from the wallet's secret when it has none. */
const withLink = (r, secret) => (r.link ? r : { ...r, link: linkOf(secret, evmAddress(publicKey(hexToBytes(r.alias)))) });

export const PASSPHRASE_NEEDED = "The wallet's passphrase is needed: it is asked each time.";
/** Unlock, a passphrase and the wallet's words are a sealed wallet's: a connected one's are in its wallet app. */
export const CONNECTED = 'This wallet is connected: its wallet app asks you for each action, so there is nothing to unlock.';

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

const BACKUP_KEYS = ['alias', 'wallet', 'nostr', 'retired'];

/** The alias an earlier record used, before its keys were derived (retired at that Unlock): { words, privateKey }, or null. */
const retiredOf = (r) => {
  const old = r.retired?.at(-1);
  return old ? { words: wordsOf(hexToBytes(old.alias)), privateKey: privateKeyHex(hexToBytes(old.alias)) } : null;
};

/** The address of the alias an earlier record used (its Base ETH may still be there), or null. */
export const retiredAlias = (record) => {
  const old = record?.retired?.at(-1);
  return old ? evmAddress(publicKey(hexToBytes(old.alias))) : null;
};

/**
 * Backup, from the passphrase each time: 'alias' | 'wallet' → { words, privateKey }; 'nostr' → { nsec, secret };
 * null or undefined → { alias, wallet, nostr }. The alias and the Nostr key are stored unencrypted, but they are
 * private keys: they are shown only to someone who knows the passphrase too.
 */
export async function backupKeys(record, which, passphrase) {
  if (which != null && !BACKUP_KEYS.includes(which)) {
    throw new Error("Name the key: 'alias', 'wallet', 'nostr' or 'retired' (or nothing, for the first three).");
  }
  return withPassphrase(record, passphrase, (wallet) => {
    const { alias, nostr } = loadKeys(record);
    try {
      if (which === 'retired') return retiredOf(record);
      const all = { alias: alias.backup(), wallet: wallet.backup(), nostr: { nsec: nsec(nostr.secret), secret: nostr.secret } };
      return which == null ? all : all[which];
    } finally {
      alias.lock();
    }
  });
}

/**
 * A connected wallet's Backup: the alias's and the Nostr key's ('alias' | 'nostr', or both for null or undefined), shown
 * once the caller has checked the wallet's signature of connect.js showKeysText. Its own words are in its wallet app.
 */
export function connectedBackup(record, which) {
  const r = checkRecord(record);
  if (r.wallet.kind !== 'connected') throw new Error('Not a connected wallet.');
  if (which === 'wallet') throw new Error(`This wallet's words are in ${r.wallet.name}: back it up there.`);
  if (which != null && !BACKUP_KEYS.includes(which)) throw new Error("Name the key: 'alias' or 'nostr' (or nothing, for both).");
  if (which === 'retired') return retiredOf(r);
  const { alias, nostr } = loadKeys(r);
  try {
    const all = { alias: alias.backup(), nostr: { nsec: nsec(nostr.secret), secret: nostr.secret } };
    return which == null ? all : all[which];
  } finally {
    alias.lock();
  }
}

// ── an encrypted backup file (docs/design/keys.md#an-encrypted-backup): for an agent to keep where the person keeps
// their secrets, since a browser's storage can be wiped at any time ──

export const BACKUP_FILE = 'satori-backup';

/**
 * The keys (backupKeys' or connectedBackup's: { wallet?, alias, nostr }) sealed with a passphrase, as the wallet is
 * stored here (PBKDF2, AES-GCM): one JSON object, safe to store and useless without the passphrase. A connected
 * wallet's own words are in its wallet app: `wallet` null. → { kind: 'satori-backup', v: 1, address, at, sealed }
 */
export async function sealBackup({ address, keys, passphrase, at = new Date().toISOString() }) {
  checkNewPassphrase(passphrase);
  const plain = new TextEncoder().encode(JSON.stringify({ wallet: keys.wallet?.words ?? null, alias: keys.alias.words, nostr: keys.nostr.nsec }));
  try {
    return { kind: BACKUP_FILE, v: 1, address, at, sealed: await sealSecret(plain, passphrase) };
  } finally {
    plain.fill(0);
  }
}

/** A backup file opened with its passphrase: { walletWords (null: a connected wallet's), aliasWords, nostrKey, address }. */
export async function openBackup(backup, passphrase) {
  const b = typeof backup === 'string' ? JSON.parse(backup) : backup;
  if (b?.kind !== BACKUP_FILE || b.v !== 1) throw new Error('Not a Satori backup file.');
  const plain = await openSecret(b.sealed, passphrase);
  try {
    const k = JSON.parse(new TextDecoder().decode(plain));
    return { walletWords: k.wallet, aliasWords: k.alias, nostrKey: k.nostr, address: b.address };
  } finally {
    plain.fill(0);
  }
}
