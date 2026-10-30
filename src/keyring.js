// The wallet's signer, the one place that holds it (docs/design/wallets.md, docs/design/keys.md): a sealed wallet's from
// Unlock until Lock; a connected wallet's (src/keys/connect.js) while its wallet app is in this browser. The keys
// themselves are the session's (src/session.js); this is only what is open now.
//   const k = createKeyring({ session, projectId })
//   k.wallet                        // the signer, or null
//   await k.findConnected()         // a connected wallet's app found again (never a prompt) → k.connected
//   await k.reconnect()             // a phone path's ended session, approved again: the same account
//   await k.unlock(passphrase, run) // → { linked, rekeyed, opened }: session.unlock, inside `run`; a Lock meanwhile wins
//   k.lock()                        // a sealed wallet's secret wiped (a connected one holds none here)
//   k.notHere()                     // the error a connected wallet's action gives while its app is elsewhere
//   await k.connectedBackup(which)  // a connected wallet's Backup, once its wallet app has signed showKeysText
import { findWallets, requestAddress, signText, connectedWallet, showKeysText } from './keys/connect.js';
import { openRelay, RELAYS } from './keys/relay.js';
import { DEFAULTS as CHAIN } from './chain/config.js';

export function createKeyring({ session, projectId, find = findWallets, relay = openRelay }) {
  let wallet = null;
  let connected = null; // a connected wallet: { name, found, relay }
  let locks = 0; // a Lock during an Unlock in flight wins

  /** A phone path's stored session (src/keys/relay.js), if it is still this wallet's: its provider, else null. */
  async function relayed(rdns) {
    try {
      const r = await relay(rdns, { config: CHAIN, projectId });
      const accounts = r ? await r.provider.request({ method: 'eth_accounts' }) : [];
      return accounts.some((a) => a.toLowerCase() === session.walletPublic.evmAddress.toLowerCase()) ? r.provider : null;
    } catch (err) {
      console.warn('[satori] the wallet\'s relay session', err);
      return null;
    }
  }

  const notHere = () => new Error(connected?.relay ? `The link to ${connected.name} has ended: reconnect it in Settings › Keys.`
    : `${connected?.name} isn't in this browser: open the app where it is installed.`);

  return {
    get wallet() { return wallet; },
    get connected() { return connected; },

    /**
     * A connected wallet, found again in this browser by its EIP-6963 id (docs/design/wallets.md#a-connected-wallet): its
     * signer, or none (another browser, the extension removed): the app still predicts, and wallet actions say so.
     */
    async findConnected() {
      const { rdns, name } = session.walletPublic.connected;
      const isRelay = RELAYS.includes(rdns);
      const provider = isRelay ? await relayed(rdns) : (await find()).find((x) => x.rdns === rdns)?.provider;
      wallet = provider ? connectedWallet({ address: session.walletPublic.evmAddress, name, provider }) : null;
      connected = { name, found: !!provider, relay: isRelay };
      return connected;
    },

    /** Reconnect a phone path whose session ended: the person approves again, and it must be the same account. */
    async reconnect() {
      const { rdns, name } = session.walletPublic.connected;
      const { provider } = await relay(rdns, { config: CHAIN, projectId, connect: true });
      const address = await requestAddress(provider);
      if (address !== session.walletPublic.evmAddress) throw new Error(`That is another account: choose ${session.walletPublic.evmAddress} in ${name}.`);
      wallet = connectedWallet({ address, name, provider });
      connected = { name, found: true, relay: true };
      return connected;
    },

    /**
     * The sealed wallet opened (session.unlock, inside `run`: an upgrade it made is saved), unless a Lock came meanwhile.
     * → { linked, rekeyed, opened }
     */
    async unlock(passphrase, run = (fn) => fn()) {
      const count = locks;
      const { wallet: v, linked, rekeyed } = await run(() => session.unlock(passphrase));
      if (count !== locks) {
        v.lock();
        return { linked, rekeyed, opened: false };
      }
      wallet?.lock();
      wallet = v;
      return { linked, rekeyed, opened: true };
    },

    /** The wallet wiped from memory; a connected wallet holds no secret here, so it stays. */
    lock() {
      locks++;
      if (wallet?.connected) return;
      wallet?.lock();
      wallet = null;
    },

    notHere,

    /** A connected wallet's Backup: the alias's or the Nostr key's, once its wallet app has signed showKeysText (checked). */
    async connectedBackup(which) {
      if (which === 'wallet') return session.connectedBackup(which); // its words are in its wallet app: said so
      if (!wallet) throw notHere();
      await signText(wallet.provider, session.walletPublic.evmAddress, showKeysText(session.walletPublic.evmAddress));
      return session.connectedBackup(which);
    },
  };
}
