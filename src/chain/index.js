// Base (docs/design/base.md): the D7 contracts over viem, as Satori Lite calls
// them (base_predict.py, base_claim.py) and as the dapp goes further
// (hub.claim, setAllowedDelegator). Keys are injected per call: our signers
// ({ evmAddress, signDigest }, src/keys), viem accounts, or 0x private keys
// (tests and scripts). Nothing here stores a key.
//
//   const chain = createChain({ config, transport })
//   await chain.status({ alias, wallet })        // one multicall, no key needed
//   await chain.delegate({ alias, wallet }) / chain.undelegate({ wallet })
//   await chain.streams() / chain.history(id) / chain.simulateGame(alias, game) / chain.sendBatch(alias, games)
//   await chain.claimRewards(wallet) / claimMerkle(wallet, proof) / claimAirdrop(wallet) / sendEth / sendSatori
//   createChannels({ chain, config })              // payment channels on this chain (channels.js)
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, encodePacked, formatGwei, hashTypedData,
  hexToBytes, keccak256, serializeSignature, serializeTransaction, zeroAddress, WaitForTransactionReceiptTimeoutError,
} from 'viem';
import { privateKeyToAccount, toAccount as customAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  airdropAbi, engineAbi, gamesAbi, hubAbi, lensAbi, merkleAbi, multicall3Abi, registryAbi, rewardsAbi, tokenAbi, votingAbi,
} from './abi.js';
import { serial } from '../util.js';

export const ROUND_S = 86400; // a round is a UTC day (SatoriToken.sol:329-331)
export const UP = 1; // base_predict.py:23-24
export const DOWN = 2;
export const INDEFINITE = 2 ** 24 - 1; // transferLockedUntil while staked (SatoriHub.sol:426-429)
export const HISTORY = 768; // the registry's ring (SatoriRegistry.sol HISTORY_SIZE)
/**
 * Gas over eth_estimateGas on every write. The token runs its transfer hook in
 * a try/catch (SatoriToken.sol:831-842), so the estimate is the least gas at
 * which the hook may fail silently: SATORI minted or sent to a staked wallet
 * then leaves the alias's power short, and the wallet can never unstake
 * (Panic 0x11, docs/issues/token-hook-gas-estimate.md). Unused gas is
 * not charged.
 */
export const HOOK_GAS = 500_000n;

export const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * The token's transfer rule (SatoriToken.sol:816-821): blocked while
 * `lockedUntil != 0 && lockedUntil >= round`. Free from round lockedUntil + 1,
 * at its 00:00 UTC. (Lite's stake_status uses `>`, one round early.)
 */
export function transferLock(lockedUntil, round) {
  const locked = lockedUntil !== 0 && lockedUntil >= round;
  const indefinite = lockedUntil >= INDEFINITE;
  return {
    locked,
    indefinite: locked && indefinite,
    untilRound: locked && !indefinite ? lockedUntil : null,
    freeAt: locked && !indefinite ? (lockedUntil + 1) * ROUND_S : null,
  };
}

/** Unix seconds → 'Oct 17, 00:00 UTC' (rounds start at 00:00 UTC). */
export function fmtUtc(s) {
  return `${new Date(s * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZone: 'UTC' })} UTC`;
}

/**
 * Whether the wallet's SATORI can be sent (the token's rule: not while lockedUntil >= round): never while staked; after
 * Unstake, from the round after lockedUntil, at its 00:00 UTC.
 */
export function lockText(lock) {
  if (!lock) return '–';
  if (!lock.locked) return 'Free to send';
  if (lock.indefinite) return "Staked SATORI can't be sent until you unstake";
  return `SATORI can be sent from ${fmtUtc(lock.freeAt)} (round ${lock.untilRound + 1})`;
}

/** The one-byte payload: solidityPacked(['uint8'], [direction]) (base_predict.py:237). */
export const payload = (direction) => encodePacked(['uint8'], [direction]);

/**
 * Our signer, a viem account, or a 0x private key → a viem account. Our signer signs transactions and EIP-712 typed
 * data (a channel's vouchers, a token's permit: channels.js) by its digest, inside the signer.
 */
export function toAccount(key) {
  if (typeof key === 'string') return privateKeyToAccount(key);
  if (key?.signTransaction) return key;
  if (!key?.signDigest) throw new Error('No key to sign with');
  return customAccount({
    address: key.evmAddress,
    async signTransaction(tx, { serializer = serializeTransaction } = {}) {
      const signable = tx.type === 'eip4844' ? { ...tx, sidecars: false } : tx;
      return serializer(tx, key.signDigest(hexToBytes(keccak256(serializer(signable)))));
    },
    async signMessage() { throw new Error('Not supported'); },
    async signTypedData(typedData) { return serializeSignature(key.signDigest(hexToBytes(hashTypedData(typedData)))); },
  });
}
const addressOf = (key) => (typeof key === 'string' && key.length === 42 ? key : toAccount(key).address);

/**
 * A simulate's or a send's custom error name ('reverted' for a bare revert);
 * null when it is not a revert. viem also reads a node's internal error
 * (-32603) as a revert with only a message: one with neither revert data nor
 * "revert" in its message is the RPC failing, not the contract (as the dapp's
 * isTransient, satori-ui/src/utils/rpcProvider.ts:45-71).
 */
export function revertName(err) {
  const rev = err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!rev) return null;
  if (rev.data?.errorName) return rev.data.errorName;
  return rev.raw !== undefined || /revert/i.test(rev.reason ?? '') ? 'reverted' : null;
}

/** A Solidity panic's code (0x11: an arithmetic underflow or overflow), or null when it is not a panic. */
export function panicOf(err) {
  const rev = err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError);
  return rev?.data?.errorName === 'Panic' ? Number(rev.data.args?.[0]) : null;
}

/**
 * The max fee per gas over the ceiling (Settings' max fee): refused before anything is sent, for every transaction,
 * the wallet's and the alias's (the security review, 2026-10-19: an RPC quoting a huge tip must not be paid).
 */
export class FeeCeilingError extends Error {
  constructor(maxFeePerGas, ceiling) {
    super(`Gas is above the max fee: ${formatGwei(maxFeePerGas)} gwei > ${formatGwei(ceiling)} gwei. `
      + 'Try again later, or raise the max fee in Settings › Satori contract.');
    this.name = 'FeeCeilingError'; // no bigint fields: an error crossing to an agent's page.evaluate must serialize
  }
}

/** Contract errors said in plain words. */
const PLAIN = {
  HookFailedWithoutReason: 'The transaction ran out of gas; try again', // a starved transfer (D7)
};

/** An error in a line: the contract's error name (or its plain words), else viem's short message. */
export function errorText(err) {
  const name = revertName(err);
  if (name) return PLAIN[name] ?? `reverted: ${name}`;
  return String(err?.shortMessage ?? err?.message ?? err).split('\n')[0];
}

/**
 * @param {{config: object, transport: any, pollingInterval?: number, settle?: {tries: number, ms: number},
 *   maxFee?: () => Promise<bigint|null>}} opts
 *   settle: re-reads after a write until it shows (Lite: 5 × 1 s, routes.py:1449-1463);
 *   maxFee: the ceiling on every transaction's max fee per gas, in wei (Settings), asked at each write (none: no check)
 */
export function createChain({ config, transport, pollingInterval = 1000, settle = { tries: 5, ms: 1000 }, maxFee = async () => null }) {
  const chain = { ...baseSepolia, contracts: { ...baseSepolia.contracts, multicall3: { address: config.multicall3 } } };
  // ccipRead off: a contract's revert must never make the page fetch a URL it names (EIP-3668 off-chain lookups)
  const client = createPublicClient({ chain, transport, pollingInterval, ccipRead: false });
  const c = (name, abi) => (functionName, args = []) => ({ address: config[name], abi, functionName, args });
  const engine = c('engine', engineAbi);
  const games = c('games', gamesAbi);
  const registry = c('registry', registryAbi);
  const hub = c('hub', hubAbi);
  const rewards = c('rewards', rewardsAbi);
  const lens = c('lens', lensAbi);
  const token = c('token', tokenAbi);
  const merkle = c('merkle', merkleAbi);
  const airdrop = c('airdrop', airdropAbi);
  const voting = c('voting', votingAbi);
  const mc3 = c('multicall3', multicall3Abi);
  const read = (call) => client.readContract(call);
  const many = (contracts) => client.multicall({ contracts, allowFailure: false });

  // One write at a time, for both keys: the batch and a setup step never race for the alias's nonce.
  const queued = serial();
  const batchCall = (list) => engine('predictMultipleWithPayloads', [list.map((g) => ({ gameId: g.gameId, payload: payload(g.direction) }))]);

  /**
   * EIP-1559 fees: the tip the node suggests (eth_maxPriorityFeePerGas) and a
   * max fee of 2 × the latest base fee + the tip (Lite's 2× margin,
   * evm.py:74-75, on the base fee rather than the gas price).
   */
  async function fees() {
    const [block, tip] = await Promise.all([client.getBlock(), client.estimateMaxPriorityFeePerGas()]);
    return { maxFeePerGas: 2n * (block.baseFeePerGas ?? 0n) + tip, maxPriorityFeePerGas: tip };
  }
  /** `fee`, if its max fee per gas is within the ceiling; else FeeCeilingError. */
  async function capped(fee) {
    const ceiling = await maxFee();
    if (ceiling != null && fee.maxFeePerGas > ceiling) throw new FeeCeilingError(fee.maxFeePerGas, ceiling);
    return fee;
  }

  /**
   * As satorilib's EvmClient.send (evm.py:60-93): simulate and estimate first
   * (a revert throws, naming the error, before any gas), the limit with
   * HOOK_GAS over the estimate (or `pad`: more for a call that pays many), the fees within the ceiling (maxFee), send at the
   * account's next nonce (onSent(hash, { nonce, gas, maxFeePerGas,
   * maxPriorityFeePerGas }) at once: the batch keeps them to replace it if it
   * never mines), wait for the receipt (`timeout` ms, viem's 3 min by default),
   * throw unless it succeeded.
   */
  const write = (key, call, { fees: given, onSent, timeout, pad = HOOK_GAS } = {}) => queued(async () => {
    const account = toAccount(key);
    const { request } = await client.simulateContract({ ...call, account });
    const [estimate, fee, nonce] = await Promise.all([client.estimateContractGas({ ...call, account }), (given ? Promise.resolve(given) : fees()).then(capped),
      client.getTransactionCount({ address: account.address, blockTag: 'pending' })]);
    const writer = createWalletClient({ account, chain, transport });
    const gas = estimate + pad;
    const hash = await writer.writeContract({ ...request, gas, nonce, ...fee });
    await onSent?.(hash, { nonce, gas, ...fee });
    return receiptOf(hash, call.functionName, timeout);
  });

  async function receiptOf(hash, what, timeout) {
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval, ...(timeout ? { timeout } : {}) });
    if (receipt.status !== 'success') throw new Error(`${what} failed on-chain (${hash})`);
    return { hash, receipt };
  }

  /** The RPC is load-balanced and lags a block or two: re-read until `check` holds, then trust the receipt. */
  async function settled(check) {
    for (let i = 0; i < settle.tries; i++) {
      try { if (await check()) return true; } catch { /* a lagging or failing read: try again */ }
      if (i < settle.tries - 1) await new Promise((r) => setTimeout(r, settle.ms));
    }
    return false;
  }

  const delegateOf = async (addr) => (await read(rewards('predictionDelegateInfo', [addr])))[0];
  const minedOf = async (r) => {
    const block = await client.getBlock({ blockNumber: r.blockNumber });
    return { status: r.status, at: Number(block.timestamp), blockNumber: Number(r.blockNumber), hash: r.transactionHash };
  };

  return {
    fees,
    // For modules on this chain (channels.js): its public client, and the write every contract call here goes
    // through (simulate, the pad, the max fee, one at a time with the rest, the receipt).
    client,
    write,
    /** What the RPC says it is (the app refuses a chain other than the config's). */
    chainId: () => client.getChainId(),

    /** A sent tx's { status, at (its block's time), blockNumber, hash }, or null if it is not mined within `timeout` ms. */
    async receipt(hash, { timeout = 60_000 } = {}) {
      let r;
      try {
        r = await client.waitForTransactionReceipt({ hash, pollingInterval, timeout });
      } catch (err) {
        if (err instanceof WaitForTransactionReceiptTimeoutError) return null;
        throw err;
      }
      return minedOf(r);
    },

    /**
     * The one of `hashes` (a batch and its replacements, all at one nonce) that was mined, as receipt() says it: each
     * looked up at once, then the latest waited for up to `timeout` ms; null when none is.
     */
    async minedAny(hashes, { timeout = 60_000 } = {}) {
      for (const hash of hashes) {
        const r = await client.getTransactionReceipt({ hash }).catch(() => null);
        if (r) return minedOf(r);
      }
      return this.receipt(hashes.at(-1), { timeout });
    },

    /** How many transactions `address` has had mined ('latest'), or sent ('pending'): the next nonce. */
    nonce: (address, blockTag = 'latest') => client.getTransactionCount({ address, blockTag }),

    /**
     * Everything the Base card shows, in one multicall (each read may fail on
     * its own) plus the gas price.
     */
    async status({ alias, wallet }) {
      const calls = [
        ['round', token('getCurrentRound')], ['chainTime', mc3('getCurrentBlockTimestamp')],
        ['aliasEth', mc3('getEthBalance', [alias])], ['aliasInfo', rewards('predictionDelegateInfo', [alias])],
        ['fee', rewards('effectivePredictorFee', [alias])], ['allowed', hub('allowedDelegator', [alias])],
        ['walletEth', mc3('getEthBalance', [wallet])], ['satori', token('balanceOf', [wallet])],
        ['walletInfo', rewards('predictionDelegateInfo', [wallet])], ['referral', rewards('referral', [wallet])], ['lockedUntil', token('transferLockedUntil', [wallet])],
        ['rewards', lens('getTotalClaimableRewards', [wallet])], ['airdrop', airdrop('claimableAirdrop', [wallet])],
        ['minted', merkle('alreadyMintedTo', [wallet])], // the reward drop paid so far: central's proof says the entitlement
      ];
      const [results, gasPrice] = await Promise.all([
        client.multicall({ contracts: calls.map(([, call]) => call), allowFailure: true }),
        client.getGasPrice().catch(() => null),
      ]);
      const r = {};
      const errors = [];
      calls.forEach(([name], i) => {
        if (results[i].status === 'success') r[name] = results[i].result;
        else errors.push(`${name}: ${errorText(results[i].error)}`);
      });
      const round = r.round == null ? null : Number(r.round);
      return {
        round,
        chainTime: r.chainTime == null ? null : Number(r.chainTime),
        gasPrice,
        alias: {
          address: alias, eth: r.aliasEth ?? null, delegate: r.aliasInfo?.[0] ?? null,
          power: r.aliasInfo?.[1] ?? null, fee: r.fee ?? null, allowedDelegator: r.allowed ?? null,
        },
        wallet: {
          address: wallet, eth: r.walletEth ?? null, satori: r.satori ?? null, delegate: r.walletInfo?.[0] ?? null,
          lockedUntil: r.lockedUntil ?? null, referral: r.referral ?? null,
          lock: r.lockedUntil == null || round == null ? null : transferLock(r.lockedUntil, round),
        },
        claimable: { rewards: r.rewards?.[0] ?? null, rewardsComplete: r.rewards?.[1] ?? null, airdrop: r.airdrop ?? null,
          minted: r.minted ?? null },
        errors,
      };
    },

    /**
     * Stake: Lite's ensure_delegation (base_predict.py:273-290) and the dapp's setup
     * (GameWalletPanel.tsx:536-595): the alias's fee to 0, the alias
     * accepts only this wallet, the wallet's delegatePredictionPower(alias). Each step
     * only when needed. onStep('send' | 'confirm', k, n) for each, then onStep('settle').
     * A `referrer` (the invite link's) is registered first, by the wallet, when it has none (set once, never the wallet
     * itself: the contract refuses both), so a failure leaves nothing staked.
     * → { steps: [{ step, by, hash }], settled }
     */
    async delegate({ alias, wallet, referrer = null, onStep = () => {} }) {
      const I = toAccount(alias);
      const V = toAccount(wallet);
      const look = () => many([rewards('effectivePredictorFee', [I.address]), hub('allowedDelegator', [I.address]),
        rewards('predictionDelegateInfo', [V.address]), rewards('referral', [V.address])]);
      const [fee, allowed, [delegate], referral] = await look();
      const todo = [
        referrer && !same(referrer, V.address) && same(referral, zeroAddress) && ['setReferral(referrer)', 'wallet', V, rewards('setReferral', [referrer])],
        fee !== 0 && ['setPredictorFee(0)', 'alias', I, rewards('setPredictorFee', [0])],
        !same(allowed, V.address) && ['setAllowedDelegator(wallet)', 'alias', I, hub('setAllowedDelegator', [V.address])],
        !same(delegate, I.address) && ['delegatePredictionPower(alias)', 'wallet', V, hub('delegatePredictionPower', [I.address])],
      ].filter(Boolean);
      const steps = [];
      for (const [i, [name, by, key, call]] of todo.entries()) {
        onStep('send', i + 1, todo.length);
        steps.push({ step: name, by, hash: (await write(key, call, { onSent: () => onStep('confirm', i + 1, todo.length) })).hash });
      }
      if (steps.length) onStep('settle');
      const ok = !steps.length || await settled(async () => {
        const [f, a, [d]] = await look();
        return f === 0 && same(a, V.address) && same(d, I.address);
      });
      return { steps, settled: ok };
    },

    /** Unstake: the wallet's delegatePredictionPower(0x0) (base_predict.py:292-301); onStep as above. → { steps, settled } */
    async undelegate({ wallet, onStep = () => {} }) {
      const V = toAccount(wallet);
      if (same(await delegateOf(V.address), zeroAddress)) return { steps: [], settled: true };
      onStep('send', 1, 1);
      const { hash } = await write(V, hub('delegatePredictionPower', [zeroAddress]), { onSent: () => onStep('confirm', 1, 1) });
      onStep('settle');
      const ok = await settled(async () => same(await delegateOf(V.address), zeroAddress));
      return { steps: [{ step: 'delegatePredictionPower(0x0)', by: 'wallet', hash }], settled: ok };
    },

    /** What the batch's due rule reads (start.py:1171-1176): the round, chain time, incoming power, this round's count. */
    async batchState(alias) {
      const [round, chainTime, [, power]] = await many([token('getCurrentRound'), mc3('getCurrentBlockTimestamp'),
        rewards('predictionDelegateInfo', [alias])]);
      const predicted = await read(engine('predictedStreamsCount', [alias, round]));
      return { round: Number(round), chainTime: Number(chainTime), power, predicted: Number(predicted) };
    },

    /**
     * The registry's streams whose binary game the engine pays: [{ streamId,
     * gameId, named, cadenceMinutes, latestHour, count, weight }]. Anyone can
     * add a stream (and its game) for a small burn, so only games with voting
     * weight > 0 are kept, the engine's own eligibility test
     * (SatoriEngine.sol:828: an unweighted game earns no SATORI). isNamedStream
     * reverts for an unknown id: a failure reads as not named
     * (base_predict.py:223-230). Two multicalls: the games, then their weights.
     */
    async streams() {
      const ids = await read(registry('getAllDataStreams'));
      if (!ids.length) return [];
      const res = await client.multicall({ allowFailure: true, contracts: ids.flatMap((id) => [
        games('binaryGameByStream', [id]), registry('isNamedStream', [id]), registry('getLatestUpdateInfo', [id]),
      ]) });
      const list = ids.map((streamId, i) => {
        const [game, named, info] = res.slice(3 * i, 3 * i + 3);
        const [count, latestHour, , cadenceMinutes] = info.status === 'success' ? info.result : [0, 0n, 0n, 0];
        return {
          streamId, gameId: game.status === 'success' ? game.result : 0, named: named.status === 'success' && named.result,
          cadenceMinutes, latestHour: Number(latestHour), count,
        };
      }).filter((g) => g.gameId !== 0);
      if (!list.length) return [];
      const weights = await many(list.map((g) => voting('weightOf', [g.gameId])));
      return list.map((g, i) => ({ ...g, weight: weights[i] })).filter((g) => g.weight > 0n);
    },

    /** A stream's history, oldest first: [{ hour, value: bigint }] (the whole ring, SatoriRegistry.sol:1375-1393). */
    async history(streamId) {
      const [values, hours] = await read(registry('getHistoryPage', [streamId, 0n, BigInt(HISTORY)]));
      return hours.map((hour, i) => ({ hour, value: values[i] }));
    },

    /** One game alone, from the alias, without sending: null when it would pass, else the revert's name. RPC errors throw. */
    async simulateGame(alias, { gameId, direction }) {
      try {
        await client.simulateContract({ ...engine('predictMultipleWithPayloads', [[{ gameId, payload: payload(direction) }]]),
          account: addressOf(alias) });
        return null;
      } catch (err) {
        const name = revertName(err);
        if (name === null) throw err;
        return name;
      }
    },

    /**
     * The day's batch from the alias; onSent(hash, { nonce, gas, fees }) as soon as it is sent, `fees` as given
     * (the batch checks them against its ceiling), `timeout` for its receipt.
     * → { hash, at (the block's time), blockNumber }
     */
    async sendBatch(alias, list, opts = {}) {
      const { hash, receipt } = await write(alias, batchCall(list), opts);
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      return { hash, at: Number(block.timestamp), blockNumber: Number(receipt.blockNumber) };
    },

    /**
     * A batch sent again in place of one that does not mine: the same games at the same nonce, gas limit and the
     * given (higher) fees; no simulate (the first is still pending) and no wait (the next check looks). → its hash
     */
    replaceBatch: (alias, list, { nonce, gas, fees: fee }) => queued(async () => {
      const account = toAccount(alias);
      const writer = createWalletClient({ account, chain, transport });
      return writer.writeContract({ ...batchCall(list), account, chain, nonce, gas, ...await capped(fee) });
    }),

    // the wallet's writes below: opts.onSent(hash) once sent, before the receipt (Home's "Waiting for Base to confirm…")
    /** On-chain rewards: hub.claim() from the wallet (the dapp, useDashboard.ts:288-311). */
    claimRewards: (wallet, opts) => write(wallet, hub('claim'), opts),
    /** What the merkle lane has paid `addr` (at `blockNumber`, else now). */
    alreadyMinted: (addr, blockNumber) => client.readContract({ ...merkle('alreadyMintedTo', [addr]), ...(blockNumber ? { blockNumber } : {}) }),
    /** claimMerkle(lifetimeEntitlement, proof) from the wallet (base_claim.py:99-104). */
    claimMerkle: (wallet, { amountWei, proof }, opts) => write(wallet, merkle('claimMerkle', [BigInt(amountWei), proof]), opts),
    claimAirdrop: (wallet, opts) => write(wallet, airdrop('claimAirdrop'), opts),

    /**
     * A send's fee before it is sent, from the sender's address (no key): the gas limit it would be sent with (ETH:
     * the estimate; SATORI: the estimate + HOOK_GAS), `about` = the estimate at the latest base fee + the tip, `max`
     * = the limit at the max fee (2 × the base fee + the tip). Wei. An estimate that reverts (too little, a transfer
     * lock) throws, and so does a max fee over the ceiling (FeeCeilingError: the send would be refused).
     */
    async sendFee(from, { asset, to, wei }) {
      const [estimate, block, tip] = await Promise.all([
        asset === 'ETH' ? client.estimateGas({ account: from, to, value: wei })
          : client.estimateContractGas({ ...token('transfer', [to, wei]), account: from }),
        client.getBlock(), client.estimateMaxPriorityFeePerGas()]);
      const base = block.baseFeePerGas ?? 0n;
      const gas = asset === 'ETH' ? estimate : estimate + HOOK_GAS;
      await capped({ maxFeePerGas: 2n * base + tip, maxPriorityFeePerGas: tip });
      return { gas, about: estimate * (base + tip), max: gas * (2n * base + tip) };
    },

    /** SATORI from the wallet (the token refuses while transfer-locked: the simulate says Locked). */
    sendSatori: (wallet, to, amount, opts) => write(wallet, token('transfer', [to, amount]), opts),
    /** ETH from the wallet: estimated first (a failure throws before sending); a plain transfer runs no hook, so no pad. */
    sendEth: (wallet, to, value, { onSent } = {}) => queued(async () => {
      const account = toAccount(wallet);
      const [gas, fee] = await Promise.all([client.estimateGas({ account, to, value }), fees().then(capped)]);
      const writer = createWalletClient({ account, chain, transport });
      const hash = await writer.sendTransaction({ to, value, gas, ...fee });
      await onSent?.(hash);
      return receiptOf(hash, 'transfer');
    }),
  };
}
