// The screens' actions (src/ui/*.js calls them as `a.…`): each a person's tap or form, its checks and what it shows
// after. The running app's parts come from src/main.js (createActions), its changing ones read (and set) when used.
//   const actions = createActions({ exclusive, go, …, get db() { return db; }, … })
import { state } from './ui/view.js';
import {
  generateSecret, secretFromText, wordsOf, newKeys, readDockerFiles, passphraseOk, MIN_PASSPHRASE, IMPORT_MAX,
} from './keys/index.js';
import { findWallets } from './keys/connect.js';
import { errorText, same } from './chain/index.js';
import { toggleDest } from './neuron/models.js';
import { box as modelBox } from './ui/models.js';
import { NEED_GAS, NEED_ALIAS_GAS, NEED_STAKE_GAS } from './neuron/base.js';
import { shareLink, sharedLink } from './neuron/referral.js';
import { queueOf, stepOf, favoritesIn, played, opensAgain } from './ui/gameflow.js';
import { playerOf } from './neuron/play.js';
import { DEFAULT_PRICE } from './ui/market.js';
import { formatEther, getAddress, isAddress } from 'viem';
import { setTheme } from './ui/theme.js';
import { writePref, readFavorites, writeFavorites, SORT_KEY, INSTALL_KEY, NEXT_STEP_KEY } from './ui/prefs.js';
import { pickIndexes, shortHash, claimLine, stepText, fmtNum } from './ui/format.js';
import { applyUpdate, install } from './pwa/index.js';
import { turnReminder, remindOnce } from './pwa/push.js';

export function createActions(app) {
  const {
    ADMIN_DONE, DEFAULTS, DEV_FEE_DONE, addWallet, adminAction, autoLock, backupOf, baseAction, connectTo, dayDetail,
    devFeeAction, exclusive, finishUpdate, go, keyring, lock, marketAction, nameWallet, nowS, playCalls, pollNow,
    readRewardNow, reconnect, recordOf, refreshAdmin, refreshBase, refreshDevFee, refreshNostr, refreshRoles,
    refreshSafe, relinkWallet, reminderPlayer, removeNeeds, removeWallet, retiredText, roleAction, safeAction,
    session, setAsideDb, setBaseSettings, setCentral, setReward, setSubscribed, setup, switchWallet, theSafe, unlock,
    walletOps, withWallet,
  } = app;

  function wipePending() {
    app.pending?.wallet?.fill(0);
    app.pending = null;
    state.words = [];
    state.passNote = '';
  }

  function goStep(step) {
    state.error = '';
    state.step = step;
  }

  /** A UI action whose error is shown at state[key], cleared when it starts. */
  const shownAt = (key, fn) => async (...args) => {
    state[key] = '';
    try {
      await fn(...args);
    } catch (err) {
      state[key] = err?.message ?? String(err);
    }
  };

  /** A Base action from the card: its result (text, and its txs, linked) or error is shown there. */
  const baseUi = (what, fn) => shownAt('baseError', async () => {
    Object.assign(state, { baseResult: '', baseTxs: [], baseDid: what });
    const { text, txs = [] } = await baseAction(what, fn);
    Object.assign(state, { baseResult: text, baseTxs: txs });
  })();

  const stepTxs = (steps) => steps.map((x) => ({ label: stepText(x.step), title: `${x.step} by the ${x.by}`, hash: x.hash }));
  const claimTxs = (r) => [['Rewards', r.rewards], ['Merkle', r.merkle], ['Airdrop', r.airdrop]]
    .filter(([, x]) => x?.hash).map(([label, x]) => ({ label, hash: x.hash }));

  const actions = {
    goStep,
    setTheme(t) { state.theme = setTheme(t); },
    newWords() {
      wipePending();
      app.pending = { wallet: generateSecret() };
      state.words = wordsOf(app.pending.wallet).split(' ');
      goStep('words');
    },
    toConfirm() {
      state.confirmAt = pickIndexes(3, 24);
      goStep('confirm');
    },
    confirmWords(f, el) {
      const ok = state.confirmAt.every((i) => (f[`w${i}`] ?? '').trim().toLowerCase() === state.words[i]);
      if (!ok) return void (state.error = 'Those words do not match. Check your list.');
      el.reset();
      goStep('passphrase');
    },
    restoreWords(f, el) {
      wipePending();
      const secret = (text, which) => {
        try { return secretFromText(text); } catch { throw new Error(`The ${which}: not 24 backup words or a private key.`); }
      };
      try {
        app.pending = { wallet: secret(f.wallet, 'wallet') }; // the alias and the Nostr key are derived from it
      } catch (err) {
        wipePending();
        return void (state.error = err.message);
      }
      el.reset();
      goStep('passphrase');
    },
    createKeys: shownAt('error', async (f, el) => {
      if (f.pass1 !== f.pass2) throw new Error('The passphrases differ.');
      await setup(async () => {
        const out = await newKeys(app.pending, f.pass1);
        wipePending();
        el.reset();
        return out;
      }, { backedUp: true }); // reached only after the words were confirmed, typed in, or brought as files
    }),
    /**
     * Dockerized Neuron files: decrypted with the Docker wallet password and translated into this app's
     * record. The same password becomes this app's passphrase when it meets the rule and `reuse` is ticked;
     * otherwise the passphrase step asks for one.
     */
    /** Setup's Connect: the wallets in this browser (docs/design/wallets.md#a-connected-wallet). */
    async lookForWallets() {
      goStep('connect');
      Object.assign(state, { connectFound: null, error: '' });
      app.foundWallets = await findWallets();
      state.connectFound = app.foundWallets.map(({ rdns, name }) => ({ rdns, name }));
      state.walletConnectReady = !!DEFAULTS.walletConnect;
    },
    connect: shownAt('error', (rdns) => connectTo(rdns)),
    reconnect: shownAt('walletError', () => reconnect()),
    importDocker: shownAt('error', async (el) => {
      const f = new FormData(el);
      await setup(async () => {
        if (f.get('wallet')?.size > IMPORT_MAX) throw new Error('The wallet file: over 64 KB, so not a Docker file.'); // not read at all
        const password = String(f.get('pass') ?? '');
        const reuse = f.get('reuse') === 'on';
        const secrets = await readDockerFiles({ walletText: await f.get('wallet').text(), password });
        el.reset();
        if (reuse && passphraseOk(password)) {
          try {
            return await newKeys(secrets, password);
          } finally {
            secrets.wallet.fill(0);
          }
        }
        wipePending();
        app.pending = secrets;
        state.passNote = reuse
          ? `The Docker install's wallet password is shorter than ${MIN_PASSPHRASE} characters. Choose a new passphrase for this app.`
          : 'Choose a passphrase for this app.';
        goStep('passphrase');
        return null;
      }, { backedUp: true });
    }),
    /** Settings' Unlock; an action asked for meanwhile (its inline prompt open) runs after it, and the wallet stays unlocked. */
    unlock: shownAt('walletError', async (f, el) => actions.unlockAndRun(f, el)),
    /** The inline prompt: Unlock, then the action it was opened for, then Lock again (it was unlocked for that alone). */
    unlockThen: shownAt('unlockError', async (f, el) => actions.unlockAndRun(f, el, { inline: true })),
    async unlockAndRun(f, el, { inline = false } = {}) {
      await exclusive('unlock', () => unlock(f.pass));
      el.reset();
      const fn = app.afterUnlock;
      app.afterUnlock = null;
      if (!fn) return;
      try {
        await fn();
      } finally {
        if (inline) lock();
      }
    },
    cancelUnlock() {
      app.afterUnlock = null;
      Object.assign(state, { unlockFor: '', unlockError: '' });
    },
    go,
    /** Models: open a model's drill-in (#models/<id>). */
    openModel(id) {
      const listed = state.tab === 'models' && !state.modelOpen;
      go(`models/${id}`);
      app.fromList = listed;
    },
    /** Back to the list: the browser's back when the list is the page before, else to #models. */
    closeModel() {
      if (app.fromList) history.back();
      else go('models');
    },
    /** The open model's Retrain button: 'retrain' asks for one (kept, then run), 'stop' ends it (docs/design/models.md#retrain). */
    async retrainModel(action) {
      const d = modelBox.detail;
      const uuid = d?.source === 'central' ? d.id.slice('central:'.length) : null;
      if (!uuid || !app.retrain) return;
      state.retrainError = '';
      try {
        if (action === 'stop') app.retrain.stop(uuid);
        else await app.retrain.start(uuid);
      } catch (err) {
        state.retrainError = err?.message ?? String(err);
      }
    },
    /** The Models list's filters (where predictions go: a tap turns one off or on, the last stays on) and sort; the sort is kept on this device. */
    setModelView({ to, sort }) {
      if (to) state.modelTo = toggleDest(state.modelTo, to);
      if (sort) {
        state.modelSort = sort;
        writePref(SORT_KEY, sort);
      }
    },
    /** Streams: a stream's detail (its trend, its model, its latest predictions), or none (''). */
    /** A prediction stream's detail on Streams (its record, with its pairs), in place under its row; '' closes it. */
    async openRecord(key) {
      Object.assign(state, { recordOpen: key, recordDetail: null, recordError: '' });
      if (!key) return;
      try {
        const r = await recordOf(key);
        if (state.recordOpen === key) Object.assign(state, r ? { recordDetail: r } : { recordError: 'No longer watched.' });
      } catch (err) {
        if (state.recordOpen === key) state.recordError = `Its record could not be read: ${err?.message ?? err}`;
      }
    },
    /** Home's strip: a day opened (docs/design/health.md#a-day-opened), or the same day again: closed. */
    async openDay(date) {
      state.dayOpen = state.dayOpen === date ? '' : date;
      if (!state.dayOpen) return;
      try {
        const day = await dayDetail(date);
        if (state.dayOpen === date) state.day = day;
      } catch (err) {
        if (state.dayOpen === date) state.day = { date, error: `This day could not be read: ${err?.message ?? err}` };
      }
    },
    async openStream(uuid) {
      state.streamOpen = uuid;
      state.streamPreds = uuid ? await app.db.predictions(uuid, 10) : [];
    },
    /** Home's action card: its one button (docs/design/health.md#reasons-in-priority-order). */
    act(a) {
      if (!a) return;
      if (a.do === 'reload') location.reload();
      else if (a.do === 'poll') actions.pollNow();
      else if (a.do === 'install') actions.install();
      else if (a.do === 'dismiss') actions.dismissAdvice(a.id);
      else if (a.do === 'stake') actions.walletAction('card', 'baseDelegate');
      else if (a.do === 'receive') { go('wallet', 'receive'); state.contractQr = state.wallet; } // the address, with its QR code
      else if (a.do === 'preload') { go('wallet', 'preload'); requestAnimationFrame(actions.preloadForm); }
      else if (a.do === 'auto') actions.setPlay('auto');
      else if (a.do === 'relink') withWallet('card', actions.baseRelink);
      else if (a.do === 'backup') {
        go('settings', 'backup');
        actions.askBackup('wallet');
      } else if (a.do === 'go') go(a.tab, a.section);
    },
    finishUpdate: shownAt('walletError', async (f, el) => {
      await finishUpdate(f.pass);
      el.reset();
    }),
    lock,
    /** Backup's buttons: the passphrase is asked each time, in place (docs/design/keys.md#backup). */
    askBackup(which) {
      Object.assign(state, { backupAsk: which, backupError: '', backup: '', backupWords: '', backupKey: '', backupHex: '' }); // what another showed goes
      requestAnimationFrame(() => [...document.querySelectorAll('form.inline-unlock')].find((f) => !f.hidden && f.dataset.test?.endsWith('backup-prompt'))
        ?.querySelector('input')?.focus());
    },
    cancelBackup() { Object.assign(state, { backupAsk: '', backupError: '' }); },
    /** The passphrase typed: the key's backup shown, for 5 minutes without interaction at most. */
    showBackup: shownAt('backupError', async (f, el) => {
      const which = state.backupAsk;
      state.revealing = true;
      try {
        const b = await backupOf(which, f.pass);
        el.reset();
        const key = which === 'retired' ? retiredText(b) : b.privateKey ?? b.nsec;
        Object.assign(state, { backupAsk: '', backup: which, backupWords: b.words ?? '', backupKey: key, backupHex: b.secret ?? '' });
        if (autoLock.lockAt == null) autoLock.start();
        else autoLock.touch();
      } finally {
        state.revealing = false;
      }
    }),
    hideBackup() {
      Object.assign(state, { backup: '', backupWords: '', backupKey: '', backupHex: '' });
      if (!keyring.wallet) autoLock.stop();
    },
    async copy(key, text) {
      try {
        await navigator.clipboard.writeText(text);
        state.copied = key;
        setTimeout(() => (state.copied = ''), 1500);
      } catch { /* clipboard not allowed */ }
    },
    /** Share: the invite link (docs/design/base.md#referral-invite-links) to the device's share sheet, else copied. */
    async share() {
      if (await shareLink(sharedLink(state.base.inviteLink, state.tab)) !== 'copied') return;
      state.copied = 'share';
      setTimeout(() => (state.copied = ''), 1500);
    },
    pollNow: () => pollNow().catch((err) => console.error('[satori] poll', err)),
    install: () => install().catch((err) => console.warn('[satori] install', err)),
    /**
     * Home's Install card put away (Not now, Got it): once, on this device (docs/design/pwa.md#install). The next step's
     * (Not now): for 3 days.
     */
    dismissAdvice(id) {
      if (id === 'next-step') {
        state.nextStepDismissed = nowS();
        writePref(NEXT_STEP_KEY, String(state.nextStepDismissed));
        return;
      }
      if (id !== 'install') return;
      state.installDismissed = true;
      writePref(INSTALL_KEY, 'dismissed');
    },
    update: applyUpdate,
    dismissNotice() { state.noticeDismissed = true; },
    setAside: () => setAsideDb().catch((err) => console.error('[satori] set aside', err)),
    discover: shownAt('networkError', async () => {
      state.discovering = true;
      try {
        state.catalog = await app.nostr.discover();
      } finally {
        state.discovering = false;
      }
    }),
    subscribe: shownAt('networkError', async (pubkey, stream, on) => {
      state.subscribing = `${pubkey}:${stream}`;
      try {
        await setSubscribed(pubkey, stream, on);
      } finally {
        state.subscribing = '';
      }
    }),
    /** The Network Streams list's one button: Predict follows the stream and predicts it; Stop predicting unfollows it. */
    predictStream: shownAt('networkError', async (pubkey, stream, on) => {
      state.subscribing = `${pubkey}:${stream}`;
      try {
        const followed = state.nostr.subscriptions.some((x) => x.provider === pubkey && x.stream === stream);
        if (on && followed) {
          await app.nostr.setPredict(pubkey, stream, true);
          await refreshNostr();
        } else await setSubscribed(pubkey, stream, on, { predict: true });
      } finally {
        state.subscribing = '';
      }
    }),
    /** Predict a followed stream (its `_pred` published to the relays), or stop. */
    setPredict: shownAt('networkError', async (pubkey, stream, on) => {
      state.subscribing = `${pubkey}:${stream}`;
      try {
        await app.nostr.setPredict(pubkey, stream, on);
        await refreshNostr();
      } finally {
        state.subscribing = '';
      }
    }),
    /** Paid streams (docs/design/market.md): a price on one of our `_pred`s, free again, Buy (the wallet: Unlock in place), Stop. */
    sell: shownAt('marketError', (stream, f) => marketAction(`sell:${stream}`, () => app.nostr.sell(stream, String(f.price ?? '').trim() || DEFAULT_PRICE))),
    unsell: shownAt('marketError', (stream) => marketAction(`sell:${stream}`, () => app.nostr.unsell(stream))),
    buy(pubkey, stream, f) {
      state.networkError = '';
      return withWallet('buy', () => actions.buyNow(pubkey, stream, f.deposit));
    },
    buyNow: shownAt('networkError', (pubkey, stream, deposit) => marketAction(`buy:${pubkey}:${stream}`, () => app.nostr.buy(pubkey, stream, deposit))),
    stop: shownAt('marketError', (pubkey, stream) => marketAction(`stop:${pubkey}:${stream}`, () => app.nostr.stopBuying(pubkey, stream))),
    /** A channel's grace period, what is left taken back, a buyer's payout address: the wallet (Unlock in place). */
    setGrace(channel, f) { state.marketError = ''; return withWallet('market', () => actions.setGraceNow(channel, f.days)); },
    setGraceNow: shownAt('marketError', (channel, days) => marketAction(`grace:${channel}`, () => app.nostr.setGrace(channel, days))),
    takeBack(channel, f) { state.marketError = ''; return withWallet('market', () => actions.takeBackNow(channel, f.amount, f.to)); },
    takeBackNow: shownAt('marketError', (channel, amount, to) => marketAction(`take:${channel}`, () => app.nostr.takeBack(channel, amount, to))),
    setPayout(channel, f) { state.marketError = ''; return withWallet('market', () => actions.setPayoutNow(channel, f.payout)); },
    setPayoutNow: shownAt('marketError', (channel, address) => marketAction(`payout:${channel}`, () => app.nostr.setPayout(channel, address))),
    fillRelays(el) {
      el.elements.relays.value = state.nostr.userRelays.join('\n');
      el.elements.centralWrite.checked = state.nostr.centralWrite;
    },
    saveRelays: shownAt('relaysError', async (f, el) => {
      await app.nostr.setRelays({ relays: String(f.relays ?? '').split(/\s+/).filter(Boolean), centralWrite: f.centralWrite === 'on' });
      await refreshNostr();
      actions.fillRelays(el);
    }),
    baseRefresh: () => baseAction('refresh', () => app.base.refresh()).catch(() => {}),
    /** A wallet action from the UI: Unlock first (inline, at `slot`) when the wallet is locked. */
    async walletAction(slot, name) {
      // Claim: the alias claims what anyone may claim to the wallet (its own gas); Unlock, and the wallet's gas, only when
      // a part is the wallet's own
      if (name === 'baseClaim' && !(await app.base.claimNeedsWallet().catch(() => true))) return actions[name]();
      // Claim and Stake are transactions: no gas is said before trying (and before Unlock), after a fresh read (it may have just come)
      const noGas = () => (name === 'baseClaim' ? state.base.wallet.lowEth && NEED_GAS
        : name === 'baseDelegate' && (state.base.alias.noGas ? NEED_ALIAS_GAS : state.base.wallet.lowEth && NEED_STAKE_GAS));
      if (noGas()) await app.base.refresh().then((v) => { state.base = v; }, () => {});
      if (noGas()) return void Object.assign(state, { baseDid: name === 'baseClaim' ? 'claim' : 'stake', baseResult: '', baseTxs: [], baseError: noGas() });
      return withWallet(slot, () => actions[name]());
    },
    /**
     * A Dev Fee card's action (docs/design/devfee.md): Unlock first (inline, in that card: `card`) when locked; its
     * outcome in that card. `typed`: the address typed a second time, for the ones that can't be undone.
     */
    devFee(card, op, splitter, arg, typed) {
      Object.assign(state.devFee, { did: card, result: '', txs: [], actionError: '' });
      if (typed !== undefined && String(typed).trim().toLowerCase() !== String(arg ?? '').trim().toLowerCase()) {
        state.devFee.actionError = 'The two addresses do not match.';
        return undefined;
      }
      return withWallet(card, () => actions.devFeeNow(op, splitter, arg));
    },
    async devFeeNow(op, splitter, arg) {
      const mine = state.devFee.tree?.mine.find((m) => same(m.node, splitter));
      try {
        const txs = await devFeeAction(op, splitter, ...(arg === undefined ? [] : [arg]));
        const done = op === 'claim' ? DEV_FEE_DONE.claim(fmtNum(Number(formatEther((mine?.claimable ?? 0n) + (mine?.waiting ?? 0n)))))
          : DEV_FEE_DONE[op](isAddress(String(arg ?? '').trim()) ? getAddress(String(arg).trim()) : '');
        Object.assign(state.devFee, { result: done, txs });
        if (op === 'vote' || op === 'unvote') await actions.devFeeCheck(splitter, arg);
      } catch (err) {
        state.devFee.actionError = err?.shortMessage ?? err?.message ?? String(err);
      }
    },
    devFeeRefresh: () => refreshDevFee(true),
    /**
     * An Admin card's action (docs/design/admin.md): Unlock first (inline, in that card: `card`) when locked; its outcome
     * in that card. `typed`: the address typed a second time, for handing the admin on.
     */
    admin(card, op, args, typed) {
      Object.assign(state.admin, { did: card, result: '', txs: [], actionError: '' });
      if (typed !== undefined && String(typed).trim().toLowerCase() !== String(args[0] ?? '').trim().toLowerCase()) {
        state.admin.actionError = 'The two addresses do not match.';
        return undefined;
      }
      return withWallet(card, () => actions.adminNow(op, args));
    },
    async adminNow(op, args) {
      try {
        const txs = await adminAction(op, ...args);
        Object.assign(state.admin, { result: ADMIN_DONE[op](...args), txs });
      } catch (err) {
        state.admin.actionError = err?.shortMessage ?? err?.message ?? String(err);
      }
    },
    adminRefresh: () => refreshAdmin(true),
    /**
     * A special key's card (docs/design/roles.md): Unlock first (inline, in that card) when locked; its outcome in that
     * card. `again`: the value typed a second time, for the ones typed twice.
     */
    role(role, action, typed, again) {
      const card = `${role}:${action}`;
      Object.assign(state.roles, { did: card, result: '', txs: [], actionError: '', ask: '' });
      if (again !== undefined && String(again).trim().toLowerCase() !== String(typed ?? '').trim().toLowerCase()) {
        state.roles.actionError = 'The two entries do not match.';
        return undefined;
      }
      return withWallet(card, () => actions.roleNow(role, action, typed));
    },
    async roleNow(role, action, typed) {
      try {
        const { txs, said } = await roleAction(role, action, typed);
        Object.assign(state.roles, { result: said, txs });
      } catch (err) {
        state.roles.actionError = err?.shortMessage ?? err?.message ?? String(err);
      }
    },
    /** A card that asks first (a freeze): ask, or (`''`) stop asking. */
    roleAsk(card) { state.roles.ask = card; },
    rolesRefresh: () => refreshRoles(true),
    /**
     * A Safe key's card (docs/design/safe.md): proposed to the Safe, signed by the wallet (Unlock first, in the card).
     * `again`: the value typed a second time.
     */
    safe(keyId, action, typed, again) {
      const card = `${keyId}:${action}`;
      Object.assign(state.safe, { did: card, result: '', txs: [], actionError: '', ask: '' });
      if (again !== undefined && String(again).trim().toLowerCase() !== String(typed ?? '').trim().toLowerCase()) {
        state.safe.actionError = 'The two entries do not match.';
        return undefined;
      }
      return withWallet(`safe-${card}`, async () => {
        try {
          const { nonce } = await safeAction(card, () => app.base.safePropose(theSafe(), keyId, action, typed));
          state.safe.result = `Proposed as the Safe's transaction ${nonce}, with your signature. It waits for the other owners, under Waiting.`;
        } catch (err) {
          state.safe.actionError = err?.shortMessage ?? err?.message ?? String(err);
        }
      });
    },
    safeAsk(card) { state.safe.ask = card; },
    /** Sign, or Execute, a waiting transaction (its outcome under Waiting). */
    safeWaiting(op, hash) {
      Object.assign(state.safe, { did: 'waiting', result: '', txs: [], actionError: '' });
      return withWallet('safe-waiting', async () => {
        try {
          if (op === 'sign') {
            await safeAction(`sign:${hash}`, () => app.base.safeSign(theSafe(), hash));
            state.safe.result = 'Signed.';
          } else {
            state.safe.txs = await safeAction(`execute:${hash}`, () => app.base.safeExecute(theSafe(), hash));
            state.safe.result = 'Executed.';
          }
        } catch (err) {
          state.safe.actionError = err?.shortMessage ?? err?.message ?? String(err);
        }
      });
    },
    safeRefresh: () => refreshSafe(true),
    /** Redirect this splitter: where the proposal to `to` stands (read, no key). */
    async devFeeCheck(splitter, to) {
      state.devFee.proposal = null;
      if (!String(to ?? '').trim()) return;
      try {
        state.devFee.proposal = { splitter, ...await app.base.devFeeProposal(splitter, to) };
      } catch (err) {
        state.devFee.proposal = { splitter, error: err?.shortMessage ?? err?.message ?? String(err) };
      }
    },
    baseRelink: () => baseUi('link', async () => {
      await relinkWallet();
      return { text: 'Linked: the Satori Service pays this wallet.' };
    }),
    baseDelegate: () => baseUi('stake', async () => {
      const r = await walletOps.delegate();
      return { text: r.steps.length ? 'Staked with this app.' : 'Already staked with this app.',
        txs: stepTxs(r.steps) };
    }),
    baseUndelegate: () => baseUi('unstake', async () => {
      const r = await walletOps.undelegate();
      return { text: r.steps.length ? 'Unstaked.' : 'Not staked.', txs: stepTxs(r.steps) };
    }),
    baseClaim: () => baseUi('claim', async () => {
      const r = await walletOps.claim();
      return { text: [claimLine('Rewards', r.rewards), claimLine('Merkle', r.merkle), claimLine('Airdrop', r.airdrop)].join(' · '),
        txs: claimTxs(r) };
    }),
    /**
     * Send, step one: the review (docs/design/base.md#send-the-passphrase-each-time): the recipient in full, the amount and the asset, the
     * estimated fee; SATORI that can't be sent is said here, before the passphrase.
     */
    reviewSend: shownAt('baseError', async (f) => {
      Object.assign(state, { baseDid: 'send', baseResult: '', baseTxs: [], sendQuoting: true });
      try {
        state.sendReview = await app.base.quoteSend({ asset: f.asset, to: f.to, amount: f.amount });
      } finally {
        state.sendQuoting = false;
      }
      requestAnimationFrame(() => document.querySelector('[data-test=send-review] input')?.focus());
    }),
    /** Preload now (beside "you must preload some gas"): the Wallet tab's Preload gas, the form filled in, from anywhere. */
    preloadNow() {
      state.baseError = '';
      go('wallet', 'preload');
      requestAnimationFrame(actions.preloadForm);
    },
    /** Preload gas: the Send form filled in, Base ETH to this app's alias, a month of daily batches; the person checks and sends. */
    preloadForm() {
      const f = document.querySelector('form.send');
      if (!f) return;
      Object.assign(state, { sendReview: null, baseError: '' });
      f.elements.asset.value = 'ETH';
      f.elements.to.value = state.base.alias.address;
      f.elements.amount.value = state.base.alias.preload ?? '';
      f.elements.amount.focus();
    },
    /** Back to the form, as it was typed. */
    backSend() { Object.assign(state, { sendReview: null, baseError: '' }); },
    /** Step two: Send, with the wallet's passphrase (asked each time, unlocked or not). */
    confirmSend: (f, el) => baseUi('send', async () => {
      const q = state.sendReview;
      const r = await walletOps.send({ asset: q.asset, to: q.to, amount: q.amount, passphrase: f.pass });
      el.reset();
      document.querySelector('form.send')?.reset();
      state.sendReview = null;
      return { text: `Sent ${q.amount} ${q.asset}.`, txs: [{ label: `${q.asset} to ${shortHash(q.to)}`, hash: r.hash }] };
    }),
    /** What is stored, not the defaults (those are the placeholders). */
    fillBase(el) {
      el.elements.rpc.value = state.base.rpcSetting;
      el.elements.maxFee.value = state.base.maxFeeSetting ?? '';
    },
    // ── the Game tab (docs/design/base.md#the-game) ──
    /** Its streams read again: which can be played now, in order (favorites first). */
    async loadGame() {
      const g = state.game;
      if (g.loading || !app.base) return;
      state.game = { ...g, loading: true, error: '' };
      try {
        const { by, streams, round, played: last } = await app.base.gameStreams();
        const favorites = readFavorites(session.walletPublic?.evmAddress);
        const { queue, split } = queueOf(streams, favorites);
        // played with the game this round: its Sent screen again (predictions made elsewhere are played as usual)
        const sent = last && round != null && last.round === round ? { ...last, again: true } : null;
        state.game = { ...state.game, loading: false, loaded: Date.now(), by, streams, queue, split, favorites, round,
          favs: favoritesIn(queue, favorites), index: 0, picks: {}, screen: 'play', move: '', sendError: '', sent };
      } catch (err) {
        state.game = { ...state.game, loading: false, error: errorText(err) };
      }
    },
    /** Up (UP) or down (DOWN) on the stream shown; the next one. */
    gamePick(direction) {
      const s = state.game.queue[state.game.index];
      if (!s || state.game.screen !== 'play') return;
      state.game = { ...state.game, picks: { ...state.game.picks, [s.streamId]: direction } };
      actions.gameNext();
    },
    /** On (a swipe left: skips the stream; from the submit screen, on to more streams), as gameflow.js stepOf. */
    gameNext() { actions.gameStep(1); },
    /** Back (a swipe right). */
    gameBack() { actions.gameStep(-1); },
    gameStep(dir) {
      const g = state.game;
      const to = stepOf({ screen: g.screen, index: g.index, length: g.queue.length, split: g.split }, dir);
      if (to) state.game = { ...g, ...to, move: dir > 0 ? 'next' : 'back', sendError: '' };
    },
    gameSubmitNow() { state.game = { ...state.game, screen: 'submit', move: 'next' }; },
    toggleChip(key) { state.chipOpen = state.chipOpen === key ? '' : key; },
    toggleContractQr(address) { state.contractQr = state.contractQr === address ? '' : address; },
    /** The game's CLAIM: Home's Claim (Unlock in place); the amount kept to show beside CLAIMED. */
    gameClaim() {
      state.game = { ...state.game, claimAmount: Number(state.base.claimable?.total ?? 0) };
      return actions.walletAction('game-claim', 'baseClaim');
    },
    /** Played today: the Sent screen put away (for this session), the streams shown again to look at. */
    async gameRest() {
      const fresh = !state.game.sent?.again; // just sent: the streams read again first, so they show as played
      state.game = { ...state.game, rest: true, screen: 'play', index: 0 };
      if (fresh) await actions.loadGame();
    },
    /** Star a stream, or unstar it: kept on this device for this wallet; the next game shows favorites first. */
    gameStar(streamId) {
      const f = state.game.favorites;
      const favorites = f.includes(streamId) ? f.filter((id) => id !== streamId) : [...f, streamId];
      writeFavorites(session.walletPublic?.evmAddress, favorites);
      state.game = { ...state.game, favorites };
    },
    /**
     * Send the calls: from the alias when staked with it; else from the wallet (Unlock in place, or its wallet app).
     * Streams already predicted (gameflow.js played) are not sent: done, as if they were. All of them: done, nothing sent.
     */
    async gameSend() {
      const g = state.game;
      const calls = g.queue.filter((s) => g.picks[s.streamId]).map((s) => ({ stream: s, direction: g.picks[s.streamId] }));
      if (!calls.length || g.sending) return undefined;
      // who sends: the stake read from the chain now, at Submit (the tab's read may be minutes old, a Stake elsewhere since)
      state.game = { ...state.game, sending: true, sendError: '' };
      await app.base.refresh().then(refreshBase).catch(() => {}); // unread: the last read decides, and playHand reads again
      state.game = { ...state.game, sending: false };
      const run = async () => {
        state.game = { ...state.game, sending: true, sendError: '' };
        try {
          state.game = { ...state.game, sending: false, sent: await playCalls(calls, g) };
        } catch (err) {
          state.game = { ...state.game, sending: false, sendError: errorText(err) };
        }
      };
      // nothing to send (all already predicted), or the alias sends: no Unlock (base.playHand decides the same way)
      return playerOf(state.base.wallet.staked) === 'alias' || calls.every((c) => played(c.stream)) ? run() : withWallet('game', run);
    },
    /** The Sent screen's Remind me: one notification when the game opens again (opensAgain; docs/design/push.md). */
    async gameRemind() {
      const g = state.game;
      if (!g.sent || g.reminding) return;
      state.game = { ...g, reminding: true, remindError: '' };
      try {
        await remindOnce(opensAgain(g.sent));
        state.game = { ...state.game, reminding: false };
      } catch (err) {
        state.game = { ...state.game, reminding: false, remindError: errorText(err) };
      }
    },
    /** The daily reminder (Settings › This device; docs/design/push.md): on or off. */
    async setReminder(on) {
      state.reminder = { ...state.reminder, busy: true, error: '' };
      try {
        await turnReminder(on, reminderPlayer());
      } catch (err) {
        state.reminder = { ...state.reminder, error: errorText(err) };
      } finally {
        state.reminder = { ...state.reminder, busy: false };
      }
    },
    /** The Game tab's switch: 'manual' (play by hand: the daily batch is not sent) or 'auto' (docs/design/base.md#played-by-hand). */
    async setPlay(mode) {
      const was = state.base.play;
      state.base = { ...state.base, play: mode }; // at once; stored meanwhile
      try { await app.base.setPlay(mode); } catch (err) { state.base = { ...state.base, play: was }; console.warn('[satori] play', err); }
    },
    saveBase: shownAt('baseRpcError', async (f, el) => {
      state.base = await setBaseSettings({ rpc: f.rpc, maxFee: f.maxFee });
      actions.fillBase(el);
    }),
    saveCentral: shownAt('settingsError', async (f, el) => {
      await setCentral(f.url);
      el.reset();
    }),
    /** Settings › Reward address: Save (the address typed), Clear, and Try again after a failed read. */
    saveReward: shownAt('rewardError', async (f, el) => {
      await setReward(f.address);
      el.reset();
    }),
    clearReward: shownAt('rewardError', () => setReward(null)),
    readReward: () => void (app.reward && readRewardNow()),
    /** The Wallets card (docs/design/wallets.md#several-wallets): Add, Switch, and Remove after it asks. */
    addWallet: shownAt('walletsError', () => addWallet()),
    /** The Name card: the wallet in use named, or '' to clear it (then a special key's name comes back by itself). */
    async saveWalletName(name) {
      Object.assign(state, { walletNameSaid: '', walletNameError: '' });
      try {
        await nameWallet(name);
        state.walletNameSaid = String(name ?? '').trim() ? 'Saved.' : 'Cleared.';
      } catch (err) {
        state.walletNameError = err?.message ?? String(err);
      }
    },
    switchWallet: shownAt('walletsError', (id) => switchWallet(id)),
    askRemoveWallet: shownAt('walletsError', async (id) => {
      Object.assign(state, { walletRemove: id, walletRemoveNeeds: '', walletsError: '' });
      const needs = await removeNeeds(id);
      if (state.walletRemove === id) state.walletRemoveNeeds = needs;
      requestAnimationFrame(() => document.querySelector('[data-test=wallet-remove-pass]')?.focus());
    }),
    cancelRemoveWallet() { Object.assign(state, { walletRemove: 0, walletRemoveNeeds: '', walletsError: '' }); },
    removeWallet: shownAt('walletsError', async (f, el) => {
      await removeWallet(state.walletRemove, f.pass);
      el.reset();
    }),
  };

  return actions;
}
