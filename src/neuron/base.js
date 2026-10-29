// The Base flow (docs/design/base.md), as Satori Lite runs it (start.py:1143-1274,
// web/routes.py:1321-1529) and as the dapp goes further:
//   status (no key) · Stake / Unstake (Unlock) · the daily batch (the alias, on its own)
//   · claims (Unlock: hub.claim, merkle, airdrop) · send (Unlock)
// The batch goes at the first check of each UTC round: 10 s after start (at
// once when one is due), at the next round's start (chain time) and at least hourly.
import { SKIP } from './skip.js';
import { playerOf } from './play.js';
import {
  fallback, formatEther, formatGwei, getAddress, http, isAddress, parseEther, parseGwei, zeroAddress, WaitForTransactionReceiptTimeoutError,
} from 'viem';
import { createChain, errorText, lockText, panicOf, same, DOWN, UP, ROUND_S } from '../chain/index.js';
import { checkRpcSetting, loadConfig, rpcUrls } from '../chain/config.js';
import { createChannels } from '../chain/channels.js';
import { explainForecast as engineForecast, STEP_S } from '../engine/index.js';
import { createSchedule } from './schedule.js';
import { createWork } from './work.js';
import { inviteLink, referrerOf } from './referral.js';
import { emit, traced } from '../traffic.js';
import { adopt, withBatchLock } from '../pwa/handoff.js';

export const FIRST_CHECK_S = 10;
/**
 * Who sends the Satori contract predictions (docs/design/base.md#played-by-hand): 'auto', the alias's daily batch (the
 * default), or 'manual', the person in the Game tab. Manual changes only that: the batch is worked out, never sent.
 */
export const PLAYS = ['auto', 'manual'];
export const PLAYED_BY_HAND = 'played by hand: the batch is not sent';
export const CHECK_EVERY_S = 3600;
const AFTER_ROUND_S = 60; // the check after a round starts: 00:01 UTC, chain time
const BATCH_GAS = 1_500_000n; // a one-game batch's limit (estimate + HOOK_GAS); measured 410k–790k used on the fork
const LOW_BATCHES = 7; // warn below a week of batches
const PRELOAD_MAX = 10n ** 17n; // Preload gas suggests half the wallet's ETH, up to 0.1 ETH (the owner, 2026-10-28)
/** Rounded up to one significant digit: 0.000437 → 0.0005. */
/**
 * The unattended batch's ceiling on the max fee per gas (Settings). Base's fees
 * are ~0.01 gwei (Base Sepolia, 2026-10-15: base fee 0.005, tip 0.001), so 2
 * gwei only stops a spike of ~200× or an RPC quoting nonsense; it caps a
 * batch at about 0.003 ETH (1.5M gas). It sits above the 1 gwei tip anvil
 * quotes, so the local fork works.
 */
export const MAX_FEE_GWEI = 2;
const PENDING_WAIT_MS = 30_000; // how long a check waits for a batch sent earlier
/** A batch sent and not mined this long (s) is looked at again: its nonce still pending, it is sent again with a higher fee. */
export const STUCK_S = 600;

/**
 * A replacement's fees (docs/design/base.md#a-batch-that-never-mines): each a quarter over what the stuck batch pays (a
 * node takes a replacement at 10 % more on both), or the market's when that is higher.
 */
export function bumpFees(old, market) {
  const up = (x) => (x * 5n + 3n) / 4n;
  const tip = [up(old.maxPriorityFeePerGas), market.maxPriorityFeePerGas].reduce((a, b) => (a > b ? a : b));
  const max = [up(old.maxFeePerGas), market.maxFeePerGas, tip].reduce((a, b) => (a > b ? a : b));
  return { maxFeePerGas: max, maxPriorityFeePerGas: tip };
}
const feesOf = (f) => ({ maxFeePerGas: BigInt(f.maxFeePerGas), maxPriorityFeePerGas: BigInt(f.maxPriorityFeePerGas) });
/** A fee per gas in gwei, three significant digits ('0.00125'), as the stuck batch says it. */
const gweiText = (wei) => Number(formatGwei(wei)).toLocaleString('en-US', { maximumSignificantDigits: 3, maximumFractionDigits: 20 });
const feesText = (f) => ({ maxFeePerGas: String(f.maxFeePerGas), maxPriorityFeePerGas: String(f.maxPriorityFeePerGas) });

/** The max fee setting as typed: '' or null for the default, else a positive number of gwei. */
export function checkMaxFee(raw) {
  const text = String(raw ?? '').trim();
  const gwei = text === '' ? null : Number(text);
  if (gwei !== null && !(Number.isFinite(gwei) && gwei > 0)) throw new Error('The max fee must be a positive number of gwei.');
  return gwei;
}

/**
 * How far ahead the batch forecasts a registry stream: one cadence, and at least
 * the 24 h a round scores (docs/intent/engine.md): two 12 h steps for an hourly
 * stream, one 24 h step for the daily default stream.
 */
export const horizonFor = (cadenceMinutes) => Math.max(ROUND_S, (Number(cadenceMinutes) || 0) * 60);

/**
 * The engine's step for a registry stream (docs/design/base.md, the daily batch): the
 * horizon cut into n = max(1, floor(horizon / max(12 h, cadence))) equal steps, so the
 * forecast lands exactly on the horizon: 12 h for a stream that updates at least that
 * often, else one step of the horizon (a 13 h or an 18 h cadence: one 24 h step).
 */
export function stepFor(cadenceMinutes) {
  const horizon = horizonFor(cadenceMinutes);
  return horizon / Math.max(1, Math.floor(horizon / Math.max(STEP_S, (Number(cadenceMinutes) || 0) * 60)));
}

/** Lite's direction_from (base_predict.py:141-143): UP if the forecast is above the latest value; a tie is DOWN. */
export const directionOf = (forecast, latest) => (forecast > latest ? UP : DOWN);

/**
 * A game's direction and the rule that decided it (the owner, 2026-10-19; docs/design/base.md#the-daily-batch-the-alias-on-its-own):
 * - 'forecast': UP if the forecast is above the latest value, else DOWN (Lite's rule, for every forecast but a tie);
 * - 'last-move': a forecast equal to the latest (a naive or no-opinion model) follows the stream's last move, the most
 *   recent change in its history: up → UP, down → DOWN (Lite answers DOWN);
 * - 'flat': a tie on a history with no change at all (flat, or one value) stays DOWN, the last fallback.
 * history: the registry's [{ hour, value: bigint }], oldest first; the moves compare the int232 values exactly.
 * → { direction, rule }
 */
export function directionFor(forecast, history) {
  const values = history.map((h) => BigInt(h.value));
  const latest = values.at(-1);
  if (forecast !== Number(latest)) return { direction: directionOf(forecast, Number(latest)), rule: 'forecast' };
  for (let i = values.length - 1; i > 0; i--) {
    if (values[i] !== values[i - 1]) return { direction: values[i] > values[i - 1] ? UP : DOWN, rule: 'last-move' };
  }
  return { direction: DOWN, rule: 'flat' };
}

/** Registry history → the engine's points (the value's scale does not matter to a direction). */
export const toPoints = (history) => history.map(({ hour, value }) => ({ ts: hour * 3600, value: Number(value) }));

const plainAmount = (wei) => (wei == null ? null : formatEther(wei));
/** ETH under one transaction's gas (none at all when the gas price is not known). */
const lowOnGas = (eth, gas) => eth != null && (eth === 0n || (gas != null && eth < gas));

/** Central's reward drop is published after its daily run: the wallet's proof is asked again at most hourly. */
export const PROOF_TTL_S = 3600;
/** A wallet transaction needs Base ETH for gas (Claim says so before it tries). */
export const NEED_GAS = 'The wallet needs a little Base ETH for gas to claim.';
/** Stake's two alias steps and its wallet step need gas on each (said before trying, as Claim). */
export const NEED_ALIAS_GAS = "The alias needs a little Base ETH for gas: send some from the wallet to the alias's address, then stake.";
export const NEED_STAKE_GAS = 'The wallet needs a little Base ETH for gas to stake.';
export const ZERO_ADDRESS = 'The zero address (0x000…000) burns what is sent to it: refused.';

/**
 * A send's inputs, checked before anything is asked of the chain or the passphrase: { asset: 'ETH' | 'SATORI', to (a
 * 0x address, not the zero address), amount (a positive decimal string) } → { asset, to, amount, wei }.
 */
export function checkSend({ asset, to, amount } = {}) {
  const kind = String(asset ?? '').toUpperCase();
  if (kind !== 'ETH' && kind !== 'SATORI') throw new Error("Name the asset: 'ETH' or 'SATORI'.");
  const address = String(to ?? '').trim();
  if (!isAddress(address)) throw new Error('The recipient must be a 0x address.');
  if (same(address, zeroAddress)) throw new Error(ZERO_ADDRESS);
  const text = String(amount ?? '').trim();
  let wei;
  try { wei = parseEther(text); } catch { wei = 0n; }
  if (!(wei > 0n)) throw new Error('The amount must be a positive number.');
  return { asset: kind, to: address, amount: text, wei };
}

/**
 * Central's answer for the wallet's merkle proof (merkle.py:45-58), or its error → { state: 'ok', amountWei, proof, root }
 * (the lifetime entitlement), 'none' (no drop published yet), 'not-in' (this wallet is not in the current drop), or
 * 'unknown' (missing: a central without the route, as prod on main; else central did not answer), with `error`.
 */
export function proofState({ entry, error } = {}) {
  if (error) {
    if (error.status === 404 && /no reward drop/i.test(error.detail)) return { state: 'none' };
    if (error.status === 404 && /not in the current drop/i.test(error.detail)) return { state: 'not-in' };
    return { state: 'unknown', missing: error.status === 404, error };
  }
  try {
    return { state: 'ok', amountWei: BigInt(entry.amountWei), proof: entry.proof, root: entry.root };
  } catch {
    return { state: 'unknown', missing: false, error: new Error('the Satori Service sent no amount') };
  }
}

/** The drop still to claim: max(0, the entitlement − alreadyMintedTo); 0 with no entry; null when it is not known. */
export function dropClaimable(proof, minted) {
  if (proof?.state === 'none' || proof?.state === 'not-in') return 0n;
  if (proof?.state !== 'ok' || minted == null) return null;
  return proof.amountWei > minted ? proof.amountWei - minted : 0n;
}

/** The wallet's merkle proof from central, as proofState says it (never throws). */
const askProof = (c, address) => c.merkleProof(address).then((entry) => proofState({ entry }), (error) => proofState({ error }));

/** What a staking out of sync means, plainly (Home's card, the Wallet card, a refused Unstake). */
export const OUT_OF_SYNC = "Unstaking will fail until the contract fix. Don't add SATORI to the wallet.";

/**
 * Whether the stake is booked right (the token-hook bug, docs/issues/token-hook-gas-estimate.md): SATORI that reached a
 * staked wallet in a transaction whose hook ran out of gas is in its balance and not in the alias's power, and
 * unstaking then underflows (Panic 0x11) until the contract fix. Once the alias accepts only this wallet
 * (allowedDelegator == wallet) and the wallet stakes with it, the wallet is its only staker, so the alias's power must
 * equal the wallet's SATORI: under it is out of sync (shortfall: the SATORI not booked). Otherwise other stakers are
 * possible and nothing is checked (null). → { inSync: true | false | null, shortfall: decimal string | null }
 */
export function stakeSync({ staked, allowedDelegator, wallet, power, balance }) {
  if (staked !== 'alias' || !same(allowedDelegator, wallet) || power == null || balance == null) return { inSync: null, shortfall: null };
  return power < balance ? { inSync: false, shortfall: formatEther(balance - power) } : { inSync: true, shortfall: null };
}

/** A mined batch: stored as the last one, its round from its block (a send at 23:59:59 can land in the next round). */
async function finish(db, b, mined) {
  const batch = { round: Math.floor(mined.at / ROUND_S), at: mined.at, hash: b.hash, games: b.games, dropped: b.dropped };
  await db.set('base_last_batch', batch);
  await db.set('base_pending_batch', null);
  await db.checkpoint();
  return { at: mined.at, round: batch.round, sent: batch };
}

/**
 * A batch sent and not mined for STUCK_S (docs/design/base.md#a-batch-that-never-mines): its nonce still pending, it is
 * sent again at that nonce with fees bumped (bumpFees), within the ceiling; past it, it waits and says so. Its nonce
 * taken (mined: ours unseen, or another transaction): null, let go.
 */
async function unstick({ chain, alias, db, pending, maxFeeWei, now, at, round, report }) {
  if ((await chain.nonce(alias.evmAddress, 'latest')) > pending.nonce) return null;
  const fees = bumpFees(feesOf(pending.fees), await chain.fees());
  const fee = gweiText(fees.maxFeePerGas);
  console.warn('[satori] base batch stuck', { hash: pending.hash, nonce: pending.nonce, sentAt: pending.sentAt, fee });
  const keep = async (p) => {
    await db.set('base_pending_batch', p);
    await db.checkpoint();
  };
  if (fees.maxFeePerGas > maxFeeWei) {
    const max = gweiText(maxFeeWei);
    const stuck = { at: now(), ceiling: true, fee, max, replaced: pending.stuck?.replaced ?? 0 };
    await keep({ ...pending, stuck });
    return { at, round, stuck, skip: SKIP.stuckCeiling, skipped: `stuck: a higher fee (${fee} gwei) would pass the max fee (${max} gwei); raise it in Settings` };
  }
  report('send');
  const hash = await chain.replaceBatch(alias, pending.games, { nonce: pending.nonce, gas: BigInt(pending.gas), fees });
  const stuck = { at: now(), fee, replaced: (pending.stuck?.replaced ?? 0) + 1 };
  await keep({ ...pending, hash, hashes: [...(pending.hashes ?? [pending.hash]), hash], fees: feesText(fees), sentAt: now(), stuck });
  report('confirm');
  return { at, round, stuck, pendingAt: now(), skip: SKIP.stuckRetry, skipped: `stuck: retrying with a higher fee (${fee} gwei)` };
}

/**
 * The daily batch (start.py:1143-1236 with the fixes in docs/design/base.md).
 * Never throws: the result says what happened. report(step): 'check' (the games, once a batch is due), 'send',
 * 'confirm' (waiting for its receipt, or for one sent before); nothing for a check with nothing to do. A batch still
 * pending says when it was sent (pendingAt, local seconds): the next check comes STUCK_S after it.
 * @returns {Promise<object>} { at, round, sent: {round, at, hash, games, dropped} } | { at, round?, skipped, dropped?,
 *   pendingAt?, stuck? } | { at, error }
 */
export async function runBatch({ chain, alias, db, forecast = engineForecast, maxFeeWei = parseGwei(String(MAX_FEE_GWEI)), manual = false,
  pendingWaitMs = PENDING_WAIT_MS, sendWaitMs, stuckS = STUCK_S, now = () => Date.now() / 1000, report = () => {} }) {
  let at = null;
  try {
    // A batch sent before the tab closed (or a check ended) has its hash kept: wait for it, never send twice; one that
    // does not mine for STUCK_S is sent again with a higher fee (unstick).
    const pending = await db.get('base_pending_batch');
    if (pending) {
      report('confirm');
      const known = pending.nonce != null && pending.sentAt != null; // sent by a version that keeps its nonce
      const late = known && now() - pending.sentAt >= stuckS; // waited for long enough: a look, not another wait
      const mined = await chain.minedAny(pending.hashes ?? [pending.hash], { timeout: late ? 1000 : pendingWaitMs });
      if (mined?.status === 'success') return finish(db, { ...pending, hash: mined.hash }, mined);
      if (!mined) {
        const st = await chain.batchState(alias.evmAddress);
        if (late) {
          const r = await unstick({ chain, alias, db, pending, maxFeeWei, now, at: st.chainTime, round: st.round, report });
          if (r) return r;
        } else if (known || pending.round === st.round) {
          return { at: st.chainTime, round: st.round, skip: SKIP.pending, skipped: `waiting for the batch already sent (${pending.hash})`,
            ...(known ? { pendingAt: pending.sentAt } : {}) };
        }
      }
      // reverted, its nonce taken by another transaction, or an earlier round's (from an older version) that never mined
      await db.set('base_pending_batch', null);
    }

    const state = await chain.batchState(alias.evmAddress);
    at = state.chainTime;
    const { round } = state;
    if (state.power === 0n) return { at, round, skip: SKIP.unstaked, skipped: 'nothing staked with this app' };
    if (state.predicted !== 0) return { at, round, skip: SKIP.predicted, skipped: 'already predicted this round' };

    report('check');
    const games = [];
    const dropped = [];
    const list = await chain.streams();
    // how each stream's values read (the adapter's decimals), kept with its game for the Models tab; unread: plain numbers
    const displays = chain.streamDisplays ? await chain.streamDisplays(list.map((g) => g.streamId)).catch(() => []) : [];
    for (const [i, g] of list.entries()) {
      const history = await chain.history(g.streamId);
      const step = stepFor(g.cadenceMinutes);
      const f = history.length ? forecast(toPoints(history), { step, horizon: horizonFor(g.cadenceMinutes) }) : null;
      const base = { streamId: g.streamId, gameId: g.gameId, named: g.named, cadenceMinutes: g.cadenceMinutes,
        ...(displays[i] ? { decimals: displays[i].decimals } : {}) };
      if (!f) {
        // no values yet: nothing to forecast, so the no-opinion rule (DOWN, as 'flat'). A Sentiment stream records its
        // first value when it is first predicted (updateValuesStrict), so skipping it would leave it empty for good
        const game = { ...base, direction: DOWN, rule: 'no-history', step };
        const error = await chain.simulateGame(alias, game);
        if (error) dropped.push({ ...game, error });
        else games.push(game);
        continue;
      }
      const last = history.at(-1).value; // int232, in the stream's own units
      // As decimal strings, as amounts are: an int232 is often beyond 2^53 (the default stream is a ratio × 1e18).
      // score, persist, tests: the engine's backtest (its median error and no change's, null below 5 origins, and its
      // origins), kept with the forecast for the Models tab (scoring is part of training).
      const game = { ...base, ...directionFor(f.value, history), model: f.model, latest: last.toString(),
        forecast: BigInt(Math.round(f.value)).toString(), horizon: f.horizon, step,
        score: f.score ?? null, persist: f.persist ?? null, tests: f.tests ?? null };
      // The contract's own checks, named games' 24 clock hours included (SatoriEngine.sol:791-810).
      const error = await chain.simulateGame(alias, game);
      if (error) dropped.push({ ...game, error });
      else games.push(game);
    }
    if (!games.length) return { at, round, skip: dropped.length ? SKIP.noPass : SKIP.noGames, skipped: dropped.length ? 'no game passes its simulation' : 'no streams with a game', dropped };
    // played by hand (the Game tab): the day's calls are made, as always, and not sent
    if (manual) return { at, round, skip: SKIP.byHand, skipped: PLAYED_BY_HAND, games, dropped };

    const fees = await chain.fees();
    if (fees.maxFeePerGas > maxFeeWei) {
      return { at, round, dropped,
        skip: SKIP.gasCeiling, skipped: `gas above the ceiling: a max fee of ${formatGwei(fees.maxFeePerGas)} gwei > ${formatGwei(maxFeeWei)} gwei; the next check tries again` };
    }
    report('send');
    let sent;
    try {
      sent = await chain.sendBatch(alias, games, { fees, timeout: sendWaitMs, onSent: async (hash, tx) => {
        await db.set('base_pending_batch', { round, hash, games, dropped, nonce: tx.nonce, gas: String(tx.gas), fees: feesText(tx),
          sentAt: now() });
        await db.checkpoint();
        report('confirm');
      } });
    } catch (err) {
      if (!(err instanceof WaitForTransactionReceiptTimeoutError)) throw err;
      const p = await db.get('base_pending_batch'); // sent, not mined yet: the next check looks again
      return { at, round, skip: SKIP.pending, skipped: `waiting for the batch already sent (${p?.hash})`, pendingAt: p?.sentAt ?? null };
    }
    return finish(db, { hash: sent.hash, games, dropped }, sent);
  } catch (err) {
    console.warn('[satori] base batch', err);
    return { at, error: errorText(err) };
  }
}

/**
 * When the next check runs (local seconds): the next round's start + 1 min
 * (on the chain's clock, which a fork may run ahead), at most an hour away; a
 * batch sent and not mined (pendingAt: when), STUCK_S after it was sent, at least
 * a minute from now.
 */
export function nextCheckAt({ now, chainTime, pendingAt = null }) {
  let next = now + CHECK_EVERY_S;
  if (chainTime != null) {
    const roundStart = (Math.floor(chainTime / ROUND_S) + 1) * ROUND_S;
    next = Math.min(next, now + (roundStart - chainTime) + AFTER_ROUND_S);
  }
  return pendingAt == null ? next : Math.min(next, Math.max(now + 60, pendingAt + STUCK_S));
}

/**
 * A play noted without its calls (before the Sent screen listed them): read from its transaction, named from the streams.
 * Nothing sent (no hash), or the read fails: as noted.
 */
async function withCalls(chain, play, streams) {
  if (!play?.hash || play.calls) return play;
  const sent = await chain.batchOf(play.hash).catch(() => null);
  if (!sent) return play;
  const calls = sent.map(({ gameId, direction }) => {
    const s = streams.find((x) => x.gameId === gameId);
    return s ? { streamId: s.streamId, name: s.name, direction } : null;
  }).filter(Boolean);
  return { ...play, calls };
}

/**
 * @param {object} o
 * @param {object} o.db the app's db
 * @param {{evmAddress: string, signDigest: Function}} o.alias
 * @param {string} o.walletAddress the wallet's Base address (from its public key, in clear in the keys record: no Unlock needed)
 * @param {() => object|null} o.wallet the unlocked wallet signer, or null
 * @param {() => object} o.central the current central client
 * @param {string} [o.defaultRpc] the RPC when none is saved, if the build or the dev server set one (src/config.js)
 * @param {any} [o.transport] a viem transport (tests); else http to the RPC URLs
 * @param {() => void} [o.onTraffic] each RPC request and its answer (Home's glow, src/traffic.js)
 * @param {(result: object) => void} [o.onCheck] each batch check's result (Home's activity log)
 * @param {(keys: string[], url: string) => void} [o.onConfigDiffers] central's contract addresses differ from the bundle's
 *   (which are kept): the keys, once per fetch of its config (Home's activity log, a quiet warning)
 * @param {object} [o.work] what the neuron is doing (src/neuron/work.js): the batch ('base') and the wallet's actions say their steps
 * @param {object} [o.sw] the daily push's wake (src/pwa/wake.js): { get, put } over IndexedDB, and handoff(info), which
 *   leaves the service worker what it needs to send a batch; null where there is none (tests)
 */
export function createBase({ db, alias, walletAddress, wallet, central, defaultRpc, transport, forecast = engineForecast,
  now = () => Date.now() / 1000, onChange = () => {}, onCheck = () => {}, onConfigDiffers = () => {}, setTimeout: st = setTimeout,
  clearTimeout: ct = clearTimeout, origin = globalThis.location?.href, onTraffic = () => emit('base'), work = createWork(), sw = null }) {
  let cache = null; // central's config, 1 h
  let made = null; // { key, chain, rpc }
  let status = null; // the last status read
  let statusError = '';
  let proof = null; // the wallet's merkle proof from central: proofState, with { at, url } (asked at most hourly)
  let lastCheck = null;
  let play = null; // PLAYS: read from base_play once, then kept here (setPlay writes both)
  const readPlay = async () => (play ??= (await db.get('base_play')) === 'manual' ? 'manual' : 'auto');
  const changed = () => onChange();
  const hasReferral = (a) => !!a && !same(a, zeroAddress);

  const resolve = (u) => (u.startsWith('/') && origin ? new URL(u, origin).href : u);

  /**
   * The chain for the current config and RPC (rebuilt when either changes), every write under the max fee.
   * A new RPC is asked its chain id once: another chain than the config's is
   * refused, for reads, writes and the batch alike. Central's addresses that are not the bundle's are said
   * (onConfigDiffers), never used; with an RPC the build fixed, its rpcUrl and explorerUrl are not used either.
   */
  async function chainNow() {
    const c = central();
    const loaded = await loadConfig({ fetchCentral: () => c.baseConfig(), url: c.url, cache, now: now(), pinned: !!defaultRpc });
    cache = loaded.cache;
    if (loaded.fresh && loaded.differs.length) {
      console.warn('[satori] the Satori Service\'s contract addresses differ from the app\'s; the app\'s are used', c.url, loaded.differs);
      onConfigDiffers(loaded.differs, c.url);
    }
    const setting = (await db.get('base_rpc_url')) || '';
    const urls = rpcUrls({ config: loaded.config, setting, fixed: defaultRpc });
    const key = JSON.stringify([loaded.config, urls]);
    if (made?.key !== key) {
      const t = traced(transport ?? (urls.length === 1 ? http(resolve(urls[0])) : fallback(urls.map((u) => http(resolve(u))))), onTraffic);
      made = { key, rpc: urls, config: loaded.config, chainId: null,
        local: urls.every((u) => u.startsWith('/')), chain: createChain({ config: loaded.config, transport: t, maxFee: maxFeeWei }) };
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

  function needWallet() {
    const v = wallet();
    if (!v) throw new Error('Unlock the wallet first');
    return v;
  }

  /**
   * The wallet's merkle proof, asked again once an hour has gone by (or for another central). An answer that did not
   * come (central down) keeps the last one and is asked again at the next read; a central without the route is unknown.
   */
  async function proofNow() {
    const c = central();
    if (proof?.url === c.url && now() - proof.at < PROOF_TTL_S) return;
    keepProof(c, await askProof(c, walletAddress));
  }
  function keepProof(c, p) {
    if (p.state === 'unknown' && !p.missing && proof?.url === c.url) return; // central did not answer: keep the last
    proof = { ...p, at: now(), url: c.url };
  }

  async function refresh() {
    await readPlay();
    try {
      const { chain } = await chainNow();
      [status] = await Promise.all([chain.status({ alias: alias.evmAddress, wallet: walletAddress }), proofNow()]);
      statusError = status.round == null ? (status.errors[0] ?? 'no answer') : '';
      if (hasReferral(status.wallet.referral)) await db.set('referrer', null); // set once: nothing left to register
    } catch (err) {
      statusError = errorText(err);
    }
    changed();
    return view();
  }

  /** The status for the UI and agents: plain values, amounts as decimal strings. */
  function view() {
    const s = status;
    const gas = s?.gasPrice ? BATCH_GAS * 2n * s.gasPrice : null; // one transaction's worth, at most
    const batchesLeft = s?.alias.eth != null && gas ? Number(s.alias.eth / gas) : null;
    const c = s?.claimable;
    const drop = c ? dropClaimable(proof, c.minted) : null;
    const parts = [c?.rewards, drop, c?.airdrop].filter((x) => x != null);
    const vd = s?.wallet.delegate; // whom the wallet's prediction power goes to (predictionDelegateInfo)
    const staked = vd == null ? null : same(vd, alias.evmAddress) ? 'alias' : same(vd, zeroAddress) ? 'none' : 'other';
    const sync = stakeSync({ staked, allowedDelegator: s?.alias.allowedDelegator, wallet: walletAddress, power: s?.alias.power,
      balance: s?.wallet.satori });
    return {
      rpc: made?.rpc ?? [], config: made ? (made.fromCentral ? 'central' : 'bundled') : null,
      localFork: !!made?.local, // a path on this site: the dev server's /rpc, a local fork
      explorer: made && !made.local ? made.config.explorerUrl : null, // links tx hashes (not for a local fork)
      error: statusError, errors: s?.errors ?? [],
      round: s?.round ?? null, chainTime: s?.chainTime ?? null,
      alias: {
        address: alias.evmAddress, eth: plainAmount(s?.alias.eth), power: plainAmount(s?.alias.power),
        fee: s?.alias.fee ?? null, allowedStaker: s?.alias.allowedDelegator ?? null,
        batchesLeft, lowEth: batchesLeft != null && batchesLeft < LOW_BATCHES,
        noGas: lowOnGas(s?.alias.eth, gas), // under one transaction's gas: Stake says so before it tries
        preload: s?.wallet.eth > 0n ? formatEther(s.wallet.eth / 2n < PRELOAD_MAX ? s.wallet.eth / 2n : PRELOAD_MAX) : null, // Preload gas's amount (ETH)
      },
      wallet: {
        address: walletAddress, eth: plainAmount(s?.wallet.eth), satori: plainAmount(s?.wallet.satori),
        stakedWith: vd ?? null,
        referral: hasReferral(s?.wallet.referral) ? s.wallet.referral : null, // who the wallet is referred by (rewards.referral)
        staked,
        ...sync, // inSync, shortfall: the stake booked right (stakeSync)
        lock: s?.wallet.lock ?? null,
        lowEth: lowOnGas(s?.wallet.eth, gas), // under one transaction's gas: Claim says so before it tries
      },
      // the drop: the Satori Service's reward drop not claimed yet (null: this central does not say)
      claimable: { rewards: plainAmount(c?.rewards), drop: plainAmount(drop), airdrop: plainAmount(c?.airdrop),
        total: parts.length ? formatEther(parts.reduce((a, b) => a + b, 0n)) : null },
      lastCheck, nextCheck: schedule.next, checking: schedule.running, play,
    };
  }

  /** The last batch mined, and one sent and not mined yet (its stuck state: Home's base-stuck). */
  async function withLast(v) {
    return { ...v, lastBatch: (await db.get('base_last_batch')) ?? null, pendingBatch: (await db.get('base_pending_batch')) ?? null,
      lastPlay: (await db.get('game_last_play')) ?? null }; // the game's last Submit (the contract card: played today)
  }

  // ── the batch's schedule: a check runs the batch if due; one at a time; then the next check is armed ──
  async function check() {
    let result;
    try {
      const { chain } = await chainNow();
      const manual = (await readPlay()) === 'manual';
      // one sender at a time, the app or the push's service worker; a batch the worker sent is the app's to wait for
      result = await withBatchLock(async () => {
        if (sw) await adopt({ get: sw.get, put: sw.put, db });
        return work.run('base', async (report) => runBatch({ chain, alias, db, forecast, maxFeeWei: await maxFeeWei(), manual, now, report }));
      });
    } catch (err) {
      result = { at: null, error: errorText(err) };
    }
    // the contract unused (nothing staked here, no batch ever sent): its RPC's trouble is calm (docs/design/health.md)
    if (result.error && !(status?.alias?.power > 0n) && !(await db.get('base_last_batch'))) result.unused = true;
    lastCheck = result;
    onCheck(result); // Home's activity log
    await refresh();
    await leave();
    return result;
  }

  /** The handoff for the push's service worker (src/pwa/wake.js): this chain, its RPCs, the max fee, how the app plays. */
  async function leave() {
    if (!sw || !made) return;
    try {
      await sw.handoff({ rpc: made.rpc.map(resolve), config: made.config, maxFeeWei: String(await maxFeeWei()),
        play: await readPlay(), staked: !!status && status.alias.power > 0n });
    } catch (err) {
      console.warn('[satori] push handoff', err);
    }
  }
  const schedule = createSchedule(check, {
    now, setTimeout: st, clearTimeout: ct, name: 'base', onChange: changed,
    after: () => nextCheckAt({ now: now(), chainTime: lastCheck?.at ?? status?.chainTime ?? null, pendingAt: lastCheck?.pendingAt ?? null }),
  });

  // ── wallet actions (Unlock): each says its steps as work `task` (step(name, k, n)) ──
  async function act(task, fn) {
    const { chain } = await chainNow();
    try {
      return await work.run(task, (step) => fn(chain, step));
    } finally {
      await refresh();
    }
  }
  /** The wallet's SATORI can be sent now (the token's transfer lock), else it throws when it can. */
  async function sendable(chain) {
    const lock = (await chain.status({ alias: alias.evmAddress, wallet: walletAddress })).wallet.lock;
    if (lock?.locked) throw new Error(`${lockText(lock)}.`);
  }
  /** A wallet write's options: the step 'confirm' once it is sent. */
  const sent = (step) => ({ onSent: () => step('confirm') });

  /**
   * The merkle drop: central's proof alone, as Lite (routes.py:1321-1331); its
   * 404 says which case (merkle.py:45-58), and prod, which lacks the route,
   * answers a plain Not Found. What was paid is read back at the claim's
   * block: the lane's reserve may pay only part (SatoriMerkle.sol:196-201).
   */
  async function merkleDue(chain) {
    const c = central();
    const p = await askProof(c, walletAddress);
    keepProof(c, p); // asked just now: the card's drop needs no other call
    if (p.state === 'none') return { skipped: `no merkle drop published on ${c.url}` };
    if (p.state === 'not-in') return { skipped: 'this wallet is not in the current drop' };
    if (p.state === 'unknown') {
      if (!p.missing) throw p.error;
      return { skipped: `${c.url} serves no merkle drop (${p.error.detail})` };
    }
    const before = await chain.alreadyMinted(walletAddress);
    if (p.amountWei <= before) return { skipped: 'already claimed: up to date with the drop' };
    return { p, before };
  }
  async function claimMerkle(chain, v, due, step) {
    step('drop');
    const { p, before } = due;
    const { hash, receipt } = await chain.claimMerkle(v, { amountWei: p.amountWei.toString(), proof: p.proof }, sent(step));
    const after = await chain.alreadyMinted(walletAddress, receipt.blockNumber);
    return { hash, amount: formatEther(after - before) };
  }

  /**
   * Who sends each part of Claim (docs/design/base.md#claims): the alias, with its own gas and no Unlock, where the
   * contract lets anyone claim to the wallet (the airdrop; the on-chain rewards once the permissionless claim is live,
   * read by a simulate); else the wallet. The merkle drop is the wallet's own (until its claim is permissionless too).
   * → { st, rewards, airdrop: 'alias' | 'wallet' | null (nothing owed), merkle: merkleDue's, or { error }, wallet: bool }
   */
  async function claimPlan(chain) {
    const st = await chain.status({ alias: alias.evmAddress, wallet: walletAddress });
    const gas = st.gasPrice ? BATCH_GAS * 2n * st.gasPrice : null;
    const aliasPays = !lowOnGas(st.alias.eth, gas) && st.alias.eth != null;
    const byAlias = async () => aliasPays && (await chain.canClaimFor(alias.evmAddress, walletAddress).catch(() => 'unread')) === null;
    const rewards = !(st.claimable.rewards > 0n) ? null : (await byAlias()) ? 'alias' : 'wallet';
    const airdrop = !(st.claimable.airdrop > 0n) ? null : aliasPays ? 'alias' : 'wallet';
    const merkle = await merkleDue(chain).catch((err) => ({ error: errorText(err) }));
    return { st, gas, rewards, airdrop, merkle, wallet: rewards === 'wallet' || airdrop === 'wallet' || !!merkle.p };
  }

  return {
    refresh,
    /**
     * The payment channels' client on the current chain (src/chain/channels.js: its writes share this chain's queue, pads
     * and max fee), the bundled config and the chain's clock (s): the market's (src/neuron/market.js).
     */
    async channels() {
      const m = await chainNow();
      m.channels ??= createChannels({ chain: m.chain, config: m.config });
      return { channels: m.channels, config: m.config, chainTime: async () => Number((await m.chain.client.getBlock()).timestamp) };
    },
    /** A registry stream's history as the engine reads it (the Models tab's drill-in): [{ ts, value }], oldest first. */
    async history(streamId) {
      const { chain } = await chainNow();
      return toPoints(await chain.history(streamId));
    },
    /** The same, as the chain keeps it: [{ hour, value: bigint }] (a call's result, src/neuron/day.js: exact, not as numbers). */
    async chainHistory(streamId) {
      const { chain } = await chainNow();
      return chain.history(streamId);
    },
    /** The status, with the settings as stored ('' and null: the defaults) and the max fee in force. */
    async status() {
      const maxFeeSetting = (await db.get('base_max_fee_gwei')) ?? null;
      return { ...(await withLast(view())), pendingReferrer: (await db.get('referrer')) ?? null,
        inviteLink: inviteLink(origin ? new URL(origin).origin : '', walletAddress), rpcSetting: (await db.get('base_rpc_url')) || '', maxFeeSetting,
        maxFeeGwei: maxFeeSetting ?? MAX_FEE_GWEI };
    },

    /**
     * Settings: the RPC (https, a path on this site, or '' for the default)
     * and the batch's max fee (gwei, or '' / null for the default), either or
     * both; each is checked before either is saved. A new RPC is read at once.
     * → status()
     */
    /**
     * The Game tab's streams (docs/design/base.md#the-game): every stream with a game (weight 0: not reward eligible), each with its name, its history
     * (decimal strings), whether the player can predict it now (`blocked`: the simulate's revert name, else null) and the
     * player's streak on it with the game's bar (`streak`: { streak, bar }, or null), and how its values read (`display`:
 * { decimals, unit, label } from its adapter, or null).
     * The player: the alias when the wallet is staked with it, else the wallet. → { by: 'alias' | 'wallet', streams }
     */
    async gameStreams() {
      await refresh(); // the round now (a game played this round shows its Sent screen) and whom the wallet stakes with
      const { chain } = await chainNow();
      const by = playerOf(view().wallet.staked);
      const player = by === 'alias' ? alias.evmAddress : walletAddress;
      const list = await chain.streams({ all: true });
      const ids = list.map((g) => g.streamId);
      const [names, streaks, displays] = await Promise.all([chain.streamNames(ids),
        chain.streaks(player, list.map((g) => g.gameId)).catch(() => list.map(() => null)),
        chain.streamDisplays(ids).catch(() => ids.map(() => null))]);
      const streams = await Promise.all(list.map(async (g, i) => {
        const [history, blocked] = await Promise.all([chain.history(g.streamId), chain.simulateGame(player, { gameId: g.gameId, direction: UP })]);
        return { streamId: g.streamId, gameId: g.gameId, name: names[i] || `Stream ${g.streamId}`, named: g.named,
          cadenceMinutes: g.cadenceMinutes, weight: String(g.weight), blocked, streak: streaks[i], // { streak, bar } or null
          display: displays[i], // { decimals, unit, label }: how its values read; null: plain numbers
          history: history.map((h) => ({ hour: h.hour, value: String(h.value) })) };
      }));
      return { by, streams, round: view().round, played: await withCalls(chain, (await db.get('game_last_play')) ?? null, streams) };
    },

    /** Who sends the Satori contract predictions, from the database alone (no chain): what the Game tab needs first. */
    play: readPlay,

    /** Note a game's Submit (sent, or done without sending: the Game tab's played streams): { round, at, count, hash }. */
    async notePlay(play) {
      await db.set('game_last_play', play);
    },

    /**
     * The Game tab's predictions, one transaction: from the alias when the wallet is staked with it, else from the
     * wallet (Unlock, or its wallet app); a wallet invited by a link (held: holdReferrer) and not referred yet registers
     * its referral with it. picks: [{ gameId, direction }]. → { hash, at, by, round, referrer? } (noted: notePlay, with `count`)
     */
    async playHand(picks) {
      if (!picks?.length) throw new Error('No predictions to send.');
      await refresh(); // whom the wallet stakes with now, read from the chain: a Stake or Unstake elsewhere since counts
      const by = playerOf(view().wallet.staked);
      const player = by === 'alias' ? alias : needWallet();
      // the wallet's first prediction from an invite link registers who invited it, as the dapp does (the alias's
      // can't: the referral would be the alias's; a staked wallet's was registered by Stake)
      const held = by === 'wallet' && !hasReferral(status?.wallet.referral) ? (await db.get('referrer')) ?? null : null;
      const referrer = held && !same(held, walletAddress) ? held : null;
      const r = await act('base', async (chain, step) => {
        step('send');
        return chain.sendBatch(player, picks.map(({ gameId, direction }) => ({ gameId, direction })), { referrer, onSent: () => step('confirm') });
      });
      if (referrer) await db.set('referrer', null); // registered (or one already was: the contract keeps the first)
      return { hash: r.hash, at: r.at, by, round: Math.floor(r.at / ROUND_S), ...(referrer ? { referrer } : {}) };
    },

    /** Who sends the Satori contract predictions: 'auto' (the daily batch) or 'manual' (the Game tab). → status() */
    async setPlay(mode) {
      if (!PLAYS.includes(mode)) throw new Error(`play: one of ${PLAYS.join(', ')}, not ${mode}.`);
      play = mode;
      await db.set('base_play', mode);
      await db.checkpoint();
      await leave();
      changed();
      return this.status();
    },

    async setSettings({ rpc, maxFee } = {}) {
      const url = rpc === undefined ? undefined : checkRpcSetting(rpc);
      const gwei = maxFee === undefined ? undefined : checkMaxFee(maxFee);
      if (url !== undefined) await db.set('base_rpc_url', url);
      if (gwei !== undefined) await db.set('base_max_fee_gwei', gwei);
      await db.checkpoint();
      if (url !== undefined) await refresh();
      else changed();
      await leave();
      return this.status();
    },

    /**
     * The first check FIRST_CHECK_S after the load, or at once when a batch is due: the alias has power and no
     * batch this round, or one sent before waits for its receipt (docs/design/base.md#when-in-the-round).
     */
    start() {
      schedule.start(now() + FIRST_CHECK_S);
      refresh().then(async () => {
        const last = await db.get('base_last_batch');
        const due = !!(await db.get('base_pending_batch'))
          || (status?.round != null && status.alias.power > 0n && last?.round !== status.round);
        if (due && !schedule.running && schedule.next > now()) await schedule.arm(now());
      }).catch(() => {});
    },
    stop: schedule.stop,
    /** The batch now if due (window.satori.predictBase). */
    predict: schedule.run,
    /** The check now when its time has passed and none runs (the device slept); else null. */
    catchUp: schedule.catchUp,

    /**
     * An invite link's referrer, held until Stake registers it (docs/design/base.md#referral-invite-links): the newest
     * wins; not an address, the zero address and the wallet's own are refused. → whether it is held now
     */
    async holdReferrer(address) {
      const ref = referrerOf(`?ref=${address ?? ''}`);
      if (!ref || same(ref, walletAddress)) return false;
      await db.set('referrer', ref);
      changed();
      return true;
    },

    /** Stake with this neuron (docs/design/base.md): needs Unlock. Then a batch check soon. */
    async delegate() {
      const v = needWallet();
      const referrer = (await db.get('referrer')) ?? null;
      const r = await act('stake', async (chain, step) => {
        const st = await chain.status({ alias: alias.evmAddress, wallet: v.evmAddress });
        const gas = st.gasPrice ? BATCH_GAS * 2n * st.gasPrice : null;
        if (lowOnGas(st.alias.eth, gas)) throw new Error(NEED_ALIAS_GAS);
        if (lowOnGas(st.wallet.eth, gas)) throw new Error(NEED_STAKE_GAS);
        return chain.delegate({ alias, wallet: v, referrer, onStep: step });
      });
      schedule.arm(now() + FIRST_CHECK_S);
      return r;
    },
    /** Unstake (needs Unlock). A stake out of sync underflows (Panic 0x11) in the simulate: said plainly, nothing sent. */
    async undelegate() {
      const v = needWallet();
      return act('unstake', async (chain, step) => {
        try {
          return await chain.undelegate({ wallet: v, onStep: step });
        } catch (err) {
          if (panicOf(err) === 0x11) throw new Error(`Staking is out of sync. ${OUT_OF_SYNC}`);
          throw err;
        }
      });
    },

    /** hub.claim() (the lens says > 0), the merkle drop (central's proof), the airdrop; each on its own. */
    /** Whether Claim needs the wallet (Unlock) now: claimPlan's `wallet`, read without a key. → boolean */
    async claimNeedsWallet() {
      const { chain } = await chainNow();
      return (await claimPlan(chain)).wallet;
    },
    /**
     * Claim each part from whoever claimPlan says: the alias (no Unlock) or the wallet (needs Unlock only then). Each
     * part on its own: { rewards, merkle, airdrop }, each { hash, amount, by } | { skipped } | { error }.
     */
    async claim() {
      const v = wallet();
      return act('claim', async (chain, step) => {
        const plan = await claimPlan(chain);
        if (plan.wallet) {
          if (!v) needWallet();
          if (lowOnGas(plan.st.wallet.eth, plan.gas)) throw new Error(NEED_GAS);
        }
        const each = async (fn) => {
          try { return await fn(); } catch (err) { return { error: errorText(err) }; }
        };
        const rewards = await each(async () => {
          if (!plan.rewards) return { skipped: 'nothing to claim on-chain' };
          step('rewards');
          const tx = plan.rewards === 'alias' ? chain.claimRewardsFor(alias, walletAddress, sent(step)) : chain.claimRewards(v, sent(step));
          return { hash: (await tx).hash, amount: formatEther(plan.st.claimable.rewards), by: plan.rewards };
        });
        const merkle = await each(async () => {
          if (plan.merkle.error) throw new Error(plan.merkle.error);
          if (plan.merkle.skipped) return { skipped: plan.merkle.skipped };
          return { ...(await claimMerkle(chain, v, plan.merkle, step)), by: 'wallet' };
        });
        const airdrop = await each(async () => {
          if (!plan.airdrop) return { skipped: 'no vested airdrop to claim' };
          step('airdrop');
          const tx = plan.airdrop === 'alias' ? chain.claimAirdropFor(alias, walletAddress, sent(step)) : chain.claimAirdrop(v, sent(step));
          return { hash: (await tx).hash, amount: formatEther(plan.st.claimable.airdrop), by: plan.airdrop };
        });
        return { rewards, merkle, airdrop };
      });
    },

    /**
     * The review before a send (no key needed): the inputs checked, SATORI's transfer lock, and the fee: the gas
     * estimated from the wallet's address, `about` at the base fee + the tip, `max` at the gas limit and the max fee
     * (decimal ETH). → { asset, to, amount, fee: { gas, about, max } }
     */
    async quoteSend(o) {
      const { asset, to, amount, wei } = checkSend(o);
      const { chain } = await chainNow();
      if (asset === 'SATORI') await sendable(chain);
      const fee = await chain.sendFee(walletAddress, { asset, to, wei });
      const less = fee.value != null && fee.value !== wei; // all the ETH: what is left once the fee is paid
      return { asset, to: getAddress(to), amount: less ? formatEther(fee.value) : amount, ...(less && { lessFee: true }),
        fee: { gas: Number(fee.gas), about: formatEther(fee.about), max: formatEther(fee.max) } };
    },

    /**
     * From the wallet: { asset: 'ETH' | 'SATORI', to, amount } (a decimal string). `key`: the wallet to send with, as the
     * app opens it from the passphrase for each send (keys' withPassphrase); else the unlocked one. → { hash }
     */
    async send(o, key) {
      const { asset, to, wei } = checkSend(o);
      const v = key ?? needWallet();
      return act('send', async (chain, step) => {
        const tx = { onSent: () => step('confirm', 1, 1) };
        if (asset === 'ETH') {
          step('send', 1, 1);
          return { hash: (await chain.sendEth(v, to, wei, tx)).hash };
        }
        await sendable(chain);
        step('send', 1, 1);
        return { hash: (await chain.sendSatori(v, to, wei, tx)).hash };
      });
    },
  };
}
