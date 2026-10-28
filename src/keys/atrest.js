// The alias and the Nostr key at rest (docs/design/keys.md#at-rest): sealed with this browser's own key, an AES-GCM
// CryptoKey made non-extractable (a script can use it, never read it) and kept in IndexedDB, where the browser keeps
// one; else as before, in hex. Only the stored record changes: the keys module works on the plain one.
//
//   const key = await deviceKey({ get, put })        // the CryptoKey, or null: this browser can't keep one (checked)
//   const stored = await toRest(record, key)          // to store: { ...record, sealed } in place of alias, nostr, retired
//   const record = await fromRest(stored, key)        // as read: the plain record again
import { base64 } from '@scure/base';

export const DEVICE_KEY = 'device-key';
export const KEY_GONE = "This app's keys are sealed with this browser's own key, and it is gone. Import the wallet again (Setup) to bring them back.";
const subtle = () => globalThis.crypto.subtle;

async function seal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { iv: base64.encode(iv), data: base64.encode(data) };
}

const open = async (key, { iv, data }) => new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: base64.decode(iv) }, key, base64.decode(data)));

/**
 * This browser's key, made once: kept (`put`) and read back (`get`), it must come back as a CryptoKey that can't be
 * exported and must open what it sealed. Anything else (a browser that can't keep a CryptoKey in IndexedDB, a private
 * window) → null: the keys stay in hex, and the next load checks again.
 */
export async function deviceKey({ get, put }) {
  try {
    if (!(await get(DEVICE_KEY))) {
      await put(DEVICE_KEY, await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    }
    const key = await get(DEVICE_KEY);
    if (!(key instanceof CryptoKey) || key.extractable || key.algorithm?.name !== 'AES-GCM') return null;
    const probe = crypto.getRandomValues(new Uint8Array(16));
    const back = await open(key, await seal(key, probe));
    return back.length === probe.length && back.every((b, i) => b === probe[i]) ? key : null;
  } catch {
    return null;
  }
}

/** The record to store: its alias and Nostr key sealed with `key`; with no key, the record in hex. */
export async function toRest(record, key) {
  if (!key) return record;
  const { alias, nostr, retired, ...rest } = record;
  const plain = new TextEncoder().encode(JSON.stringify({ alias, nostr, ...(retired && { retired }) }));
  try {
    return { ...rest, sealed: await seal(key, plain) };
  } finally {
    plain.fill(0);
  }
}

/** The stored record, plain again; sealed with no key to open it → KEY_GONE. */
export async function fromRest(stored, key) {
  if (!stored?.sealed) return stored;
  if (!key) throw new Error(KEY_GONE);
  const { sealed, ...rest } = stored;
  let plain;
  try {
    plain = await open(key, sealed);
  } catch {
    throw new Error(KEY_GONE);
  }
  try {
    const { alias, nostr, retired } = JSON.parse(new TextDecoder().decode(plain));
    return { ...rest, alias, nostr, ...(retired && { retired }) };
  } finally {
    plain.fill(0);
  }
}
