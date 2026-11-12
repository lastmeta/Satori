// The app's keys, in its own record, meta `keys` (docs/design/keys.md, docs/design/wallets.md):
//   { v: 1, alias: hex, nostr: hex, from, wallet: { pubkey, kdf, cipher, data }, link: { message, signature } }
// alias  — not behind the passphrase on purpose: the app signs on its own (central's login, the Base batch);
// nostr  — the same: it signs the Nostr events on its own;
// from   — where those two came from (docs/design/wallets.md#derived-keys): 'wallet' (derived from the wallet in the
//          app), 'random' (a connected wallet, never from a signature; an earlier record, until its next Unlock);
// wallet — sealed with the passphrase (wallet.js), holds the funds; its public key in clear,
//          so its Base address shows while locked;
// link   — the wallet's EIP-191 signature of its link to the alias (linkMessage), sent with every register;
//          made whenever the wallet is in hand (newKeys, an Unlock without one).
// offchain, onchain — another alias for one job, absent when the alias above does it (docs/design/wallets.md#an-alias-for-each-job):
//          { alias: hex, link }, imported: `offchain` for the Satori Service, `onchain` for the Satori contract.
// retired — the alias and Nostr keys this record held before, never dropped (keepRetired): [{ alias, nostr, at }].
//          Funds sent to an earlier alias stay reachable (Backup's "Earlier keys").
// hd     - a wallet imported from words: the words sealed with the passphrase and its sub-wallets (hd.js), absent else.
// An earlier version's wallet, until its next Unlock: wallet: { pubkey | null, yaml } (Docker's text).
//
//   const record = await newKeys({ wallet, words? }, passphrase)   // create, restore, import: the alias and Nostr key derived;
//                                                                  // words (Import's): its sub-wallets too (hd.js)
//   const next = await withSubWallet(record, n, passphrase)   // the wallet becomes sub-wallet row n's key
//   const { wallet } = await readDockerFiles({ walletText, password })  // import: translate
//   const record = await recordFromRows({ aliasYaml, walletYaml, nostrYaml? })  // migration 7: earlier rows
//   const next = await withAliasFor(record, job, text, link)   // job 'offchain' | 'onchain': another alias for it; '' → the app's own
//   const next = await restoredRecord(record, { alias, nostr }, signLink)   // a connected wallet's keys from a backup
//   const record = connectedRecord({ address, rdns, name, signLink })   // Connect: the wallet stays in its app
//   const record = recordFromBackup(await openBackup(file, passphrase))   // that wallet's keys and link, with no wallet app
//   const { alias, nostr, wallet, offchain, onchain } = loadKeys(record)   // alias: a signer; wallet: { pubkey, evmAddress,
//                                                                 // connected }; offchain, onchain: { alias: a signer, link } | null
//   const { wallet, record } = await unlockWallet(record, passphrase)   // record: store it (an upgrade), or null
//   await withPassphrase(record, passphrase, (wallet) => …)   // the wallet for one use (Send), wiped after it
//   await backupKeys(record, which, passphrase)   // Backup: the passphrase each time, unlocked or not
//   signer: pubkey, evmAddress, signDigest(hash), backup() → { words, privateKey }, lock();
//           the alias's also signCentralLogin(challenge) (EIP-191, central's login: src/central/login.js);
//           the wallet's also signLink(aliasAddress) → the record's link
export { cleanKeyText, generateSecret, secretFromWords, secretFromText, keyFromText, wordsOf, publicKey, evmAddress } from './keys.js';
export { MIN_PASSPHRASE, passphraseOk } from './wallet.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { checkKey, generateSecret, secretFromText, publicKey, wordsOf, evmAddress, signDigest, privateKeyHex } from './keys.js';
import { sealSecret, openSecret, checkNewPassphrase } from './wallet.js';
import { readKeyFile, readNostrYaml, secrecy, walletPubkey } from './docker.js';
import { loginSignature } from '../central/login.js';
import { generateNostrSecret, nostrPubkey, nsec, npub, nostrSecretOf } from '../nostr/event.js';
import { keysFromWallet } from './derive.js';
import { sealWords, secretAt, hdOk, rowAt, rowOf } from './hd.js';

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

/** The text a wallet signs to link its alias for the Satori Service (docs/design/wallets.md#the-satori-network-register-login-and-the-link). */
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
 * `created`: when (unix seconds), Home's first day (docs/design/health.md#the-day-strip). `words`: the words Import
 * made the wallet from (keyFromText), kept for its sub-wallets (hd.js).
 */
export async function newKeys({ wallet, words = null }, passphrase) {
  checkNewPassphrase(passphrase);
  checkKey(wallet);
  const hd = words ? await sealWords(words, passphrase) : null;
  if (hd && hd.first !== publicKey(wallet)) throw new Error("These words are not the wallet's.");
  const { alias, nostr } = derivedFrom(wallet);
  try {
    const created = Math.floor(Date.now() / 1000);
    return { v: RECORD_VERSION, created, alias: bytesToHex(alias), nostr, from: 'wallet',
      wallet: { pubkey: publicKey(wallet), ...await sealSecret(wallet, passphrase) },
      link: linkOf(wallet, evmAddress(publicKey(alias)), created), ...(hd && { hd }) };
  } finally {
    alias.fill(0);
  }
}

/**
 * The record with the wallet switched to sub-wallet row n (docs/design/wallets.md#sub-wallets), from its words and the
 * passphrase: as Import of that key would make it (sealed with the same passphrase, its alias, Nostr key and link new),
 * keeping `created` and `hd` (at: that row). Another alias for a job goes: its link was the old wallet's. The keys it
 * replaces are kept by the save (keepRetired).
 */
export async function withSubWallet(record, n, passphrase) {
  const r = checkRecord(record);
  if (!r.hd) throw new Error(NO_SUB_WALLETS);
  const at = rowAt(r.hd, n);
  if (n === rowOf(r.hd.at)) throw new Error('That key is the one in use.');
  if (typeof passphrase !== 'string' || !passphrase) throw new Error(PASSPHRASE_NEEDED);
  const secret = await secretAt(r.hd, n, passphrase);
  try {
    const { offchain: _o, onchain: _c, ...kept } = r;
    return { ...kept, ...await newKeys({ wallet: secret }, passphrase), created: r.created, hd: { ...r.hd, at } };
  } finally {
    secret.fill(0);
  }
}
export const NO_SUB_WALLETS = 'This wallet was not imported from words: it has no sub-wallets.';

/**
 * A connected wallet's record (docs/design/wallets.md#a-connected-wallet): its alias and Nostr key, random (no secret
 * can come from a signature: any site can ask for the same one), the wallet's address and how to find it again (its
 * EIP-6963 rdns and name), and the link the wallet signs now: `signLink(message)` → the signature (the wallet app asks
 * the person; src/keys/connect.js signText checks it).
 */
export async function connectedRecord({ address, rdns, name, signLink }) {
  const alias = generateSecret();
  const nostr = generateNostrSecret();
  try {
    const created = Math.floor(Date.now() / 1000);
    const message = linkMessage({ alias: evmAddress(publicKey(alias)), wallet: address, issued: created });
    const signature = await signLink(message);
    return { v: RECORD_VERSION, created, alias: bytesToHex(alias), nostr, from: 'random',
      wallet: { kind: 'connected', address, rdns, name }, link: { message, signature } };
  } finally {
    alias.fill(0);
  }
}

/**
 * A connected wallet's record from its backup (openBackup): its alias, Nostr key and the link its wallet app signed, so
 * neither the wallet app nor a new signature is needed: an agent's browser wiped between visits comes back whole.
 */
export function recordFromBackup({ address, aliasWords, nostrKey, connected: { rdns, name, link }, retired }) {
  const alias = secretFromText(aliasWords);
  try {
    return keepRetired(null, { v: RECORD_VERSION, created: Math.floor(Date.now() / 1000), alias: bytesToHex(alias), nostr: nostrSecretOf(nostrKey), from: 'random',
      wallet: { kind: 'connected', address, rdns, name }, link, retired });
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
  for (const job of JOBS) {
    const o = r[job];
    if (o != null && !(HEX64.test(o.alias) && typeof o.link?.message === 'string' && typeof o.link?.signature === 'string')) {
      throw new Error(`The stored alias for the ${FOR[job]} is not readable.`);
    }
  }
  if (r.retired != null && !(Array.isArray(r.retired) && r.retired.every((k) => HEX64.test(k?.alias) && HEX64.test(k?.nostr)))) {
    throw new Error('The stored earlier keys are not readable.');
  }
  if (r.hd != null && !hdOk(r.hd)) throw new Error('The stored sub-wallets are not readable.');
  return r;
}

/**
 * The record to store in place of `old`: any alias or Nostr key `old` held that `next` doesn't is kept in `retired`
 * (the owner, 2026-10-28: an upgrade dropped an alias that held ETH). Keys are only ever added, never lost.
 */
export function keepRetired(old, next, now = Math.floor(Date.now() / 1000)) {
  const jobs = (r) => JOBS.filter((j) => r[j]).map((j) => r[j].alias);
  const held = (r) => (r ? [{ alias: r.alias, nostr: r.nostr }, ...jobs(r).map((alias) => ({ alias, nostr: r.nostr })), ...(r.retired ?? [])] : []);
  const current = new Set([next.alias, next.nostr, ...jobs(next)]);
  const seen = new Set();
  const retired = [...(next.retired ?? []), ...held(old)].filter((k) => {
    const id = `${k.alias}:${k.nostr}`;
    if (!k.alias || seen.has(id) || (current.has(k.alias) && current.has(k.nostr))) return false;
    seen.add(id);
    return true;
  }).map((k) => ({ alias: k.alias, nostr: k.nostr, at: k.at ?? now }));
  if (JSON.stringify(retired) === JSON.stringify(next.retired ?? [])) return next; // nothing more to keep
  return { ...next, retired };
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
    offchain: jobKeys(r.offchain),
    onchain: jobKeys(r.onchain),
  };
}

/** The two jobs an alias does (central's alias reports), and who each is for, in words. */
export const JOBS = ['offchain', 'onchain'];
const FOR = { offchain: 'Satori Service', onchain: 'Satori contract' };
const jobKeys = (o) => (o ? { alias: signer(checkKey(hexToBytes(o.alias)), { login: true }), link: o.link } : null);

/** withAliasFor(record, 'offchain', …): the alias for the Satori Service (docs/design/wallets.md#an-alias-for-each-job). */
export const withOffchainAlias = (record, text, link) => withAliasFor(record, 'offchain', text, link);

/**
 * The record with another alias for a job (docs/design/wallets.md#an-alias-for-each-job): 'offchain' (the Satori
 * Service) or 'onchain' (the Satori contract); `text` its private key or 24 words, linked by the wallet:
 * `link(aliasAddress)` → { message, signature } (the wallet in the app, or a connected wallet's app). Nothing, or this
 * app's own alias: the app's own does the job again (the one it had is kept as an earlier key by keepRetired). The
 * wallet's own key is refused.
 */
export async function withAliasFor(record, job, text, link) {
  const r = checkRecord(record);
  if (!JOBS.includes(job)) throw new Error("The job is 'offchain' (the Satori Service) or 'onchain' (the Satori contract).");
  const t = String(text ?? '').trim();
  let secret = null;
  if (t) {
    try {
      secret = secretFromText(t);
    } catch {
      throw new Error('Not 24 backup words or a private key.');
    }
  }
  try {
    const key = secret && bytesToHex(secret);
    if (!key || key === r.alias) {
      if (!r[job]) throw new Error(`This app already uses its own alias for the ${FOR[job]}.`);
      const { [job]: _gone, ...own } = r;
      return own;
    }
    const address = evmAddress(publicKey(secret));
    if (publicKey(secret) === r.wallet.pubkey || address === r.wallet.address) throw new Error("That is the wallet's own key: give an alias's.");
    if (key === r[job]?.alias) throw new Error(`That is the alias this app uses for the ${FOR[job]} now.`);
    return { ...r, [job]: { alias: key, link: await link(address) } };
  } finally {
    secret?.fill(0);
  }
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
 * A connected wallet's record with its alias, its Nostr key or both put back from a backup (docs/design/wallets.md#restoring-a-connected-wallets-keys):
 * `alias` its private key or 24 words, `nostr` its nsec or hex, either left empty to keep the one it has; `retired` a
 * backup file's earlier keys. The wallet signs the new link: `signLink(message)` → the signature.
 */
export async function restoredRecord(record, { alias, nostr, retired = [] }, signLink) {
  const r = checkRecord(record);
  if (r.wallet.kind !== 'connected') throw new Error("This wallet's alias and Nostr key come from its words: nothing to restore.");
  const [aliasText, nostrText] = [alias, nostr].map((x) => String(x ?? '').trim());
  if (!aliasText && !nostrText) throw new Error('Give the alias key, the Nostr key, or both.');
  let secret;
  try {
    secret = aliasText ? secretFromText(aliasText) : hexToBytes(r.alias);
  } catch {
    throw new Error('The alias key: not 24 backup words or a private key.');
  }
  try {
    const keys = { alias: bytesToHex(secret), nostr: nostrText ? nostrSecretOf(nostrText) : r.nostr };
    if (keys.alias === r.alias && keys.nostr === r.nostr) throw new Error('Those are the keys this app has now.');
    const aliasAddress = evmAddress(publicKey(secret));
    if (aliasAddress === r.wallet.address) throw new Error('The alias and the wallet must not be the same key.');
    const message = linkMessage({ alias: aliasAddress, wallet: r.wallet.address, issued: Math.floor(Date.now() / 1000) });
    return { ...r, ...keys, retired: [...(r.retired ?? []), ...retired], link: { message, signature: await signLink(message) } };
  } finally {
    secret.fill(0);
  }
}

/**
 * The record with the alias and the Nostr key derived from the wallet (an earlier record's random ones replaced, with a
 * new link, since the alias changed); the record itself when they already are.
 */
function withDerived(r, secret) {
  if (r.from === 'wallet') return r;
  const { alias, nostr } = derivedFrom(secret);
  try {
    const { link: _old, ...rest } = r;
    return { ...rest, alias: bytesToHex(alias), nostr, from: 'wallet' };
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

/**
 * A stored record's wallet passphrase checked, from the wallet part alone (sealed with the passphrase; the alias and
 * the Nostr key, sealed with this browser's key, are not needed): another wallet's, before it is removed. A wrong one
 * throws 'Wrong passphrase'. → 'checked', or 'connected' (its wallet is in its wallet app: there is no passphrase).
 */
export async function checkWalletPassphrase(stored, passphrase) {
  const v = stored?.wallet ?? {};
  if (v.kind === 'connected') return 'connected';
  if (typeof passphrase !== 'string' || !passphrase) throw new Error(PASSPHRASE_NEEDED);
  if (typeof v.data === 'string') {
    const secret = await openSecret(v, passphrase);
    try {
      if (publicKey(secret) !== v.pubkey) throw new Error('Wrong passphrase');
    } finally {
      secret.fill(0);
    }
    return 'checked';
  }
  if (typeof v.yaml !== 'string') throw new Error('The stored wallet is not readable.');
  if (secrecy(v.yaml) === 'plain') return 'checked'; // an early import kept in plain text: no passphrase yet
  const { secret, mismatches } = await readKeyFile(v.yaml, { password: passphrase, encodings: ['latin1', 'utf8'] });
  secret.fill(0);
  if (mismatches.length) throw new Error('Wrong passphrase');
  return 'checked';
}

const BACKUP_KEYS = ['alias', 'wallet', 'nostr', 'retired', 'offchain', 'onchain'];

/** A job's own alias's backup (offchain, onchain), or null when the app's alias does it. */
function jobBackup(o) {
  if (!o) return null;
  const s = signer(checkKey(hexToBytes(o.alias)));
  try {
    return s.backup();
  } finally {
    s.lock();
  }
}

/** The record's earlier keys (keepRetired), newest first: [{ address, privateKey, npub, nsec, at }]. */
function retiredBackup(r) {
  return [...(r.retired ?? [])].reverse().map((k) => {
    const alias = signer(checkKey(hexToBytes(k.alias)));
    const nostr = nostrOf(k.nostr);
    try {
      return { address: alias.evmAddress, privateKey: alias.backup().privateKey, npub: npub(nostr.pubkey), nsec: nsec(nostr.secret), at: k.at ?? null };
    } finally {
      alias.lock();
    }
  });
}

/**
 * Backup, from the passphrase each time: 'alias' | 'wallet' → { words, privateKey }; 'nostr' → { nsec, secret };
 * null or undefined → { alias, wallet, nostr }. The alias and the Nostr key are stored unencrypted, but they are
 * private keys: they are shown only to someone who knows the passphrase too.
 */
export async function backupKeys(record, which, passphrase) {
  if (which != null && !BACKUP_KEYS.includes(which)) {
    throw new Error("Name the key: 'alias', 'wallet', 'nostr', 'retired', 'offchain' or 'onchain' (or nothing, for all of them).");
  }
  return withPassphrase(record, passphrase, (wallet) => {
    const { alias, nostr } = loadKeys(record);
    try {
      const all = { alias: alias.backup(), wallet: wallet.backup(), nostr: { nsec: nsec(nostr.secret), secret: nostr.secret },
        retired: retiredBackup(record), offchain: jobBackup(record.offchain), onchain: jobBackup(record.onchain) };
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
  if (which != null && !BACKUP_KEYS.includes(which)) throw new Error("Name the key: 'alias', 'nostr', 'retired', 'offchain' or 'onchain' (or nothing, for all of them).");
  const { alias, nostr } = loadKeys(r);
  try {
    const all = { alias: alias.backup(), nostr: { nsec: nsec(nostr.secret), secret: nostr.secret }, retired: retiredBackup(r),
      offchain: jobBackup(r.offchain), onchain: jobBackup(r.onchain) };
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
export async function sealBackup({ address, keys, passphrase, connected = null, data = null, at = new Date().toISOString() }) {
  checkNewPassphrase(passphrase);
  const plain = new TextEncoder().encode(JSON.stringify({ wallet: keys.wallet?.words ?? null, alias: keys.alias.words, nostr: keys.nostr.nsec,
    retired: (keys.retired ?? []).map((k) => ({ alias: k.privateKey, nostr: k.nsec, at: k.at })), connected, data }));
  try {
    return { kind: BACKUP_FILE, v: 1, address, at, sealed: await sealSecret(plain, passphrase) };
  } finally {
    plain.fill(0);
  }
}

/** A backup file's earlier keys as the record keeps them: [{ alias: hex, nostr: hex, at }]. */
function retiredFromBackup(list) {
  return (Array.isArray(list) ? list : []).map((k) => ({ alias: String(k.alias).replace(/^0x/, '').toLowerCase(),
    nostr: nostrSecretOf(k.nostr), at: k.at ?? null })).filter((k) => HEX64.test(k.alias) && HEX64.test(k.nostr));
}

/** A backup file opened with its passphrase: { walletWords (null: a connected wallet's), aliasWords, nostrKey, address, connected, data }. */
export async function openBackup(backup, passphrase) {
  const b = typeof backup === 'string' ? JSON.parse(backup) : backup;
  if (b?.kind !== BACKUP_FILE || b.v !== 1) throw new Error('Not a Satori backup file.');
  const plain = await openSecret(b.sealed, passphrase);
  try {
    const k = JSON.parse(new TextDecoder().decode(plain));
    return { walletWords: k.wallet, aliasWords: k.alias, nostrKey: k.nostr, address: b.address, retired: retiredFromBackup(k.retired),
      connected: k.connected ?? null, data: k.data ?? null };
  } finally {
    plain.fill(0);
  }
}
