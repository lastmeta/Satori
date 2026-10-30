// window.satori: the same app for agents (public/llms.txt, docs/design/OVERVIEW.md). Every screen action has a call
// here, with its checks; the running app's parts come from src/main.js (createAgent), its changing ones read when used.
//   window.satori = createAgent({ actions, exclusive, …, get db() { return db; }, … })
import { state } from './ui/view.js';
import { generateSecret, secretFromText, newKeys, readDockerFiles, sealBackup, openBackup, keepRetired } from './keys/index.js';
import { findWallets } from './keys/connect.js';
import { RELAYS } from './keys/relay.js';
import { UP, DOWN } from './chain/index.js';
import { relayUuid } from './nostr/satori.js';
import { queueOf, played, latestText, opensAgain } from './ui/gameflow.js';
import { listingOf } from './neuron/market.js';
import { watchable } from './neuron/records.js';
import { DEFAULT_PRICE } from './ui/market.js';
import { formatEther } from 'viem';
import { rolesView } from './neuron/roles.js';
import { devFeeView } from './neuron/devfee.js';
import { adminView } from './neuron/admin.js';
import { safeView } from './neuron/safe.js';
import { contractChecks, predictedToday, networkChecks, networkSent, relayChecks, relaysOn } from './ui/contractflow.js';
import { healthOf } from './neuron/health.js';
import { lastTraffic } from './traffic.js';
import { setTheme } from './ui/theme.js';
import { readFavorites, writeFavorites } from './ui/prefs.js';
import { walletsView } from './wallets.js';
import { applyUpdate, install, storage } from './pwa/index.js';
import { turnReminder, remindOnce } from './pwa/push.js';

export function createAgent(app) {
  const {
    DEFAULTS, VERSION, actions, addWallet, adminAction, backupOf, baseAction, centralStatus, centralUuid, connectTo,
    dayDetail, detailOf, devFeeAction, exclusive, finishUpdate, go, listModels, lock, marketAction, nameWallet,
    nowS, playCalls, pollNow, readAdmin, readDevFee, readRewardNow, readRoles, readSafe, refreshBase, refreshNostr,
    relinkWallet, reminderPlayer, removeWallet, retrainOf, roleAction, safeAction, session, setAsideDb,
    setBaseSettings, setCentral, setReward, setSubscribed, setup, since, switchWallet, theSafe, unlock, walletOps,
    work,
  } = app;

  /** Central's stream meta: the object its JSON text holds, the text if it is not JSON, or null. */
  function parseMeta(meta) {
    try { return meta == null ? null : JSON.parse(meta); } catch { return meta; }
  }

  const ready = () => {
    if (state.screen !== 'home') throw new Error(`Not running (screen: ${state.screen}). Set up first.`);
  };

  /** The Nostr flow's status, the same as the Nostr card. */
  const nostrStatus = () => app.nostr.status();

  const satori = {
    help: 'Read /llms.txt',
    async status() {
      const home = state.screen === 'home';
      return {
        screen: state.screen,
        version: VERSION, // browser-<package version>+<git short sha>
        alias: state.alias || null,
        wallet: state.wallet || null,
        walletKind: !state.wallet ? null : state.connected ? 'connected' : 'sealed',
        keysFrom: state.keysFrom || null, // where the alias and the Nostr key came from (docs/design/wallets.md#derived-keys)
        connected: state.connected, // a connected wallet: { name, found } (found: its wallet app is in this browser), else null
        unlocked: state.unlocked,
        lockAt: state.lockAt, // when the wallet locks on its own (ms), or null

        central: home ? await centralStatus() : null,
        nostr: home ? await nostrStatus() : null,
        base: home ? await app.base.status() : null,
        storage: await storage(),
        app: { ...state.app },
        recovered: state.recovered,
        setAside: state.setAside, // a database file that would not open, set aside under this name (this page load), or null
        // the last training pass (docs/design/models.md#the-training-pass): { central, nostr, base, stopped, ms }, or null
        train: app.trainer?.last ?? null,
      };
    },
    /** On Setup: the wallets in this browser that can be connected (EIP-6963, else window.ethereum; with none, MetaMask Connect and
     * WalletConnect) → [{ rdns, name }]. */
    async connectWallets() {
      app.foundWallets = await findWallets();
      const found = app.foundWallets.map(({ rdns, name }) => ({ rdns, name }));
      // none in this browser (a phone's Chrome or Safari): the dapp's two relay paths
      return found.length ? found : [{ rdns: RELAYS[0], name: 'MetaMask' }, ...(DEFAULTS.walletConnect ? [{ rdns: RELAYS[1], name: 'Other wallet' }] : [])];
    },
    /** On Setup: connect one of them (connectWallets() first); its wallet app asks the person for the account and the link. → status */
    async connect(rdns) {
      await connectTo(rdns);
      return window.satori.status();
    },
    /** This app's wallets (docs/design/wallets.md#several-wallets) → { active, wallets: [{ id, address, active }] }. */
    wallets: async () => walletsView(app.wallets, state.wallet || null),
    /** A new wallet, active: the page reloads on Setup (setup() then makes it). Only on the person's request. → { reloading: true } */
    async addWallet() { await addWallet(); return { reloading: true }; },
    /** Another wallet of this app's, by id: the keys locked, the page reloaded with it. → { reloading: true } */
    async switchWallet(id) { await switchWallet(id); return { reloading: true }; },
    /** Remove a wallet that is not in use, with that wallet's passphrase (none for a connected one): off the list, its file
     * set aside, never deleted. Only on the person's request, after its words are backed up. → wallets() */
    async removeWallet(id, passphrase) { await removeWallet(id, passphrase); return walletsView(app.wallets, state.wallet || null); },
    /**
     * Name the wallet in use (at most 40 characters; '' clears it, and a special key's name, such as "Admin", comes back by
     * itself). Shown in the app bar and the Wallets list, on this device only. → wallets()
     */
    async nameWallet(name) { ready(); await nameWallet(name); return walletsView(app.wallets, state.wallet || null); },
    /** Chromium's install prompt, when offered (status().app.canInstall; needs a user gesture). → 'accepted' | 'dismissed' | 'unavailable' */
    install() { return install(); },
    /** When status().app.update: the new version takes over and the page reloads. → false if none is waiting */
    update() { return applyUpdate(); },
    /**
     * On the 'damaged' screen (the database file won't open): set it aside (renamed, never deleted) and start again on
     * Setup, to import again. Only on the person's request: their keys are in that file. → status()
     */
    async setAside() { await setAsideDb(); return window.satori.status(); },
    /** Create a wallet (a new one unless its words or private key are given; its alias and Nostr key derived). Stays locked. */
    async setup({ passphrase, walletWords, backup } = {}) {
      let retired = [];
      if (backup) { // exportBackup()'s file, opened with its passphrase
        const b = await openBackup(backup, passphrase);
        if (!b.walletWords) throw new Error("This backup is a connected wallet's: its words are in its wallet app. Connect it (connect()).");
        ({ walletWords, retired } = b);
      }
      await setup(async () => {
        const keys = {};
        try {
          keys.wallet = walletWords ? secretFromText(walletWords) : generateSecret();
          const r = await newKeys(keys, passphrase);
          return retired.length ? keepRetired(null, { ...r, retired }) : r; // its earlier keys come back with it
        } finally {
          keys.wallet?.fill(0);
        }
      }, { backedUp: !!walletWords }); // given words are a backup; random ones are not until backup() shows them
      return window.satori.status();
    },
    /**
     * Home's answer (docs/design/health.md): { status: 'ok' | 'idle' | 'warn' | 'bad', tone, title, line, action, days,
     * channels: { central, base, network }, feed, reasons (each bad, warn, idle or advice: the card only), work }, read fresh.
     */
    async health() {
      ready();
      return healthOf({ now: nowS(), rows: app.activity.rows(), central: await centralStatus(), base: await app.base.status(),
        nostr: await nostrStatus(), storage: await storage(), app: { ...state.app }, backedUp: !!state.backupAt, since: since(),
        installDismissed: state.installDismissed, nextStepDismissed: state.nextStepDismissed, traffic: lastTraffic(), work: work.all() });
    },
    /**
     * Show a tab: 'home' | 'models' | 'streams' | 'wallet' | 'settings' (also #home … #settings in the URL), or a model's
     * drill-in: 'models/<id>' (#models/<id>). → the tab, or 'models/<id>'
     */
    go(tab) { return go(String(tab ?? '').replace(/^#/, '')); },
    /** Settings → Appearance: 'system' (the default: the device's light or dark), 'light' or 'dark'; kept on this device. → it */
    setTheme(theme) { state.theme = setTheme(theme); return state.theme; },
    /** Poll central now: store, forecast new rows, send what is pending. → { poll, submit } */
    async poll() { ready(); return pollNow(); },
    /** Central's streams with the latest observation, our latest prediction and the stream's spec. */
    async streams() { ready(); return (await app.db.streams()).map((r) => ({ ...r, meta: parseMeta(r.meta), spec: parseMeta(r.spec) })); },
    /**
     * Every model the neuron runs (docs/design/models.md): central's streams, the Base batch's, the Nostr `_pred`s; each
     * { id, source, name, kind, quality, inputs, outputs: [{ stream, name, latest, forecast, direction, influence,
     * quality, destinations }], trained } and, for central's, the spec as before. From what the Models tab shows (read
     * again after every poll, Nostr publish and Base check: poll() resolves after it), so it is cheap.
     */
    async models() {
      ready();
      return listModels({ streams: state.streams, nostrStatus: state.nostr, baseStatus: state.base });
    },
    /**
     * One model's drill-in, recomputed now from its stored spec and history: models()'s fields, `model` (kind, rows,
     * tests, step, horizon, weight, λ's, generation, accepted, coef, trained, quality), each output's `history` (the
     * chart's), `ms` and `readMs`. id: models()'s, or a central stream's uuid or name. → null when there is none
     */
    async model(id) {
      ready();
      const d = await detailOf(String(id ?? ''), { streams: state.streams, nostrStatus: state.nostr, baseStatus: state.base });
      return d && { ...d, retrain: retrainOf(d) };
    },
    /**
     * Retrain a Satori Service model (docs/design/models.md#retrain): keep training it, from stored history, until one
     * beats no change, then stop; never a prediction. Resolves when it ends (or at once with a note when its last retrain
     * looked at the same data) → model(id).retrain's status. Throws when it can't: not a Network model, no history.
     */
    async retrain(id) {
      ready();
      const uuid = centralUuid(id);
      if (!uuid) throw new Error(`Retrain is for Satori Service models for now (got ${id}).`);
      if ((await app.retrain.start(uuid)).running) await app.retrain.done(uuid);
      return app.retrain.status(uuid);
    },
    /** Stop a retrain: it ends at its next try and keeps the current model. → its status */
    async stopRetrain(id) {
      ready();
      const uuid = centralUuid(id);
      if (!uuid) throw new Error(`No Satori Service model: ${id}.`);
      app.retrain.stop(uuid);
      await app.retrain.done(uuid);
      return app.retrain.status(uuid);
    },
    /** One stream's predictions (uuid or name), newest first. */
    async predictions(stream, limit = 20) { ready(); return app.db.predictions(stream, limit); },
    /** Set the central URL ('' = the default) and register there. → status().central */
    async setCentral(url) { ready(); await setCentral(url); return centralStatus(); },
    /**
     * Where the Satori Service sends this neuron's rewards, read from it now (signed in by the alias). → { address: '0x…'
     * (checksummed) | null (not set: the wallet), whose: 'wallet' | 'alias' | null, at }; throws when it could not be read.
     */
    async rewardAddress() {
      ready();
      const st = await readRewardNow();
      if (st.error) throw new Error(st.error);
      return { address: st.address, whose: st.whose, at: st.at };
    },
    /**
     * Set the reward address (a Base 0x address, not this neuron's alias) or clear it (null or ''), signed in by the
     * alias; free. → { address, whose, at }
     */
    async setRewardAddress(address) { ready(); const st = await setReward(address); return { address: st.address, whose: st.whose, at: st.at }; },
    /** Unlock (on the 'finish' screen it also finishes an earlier version's update, then the neuron starts). */
    async unlock(passphrase) {
      if (state.screen === 'finish') {
        await finishUpdate(passphrase);
      } else {
        ready();
        await exclusive('unlock', () => unlock(passphrase));
      }
      return true;
    },
    lock() { lock(); return true; },
    /**
     * The passphrase each time, unlocked or not (~0.3 s). 'alias' | 'wallet' → { words, privateKey }; 'nostr' → { nsec,
     * secret }; null or undefined → { alias, wallet, nostr }.
     */
    async backup(which, passphrase) { ready(); return backupOf(which, passphrase); },
    /**
     * Every key, sealed with `passphrase` (the wallet's; a connected wallet's own words are in its wallet app) in one
     * JSON file to keep where the person keeps secrets: setup({ passphrase, backup }) restores it on a fresh browser.
     * → { kind: 'satori-backup', v: 1, address, at, sealed }
     */
    async exportBackup(passphrase) {
      ready();
      const keys = await backupOf(undefined, passphrase);
      return sealBackup({ address: session.walletPublic.evmAddress, keys, passphrase });
    },
    /** Import a Docker (Lite) install: its { wallet } file's text, its `password`, and `passphrase` for this app (default: the password). */
    async importDocker({ wallet: walletText, password = '', passphrase = password } = {}) {
      await setup(async () => {
        const secrets = await readDockerFiles({ walletText, password });
        try {
          return await newKeys(secrets, passphrase);
        } finally {
          secrets.wallet.fill(0);
        }
      }, { backedUp: true });
      return window.satori.status();
    },
    /**
     * The Game tab (docs/design/base.md#the-game): who plays (`by`: the alias when staked with it, else the wallet), the
     * mode (`play`: by hand is 'manual'), whether it was played this round, the favorites, and the streams in the game's
     * order (eligible: reward eligible; alreadyPredicted: played as usual, not sent), with their history.
     */
    async game() {
      ready();
      const { by, streams, round, played: last } = await app.base.gameStreams();
      const favorites = readFavorites(session.walletPublic?.evmAddress);
      const { queue, split } = queueOf(streams, favorites);
      const today = last && last.round === round ? last : null;
      return { play: state.base.play, by, round, playedToday: today, opensAt: today ? opensAgain(today) : null, favorites,
        streams: queue.map((s, i) => ({ streamId: s.streamId, gameId: s.gameId, name: s.name, named: s.named, eligible: i < split,
          alreadyPredicted: played(s), latest: latestText(s), display: s.display ?? null, streak: s.streak ?? null, history: s.history })),
        unavailable: streams.filter((s) => !queue.includes(s)).map((s) => ({ streamId: s.streamId, name: s.name, why: s.blocked })) };
    },
    /**
     * Play the game by hand: [{ streamId, direction: 'up' | 'down' }], one transaction (needs setPlay('manual'); the wallet
     * unlocked when it plays). → { count, hash (null: nothing needed sending), by, at, round }
     */
    async playGame(picks = []) {
      ready();
      if (state.base.play !== 'manual') throw new Error("The app plays automatically: setPlay('manual') first, if the person asked to play by hand.");
      const g = await app.base.gameStreams();
      const { queue } = queueOf(g.streams);
      const calls = picks.map(({ streamId, direction }) => {
        const stream = queue.find((s) => s.streamId === Number(streamId));
        if (!stream) throw new Error(`Stream ${streamId} can't be played now.`);
        if (direction !== 'up' && direction !== 'down') throw new Error("direction: 'up' or 'down'.");
        return { stream, direction: direction === 'up' ? UP : DOWN };
      });
      if (!calls.length) throw new Error('No predictions to send.');
      const sent = await playCalls(calls, g);
      state.game = { ...state.game, loaded: 0 }; // the Game tab reads again when it opens
      return sent;
    },
    /** The game's favorites (stream ids, shown first, in this order), kept on this device for this wallet. → them */
    setGameFavorites(ids = []) {
      const favorites = [...new Set(ids.map(Number).filter(Number.isInteger))];
      writeFavorites(session.walletPublic?.evmAddress, favorites);
      state.game = { ...state.game, favorites, loaded: 0 };
      return favorites;
    },
    /**
     * Home's Satori contract card: the mode, whether a prediction went to the contract this round, and what has to be in
     * place, each { id, state: 'ok' | 'bad' | 'wait', text, fix?: 'stake' | 'fund' (with address) | 'game' }.
     */
    async contract() {
      ready();
      await app.base.refresh();
      const v = await app.base.status();
      return { play: v.play, predictedToday: predictedToday(v), checks: contractChecks(v) };
    },
    /**
     * Home's chip cards (docs/design/health.md#the-chip-cards): 'network' | 'contract' | 'relays' → { working, checks }
     * (working: the arrow is green: sent in the last day, predicted this round, a relay connected); the contract's also
     * has `play` (as contract()).
     */
    async channel(key) {
      ready();
      if (key === 'contract') { const c = await window.satori.contract(); return { ...c, working: c.predictedToday }; }
      if (key === 'network') { const c = await centralStatus(); return { working: networkSent(c, nowS()), checks: networkChecks(c, nowS()) }; }
      if (key === 'relays') { const n = await nostrStatus(); return { working: relaysOn(n), checks: relayChecks(n) }; }
      throw new Error("channel: 'network', 'contract' or 'relays'.");
    },
    /** One day of Home's strip ('2026-10-24', local): when the app predicted, on the Satori Service and the contract, and how those did. */
    async day(date) { ready(); return dayDetail(String(date)); },
    /**
     * Put away Home's advice card ('install': Install, kept on this device; 'next-step': the next step, for 3 days) or the
     * recovered-database notice ('notice').
     */
    dismiss(what) {
      if (what === 'notice') return void actions.dismissNotice();
      if (what !== 'install' && what !== 'next-step') throw new Error("dismiss: 'install', 'next-step' or 'notice'.");
      actions.dismissAdvice(what);
    },
    /** Nostr: the key, the relays and their state, the subscribed streams with the latest observation and our `_pred`. */
    async nostr() { ready(); return nostrStatus(); },
    /** The relays' stream catalog (newest per provider and stream, no tombstones); `pred` and `subscribed` marked. */
    async discover() { ready(); const list = await app.nostr.discover(); state.catalog = list; return list; },
    /**
     * The Market tab (docs/design/market.md#the-market-tab): `forSale`, every stream the relays announce with a price
     * (discover()'s entries, with its listing's `price` in SATORI and the track record's `record` when watched); and
     * nostr().market's `selling` and `bought`.
     */
    async market() {
      ready();
      const list = state.catalog.length ? state.catalog : await window.satori.discover();
      const records = await app.nostr.records();
      const forSale = list.filter((s) => listingOf(s) && watchable(s)).map((s) => ({ pubkey: s.pubkey, stream: s.stream_name, name: s.name,
        description: s.description, cadence_seconds: s.cadence_seconds, price: formatEther(listingOf(s).price),
        record: records.find((r) => r.pubkey === s.pubkey && r.stream === s.stream_name)?.markText ?? null }));
      const { market: mk } = await nostrStatus();
      return { forSale, selling: mk?.selling ?? [], bought: mk?.bought ?? [] };
    },
    /**
     * Follow a free stream: its data kept (Streams, the engine's inputs). { predict: true } predicts it too: its
     * `<stream>_pred` is published to the relays on each new observation (or setPredict later).
     */
    async subscribe(pubkey, stream, { predict = false } = {}) {
      ready();
      return setSubscribed(String(pubkey ?? '').trim().toLowerCase(), stream, true, { predict });
    },
    /** Predict a followed stream, or stop (its `_pred` tombstoned; still followed). → its view */
    async setPredict(pubkey, stream, on) {
      ready();
      const r = await app.nostr.setPredict(String(pubkey ?? '').trim().toLowerCase(), stream, on);
      await refreshNostr();
      return r;
    },
    /** → nostr(), as setRelays. */
    async unsubscribe(pubkey, stream) { ready(); return setSubscribed(String(pubkey ?? '').trim().toLowerCase(), stream, false); },
    /** Our `<stream>_pred` history for a relay stream, newest first: { seq, value, model, obs_seq, made_at, event_id, relays }. */
    async relayPredictions(pubkey, stream, limit = 20) {
      ready();
      return (await app.db.relayPredictions(relayUuid(String(pubkey ?? '').trim().toLowerCase(), String(stream ?? '')), limit))
        .map(({ stream_uuid, ...p }) => p);
    },
    /**
     * The track record (docs/design/track-record.md): every prediction stream on the relays, watched on its own, best first:
     * [{ pubkey, stream, name, mine, source: { pubkey, stream, name }, cadence_seconds, received, scored, error, noChange,
     * ratio, mark, markText, direction: { right, total }, since, last }]. Only predictions this neuron received before the outcome count.
     */
    async records() { ready(); return app.nostr.records(); },
    /** One watched prediction stream's record, with `pairs`: the last 28 scored { ts, predicted, actual, baseline }; null when not watched. */
    async record(pubkey, stream) { ready(); return app.nostr.record(pubkey, stream); },
    /** Sell one of this neuron's `<stream>_pred` streams at `price` SATORI per observation (only on the person's request). → nostr() */
    async sell(stream, price = DEFAULT_PRICE) { ready(); return marketAction('sell', () => app.nostr.sell(stream, price ?? DEFAULT_PRICE)); },
    /** That stream free again. → nostr() */
    async unsell(stream) { ready(); return marketAction('unsell', () => app.nostr.unsell(stream)); },
    /**
     * Buy a stream sold on the Satori contract (only on the person's request; needs Unlock; gas): the wallet opens a channel
     * with `deposit` SATORI (100 observations by default). → nostr().market.bought's entry
     */
    async buy(pubkey, stream, deposit) { ready(); return marketAction('buy', () => app.nostr.buy(String(pubkey ?? '').trim().toLowerCase(), stream, deposit)); },
    /** Stop buying: the alias asks to close the channel (gas, no Unlock); the rest comes back to the wallet after 7 days. → the same */
    async stop(pubkey, stream) { ready(); return marketAction('stop', () => app.nostr.stopBuying(String(pubkey ?? '').trim().toLowerCase(), stream)); },
    /**
     * After a stopped channel's grace period, take back `amount` SATORI (all that is left by default) to `to` (the wallet by
     * default); the channel stays, and buy() of that stream uses it again (needs Unlock; gas). → nostr().market.bought's entry
     */
    async takeBack(channel, amount, to) { ready(); return marketAction('takeBack', () => app.nostr.takeBack(channel, amount, to)); },
    /**
     * A bought or sold channel's grace period in `days` (needs Unlock; gas): longer by the buyer or shorter by the seller
     * applies at once, otherwise it is asked of the other side. → { applied, grace } (seconds)
     */
    async setGrace(channel, days) { ready(); return marketAction('setGrace', () => app.nostr.setGrace(channel, days)); },
    /** Where a buyer's channel of ours pays its settlements (needs Unlock; gas). → that buyer's entry in nostr().market.selling */
    async setPayout(channel, address) { ready(); return marketAction('setPayout', () => app.nostr.setPayout(channel, address)); },
    /** Settings: { relays: ['wss://…'], centralWrite: boolean }, either or both. → nostr() */
    async setRelays(settings) { ready(); const s = await app.nostr.setRelays(settings); await refreshNostr(); return s; },
    /** Base: a fresh read of the chain (one multicall) and the last batch. */
    async base() { ready(); await app.base.refresh(); return app.base.status(); },
    /** Stake with this neuron (needs Unlock): the wallet's prediction power to the alias. → { steps: [{ step, by, hash }], settled } */
    async stake() { ready(); return baseAction('stake', walletOps.delegate); },
    /** A fresh wallet link to this app's alias, sent at once (needs Unlock, or a connected wallet's approval). → the register's answer */
    async relink() { ready(); return baseAction('link', relinkWallet); },
    /** Unstake (needs Unlock): the SATORI can be sent once the next round ends. → the same shape */
    async unstake() { ready(); return baseAction('unstake', walletOps.undelegate); },
    /**
     * The on-chain rewards, the merkle drop, the airdrop: from the alias where anyone may claim to the wallet, else from
     * the wallet (needs Unlock then). → { rewards, merkle, airdrop }
     */
    async claim() { ready(); return baseAction('claim', walletOps.claim); },
    /**
     * The Dev Fee tab's state, read fresh (docs/design/devfee.md): { shown, top, splitters: [{ address, parent, authority,
     * pendingAuthority, thresholdPct, mine: { slotId, pct, wholePct, claimable, waiting, trigger } | null }] }; SATORI as
     * decimal strings.
     */
    async devFee() {
      ready();
      await readDevFee();
      if (state.devFee.error) throw new Error(state.devFee.error);
      return devFeeView(state.devFee.tree);
    },
    /** Claim the wallet's dev fee in `splitter` (what waits in the top moved down first). Needs Unlock; gas. → [{ hash, label }] */
    async devFeeClaim(splitter) { ready(); return devFeeAction('claim', splitter); },
    /** Who may trigger the wallet's payout in `splitter`: an address, or '' for anyone. Needs Unlock. */
    async devFeeTrigger(splitter, caller = '') { ready(); return devFeeAction('trigger', splitter, caller); },
    /** Hand the wallet's slot in `splitter` to `to`, for good. Needs Unlock. */
    async devFeeMoveSlot(splitter, to) { ready(); return devFeeAction('moveSlot', splitter, to); },
    /** Where "redirect `splitter` to `to`" stands: { to, agreedPct, thresholdPct, cleared, iAgreed }. No key. */
    async devFeeProposal(splitter, to) {
      ready();
      const p = await app.base.devFeeProposal(splitter, to);
      return { to: p.to, agreedPct: Number(p.agreedBps) / 100, thresholdPct: Number(p.thresholdBps) / 100, cleared: p.cleared, iAgreed: p.iAgreed };
    },
    /** Agree to redirect `splitter` to `to` (a payee of it). Needs Unlock. */
    async devFeeVote(splitter, to) { ready(); return devFeeAction('vote', splitter, to); },
    /** Take that agreement back. Needs Unlock. */
    async devFeeUnvote(splitter, to) { ready(); return devFeeAction('unvote', splitter, to); },
    /** Redirect `splitter`'s slot in the top to `to`: its authority alone, or anyone once enough agreed. Needs Unlock. */
    async devFeeRedirect(splitter, to) { ready(); return devFeeAction('redirect', splitter, to); },
    /** Offer `splitter`'s authority to `to` (it moves when they accept). Needs Unlock. */
    async devFeeOffer(splitter, to) { ready(); return devFeeAction('offer', splitter, to); },
    /** Accept `splitter`'s authority, offered to this wallet. Needs Unlock. */
    async devFeeAccept(splitter) { ready(); return devFeeAction('accept', splitter); },
    /** Give up `splitter`'s authority for good. Needs Unlock. */
    async devFeeGiveUp(splitter) { ready(); return devFeeAction('giveUp', splitter); },
    /**
     * The Admin tab's state, read fresh (docs/design/admin.md): { shown: false, admin } for anyone but the admin; for it,
     * { shown, admin, capabilities: [{ bit, name, on }], officialRelayer, registrationFee, offchainReporter, games:
     * [{ streamId, gameId, name, approved, isDefault }] }.
     */
    async admin() {
      ready();
      await readAdmin();
      if (state.admin.error) throw new Error(state.admin.error);
      return adminView(state.admin);
    },
    /** The capabilities switched on for everyone: `bits`, the whole list (the rest go off). Needs Unlock. → [{ hash, label }] */
    async adminCapabilities(bits) { ready(); return adminAction('capabilities', bits); },
    /** Approve (true) or disapprove (false) game `gameId`. Needs Unlock. */
    async adminGame(gameId, approved) { ready(); return adminAction('game', gameId, approved); },
    /** The official relayer: an address, or '' for none. Needs Unlock. */
    async adminRelayer(to = '') { ready(); return adminAction('relayer', to); },
    /** The adapter registration fee, in SATORI (a decimal string, above 0). Needs Unlock. */
    async adminRegistrationFee(satori) { ready(); return adminAction('registrationFee', satori); },
    /** The off-chain prediction reporter: an address, or '' to switch it off. Needs Unlock. */
    async adminReporter(to = '') { ready(); return adminAction('reporter', to); },
    /** Register an official adapter: kind 'stream' or 'game', its contract address and name. Needs Unlock. */
    async adminRegisterAdapter(kind, address, name) { ready(); return adminAction('registerAdapter', kind, address, name); },
    /** Hand the admin to `to`, at once and for good from this wallet. Needs Unlock. */
    async adminTransfer(to) { ready(); return adminAction('transfer', to); },
    /**
     * The other special keys (docs/design/roles.md), read fresh: { split, schedule, publisher, appoint, wiring }, each
     * { label, holder, pending, held, isHolder, isPending, values (its page's, when held), actions }.
     */
    async specialKeys() {
      ready();
      await readRoles();
      if (state.roles.error) throw new Error(state.roles.error);
      return rolesView(state.roles.of);
    },
    /**
     * One special key's action (`role`, `action`: specialKeys()'s ids), with `value` as typed on its card (none for a
     * button). Needs Unlock; gas. → [{ hash, label }]
     */
    async specialKey(role, action, value) {
      ready();
      await readRoles();
      return (await roleAction(role, action, value)).txs;
    },
    /**
     * The Safe tab, read fresh (docs/design/safe.md): { shown, safes: [{ address, owners, threshold, nonce, keys: { root,
     * fee, upgrade, freeze, loader: values }, pending: [{ safeTxHash, nonce, description, signatures, signedByMe, enough,
     * next }] }] }.
     */
    async safe() {
      ready();
      await readSafe();
      if (state.safe.error) throw new Error(state.safe.error);
      return safeView(state.safe.safes);
    },
    /** Propose a Safe key's action (`key`, `action`, `value` as on its card), signed by the wallet. Needs Unlock; no gas. → { safeTxHash, nonce } */
    async safePropose(key, action, value) {
      ready();
      await readSafe();
      const r = await safeAction(`${key}:${action}`, () => app.base.safePropose(theSafe(), key, action, value));
      return { safeTxHash: r.safeTxHash, nonce: r.nonce.toString() };
    },
    /** Sign a waiting Safe transaction. Needs Unlock; no gas. */
    async safeSign(safeTxHash) { ready(); await readSafe(); await safeAction(`sign:${safeTxHash}`, () => app.base.safeSign(theSafe(), safeTxHash)); return { signed: true }; },
    /** Execute a waiting Safe transaction signed by enough owners (the next one). Needs Unlock; gas. → [{ hash, label }] */
    async safeExecute(safeTxHash) { ready(); await readSafe(); return safeAction(`execute:${safeTxHash}`, () => app.base.safeExecute(theSafe(), safeTxHash)); },
    /** The alias's daily batch now, if this round has none yet. → the check's result */
    async predictBase() { ready(); const r = await app.base.predict(); await refreshBase(); return r; },
    /** The review before a send, no key needed: { asset, to, amount } → { asset, to, amount, fee: { gas, about, max } } */
    async quoteSend(o) { ready(); return app.base.quoteSend(o); },
    /** From the wallet, with its passphrase each time: { asset: 'ETH' | 'SATORI', to: '0x…', amount: '1.5', passphrase } → { hash } */
    async send(o) { ready(); return baseAction('send', () => walletOps.send(o)); },
    /** Preload gas: Base ETH from the wallet to this app's alias (it pays the daily batch's gas); `amount` defaults to base().alias.preload. → { hash } */
    async preloadGas({ amount, passphrase } = {}) {
      ready();
      const to = state.base.alias.address;
      return baseAction('send', () => walletOps.send({ asset: 'ETH', to, amount: amount ?? state.base.alias.preload, passphrase }));
    },
    /** The Base RPC: an https URL, a same-origin path, or '' for the default. → base() */
    async setBaseRpc(url) { ready(); return setBaseSettings({ rpc: url }); },
    /** The unattended batch's ceiling on the max fee per gas, in gwei (null or '' = the default, 2). → base() */
    async setBaseMaxFee(gwei) { ready(); return app.base.setSettings({ maxFee: gwei }); },
    /** Who sends the Satori contract predictions: 'auto' (the daily batch) or 'manual' (the Game tab: not sent). → base() */
    async setPlay(mode) { ready(); const v = await app.base.setPlay(mode); state.base = v; return v; },
    /**
     * The daily reminder (docs/design/push.md): on, this browser asks for notification permission and subscribes; once a
     * day, if today's predictions aren't in, the app sends them in the background, or a notification reminds the person.
     * → reminder() */
    async setReminder(on) {
      ready();
      if (typeof on !== 'boolean') throw new Error('setReminder(true) or setReminder(false).');
      await turnReminder(on, reminderPlayer());
      return this.reminder();
    },
    /**
     * The Game's Remind me: one notification when the game opens again after this round's play (game().opensAt), whether
     * or not the daily reminder is on. → { at } (unix seconds)
     */
    async remindMe() {
      ready();
      const g = await this.game();
      if (!g.opensAt) throw new Error('Not played with the game this round: nothing to remind of.');
      return { at: await remindOnce(g.opensAt) };
    },
    /** { supported, on, minute, note }: whether this browser can take the daily reminder, whether it is on, its time (minute
     * of the local day: when it was turned on), and why not. */
    reminder() { const { supported, on, minute, note } = state.reminder; return { supported, on, minute, note }; },
  };

  return satori;
}
