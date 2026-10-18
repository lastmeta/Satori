// The UI's one reactive state (ArrowJS). main.js and src/pwa/ write it; the screens read it.
import { reactive } from '@arrow-js/core';
import { themeOf } from './theme.js';
import { readPref, SORT_KEY } from './prefs.js';

export const state = reactive({
  screen: 'loading', // loading | elsewhere | fatal | setup | finish (an earlier version's vault: Unlock once) | home
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
  identity: '', // the identity's Base address
  vault: '', // the vault's Base address (shown while locked)
  unlocked: false,
  vaultError: '',
  unlockFor: '', // the inline Unlock prompt that is open: '' | 'card' | 'claim' | 'wallet' | 'backup'
  unlockError: '',
  backup: '', // '' | 'identity' | 'vault' | 'nostr': which key's backup is shown
  backupWords: '', // identity, vault: the 24 words
  backupKey: '', // identity, vault: the private key (0x hex); nostr: the nsec
  backupHex: '', // nostr: the secret (hex)
  backupAt: null, // when the vault's backup was confirmed (meta.backup_at), or null
  copied: '',
  // health (docs/design/health.md): the activity log's revision, and Home's answer
  activityRev: 0,
  health: null,
  // what the neuron is doing (src/neuron/work.js: { [task]: { task, step, done, total, since } }), and, at a pace a person
  // can read (src/ui/hold.js), the hero's view ({ key, working, status, title, line }) and the action lines
  work: {},
  hero: null,
  actionLine: '', // the vault's action in progress: its card's line
  networkLine: '', // discover or subscribe, once it lasts a second
  // Models (docs/design/models.md): the list and the open model live in src/ui/models.js's box; these say they changed
  modelsRev: 0,
  modelSort: readPref(SORT_KEY, ['quality', 'name'], 'quality'), // quality | name: this device's choice (src/ui/prefs.js)
  sortOpen: false, // the Sort menu is open
  modelFilter: 'all', // all | central | base | network: where the predictions go
  modelOpen: '', // the drill-in's model id (#models/<id>), or ''
  modelRev: 0,
  modelOutput: 0, // whose inputs In shows (a model with several outputs)
  modelError: '',
  modelWidth: 320, // the Out block's width: the charts are drawn at it
  modelHover: null, // { out, i }: the chart point under the pointer
  engineWork: null, // the poll's or the Base batch's step, paced as Home's hero: { line, critical }
  // central
  central: { url: '', registration: null, lastPoll: null, nextPoll: null, polling: false, lastSubmit: null, pending: 0 },
  centralDefault: '',
  streams: [],
  sparks: {}, // uuid → its last observations (trend lines)
  streamOpen: '', // the stream whose detail is open (Streams)
  streamPreds: [], // its latest predictions
  settingsError: '',
  // Nostr (docs/design/nostr.md): the flow's status, the last catalog
  nostr: { pubkey: '', npub: '', maxStreams: 0, centralWrite: false, userRelays: [], relays: [], subscriptions: [] },
  catalog: [],
  catalogQuery: '',
  discovering: false,
  subscribing: '', // `${pubkey}:${stream}` in flight
  networkError: '',
  relaysError: '',
  // Base (docs/design/base.md): the status (window.satori.base()'s shape), what runs, the last action's result
  base: {
    rpc: [], rpcSetting: '', maxFeeSetting: null, maxFeeGwei: null, localFork: false, explorer: null, config: null, error: '', round: null,
    identity: { address: '', eth: null, power: null, batchesLeft: null, lowEth: false },
    vault: { address: '', eth: null, satori: null, stakedWith: null, staked: null, lock: null },
    claimable: { rewards: null, airdrop: null }, lastBatch: null, lastCheck: null, nextCheck: null, checking: false,
  },
  baseBusy: '', // '' | 'refresh' | 'stake' | 'unstake' | 'claim' | 'send'
  baseDid: '', // the last vault action ('stake' | 'unstake' | 'claim' | 'send'): where its result shows
  baseError: '',
  baseResult: '',
  baseTxs: [], // the last action's transactions: [{ label, hash }]
  baseRpcError: '',
  // the installed app (docs/design/pwa.md): status().app, Safari (no install prompt), status().storage
  app: { installed: false, canInstall: false, update: false },
  safari: false,
  storage: null, // { persisted, usage, quota }
  theme: themeOf(), // Settings → Appearance: 'system' | 'light' | 'dark', this device's (src/ui/theme.js)
  // the database (docs/design/storage.md#recovery): the name a WAL DuckDB could not replay was set aside under
  recovered: null,
  noticeDismissed: false,
});
