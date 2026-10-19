// The Base flow (docs/design/base.md), as Satori Lite runs it (start.py:1143-1274,
// web/routes.py:1321-1529) and as the dapp goes further:
//   status (no key) · Stake / Unstake (Unlock) · the daily batch (the identity, on its own)
//   · claims (Unlock: hub.claim, merkle, airdrop) · send (Unlock)
// The batch goes at the first check of each UTC round: 10 s after start (at
// once when one is due), at the next round's start (chain time) and at least hourly.
import {
  fallback, formatEther, formatGwei, getAddress, http, isAddress, parseEther, parseGwei, zeroAddress, WaitForTransactionReceiptTimeoutError,
} from 'viem';
import { createChain, errorText, lockText, panicOf, same, DOWN, UP, ROUND_S } from '../chain/index.js';
import { checkRpcSetting, loadConfig, rpcUrls } from '../chain/config.js';
import { explainForecast as engineForecast, STEP_S } from '../engine/index.js';
import { createSchedule } from './schedule.js';
import { createWork } from './work.js';
import { emit, traced } from '../traffic.js';

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
 * A game's direction and the rule that decided it (the owner, 2026-10-19; docs/design/base.md#the-daily-batch-the-identity-on-its-own):
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

/** Central's reward drop is published after its daily run: the vault's proof is asked again at most hourly. */
export const PROOF_TTL_S = 3600;
/** A vault transaction needs Base ETH for gas (Claim says so before it tries). */
export const NEED_GAS = 'The vault needs a little Base ETH for gas to claim.';
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
 * Central's answer for the vault's merkle proof (merkle.py:45-58), or its error → { state: 'ok', amountWei, proof, root }
 * (the lifetime entitlement), 'none' (no drop published yet), 'not-in' (this vault is not in the current drop), or
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
    return { state: 'unknown', missing: false, error: new Error('the Satori Network sent no amount') };
  }
}

/** The drop still to claim: max(0, the entitlement − alreadyMintedTo); 0 with no entry; null when it is not known. */
export function dropClaimable(proof, minted) {
  if (proof?.state === 'none' || proof?.state === 'not-in') return 0n;
  if (proof?.state !== 'ok' || minted == null) return null;
  return proof.amountWei > minted ? proof.amountWei - minted : 0n;
}

/** The vault's merkle proof from central, as proofState says it (never throws). */
const askProof = (c, address) => c.merkleProof(address).then((entry) => proofState({ entry }), (error) => proofState({ error }));

/** What a staking out of sync means, plainly (Home's card, the Wallet card, a refused Unstake). */
export const OUT_OF_SYNC = "Unstaking will fail until the contract fix. Don't add SATORI to the vault.";

/**
 * Whether the stake is booked right (the token-hook bug, docs/issues/token-hook-gas-estimate.md): SATORI that reached a
 * staked vault in a transaction whose hook ran out of gas is in its balance and not in the identity's power, and
 * unstaking then underflows (Panic 0x11) until the contract fix. Once the identity accepts only this vault
 * (allowedDelegator == vault) and the vault stakes with it, the vault is its only staker, so the identity's power must
 * equal the vault's SATORI: under it is out of sync (shortfall: the SATORI not booked). Otherwise other stakers are
 * possible and nothing is checked (null). → { inSync: true | false | null, shortfall: decimal string | null }
 */
export function stakeSync({ staked, allowedDelegator, vault, power, balance }) {
  if (staked !== 'identity' || !same(allowedDelegator, vault) || power == null || balance == null) return { inSync: null, shortfall: null };
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
async function unstick({ chain, identity, db, pending, maxFeeWei, now, at, round, report }) {
  if ((await chain.nonce(identity.evmAddress, 'latest')) > pending.nonce) return null;
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
    return { at, round, stuck, skipped: `stuck: a higher fee (${fee} gwei) would pass the max fee (${max} gwei); raise it in Settings` };
  }
  report('send');
  const hash = await chain.replaceBatch(identity, pending.games, { nonce: pending.nonce, gas: BigInt(pending.gas), fees });
  const stuck = { at: now(), fee, replaced: (pending.stuck?.replaced ?? 0) + 1 };
  await keep({ ...pending, hash, hashes: [...(pending.hashes ?? [pending.hash]), hash], fees: feesText(fees), sentAt: now(), stuck });
  report('confirm');
  return { at, round, stuck, pendingAt: now(), skipped: `stuck: retrying with a higher fee (${fee} gwei)` };
}

/**
 * The daily batch (start.py:1143-1236 with the fixes in docs/design/base.md).
 * Never throws: the result says what happened. report(step): 'check' (the games, once a batch is due), 'send',
 * 'confirm' (waiting for its receipt, or for one sent before); nothing for a check with nothing to do. A batch still
 * pending says when it was sent (pendingAt, local seconds): the next check comes STUCK_S after it.
 * @returns {Promise<object>} { at, round, sent: {round, at, hash, games, dropped} } | { at, round?, skipped, dropped?,
 *   pendingAt?, stuck? } | { at, error }
 */
export async function runBatch({ chain, identity, db, forecast = engineForecast, maxFeeWei = parseGwei(String(MAX_FEE_GWEI)),
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
        const st = await chain.batchState(identity.evmAddress);
        if (late) {
          const r = await unstick({ chain, identity, db, pending, maxFeeWei, now, at: st.chainTime, round: st.round, report });
          if (r) return r;
        } else if (known || pending.round === st.round) {
          return { at: st.chainTime, round: st.round, skipped: `waiting for the batch already sent (${pending.hash})`,
            ...(known ? { pendingAt: pending.sentAt } : {}) };
        }
      }
      // reverted, its nonce taken by another transaction, or an earlier round's (from an older version) that never mined
      await db.set('base_pending_batch', null);
    }

    const state = await chain.batchState(identity.evmAddress);
    at = state.chainTime;
    const { round } = state;
    if (state.power === 0n) return { at, round, skipped: 'nothing staked with this neuron' };
    if (state.predicted !== 0) return { at, round, skipped: 'already predicted this round' };

    report('check');
    const games = [];
    const dropped = [];
    for (const g of await chain.streams()) {
      const history = await chain.history(g.streamId);
      const step = stepFor(g.cadenceMinutes);
      const f = history.length ? forecast(toPoints(history), { step, horizon: horizonFor(g.cadenceMinutes) }) : null;
      const base = { streamId: g.streamId, gameId: g.gameId, named: g.named };
      if (!f) { dropped.push({ ...base, error: 'no history' }); continue; }
      const last = history.at(-1).value; // int232, in the stream's own units
      // As decimal strings, as amounts are: an int232 is often beyond 2^53 (the default stream is a ratio × 1e18).
      // score, persist, tests: the engine's backtest (its median error and no change's, null below 5 origins, and its
      // origins), kept with the forecast for the Models tab (scoring is part of training).
      const game = { ...base, ...directionFor(f.value, history), model: f.model, latest: last.toString(),
        forecast: BigInt(Math.round(f.value)).toString(), horizon: f.horizon, step,
        score: f.score ?? null, persist: f.persist ?? null, tests: f.tests ?? null };
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
    report('send');
    let sent;
    try {
      sent = await chain.sendBatch(identity, games, { fees, timeout: sendWaitMs, onSent: async (hash, tx) => {
        await db.set('base_pending_batch', { round, hash, games, dropped, nonce: tx.nonce, gas: String(tx.gas), fees: feesText(tx),
          sentAt: now() });
        await db.checkpoint();
        report('confirm');
      } });
    } catch (err) {
      if (!(err instanceof WaitForTransactionReceiptTimeoutError)) throw err;
      const p = await db.get('base_pending_batch'); // sent, not mined yet: the next check looks again
      return { at, round, skipped: `waiting for the batch already sent (${p?.hash})`, pendingAt: p?.sentAt ?? null };
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
 * @param {object} o
 * @param {object} o.db the app's db
 * @param {{evmAddress: string, signDigest: Function}} o.identity
 * @param {string} o.vaultAddress the vault's Base address (from its public key, in clear in the keys record: no Unlock needed)
 * @param {() => object|null} o.vault the unlocked vault signer, or null
 * @param {() => object} o.central the current central client
 * @param {string} [o.defaultRpc] the RPC when none is saved, if the build or the dev server set one (src/config.js)
 * @param {any} [o.transport] a viem transport (tests); else http to the RPC URLs
 * @param {() => void} [o.onTraffic] each RPC request and its answer (Home's glow, src/traffic.js)
 * @param {(result: object) => void} [o.onCheck] each batch check's result (Home's activity log)
 * @param {object} [o.work] what the neuron is doing (src/neuron/work.js): the batch ('base') and the vault's actions say their steps
 */
export function createBase({ db, identity, vaultAddress, vault, central, defaultRpc, transport, forecast = engineForecast,
  now = () => Date.now() / 1000, onChange = () => {}, onCheck = () => {}, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout,
  origin = globalThis.location?.href, onTraffic = () => emit('base'), work = createWork() }) {
  let cache = null; // central's config, 1 h
  let made = null; // { key, chain, rpc }
  let status = null; // the last status read
  let statusError = '';
  let proof = null; // the vault's merkle proof from central: proofState, with { at, url } (asked at most hourly)
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
    const urls = rpcUrls({ config: loaded.config, setting, fixed: defaultRpc });
    const key = JSON.stringify([loaded.config, urls]);
    if (made?.key !== key) {
      const t = traced(transport ?? (urls.length === 1 ? http(resolve(urls[0])) : fallback(urls.map((u) => http(resolve(u))))), onTraffic);
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

  /**
   * The vault's merkle proof, asked again once an hour has gone by (or for another central). An answer that did not
   * come (central down) keeps the last one and is asked again at the next read; a central without the route is unknown.
   */
  async function proofNow() {
    const c = central();
    if (proof?.url === c.url && now() - proof.at < PROOF_TTL_S) return;
    keepProof(c, await askProof(c, vaultAddress));
  }
  function keepProof(c, p) {
    if (p.state === 'unknown' && !p.missing && proof?.url === c.url) return; // central did not answer: keep the last
    proof = { ...p, at: now(), url: c.url };
  }

  async function refresh() {
    try {
      const { chain } = await chainNow();
      [status] = await Promise.all([chain.status({ identity: identity.evmAddress, vault: vaultAddress }), proofNow()]);
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
    const gas = s?.gasPrice ? BATCH_GAS * 2n * s.gasPrice : null; // one transaction's worth, at most
    const batchesLeft = s?.identity.eth != null && gas ? Number(s.identity.eth / gas) : null;
    const c = s?.claimable;
    const drop = c ? dropClaimable(proof, c.minted) : null;
    const parts = [c?.rewards, drop, c?.airdrop].filter((x) => x != null);
    const vd = s?.vault.delegate; // whom the vault's prediction power goes to (predictionDelegateInfo)
    const staked = vd == null ? null : same(vd, identity.evmAddress) ? 'identity' : same(vd, zeroAddress) ? 'none' : 'other';
    const sync = stakeSync({ staked, allowedDelegator: s?.identity.allowedDelegator, vault: vaultAddress, power: s?.identity.power,
      balance: s?.vault.satori });
    return {
      rpc: made?.rpc ?? [], config: made ? (made.fromCentral ? 'central' : 'bundled') : null,
      localFork: !!made?.local, // a path on this site: the dev server's /rpc, a local fork
      explorer: made && !made.local ? made.config.explorerUrl : null, // links tx hashes (not for a local fork)
      error: statusError, errors: s?.errors ?? [],
      round: s?.round ?? null, chainTime: s?.chainTime ?? null,
      identity: {
        address: identity.evmAddress, eth: plainAmount(s?.identity.eth), power: plainAmount(s?.identity.power),
        fee: s?.identity.fee ?? null, allowedStaker: s?.identity.allowedDelegator ?? null,
        batchesLeft, lowEth: batchesLeft != null && batchesLeft < LOW_BATCHES,
      },
      vault: {
        address: vaultAddress, eth: plainAmount(s?.vault.eth), satori: plainAmount(s?.vault.satori),
        stakedWith: vd ?? null,
        staked,
        ...sync, // inSync, shortfall: the stake booked right (stakeSync)
        lock: s?.vault.lock ?? null,
        lowEth: lowOnGas(s?.vault.eth, gas), // under one transaction's gas: Claim says so before it tries
      },
      // the drop: the Satori Network's reward drop not claimed yet (null: this central does not say)
      claimable: { rewards: plainAmount(c?.rewards), drop: plainAmount(drop), airdrop: plainAmount(c?.airdrop),
        total: parts.length ? formatEther(parts.reduce((a, b) => a + b, 0n)) : null },
      lastCheck, nextCheck: schedule.next, checking: schedule.running,
    };
  }

  /** The last batch mined, and one sent and not mined yet (its stuck state: Home's base-stuck). */
  async function withLast(v) {
    return { ...v, lastBatch: (await db.get('base_last_batch')) ?? null, pendingBatch: (await db.get('base_pending_batch')) ?? null };
  }

  // ── the batch's schedule: a check runs the batch if due; one at a time; then the next check is armed ──
  async function check() {
    let result;
    try {
      const { chain } = await chainNow();
      result = await work.run('base', async (report) => runBatch({ chain, identity, db, forecast, maxFeeWei: await maxFeeWei(), now, report }));
    } catch (err) {
      result = { at: null, error: errorText(err) };
    }
    // the contract unused (nothing staked here, no batch ever sent): its RPC's trouble is calm (docs/design/health.md)
    if (result.error && !(status?.identity?.power > 0n) && !(await db.get('base_last_batch'))) result.unused = true;
    lastCheck = result;
    onCheck(result); // Home's activity log
    await refresh();
    return result;
  }
  const schedule = createSchedule(check, {
    now, setTimeout: st, clearTimeout: ct, name: 'base', onChange: changed,
    after: () => nextCheckAt({ now: now(), chainTime: lastCheck?.at ?? status?.chainTime ?? null, pendingAt: lastCheck?.pendingAt ?? null }),
  });

  // ── vault actions (Unlock): each says its steps as work `task` (step(name, k, n)) ──
  async function act(task, fn) {
    const { chain } = await chainNow();
    try {
      return await work.run(task, (step) => fn(chain, step));
    } finally {
      await refresh();
    }
  }
  /** The vault's SATORI can be sent now (the token's transfer lock), else it throws when it can. */
  async function sendable(chain) {
    const lock = (await chain.status({ identity: identity.evmAddress, vault: vaultAddress })).vault.lock;
    if (lock?.locked) throw new Error(`${lockText(lock)}.`);
  }
  /** A vault write's options: the step 'confirm' once it is sent. */
  const sent = (step) => ({ onSent: () => step('confirm') });

  /**
   * The merkle drop: central's proof alone, as Lite (routes.py:1321-1331); its
   * 404 says which case (merkle.py:45-58), and prod, which lacks the route,
   * answers a plain Not Found. What was paid is read back at the claim's
   * block: the lane's reserve may pay only part (SatoriMerkle.sol:196-201).
   */
  async function claimMerkle(chain, v, step) {
    step('drop');
    const c = central();
    const p = await askProof(c, v.evmAddress);
    keepProof(c, p); // asked just now: the card's drop needs no other call
    if (p.state === 'none') return { skipped: `no merkle drop published on ${c.url}` };
    if (p.state === 'not-in') return { skipped: 'this vault is not in the current drop' };
    if (p.state === 'unknown') {
      if (!p.missing) throw p.error;
      return { skipped: `${c.url} serves no merkle drop (${p.error.detail})` };
    }
    const before = await chain.alreadyMinted(v.evmAddress);
    if (p.amountWei <= before) return { skipped: 'already claimed: up to date with the drop' };
    const { hash, receipt } = await chain.claimMerkle(v, { amountWei: p.amountWei.toString(), proof: p.proof }, sent(step));
    const after = await chain.alreadyMinted(v.evmAddress, receipt.blockNumber);
    return { hash, amount: formatEther(after - before) };
  }

  return {
    refresh,
    /** A registry stream's history as the engine reads it (the Models tab's drill-in): [{ ts, value }], oldest first. */
    async history(streamId) {
      const { chain } = await chainNow();
      return toPoints(await chain.history(streamId));
    },
    /** The status, with the settings as stored ('' and null: the defaults) and the max fee in force. */
    async status() {
      const maxFeeSetting = (await db.get('base_max_fee_gwei')) ?? null;
      return { ...(await withLast(view())), rpcSetting: (await db.get('base_rpc_url')) || '', maxFeeSetting,
        maxFeeGwei: maxFeeSetting ?? MAX_FEE_GWEI };
    },

    /**
     * Settings: the RPC (https, a path on this site, or '' for the default)
     * and the batch's max fee (gwei, or '' / null for the default), either or
     * both; each is checked before either is saved. A new RPC is read at once.
     * → status()
     */
    async setSettings({ rpc, maxFee } = {}) {
      const url = rpc === undefined ? undefined : checkRpcSetting(rpc);
      const gwei = maxFee === undefined ? undefined : checkMaxFee(maxFee);
      if (url !== undefined) await db.set('base_rpc_url', url);
      if (gwei !== undefined) await db.set('base_max_fee_gwei', gwei);
      await db.checkpoint();
      if (url !== undefined) await refresh();
      else changed();
      return this.status();
    },

    /**
     * The first check FIRST_CHECK_S after the load, or at once when a batch is due: the identity has power and no
     * batch this round, or one sent before waits for its receipt (docs/design/base.md#when-in-the-round).
     */
    start() {
      schedule.start(now() + FIRST_CHECK_S);
      refresh().then(async () => {
        const last = await db.get('base_last_batch');
        const due = !!(await db.get('base_pending_batch'))
          || (status?.round != null && status.identity.power > 0n && last?.round !== status.round);
        if (due && !schedule.running && schedule.next > now()) await schedule.arm(now());
      }).catch(() => {});
    },
    stop: schedule.stop,
    /** The batch now if due (window.satori.predictBase). */
    predict: schedule.run,
    /** The check now when its time has passed and none runs (the device slept); else null. */
    catchUp: schedule.catchUp,

    /** Stake with this neuron (docs/design/base.md): needs Unlock. Then a batch check soon. */
    async delegate() {
      const v = needVault();
      const r = await act('stake', (chain, step) => chain.delegate({ identity, vault: v, onStep: step }));
      schedule.arm(now() + FIRST_CHECK_S);
      return r;
    },
    /** Unstake (needs Unlock). A stake out of sync underflows (Panic 0x11) in the simulate: said plainly, nothing sent. */
    async undelegate() {
      const v = needVault();
      return act('unstake', async (chain, step) => {
        try {
          return await chain.undelegate({ vault: v, onStep: step });
        } catch (err) {
          if (panicOf(err) === 0x11) throw new Error(`Staking is out of sync. ${OUT_OF_SYNC}`);
          throw err;
        }
      });
    },

    /** hub.claim() (the lens says > 0), the merkle drop (central's proof), the airdrop; each on its own. */
    async claim() {
      const v = needVault();
      return act('claim', async (chain, step) => {
        const st = await chain.status({ identity: identity.evmAddress, vault: v.evmAddress });
        if (lowOnGas(st.vault.eth, st.gasPrice ? BATCH_GAS * 2n * st.gasPrice : null)) throw new Error(NEED_GAS);
        const each = async (fn) => {
          try { return await fn(); } catch (err) { return { error: errorText(err) }; }
        };
        const rewards = await each(async () => {
          const owed = st.claimable.rewards;
          if (!(owed > 0n)) return { skipped: 'nothing to claim on-chain' };
          step('rewards');
          return { hash: (await chain.claimRewards(v, sent(step))).hash, amount: formatEther(owed) };
        });
        const merkle = await each(() => claimMerkle(chain, v, step));
        const airdrop = await each(async () => {
          const owed = st.claimable.airdrop;
          if (!(owed > 0n)) return { skipped: 'no vested airdrop to claim' };
          step('airdrop');
          return { hash: (await chain.claimAirdrop(v, sent(step))).hash, amount: formatEther(owed) };
        });
        return { rewards, merkle, airdrop };
      });
    },

    /**
     * The review before a send (no key needed): the inputs checked, SATORI's transfer lock, and the fee: the gas
     * estimated from the vault's address, `about` at the base fee + the tip, `max` at the gas limit and the max fee
     * (decimal ETH). → { asset, to, amount, fee: { gas, about, max } }
     */
    async quoteSend(o) {
      const { asset, to, amount, wei } = checkSend(o);
      const { chain } = await chainNow();
      if (asset === 'SATORI') await sendable(chain);
      const fee = await chain.sendFee(vaultAddress, { asset, to, wei });
      return { asset, to: getAddress(to), amount, fee: { gas: Number(fee.gas), about: formatEther(fee.about), max: formatEther(fee.max) } };
    },

    /**
     * From the vault: { asset: 'ETH' | 'SATORI', to, amount } (a decimal string). `key`: the vault to send with, as the
     * app opens it from the passphrase for each send (keys' withPassphrase); else the unlocked one. → { hash }
     */
    async send(o, key) {
      const { asset, to, wei } = checkSend(o);
      const v = key ?? needVault();
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
