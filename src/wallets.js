// The app's wallets (docs/design/wallets.md#several-wallets): a database file each, one active at a time. The list is
// in IndexedDB, the same site storage as the databases; no list means one wallet in the first file.
//   const list = await readWallets()            // null: none written yet
//   activeOf(list) → { id, file, address }      // the wallet to open
//   await writeWallets(withAdded(list, address))  // Add a wallet: a new entry, active (the reload opens Setup)
//   withAddress(list, address) / withActive(list, id) / withoutWallet(list, id) / withName(list, name, { auto })
// Each with* returns a new list (or throws, said plainly) and never changes the one given.
import { setAsideDatabase } from './db/recover.js';

export const FIRST_FILE = 'satori-mvp.duckdb';
export const ALREADY = 'This wallet is already in this app: switch to it from the Wallet tab.';
const IDB = 'satori';
const STORE = 'app';
const KEY = 'wallets';

const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
/** The list as written, or the one first wallet (address: what this app knows of it, or null). */
const listOf = (list, address = null) => list ?? { v: 1, active: 1, wallets: [{ id: 1, file: FIRST_FILE, address }] };

/** The wallet to open: the active entry; with no list, the first file. */
export function activeOf(list) {
  const l = listOf(list);
  return l.wallets.find((w) => w.id === l.active) ?? l.wallets[0];
}

export const pathOf = (wallet) => `opfs://${wallet.file}`;

/** A new wallet, active: id one past the highest, file satori-<id>.duckdb, no address until its setup. `address`: the active one's, kept. */
export function withAdded(list, address = null) {
  const l = listOf(list, address);
  const id = Math.max(...l.wallets.map((w) => w.id)) + 1;
  return { ...l, active: id, wallets: [...l.wallets, { id, file: `satori-${id}.duckdb`, address: null }] };
}

/** The active wallet's address (after its setup, or as each start reads it); refused when another wallet has it. */
export function withAddress(list, address) {
  const l = listOf(list);
  if (l.wallets.some((w) => w.id !== l.active && same(w.address, address))) throw new Error(ALREADY);
  return { ...l, wallets: l.wallets.map((w) => (w.id === l.active ? { ...w, address } : w)) };
}

export const NAME_MAX = 40;
/**
 * The active wallet's name, shown in the app bar and the Wallets list: the person's own, or (`auto`) the special key's
 * the wallet holds ("Admin"), which a person's name always wins over. '' clears it. `address`: the active one's, for a
 * first wallet with no list yet.
 */
export function withName(list, name, { auto = false, address = null } = {}) {
  const l = listOf(list, address);
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (n.length > NAME_MAX) throw new Error(`A wallet's name is at most ${NAME_MAX} characters.`);
  return { ...l, wallets: l.wallets.map((w) => {
    if (w.id !== l.active) return w;
    const { name: _, nameAuto: __, ...rest } = w;
    return n ? { ...rest, name: n, ...(auto && { nameAuto: true }) } : rest;
  }) };
}

/** Another wallet made active (the switch reloads the page). */
export function withActive(list, id) {
  const l = listOf(list);
  if (!l.wallets.some((w) => w.id === id)) throw new Error(`No wallet ${id} in this app.`);
  return { ...l, active: id };
}

/** A wallet taken out of the list: never the active one (switch first). → { list, file } (the file to delete). */
export function withoutWallet(list, id) {
  const l = listOf(list);
  const w = l.wallets.find((x) => x.id === id);
  if (!w) throw new Error(`No wallet ${id} in this app.`);
  if (id === l.active) throw new Error('The wallet in use can\'t be removed: switch to another first.');
  return { list: { ...l, wallets: l.wallets.filter((x) => x.id !== id) }, file: w.file };
}

/** What the UI and agents see: { active, wallets: [{ id, address, name, nameAuto, active }] } (name: null when none). */
export function walletsView(list, address = null) {
  const l = listOf(list, address);
  return { active: l.active, wallets: l.wallets.map((w) => ({ id: w.id, address: w.address, name: w.name ?? null, nameAuto: !!w.nameAuto,
    active: w.id === l.active })) };
}

// ── IndexedDB ──

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function run(mode, fn) {
  const idb = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    idb.close();
  }
}

/** Another of the app's entries in the same store (this browser's key for the keys at rest: src/keys/atrest.js). */
export const appGet = (key) => run('readonly', (s) => s.get(key));
export const appPut = (key, value) => run('readwrite', (s) => s.put(value, key));

/** The list, or null (none written: one wallet in the first file). */
export const readWallets = async () => (await run('readonly', (s) => s.get(KEY))) ?? null;
export const writeWallets = (list) => run('readwrite', (s) => s.put(list, KEY));

/**
 * A removed wallet's database file and its WAL, renamed `….removed-<time>`, never deleted (only ever an inactive one: no
 * worker holds it). Its keys stay in it: an earlier or random alias its words can't bring back may hold funds.
 */
export async function setAsideWalletFile(file) {
  const dir = await navigator.storage.getDirectory();
  if (!(await dir.getFileHandle(file).then(() => true, () => false))) return null; // never set up: no file
  return setAsideDatabase(dir, file, { kind: 'removed' });
}
