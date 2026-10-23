// The app's wallets (docs/design/wallets.md#several-wallets): a database file each, one active at a time. The list is
// in IndexedDB, the same site storage as the databases; no list means one wallet in the first file.
//   const list = await readWallets()            // null: none written yet
//   activeOf(list) → { id, file, address }      // the wallet to open
//   await writeWallets(withAdded(list, address))  // Add a wallet: a new entry, active (the reload opens Setup)
//   withAddress(list, address) / withActive(list, id) / withoutWallet(list, id)
// Each with* returns a new list (or throws, said plainly) and never changes the one given.

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

/** What the UI and agents see: { active, wallets: [{ id, address, active }] }. */
export function walletsView(list, address = null) {
  const l = listOf(list, address);
  return { active: l.active, wallets: l.wallets.map((w) => ({ id: w.id, address: w.address, active: w.id === l.active })) };
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

/** The list, or null (none written: one wallet in the first file). */
export const readWallets = async () => (await run('readonly', (s) => s.get(KEY))) ?? null;
export const writeWallets = (list) => run('readwrite', (s) => s.put(list, KEY));

/** A removed wallet's database file and its WAL, from OPFS (only ever an inactive one: no worker holds it). */
export async function deleteWalletFile(file) {
  const dir = await navigator.storage.getDirectory();
  for (const name of [file, `${file}.wal`]) {
    try {
      await dir.removeEntry(name);
    } catch (err) {
      if (err?.name !== 'NotFoundError') throw err;
    }
  }
}
