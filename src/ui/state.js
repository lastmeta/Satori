// The UI's one reactive state (ArrowJS). main.js and src/pwa/ write it; the screens read it.
import { reactive } from '@arrow-js/core';
import { themeOf } from './theme.js';
import { readPref, SORT_KEY, INSTALL_KEY } from './prefs.js';

export const state = reactive({
  screen: 'loading', // loading | elsewhere | fatal | damaged (the database file won't open) | setup | finish (an earlier version's wallet: Unlock once) | home
  // the database's start (src/db/opfs.js): { step: 'download', loaded, total } (bytes on the wire) | { step: 'start' |
  // 'open' | 'ready' }; null before it begins (docs/design/storage.md#the-first-visit)
  engine: null,
  setupWaiting: false, // Setup's keys wait for the database: "Finishing setup… downloading the engine, 3.2 of 7.6 MB"
  cached: null, // while loading on a revisit: the last visit's Home (src/ui/prefs.js snapshotOf), painted until live
  tab: 'home', // home | models | streams | wallet | settings (the URL's #home … #settings; #models/<id> opens a model)
  now: Date.now() / 1000, // ticks every 30 s: relative times and the health's thresholds
  fatal: '',
  busy: '', // what is running: '' | 'setup' | 'unlock'
  error: '',
  // setup
  step: 'choose', // choose | words | confirm | restore | docker | passphrase
  words: [],
  confirmAt: [],
  passNote: '', // the passphrase step's note (an import whose password can't be reused)
  // the keys
  alias: '', // the alias's Base address
  wallet: '', // the wallet's Base address (shown while locked)
  connected: null, // a connected wallet (docs/design/wallets.md#a-connected-wallet): { name, found }, else null
  connectFound: null, // Setup's Connect: [{ rdns, name }] found in this browser; null while looking
  connecting: '', // the wallet whose app is being asked to connect
  walletConnectReady: false, // this build has a WalletConnect project id: Connect offers "Other wallet"
  wallets: { active: 1, wallets: [] }, // this app's wallets (src/wallets.js walletsView): the Wallets card, Setup's switch back
  walletRemove: 0, // the wallet whose Remove asks to confirm (its id), or 0
  unlocked: false,
  lockAt: null, // when the wallet locks on its own (ms), or null (src/keys/autolock.js)
  lockNow: 0, // the clock "Locks in 4 min" is counted from (ms; moves every 15 s while unlocked)
  walletError: '',
  unlockFor: '', // the inline Unlock prompt that is open: '' | 'card' | 'claim' | 'wallet' | 'buy'
  unlockError: '',
  backupAsk: '', // the key whose backup asks for the passphrase (each time): '' | 'alias' | 'wallet' | 'nostr'
  backupError: '',
  revealing: false, // a backup's passphrase is being checked (~0.3 s)
  backup: '', // '' | 'alias' | 'wallet' | 'nostr': which key's backup is shown
  backupWords: '', // alias, wallet: the 24 words
  backupKey: '', // alias, wallet: the private key (0x hex); nostr: the nsec
  backupHex: '', // nostr: the secret (hex)
  backupAt: null, // when the wallet's backup was confirmed (meta.backup_at), or null
  copied: '',
  // health (docs/design/health.md): the activity log's revision, and Home's answer
  activityRev: 0,
  health: null,
  // what the neuron is doing (src/neuron/work.js: { [task]: { task, step, done, total, since } }), and, at a pace a person
  // can read (src/ui/hold.js), the hero's view ({ key, working, status, title, line }) and the action lines
  work: {},
  hero: null,
  actionLine: '', // the wallet's action in progress: its card's line
  networkLine: '', // discover or subscribe, once it lasts a second
  // Models (docs/design/models.md): the list and the open model live in src/ui/models.js's box; these say they changed
  modelsRev: 0,
  modelSort: readPref(SORT_KEY, ['quality', 'name'], 'quality'), // quality | name: this device's choice (src/ui/prefs.js)
  sortOpen: false, // the Sort menu is open
  modelTo: ['network', 'contract', 'relays'], // the filters on (where predictions go); not kept: each visit to the tab starts with all
  modelOpen: '', // the drill-in's model id (#models/<id>), or ''
  modelRev: 0,
  modelOutput: 0, // whose inputs In shows (a model with several outputs)
  modelError: '',
  modelWidth: 320, // the Out block's width: the charts are drawn at it
  modelHover: null, // { out, i }: the chart point under the pointer
  engineWork: null, // the poll's or the Base batch's step, paced as Home's hero: { line, critical }
  retrainRev: 0, // Retrain's statuses changed (they live in src/ui/models.js's box.retrains, out of the reactive state)
  retrainError: '', // why the open model's Retrain could not start
  // central
  central: { url: '', registration: null, lastPoll: null, nextPoll: null, polling: false, lastSubmit: null, pending: 0 },
  centralDefault: '',
  streams: [],
  sparks: {}, // uuid → its last observations (trend lines)
  streamOpen: '', // the stream whose detail is open (Streams)
  streamPreds: [], // its latest predictions
  settingsError: '',
  // the reward address (src/neuron/reward.js; Settings): { address, at, error, reading } as last read, what runs ('' | 'save' |
  // 'clear'), its step at Home's pace, the last result's words and error
  reward: { address: null, at: null, error: null, reading: false },
  rewardBusy: '',
  rewardLine: '',
  rewardDone: '',
  rewardError: '',
  walletsError: '', // the Wallets card's Add, Switch or Remove failed
  // Nostr (docs/design/nostr.md): the flow's status, the last catalog
  nostr: { pubkey: '', npub: '', maxStreams: 0, centralWrite: false, userRelays: [], relays: [], subscriptions: [],
    watching: { streams: 0, sources: 0, found: 0, left: 0, at: null, error: null }, market: { selling: [], bought: [], error: null } },
  marketBusy: '', // a paid-stream action in flight: 'sell:<stream>' | 'buy:<pubkey>:<stream>' | 'stop:<pubkey>:<stream>' (docs/design/market.md)
  marketError: '',
  catalog: [],
  // the track record (docs/design/track-record.md): records() as last read (while Streams shows), the scan's step at a
  // readable pace, the open stream's key and its record() (with its pairs), the whole list asked for
  records: [],
  watchLine: '',
  recordOpen: '',
  recordDetail: null,
  recordError: '',
  recordsAll: false,
  catalogQuery: '',
  discovering: false,
  subscribing: '', // `${pubkey}:${stream}` in flight
  networkError: '',
  relaysError: '',
  // Base (docs/design/base.md): the status (window.satori.base()'s shape), what runs, the last action's result
  base: {
    rpc: [], rpcSetting: '', maxFeeSetting: null, maxFeeGwei: null, localFork: false, explorer: null, config: null, error: '', round: null,
    alias: { address: '', eth: null, power: null, batchesLeft: null, lowEth: false },
    wallet: { address: '', eth: null, satori: null, stakedWith: null, referral: null, staked: null, inSync: null, shortfall: null, lock: null, lowEth: false },
    claimable: { rewards: null, drop: null, airdrop: null, total: null }, pendingReferrer: null, inviteLink: '', lastBatch: null, lastCheck: null, nextCheck: null, checking: false,
  },
  baseBusy: '', // '' | 'refresh' | 'stake' | 'unstake' | 'claim' | 'send'
  baseDid: '', // the last wallet action ('stake' | 'unstake' | 'claim' | 'send'): where its result shows
  baseError: '',
  baseResult: '',
  baseTxs: [], // the last action's transactions: [{ label, hash }]
  sendReview: null, // Send's review step: base.quoteSend()'s { asset, to, amount, fee: { gas, about, max } }, or null
  sendQuoting: false, // the review is being read (the fee's estimate)
  baseRpcError: '',
  // the installed app (docs/design/pwa.md): status().app (addTo: how this browser adds Satori without a prompt, or
  // null), status().storage; the Install card put away on this device (Not now, Got it)
  app: { installed: false, canInstall: false, update: false, addTo: null },
  installDismissed: readPref(INSTALL_KEY, ['dismissed'], '') === 'dismissed',
  phone: false, // a phone (a coarse pointer, or a small screen): Home's hero says "Keep Satori open · " while it works
  storage: null, // { persisted, usage, quota }
  version: '', // browser-<package version>+<git short sha> (main.js; Settings › This device)
  theme: themeOf(), // Settings → Appearance: 'system' | 'light' | 'dark', this device's (src/ui/theme.js)
  // the database (docs/design/storage.md#recovery): the name a WAL DuckDB could not replay was set aside under
  recovered: null,
  setAside: null, // the name a database file that would not open was set aside under ("Set aside and start again"), this page load
  setAsideError: '',
  noticeDismissed: false,
});
