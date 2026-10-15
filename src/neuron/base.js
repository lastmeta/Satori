// The Base flow (docs/design/base.md), as Satori Lite runs it (start.py:1143-1274,
// web/routes.py:1321-1529) and as the dapp goes further:
//   status (no key) · Delegate / Stop delegating (Unlock) · the daily batch (the identity, on its own)
//   · claims (Unlock: hub.claim, merkle, airdrop) · send (Unlock)
// The batch goes at the first check of each UTC round: 10 s after start, at
// the next round's start (chain time) and at least hourly.
import { fallback, formatEther, http, isAddress, parseEther, zeroAddress } from 'viem';
import { createChain, errorText, revertName, same, DOWN, UP, ROUND_S } from '../chain/index.js';
import { loadConfig, rpcUrls } from '../chain/config.js';
import { forecast as engineForecast, STEP_S } from '../engine/index.js';

export const FIRST_CHECK_S = 10;
export const CHECK_EVERY_S = 3600;
export const AFTER_ROUND_S = 60; // the check after a round starts: 00:01 UTC, chain time
export const NAMED_WAIT_HOURS = 24; // base_predict.py:131
export const BATCH_GAS = 1_500_000n; // a one-game batch's limit (estimate + HOOK_GAS); measured 410k–790k used on the fork
export const LOW_BATCHES = 7; // warn below a week of batches

const errorOf = (err) => errorText(err);

/** The engine's step for a registry stream: 12 h, or its cadence when slower (docs/design/base.md, the daily batch). */
export const stepFor = (cadenceMinutes) => Math.max(STEP_S, (Number(cadenceMinutes) || 0) * 60);

/** Lite's direction_from (base_predict.py:141-143): UP if the forecast is above the latest value; a tie is DOWN. */
export const directionOf = (forecast, latest) => (forecast > latest ? UP : DOWN);

/** Lite's named_allowed (base_predict.py:146-149): 24 clock hours after our last submit (0 = unknown: try). */
export const namedAllowed = (lastSubmitTs, now) =>
  !(lastSubmitTs > 0) || Math.floor(now / 3600) >= Math.floor(lastSubmitTs / 3600) + NAMED_WAIT_HOURS;

/** Registry history → the engine's points (the value's scale does not matter to a direction). */
export const toPoints = (history) => history.map(({ hour, value }) => ({ ts: hour * 3600, value: Number(value) }));

const plainAmount = (wei) => (wei == null ? null : formatEther(wei));

/**
 * The daily batch (start.py:1143-1236 with the fixes in docs/design/base.md).
 * Never throws: the result says what happened.
 * @returns {Promise<object>} { at, round, sent: {hash, at, games, dropped} } | { at, round?, skipped, dropped? } | { at, error }
 */
export async function runBatch({ chain, identity, db, forecast = engineForecast }) {
  let at = null;
  try {
    const state = await chain.batchState(identity.evmAddress);
    at = state.chainTime;
    const { round } = state;
    if (state.power === 0n) return { at, round, skipped: 'no prediction power delegated to the identity' };
    if (state.predicted !== 0) return { at, round, skipped: 'already predicted this round' };

    const lastSubmit = (await db.get('base_last_submit_ts')) ?? 0;
    const namedOk = namedAllowed(lastSubmit, state.chainTime);
    const games = [];
    const dropped = [];
    for (const g of await chain.streams()) {
      const history = await chain.history(g.streamId);
      const f = history.length ? forecast(toPoints(history), { step: stepFor(g.cadenceMinutes) }) : null;
      const base = { streamId: g.streamId, gameId: g.gameId, named: g.named };
      if (!f) { dropped.push({ ...base, error: 'no history' }); continue; }
      const latest = Number(history.at(-1).value);
      const game = { ...base, direction: directionOf(f.t2, latest), model: f.model, latest, t2: f.t2 };
      if (g.named && !namedOk) { dropped.push({ ...game, error: `named: under ${NAMED_WAIT_HOURS} h since the last batch` }); continue; }
      const error = await chain.simulateGame(identity, game);
      if (error) dropped.push({ ...game, error });
      else games.push(game);
    }
    if (!games.length) return { at, round, skipped: dropped.length ? 'no game passes its simulation' : 'no streams with a game', dropped };

    let list = games;
    let sent;
    try {
      sent = await chain.sendBatch(identity, list);
    } catch (err) {
      // base_predict.py:157-174: a named game too early sinks the batch; resend once without them.
      const rest = list.filter((g) => !g.named);
      if (revertName(err) !== 'DuplicatePrediction' || rest.length === list.length || !rest.length) throw err;
      for (const g of list.filter((x) => x.named)) dropped.push({ ...g, error: 'DuplicatePrediction' });
      list = rest;
      sent = await chain.sendBatch(identity, list);
    }
    // Only after the receipt (Lite writes it before sending, start.py:1228-1232).
    const batch = { round, at: sent.at, hash: sent.hash, games: list, dropped };
    await db.set('base_last_batch', batch);
    await db.set('base_last_submit_ts', sent.at);
    await db.checkpoint();
    return { at: sent.at, round, sent: batch };
  } catch (err) {
    console.warn('[satori] base batch', err);
    return { at, error: errorOf(err) };
  }
}

/**
 * When the next check runs (local seconds): the next round's start + 1 min
 * (on the chain's clock, which a fork may run ahead), at most an hour away.
 */
export function nextCheckAt({ now, chainTime }) {
  if (chainTime == null) return now + CHECK_EVERY_S;
  const roundStart = (Math.floor(chainTime / ROUND_S) + 1) * ROUND_S;
  return Math.min(now + CHECK_EVERY_S, now + (roundStart - chainTime) + AFTER_ROUND_S);
}

/**
 * @param {object} o
 * @param {object} o.db the app's db
 * @param {{evmAddress: string, signDigest: Function}} o.identity
 * @param {() => string|null} o.vaultAddress the vault's Base address (known while locked from vault.yaml)
 * @param {() => object|null} o.vault the unlocked vault signer, or null
 * @param {() => object} o.central the current central client
 * @param {string} [o.devRpc] the dev server's default RPC (the local fork)
 * @param {any} [o.transport] a viem transport (tests); else http to the RPC URLs
 */
export function createBase({ db, identity, vaultAddress, vault, central, devRpc, transport, forecast = engineForecast,
  now = () => Date.now() / 1000, onChange = () => {}, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout,
  origin = globalThis.location?.href }) {
  let cache = null; // central's config, 1 h
  let made = null; // { key, chain, rpc }
  let status = null; // the last status read
  let statusError = '';
  let lastCheck = null;
  let next = null;
  let timer = null;
  let running = null;
  let stopped = true;
  const changed = () => onChange();

  const resolve = (u) => (u.startsWith('/') && origin ? new URL(u, origin).href : u);

  /** The chain for the current config and RPC (rebuilt when either changes). */
  async function chainNow() {
    const loaded = await loadConfig({ fetchCentral: () => central().baseConfig(), cache, now: now() });
    cache = loaded.cache;
    const setting = (await db.get('base_rpc_url')) || '';
    const urls = rpcUrls({ config: loaded.config, setting, devDefault: devRpc });
    const key = JSON.stringify([loaded.config, urls]);
    if (made?.key !== key) {
      const t = transport ?? (urls.length === 1 ? http(resolve(urls[0])) : fallback(urls.map((u) => http(resolve(u)))));
      made = { key, rpc: urls, fromCentral: !!cache.remote, chain: createChain({ config: loaded.config, transport: t }) };
    }
    return made;
  }

  function needVault() {
    const v = vault();
    if (!v) throw new Error('Unlock the vault first');
    return v;
  }

  async function refresh() {
    try {
      const { chain } = await chainNow();
      status = await chain.status({ identity: identity.evmAddress, vault: vaultAddress() });
      statusError = status.round == null ? (status.errors[0] ?? 'no answer') : '';
    } catch (err) {
      statusError = errorOf(err);
    }
    changed();
    return view();
  }

  /** The status for the UI and agents: plain values, amounts as decimal strings. */
  function view() {
    const s = status;
    const gas = s?.gasPrice ? BATCH_GAS * 2n * s.gasPrice : null;
    const batchesLeft = s?.identity.eth != null && gas ? Number(s.identity.eth / gas) : null;
    const vd = s?.vault?.delegate;
    return {
      rpc: made?.rpc ?? [], config: made ? (made.fromCentral ? 'central' : 'bundled') : null,
      error: statusError, errors: s?.errors ?? [],
      round: s?.round ?? null, chainTime: s?.chainTime ?? null,
      identity: {
        address: identity.evmAddress, eth: plainAmount(s?.identity.eth), power: plainAmount(s?.identity.power),
        fee: s?.identity.fee ?? null, allowedDelegator: s?.identity.allowedDelegator ?? null,
        batchesLeft, lowEth: batchesLeft != null && batchesLeft < LOW_BATCHES,
      },
      vault: {
        address: vaultAddress(), eth: plainAmount(s?.vault?.eth), satori: plainAmount(s?.vault?.satori),
        delegate: vd ?? null,
        delegated: vd == null ? null : same(vd, identity.evmAddress) ? 'identity' : same(vd, zeroAddress) ? 'none' : 'other',
        lock: s?.vault?.lock ?? null,
      },
      claimable: { rewards: plainAmount(s?.claimable?.rewards), airdrop: plainAmount(s?.claimable?.airdrop) },
      lastCheck, nextCheck: next, checking: !!running,
    };
  }

  async function withLast(v) {
    return { ...v, lastBatch: (await db.get('base_last_batch')) ?? null };
  }

  // ── the batch's schedule ──
  function arm(at) {
    next = at;
    ct(timer);
    timer = stopped ? null : st(() => void check().catch((err) => console.error('[satori] base', err)), Math.max(0, (at - now()) * 1000));
    changed();
  }

  /** The batch now, if due; one at a time (a call during one returns it). Then the next check is armed. */
  function check() {
    running ??= (async () => {
      changed();
      let result;
      try {
        const { chain } = await chainNow();
        result = await runBatch({ chain, identity, db, forecast });
      } catch (err) {
        result = { at: null, error: errorOf(err) };
      }
      lastCheck = result;
      await refresh();
      return result;
    })().finally(() => {
      running = null;
      arm(nextCheckAt({ now: now(), chainTime: lastCheck?.at ?? status?.chainTime ?? null }));
    });
    return running;
  }

  // ── vault actions (Unlock) ──
  async function act(fn) {
    const { chain } = await chainNow();
    try {
      return await fn(chain);
    } finally {
      await refresh();
    }
  }

  async function claimMerkle(chain, v) {
    const c = central();
    const notFound = (e) => e?.status === 404;
    try {
      await c.merkleRoot();
    } catch (err) {
      if (notFound(err)) return { skipped: `no merkle drop published (${c.url}: ${err.detail})` };
      throw err;
    }
    let entry;
    try {
      entry = await c.merkleProof(v.evmAddress);
    } catch (err) {
      if (notFound(err)) return { skipped: 'this vault is not in the current drop' };
      throw err;
    }
    const owed = BigInt(entry.amountWei) - await chain.alreadyMinted(v.evmAddress);
    if (owed <= 0n) return { skipped: 'already claimed: up to date with the drop' };
    const { hash } = await chain.claimMerkle(v, entry);
    return { hash, amount: formatEther(owed) };
  }

  return {
    refresh,
    async status() { return withLast(view()); },

    start() {
      stopped = false;
      arm(now() + FIRST_CHECK_S);
      refresh().catch(() => {});
    },
    stop() {
      stopped = true;
      ct(timer);
      timer = null;
    },
    /** The batch now if due (window.satori.predictBase). */
    predict: () => check(),

    /** Delegate prediction power (docs/design/base.md): needs Unlock. Then a batch check soon. */
    async delegate() {
      const v = needVault();
      const r = await act((chain) => chain.delegate({ identity, vault: v }));
      if (!stopped) arm(now() + FIRST_CHECK_S);
      return r;
    },
    async undelegate() {
      const v = needVault();
      return act((chain) => chain.undelegate({ vault: v }));
    },

    /** hub.claim() (the lens says > 0), the merkle drop (central's proof), the airdrop; each on its own. */
    async claim() {
      const v = needVault();
      return act(async (chain) => {
        const st = await chain.status({ identity: identity.evmAddress, vault: v.evmAddress });
        const each = async (fn) => {
          try { return await fn(); } catch (err) { return { error: errorOf(err) }; }
        };
        const rewards = await each(async () => {
          const owed = st.claimable.rewards;
          if (!(owed > 0n)) return { skipped: 'nothing to claim on-chain' };
          return { hash: (await chain.claimRewards(v)).hash, amount: formatEther(owed) };
        });
        const merkle = await each(() => claimMerkle(chain, v));
        const airdrop = await each(async () => {
          const owed = st.claimable.airdrop;
          if (!(owed > 0n)) return { skipped: 'no vested airdrop to claim' };
          return { hash: (await chain.claimAirdrop(v)).hash, amount: formatEther(owed) };
        });
        return { rewards, merkle, airdrop };
      });
    },

    /** From the vault: { asset: 'ETH' | 'SATORI', to, amount } (a decimal string). → { hash } */
    async send({ asset, to, amount } = {}) {
      const v = needVault();
      const kind = String(asset ?? '').toUpperCase();
      if (kind !== 'ETH' && kind !== 'SATORI') throw new Error("Name the asset: 'ETH' or 'SATORI'.");
      if (!isAddress(String(to ?? ''))) throw new Error('The recipient must be a 0x address.');
      let wei;
      try { wei = parseEther(String(amount ?? '').trim()); } catch { wei = 0n; }
      if (!(wei > 0n)) throw new Error('The amount must be a positive number.');
      return act(async (chain) => {
        if (kind === 'ETH') return { hash: (await chain.sendEth(v, to, wei)).hash };
        const st = await chain.status({ identity: identity.evmAddress, vault: v.evmAddress });
        const lock = st.vault.lock;
        if (lock?.locked) {
          throw new Error(lock.indefinite ? 'SATORI is transfer-locked while delegated: stop delegating first.'
            : `SATORI is transfer-locked until round ${lock.untilRound} (free from ${new Date(lock.freeAt * 1000).toISOString().slice(0, 16)} UTC).`);
        }
        return { hash: (await chain.sendSatori(v, to, wei)).hash };
      });
    },
  };
}
