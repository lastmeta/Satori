// Keys at rest in IndexedDB (records hold Uint8Arrays and a CryptoKey, which
// only IndexedDB can store). Runs in the neuron worker. The passphrase is never
// stored. Design: docs/design/identity.md#at-rest
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { seal, unseal, makeDeviceKey, wrapWithDevice, unwrapWithDevice } from './atrest.js';
import { deriveKeys, generateEntropy, generateNostrSecret, nostrKeys } from './keys.js';

const DB = 'satori-keys';
const STORE = 'keys';

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  } finally {
    d.close();
  }
}

const get = (k) => tx('readonly', (s) => s.get(k));
const put = (entries) => tx('readwrite', (s) => { for (const [k, v] of Object.entries(entries)) s.put(v, k); });
const del = (...keys) => tx('readwrite', (s) => { for (const k of keys) s.delete(k); });

/** Fresh identity, vault and (independent) Nostr secret. */
export function createKeys() {
  return { identity: generateEntropy(), vault: generateEntropy(), nostr: hexToBytes(generateNostrSecret()) };
}

/** Public parts, safe to show and to keep unencrypted. */
export function publicInfo({ identity, vault, nostr }) {
  const pub = (e) => {
    const { pubkey, address, scripthash, ethAddress } = deriveKeys(e);
    return { pubkey, address, scripthash, ethAddress };
  };
  return { identity: pub(identity), vault: pub(vault), nostr: { pubkeyHex: nostrKeys(bytesToHex(nostr)).pubkeyHex } };
}

/**
 * Seal all three secrets under one passphrase (each with its own salt), and
 * optionally remember the identity on this device. Replaces any stored keys.
 */
export async function saveKeys(keys, passphrase, { remember = false, iterations } = {}) {
  const opts = iterations ? { iterations } : {};
  const info = publicInfo(keys);
  const [identity, vault, nostr] = await Promise.all(
    [keys.identity, keys.vault, keys.nostr].map((k) => seal(k, passphrase, opts)));
  await put({ public: info, identity, vault, nostr });
  await (remember ? rememberIdentity(keys.identity) : forgetDevice());
  await globalThis.navigator?.storage?.persist?.().catch(() => {});
  return info;
}

/** @returns {Promise<ReturnType<typeof publicInfo> | undefined>} */
export const loadPublic = () => get('public');

/** Sign in: decrypt the identity and the Nostr key. Throws 'Wrong passphrase'. */
export async function signIn(passphrase) {
  const [i, n] = await Promise.all([get('identity'), get('nostr')]);
  if (!i) throw new Error('No keys on this device');
  const [identity, nostr] = await Promise.all([unseal(i, passphrase), unseal(n, passphrase)]);
  return { identity, nostr };
}

/** Decrypt the vault for one transaction; the caller wipes it (`.fill(0)`). */
export async function openVault(passphrase) {
  const v = await get('vault');
  if (!v) throw new Error('No keys on this device');
  return unseal(v, passphrase);
}

/** "Remember on this device": wrap the identity with a non-extractable key. */
export async function rememberIdentity(identity) {
  const key = await makeDeviceKey();
  await put({ device: { key, identity: await wrapWithDevice(identity, key) } });
}

export const forgetDevice = () => del('device');

/** The remembered identity, or null when not remembered. */
export async function openRemembered() {
  const d = await get('device');
  return d ? unwrapWithDevice(d.identity, d.key) : null;
}
