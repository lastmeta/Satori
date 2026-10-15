// chain module: Base Sepolia via viem. Design: docs/design/chain.md
// Accounts (viem LocalAccount or 0x private key) are injected by the caller;
// nothing here stores a key.
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient,
  http, toHex, zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  airdropAbi, engineAbi, ethBalanceAbi, gamesAbi, hubAbi, merkleAbi, registryAbi, rewardsAbi, tokenAbi,
} from './abi.js';

export { DEFAULTS, loadConfig } from './config.js';

/** Central's earning gate: 250 SATORI on the vault's Base address. */
export const GATE = 250n * 10n ** 18n;
const ROUND_SECONDS = 86400n;
const LOCK_INDEFINITE = 2 ** 24 - 1; // type(uint24).max
const PAGE = 256; // history entries per getHistoryPage call (ring buffer holds 768)

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const toAccount = (a) => (typeof a === 'string' ? privateKeyToAccount(a) : a);

/** A registry history entry as an `observations` row (storage.md). */
export function toObservation(streamId, { hour, value }, receivedAt = Date.now() / 1000) {
  return {
    stream_name: String(streamId), provider_pubkey: 'base', seq_num: hour, observed_at: hour * 3600,
    received_at: receivedAt, value_raw: value.toString(), value: Number(value), round: hour,
  };
}

/**
 * @param {{config: import('./config.js').DEFAULTS, transport?: any, pollingInterval?: number, flipTries?: number}} opts
 */
export function createChain({ config, transport, pollingInterval = 4000, flipTries = 30 }) {
  transport ??= http(config.rpcUrl, { batch: true });
  const client = createPublicClient({ chain: baseSepolia, transport, pollingInterval, batch: { multicall: true } });
  const read = (address, abi, functionName, args) => client.readContract({ address, abi, functionName, args });
  const c = {
    registry: (fn, args) => read(config.registry, registryAbi, fn, args),
    games: (fn, args) => read(config.games, gamesAbi, fn, args),
    engine: (fn, args) => read(config.engine, engineAbi, fn, args),
    rewards: (fn, args) => read(config.rewards, rewardsAbi, fn, args),
    token: (fn, args) => read(config.token, tokenAbi, fn, args),
    merkle: (fn, args) => read(config.merkle, merkleAbi, fn, args),
    airdrop: (fn, args) => read(config.airdrop, airdropAbi, fn, args),
  };

  /** Send from `account` (estimates first, so a reverting call throws before sending); wait for the receipt. */
  async function write(account, address, abi, functionName, args) {
    account = toAccount(account);
    const wallet = createWalletClient({ account, chain: baseSepolia, transport });
    const { request } = await client.simulateContract({ account, address, abi, functionName, args });
    const hash = await wallet.writeContract(request);
    const r = await client.waitForTransactionReceipt({ hash, pollingInterval });
    if (r.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
    return hash;
  }

  /** The load-balanced RPC lags behind a receipt: re-read until `check` holds. */
  async function untilRead(check) {
    for (let i = 0; i < flipTries; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, pollingInterval));
    }
    throw new Error('chain: the write was mined but the read has not caught up');
  }

  const delegateOf = async (addr) => (await c.rewards('predictionDelegateInfo', [addr]))[0];

  async function round() {
    const { timestamp } = await client.getBlock();
    return Number(timestamp / ROUND_SECONDS);
  }

  return {
    client,
    round,

    /** Registry streams that have a binary game: [{streamId, gameId}]. */
    async baseGames() {
      const ids = await c.registry('getAllDataStreams');
      const games = await Promise.all(ids.map((id) => c.games('binaryGameByStream', [id])));
      return ids.map((streamId, i) => ({ streamId, gameId: games[i] })).filter((g) => g.gameId !== 0);
    },

    /** Registry history newer than `sinceHour`, oldest first: [{hour, value: bigint}]. */
    async history(streamId, sinceHour = -1) {
      const byHour = new Map();
      for (let offset = 0; ; offset += PAGE) {
        const [values, hours, total] = await c.registry('getHistoryPage', [streamId, BigInt(offset), BigInt(PAGE)]);
        hours.forEach((hour, i) => { if (hour > sinceHour) byHour.set(hour, values[i]); });
        if (!hours.length || hours[0] <= sinceHour || offset + PAGE >= total) break;
      }
      return [...byHour].sort((a, b) => a[0] - b[0]).map(([hour, value]) => ({ hour, value }));
    },

    /** getLatestUpdateInfo for many streams, one multicall. */
    async latestInfo(streamIds) {
      const rows = await Promise.all(streamIds.map((id) => c.registry('getLatestUpdateInfo', [id])));
      return rows.map(([count, latestHour, lastUpdateTimestamp], i) => ({
        streamId: streamIds[i], count, latestHour: Number(latestHour), lastUpdateTimestamp: Number(lastUpdateTimestamp),
      }));
    },

    /** ETH and SATORI for vault and identity (one multicall), and the 250 gate. */
    async balances({ vault, identity }) {
      const eth = (a) => read(baseSepolia.contracts.multicall3.address, ethBalanceAbi, 'getEthBalance', [a]);
      const [ve, vs, ie, is] = await Promise.all([
        eth(vault), c.token('balanceOf', [vault]), eth(identity), c.token('balanceOf', [identity]),
      ]);
      return { vault: { eth: ve, satori: vs }, identity: { eth: ie, satori: is }, gate: { required: GATE, met: vs >= GATE } };
    },

    async delegationStatus({ vault, identity }) {
      const [[delegate], [, power], identityFee, lockedUntilRound, r] = await Promise.all([
        c.rewards('predictionDelegateInfo', [vault]), c.rewards('predictionDelegateInfo', [identity]),
        c.rewards('effectivePredictorFee', [identity]), c.token('transferLockedUntil', [vault]), round(),
      ]);
      return {
        delegated: same(delegate, identity), delegate, power, identityFee,
        lockedUntilRound, lockedIndefinitely: lockedUntilRound >= LOCK_INDEFINITE, round: r,
      };
    },

    /** Port of ensure_delegation (base_predict.py:296-316). Idempotent. */
    async delegate({ vault, identity }) {
      vault = toAccount(vault);
      identity = toAccount(identity);
      const out = {};
      if (await c.rewards('effectivePredictorFee', [identity.address]) !== 0) {
        out.feeTx = await write(identity, config.rewards, rewardsAbi, 'setPredictorFee', [0]);
        await untilRead(async () => await c.rewards('effectivePredictorFee', [identity.address]) === 0);
      }
      if (!same(await delegateOf(vault.address), identity.address)) {
        out.delegateTx = await write(vault, config.hub, hubAbi, 'delegatePredictionPower', [identity.address]);
        await untilRead(async () => same(await delegateOf(vault.address), identity.address));
      }
      return out;
    },

    /** Vault delegates to 0x0. Idempotent. */
    async revoke(vault) {
      vault = toAccount(vault);
      if (same(await delegateOf(vault.address), zeroAddress)) return {};
      const revokeTx = await write(vault, config.hub, hubAbi, 'delegatePredictionPower', [zeroAddress]);
      await untilRead(async () => same(await delegateOf(vault.address), zeroAddress));
      return { revokeTx };
    },

    /** Due when the identity holds delegated power and this UTC round has no batch from it. */
    async batchDue(identity) {
      const r = await round();
      const [[, power], count] = await Promise.all([
        c.rewards('predictionDelegateInfo', [identity]), c.engine('predictedStreamsCount', [identity, BigInt(r)]),
      ]);
      const reason = power === 0n ? 'no-power' : count !== 0n ? 'submitted' : null;
      return { due: reason === null, round: r, reason };
    },

    /**
     * Simulate each game alone, drop the ones that revert, send the rest as one
     * predictMultipleWithPayloads signed by the identity. `beforeSend(games)`
     * runs just before the send (write base_last_submit_ts there).
     * @param {{gameId: number, direction: 1|2}[]} predictions
     */
    async submitBatch(identity, predictions, { beforeSend } = {}) {
      identity = toAccount(identity);
      const req = (p) => ({ gameId: p.gameId, payload: toHex(new Uint8Array([p.direction])) });
      const results = await Promise.all(predictions.map((p) => client.simulateContract({
        account: identity, address: config.engine, abi: engineAbi,
        functionName: 'predictMultipleWithPayloads', args: [[req(p)]],
      }).then(() => null, revertName)));
      const sent = [];
      const dropped = [];
      predictions.forEach((p, i) => (results[i] === null ? sent.push(p) : dropped.push({ ...p, error: results[i] })));
      const r = await round();
      if (!sent.length) return { hash: null, round: r, sent, dropped };
      await beforeSend?.(sent);
      const wallet = createWalletClient({ account: identity, chain: baseSepolia, transport });
      const hash = await wallet.writeContract({
        address: config.engine, abi: engineAbi, functionName: 'predictMultipleWithPayloads', args: [sent.map(req)],
      });
      return { hash, round: r, sent, dropped };
    },

    /** 'success' | 'reverted' once mined. */
    async receipt(hash) {
      return (await client.waitForTransactionReceipt({ hash, pollingInterval })).status;
    },

    /** @param {{amountWei: string|bigint}} proof from central.merkleProof */
    async merkleStatus(vault, { amountWei }) {
      const entitlement = BigInt(amountWei);
      const alreadyMinted = await c.merkle('alreadyMintedTo', [vault]);
      return { entitlement, alreadyMinted, claimable: entitlement > alreadyMinted ? entitlement - alreadyMinted : 0n };
    },

    claimMerkle: (vault, { amountWei, proof }) =>
      write(vault, config.merkle, merkleAbi, 'claimMerkle', [BigInt(amountWei), proof]),

    async airdropStatus(addr) {
      const [allocation, claimed, claimable] = await Promise.all([
        c.airdrop('airdropAllocation', [addr]), c.airdrop('airdropClaimed', [addr]), c.airdrop('claimableAirdrop', [addr]),
      ]);
      return { allocation, claimed, claimable };
    },

    claimAirdrop: (vault) => write(vault, config.airdrop, airdropAbi, 'claimAirdrop', []),

    /** Vault: simulate hub.claim() from its address (null if it reverts). Identity: its own bucket. */
    async rewardsStatus({ vault, identity }) {
      const [v, i] = await Promise.all([
        client.simulateContract({ account: vault, address: config.hub, abi: hubAbi, functionName: 'claim', args: [] })
          .then((r) => r.result, () => null),
        c.rewards('unclaimedRewards', [identity]),
      ]);
      return { vault: v, identity: i };
    },

    claimRewards: (account) => write(account, config.hub, hubAbi, 'claim', []),
  };
}

/** The custom error name of a reverted simulate, else rethrow (RPC down is not a per-game failure). */
function revertName(e) {
  const rev = e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError);
  if (!rev) throw e;
  return rev.data?.errorName ?? rev.reason ?? rev.signature ?? 'reverted';
}
