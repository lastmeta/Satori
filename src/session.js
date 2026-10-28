// The keys this app runs with, one owner (docs/design/keys.md, docs/design/wallets.md): the record as stored (meta
// `keys`) and everything read from it: the alias's signer, the Nostr key, the wallet's public key and address. Nothing
// else keeps a copy; a change goes through save(), the one place the record is written, which keeps every key it
// replaces (keepRetired: keys are never lost).
//   const s = createSession({ db, restKey })
//   await s.load()               // the stored record (null: Setup); sealed at rest from now on where it was in hex
//   s.record / s.alias / s.nostr / s.walletPublic / s.retired
//   await s.save(next)           // stored in one commit, then read again
//   await s.unlock(passphrase)   // → { wallet, linked, rekeyed }: an upgrade the Unlock made is saved
import {
  loadKeys, unlockWallet, keepRetired, withPassphrase, backupKeys, connectedBackup,
} from './keys/index.js';
import { toRest, fromRest } from './keys/atrest.js';

export function createSession({ db, restKey }) {
  let record = null;
  let keys = null; // loadKeys(record): only ever from the record, again at each change

  const use = (r) => {
    record = r;
    keys = r ? loadKeys(r) : null;
  };

  return {
    get record() { return record; },
    /** The alias's signer (signDigest, evmAddress, pubkey, signCentralLogin). */
    get alias() { return keys?.alias ?? null; },
    /** The Nostr key: { secret, pubkey }. */
    get nostr() { return keys?.nostr ?? null; },
    /** The wallet as known while locked: { pubkey, evmAddress, connected: { rdns, name } | null }. */
    get walletPublic() { return keys?.wallet ?? { pubkey: null, evmAddress: null, connected: null }; },
    /** How many earlier keys the record keeps (Backup's "Earlier keys"). */
    get retired() { return record?.retired?.length ?? 0; },
    /** Where the alias and the Nostr key came from: 'wallet' | 'signature' | 'random'. */
    get from() { return record?.from ?? 'random'; },

    /** The stored record, opened (its alias and Nostr key unsealed); one still in hex is sealed now. → the record or null */
    async load() {
      const stored = (await db.get('keys')) ?? null;
      const r = await fromRest(stored, await restKey());
      if (!r) return null;
      if (!stored.sealed && await restKey()) await this.save(r); // in hex until now: sealed from now on
      else use(r);
      return record;
    },

    /** The record stored in place of the current one, in one commit; any key it replaces is kept (keepRetired). */
    async save(next) {
      const r = keepRetired(record, next);
      await db.set('keys', await toRest(r, await restKey())); // the alias and the Nostr key sealed where this browser keeps a key
      await db.checkpoint();
      use(r);
    },

    /**
     * Unlock: the wallet's signer, and the record an Unlock upgrades (its link made, an earlier version's wallet in
     * this app's form, an earlier record's keys derived from the wallet), saved. → { wallet, linked, rekeyed }
     * (rekeyed: the alias changed, so whatever runs on the old one must start again).
     */
    async unlock(passphrase) {
      const was = record;
      const { wallet, record: upgraded } = await unlockWallet(was, passphrase);
      if (upgraded) await this.save(upgraded);
      return { wallet, linked: !was.link && !!upgraded?.link, rekeyed: !!upgraded && upgraded.alias !== was.alias };
    },

    /** The wallet from its passphrase for one use (Send), wiped after it. */
    withPassphrase: (passphrase, fn) => withPassphrase(record, passphrase, fn),
    /** Backup's keys from the passphrase (backupKeys), or a connected wallet's (connectedBackup: its app has signed). */
    backup: (which, passphrase) => backupKeys(record, which, passphrase),
    connectedBackup: (which) => connectedBackup(record, which),
    /** The alias for the push's handoff: sealed with this browser's key as in the record, else in hex. */
    async handoffAlias() {
      const { sealed } = await toRest({ alias: record.alias, nostr: null }, await restKey());
      return sealed ? { sealed } : { alias: record.alias };
    },
  };
}
