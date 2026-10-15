// The Base flow (docs/design/base.md), as Satori Lite runs it (start.py:1143-1274,
// web/routes.py:1321-1529) and as the dapp goes further:
//   status (no key) · Delegate / Stop delegating (Unlock) · the daily batch (the identity, on its own)
//   · claims (Unlock: hub.claim, merkle, airdrop) · send (Unlock)
// The batch goes at the first check of each UTC round: 10 s after start, at
// the next round's start (chain time) and at least hourly.
import { fallback, formatEther, formatGwei, http, isAddress, parseEther, parseGwei, zeroAddress } from 'viem';
import { createChain, errorText, same, DOWN, UP, ROUND_S } from '../chain/index.js';
import { loadConfig, rpcUrls } from '../chain/config.js';
import { forecast as engineForecast, STEP_S } from '../engine/index.js';
import { createSchedule } from './schedule.js';
import { fmtUtc } from '../ui/format.js';

export const FIRST_CHECK_S = 10;
export const CHECK_EVERY_S = 3600;
const AFTER_ROUND_S = 60; // the check after a round starts: 00:01 UTC, chain time
const BATCH_GAS = 1_500_000n; // a one-game batch's limit (estimate + HOOK_GAS); measured 410k–790k used on the fork
const LOW_BATCHES = 7; // warn below a week of batches
/**
 * The unattended batch's ceiling on the max fee per gas (Settings). Base's fees
 * are ~0.01 gwei (Base Sepolia, 2026-10-15: base fee 0.005, tip 0.001), so 2
 * gwei only stops a spike of ~200× or an RPC quoting nonsense; it caps a
 * batch at about 0.003 ETH (1.5M gas). It sits above the 1 gwei tip anvil
 * quotes, so the local fork works.
 */
export const MAX_FEE_GWEI = 2;
const PENDING_WAIT_MS = 30_000; // how long a check waits for a batch sent earlier

/** The engine's step for a registry stream: 12 h, or its cadence when slower (docs/design/base.md, the daily batch). */
export const stepFor = (cadenceMinutes) => Math.max(STEP_S, (Number(cadenceMinutes) || 0) * 60);

/** Lite's direction_from (base_predict.py:141-143): UP if the forecast is above the latest value; a tie is DOWN. */
export const directionOf = (forecast, latest) => (forecast > latest ? UP : DOWN);

/** Registry history → the engine's points (the value's scale does not matter to a direction). */
export const toPoints = (history) => history.map(({ hour, value }) => ({ ts: hour * 3600, value: Number(value) }));

const plainAmount = (wei) => (wei == null ? null : formatEther(wei));

/** A mined batch: stored as the last one, its round from its block (a send at 23:59:59 can land in the next round). */
async function finish(db, b, mined) {
  const batch = { round: Math.floor(mined.at / ROUND_S), at: mined.at, hash: b.hash, games: b.games, dropped: b.dropped };
  await db.set('base_last_batch', batch);
  await db.set('base_pending_batch', null);
  await db.checkpoint();
  return { at: mined.at, round: batch.round, sent: batch };
}

/**
 * The daily batch (start.py:1143-1236 with the fixes in docs/design/base.md).
 * Never throws: the result says what happened.
 * @returns {Promise<object>} { at, round, sent: {round, at, hash, games, dropped} } | { at, round?, skipped, dropped? } | { at, error }
 */
export async function runBatch({ chain, identity, db, forecast = engineForecast, maxFeeWei = parseGwei(String(MAX_FEE_GWEI)),
  pendingWaitMs = PENDING_WAIT_MS }) {
  let at = null;
  try {
    // A batch sent before the tab closed (or a check ended) has its hash kept: wait for it, never send twice.
    const pending = await db.get('base_pending_batch');
    if (pending) {
      const mined = await chain.receipt(pending.hash, { timeout: pendingWaitMs });
      if (mined?.status === 'success') return finish(db, pending, mined);
      if (!mined) {
        const st = await chain.batchState(identity.evmAddress);
        if (pending.round === st.round) {
          return { at: st.chainTime, round: st.round, skipped: `waiting for the batch already sent (${pending.hash})` };
        }
      }
      await db.set('base_pending_batch', null); // reverted, or an earlier round's that never mined
    }

    const state = await chain.batchState(identity.evmAddress);
    at = state.chainTime;
    const { round } = state;
    if (state.power === 0n) return { at, round, skipped: 'no prediction power delegated to the identity' };
    if (state.predicted !== 0) return { at, round, skipped: 'already predicted this round' };

    const games = [];
    const dropped = [];
    for (const g of await chain.streams()) {
      const history = await chain.history(g.streamId);
      const f = history.length ? forecast(toPoints(history), { step: stepFor(g.cadenceMinutes) }) : null;
      const base = { streamId: g.streamId, gameId: g.gameId, named: g.named };
      if (!f) { dropped.push({ ...base, error: 'no history' }); continue; }
      const latest = Number(history.at(-1).value);
      const game = { ...base, direction: directionOf(f.t2, latest), model: f.model, latest, t2: f.t2 };
      // The contract's own checks, named games' 24 clock hours included (SatoriEngine.sol:791-810).
      const error = await chain.simulateGame(identity, game);
      if (error) dropped.push({ ...game, error });
      else games.push(game);
    }
    if (!games.length) return { at, round, skipped: dropped.length ? 'no game passes its simulation' : 'no streams with a game', dropped };

    const fees = await chain.fees();
    if (fees.maxFeePerGas > maxFeeWei) {
      return { at, round, dropped,
        skipped: `gas above the ceiling: a max fee of ${formatGwei(fees.maxFeePerGas)} gwei > ${formatGwei(maxFeeWei)} gwei; the next check tries again` };
    }
    const sent = await chain.sendBatch(identity, games, { fees, onSent: async (hash) => {
      await db.set('base_pending_batch', { round, hash, games, dropped });
      await db.checkpoint();
    } });
    return finish(db, { hash: sent.hash, games, dropped }, sent);
  } catch (err) {
    console.warn('[satori] base batch', err);
    return { at, error: errorText(err) };
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
 * @param {string} o.vaultAddress the vault's Base address (from vault.yaml's public key: no Unlock needed)
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
  const changed = () => onChange();

  const resolve = (u) => (u.startsWith('/') && origin ? new URL(u, origin).href : u);

  /**
   * The chain for the current config and RPC (rebuilt when either changes).
   * A new RPC is asked its chain id once: another chain than the config's is
   * refused, for reads, writes and the batch alike.
   */
  async function chainNow() {
    const c = central();
    const loaded = await loadConfig({ fetchCentral: () => c.baseConfig(), url: c.url, cache, now: now() });
    cache = loaded.cache;
    const setting = (await db.get('base_rpc_url')) || '';
    const urls = rpcUrls({ config: loaded.config, setting, devDefault: devRpc });
    const key = JSON.stringify([loaded.config, urls]);
    if (made?.key !== key) {
      const t = transport ?? (urls.length === 1 ? http(resolve(urls[0])) : fallback(urls.map((u) => http(resolve(u)))));
      made = { key, rpc: urls, config: loaded.config, chainId: null,
        local: urls.every((u) => u.startsWith('/')), chain: createChain({ config: loaded.config, transport: t }) };
    }
    made.fromCentral = !!cache.remote; // central2 serves the bundle's own values: the same chain, another source
    made.chainId ??= await made.chain.chainId(); // an RPC that does not answer is asked again next time
    if (made.chainId !== loaded.config.chainId) {
      throw new Error(`The RPC is on chain ${made.chainId}, not Base Sepolia (${loaded.config.chainId}): nothing is read or sent.`);
    }
    return made;
  }

  /** The batch's ceiling on the max fee per gas, in wei (Settings; MAX_FEE_GWEI by default). */
  const maxFeeWei = async () => parseGwei(Number((await db.get('base_max_fee_gwei')) ?? MAX_FEE_GWEI).toFixed(9)); // 1e-7 → '0.000000100'

  function needVault() {
    const v = vault();
    if (!v) throw new Error('Unlock the vault first');
    return v;
  }

  async function refresh() {
    try {
      const { chain } = await chainNow();
      status = await chain.status({ identity: identity.evmAddress, vault: vaultAddress });
      statusError = status.round == null ? (status.errors[0] ?? 'no answer') : '';
    } catch (err) {
      statusError = errorText(err);
    }
    changed();
    return view();
  }

  /** The status for the UI and agents: plain values, amounts as decimal strings. */
  function view() {
    const s = status;
    const gas = s?.gasPrice ? BATCH_GAS * 2n * s.gasPrice : null;
    const batchesLeft = s?.identity.eth != null && gas ? Number(s.identity.eth / gas) : null;
    const vd = s?.vault.delegate;
    return {
      rpc: made?.rpc ?? [], config: made ? (made.fromCentral ? 'central' : 'bundled') : null,
      localFork: !!made?.local, // a path on this site: the dev server's /rpc, a local fork
      explorer: made && !made.local ? made.config.explorerUrl : null, // links tx hashes (not for a local fork)
      error: statusError, errors: s?.errors ?? [],
      round: s?.round ?? null, chainTime: s?.chainTime ?? null,
      identity: {
        address: identity.evmAddress, eth: plainAmount(s?.identity.eth), power: plainAmount(s?.identity.power),
        fee: s?.identity.fee ?? null, allowedDelegator: s?.identity.allowedDelegator ?? null,
        batchesLeft, lowEth: batchesLeft != null && batchesLeft < LOW_BATCHES,
      },
      vault: {
        address: vaultAddress, eth: plainAmount(s?.vault.eth), satori: plainAmount(s?.vault.satori),
        delegate: vd ?? null,
        delegated: vd == null ? null : same(vd, identity.evmAddress) ? 'identity' : same(vd, zeroAddress) ? 'none' : 'other',
        lock: s?.vault.lock ?? null,
      },
      claimable: { rewards: plainAmount(s?.claimable.rewards), airdrop: plainAmount(s?.claimable.airdrop) },
      lastCheck, nextCheck: schedule.next, checking: schedule.running,
    };
  }

  async function withLast(v) {
    return { ...v, lastBatch: (await db.get('base_last_batch')) ?? null };
  }

  // ── the batch's schedule: a check runs the batch if due; one at a time; then the next check is armed ──
  async function check() {
    let result;
    try {
      const { chain } = await chainNow();
      result = await runBatch({ chain, identity, db, forecast, maxFeeWei: await maxFeeWei() });
    } catch (err) {
      result = { at: null, error: errorText(err) };
    }
    lastCheck = result;
    await refresh();
    return result;
  }
  const schedule = createSchedule(check, {
    now, setTimeout: st, clearTimeout: ct, name: 'base', onChange: changed,
    after: () => nextCheckAt({ now: now(), chainTime: lastCheck?.at ?? status?.chainTime ?? null }),
  });

  // ── vault actions (Unlock) ──
  async function act(fn) {
    const { chain } = await chainNow();
    try {
      return await fn(chain);
    } finally {
      await refresh();
    }
  }

  /**
   * The merkle drop: central's proof alone, as Lite (routes.py:1321-1331); its
   * 404 says which case (merkle.py:45-58), and prod, which lacks the route,
   * answers a plain Not Found. What was paid is read back at the claim's
   * block: the lane's reserve may pay only part (SatoriMerkle.sol:196-201).
   */
  async function claimMerkle(chain, v) {
    const c = central();
    let entry;
    try {
      entry = await c.merkleProof(v.evmAddress);
    } catch (err) {
      if (err?.status !== 404) throw err;
      if (/no reward drop/i.test(err.detail)) return { skipped: `no merkle drop published on ${c.url}` };
      if (/not in the current drop/i.test(err.detail)) return { skipped: 'this vault is not in the current drop' };
      return { skipped: `${c.url} serves no merkle drop (${err.detail})` };
    }
    const before = await chain.alreadyMinted(v.evmAddress);
    if (BigInt(entry.amountWei) <= before) return { skipped: 'already claimed: up to date with the drop' };
    const { hash, receipt } = await chain.claimMerkle(v, entry);
    const after = await chain.alreadyMinted(v.evmAddress, receipt.blockNumber);
    return { hash, amount: formatEther(after - before) };
  }

  return {
    refresh,
    async status() {
      return { ...(await withLast(view())), rpcSetting: (await db.get('base_rpc_url')) || '',
        maxFeeGwei: (await db.get('base_max_fee_gwei')) ?? MAX_FEE_GWEI };
    },

    start() {
      schedule.start(now() + FIRST_CHECK_S);
      refresh().catch(() => {});
    },
    stop: schedule.stop,
    /** The batch now if due (window.satori.predictBase). */
    predict: schedule.run,

    /** Delegate prediction power (docs/design/base.md): needs Unlock. Then a batch check soon. */
    async delegate() {
      const v = needVault();
      const r = await act((chain) => chain.delegate({ identity, vault: v }));
      schedule.arm(now() + FIRST_CHECK_S);
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
          try { return await fn(); } catch (err) { return { error: errorText(err) }; }
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
            : `SATORI is transfer-locked until round ${lock.untilRound} (free from ${fmtUtc(lock.freeAt)}).`);
        }
        return { hash: (await chain.sendSatori(v, to, wei)).hash };
      });
    },
  };
}
