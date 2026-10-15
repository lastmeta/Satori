// Base (docs/design/base.md): the D6 contracts over viem, as Satori Lite calls
// them (base_predict.py, base_claim.py) and as the dapp goes further
// (hub.claim, setAllowedDelegator). Keys are injected per call: our signers
// ({ evmAddress, signDigest }, src/keys), viem accounts, or 0x private keys
// (tests and scripts). Nothing here stores a key.
//
//   const chain = createChain({ config, transport })
//   await chain.status({ identity, vault })        // one multicall, no key needed
//   await chain.delegate({ identity, vault }) / chain.undelegate({ vault })
//   await chain.streams() / chain.history(id) / chain.simulateGame(identity, game) / chain.sendBatch(identity, games)
//   await chain.claimRewards(vault) / claimMerkle(vault, proof) / claimAirdrop(vault) / sendEth / sendSatori
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, encodePacked, hexToBytes,
  keccak256, serializeTransaction, zeroAddress,
} from 'viem';
import { privateKeyToAccount, toAccount as customAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  airdropAbi, engineAbi, gamesAbi, hubAbi, lensAbi, merkleAbi, multicall3Abi, registryAbi, rewardsAbi, tokenAbi,
} from './abi.js';

export const ROUND_S = 86400; // a round is a UTC day (SatoriToken.sol:329-331)
export const UP = 1; // base_predict.py:23-24
export const DOWN = 2;
export const INDEFINITE = 2 ** 24 - 1; // transferLockedUntil while delegated (SatoriHub.sol:426-429)
export const HISTORY = 768; // the registry's ring (SatoriRegistry.sol HISTORY_SIZE)
/**
 * Gas over eth_estimateGas on every write. The token runs its transfer hook in
 * a try/catch (SatoriToken.sol:831-842), so the estimate is the least gas at
 * which the hook may fail silently: SATORI minted or sent to a delegated vault
 * then leaves the delegate's power short, and the vault can never undelegate
 * (Panic 0x11, docs/future/issues/token-hook-gas-estimate.md). Unused gas is
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

/** The one-byte payload: solidityPacked(['uint8'], [direction]) (base_predict.py:237). */
export const payload = (direction) => encodePacked(['uint8'], [direction]);

/** Our signer, a viem account, or a 0x private key → a viem account. */
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
    async signTypedData() { throw new Error('Not supported'); },
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

/** An error in a line: the contract's error name, else viem's short message. */
export function errorText(err) {
  const name = revertName(err);
  if (name) return `reverted: ${name}`;
  return String(err?.shortMessage ?? err?.message ?? err).split('\n')[0];
}

/**
 * @param {{config: object, transport: any, pollingInterval?: number, settle?: {tries: number, ms: number}}} opts
 *   settle: re-reads after a write until it shows (Lite: 5 × 1 s, routes.py:1449-1463)
 */
export function createChain({ config, transport, pollingInterval = 1000, settle = { tries: 5, ms: 1000 } }) {
  const chain = { ...baseSepolia, contracts: { ...baseSepolia.contracts, multicall3: { address: config.multicall3 } } };
  const client = createPublicClient({ chain, transport, pollingInterval });
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
  const mc3 = c('multicall3', multicall3Abi);
  const read = (call) => client.readContract(call);
  const many = (contracts) => client.multicall({ contracts, allowFailure: false });

  // One write at a time, for both keys: the batch and a setup step never race for the identity's nonce.
  let tail = Promise.resolve();
  const queued = (fn) => {
    const p = tail.then(fn);
    tail = p.catch(() => {});
    return p;
  };

  /**
   * As satorilib's EvmClient.send (evm.py:60-93): simulate and estimate first
   * (a revert throws, naming the error, before any gas), the limit with
   * HOOK_GAS over the estimate, maxFee = 2 × gasPrice and priority = gasPrice,
   * wait for the receipt, throw unless it succeeded.
   */
  const write = (key, call) => queued(async () => {
    const account = toAccount(key);
    const { request } = await client.simulateContract({ ...call, account });
    const [estimate, gasPrice] = await Promise.all([client.estimateContractGas({ ...call, account }), client.getGasPrice()]);
    const wallet = createWalletClient({ account, chain, transport });
    const hash = await wallet.writeContract({ ...request, gas: estimate + HOOK_GAS, maxFeePerGas: 2n * gasPrice,
      maxPriorityFeePerGas: gasPrice });
    return receiptOf(hash, call.functionName);
  });

  async function receiptOf(hash, what) {
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval });
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

  return {
    config,
    client,

    /**
     * Everything the Base card shows, in one multicall (each read may fail on
     * its own) plus the gas price. `vault` may be null (an old vault.yaml
     * without its public key, before an Unlock).
     */
    async status({ identity, vault }) {
      const calls = [
        ['round', token('getCurrentRound')], ['chainTime', mc3('getCurrentBlockTimestamp')],
        ['identityEth', mc3('getEthBalance', [identity])], ['identityInfo', rewards('predictionDelegateInfo', [identity])],
        ['fee', rewards('effectivePredictorFee', [identity])], ['allowed', hub('allowedDelegator', [identity])],
      ];
      if (vault) {
        calls.push(['vaultEth', mc3('getEthBalance', [vault])], ['satori', token('balanceOf', [vault])],
          ['vaultInfo', rewards('predictionDelegateInfo', [vault])], ['lockedUntil', token('transferLockedUntil', [vault])],
          ['rewards', lens('getTotalClaimableRewards', [vault])], ['airdrop', airdrop('claimableAirdrop', [vault])]);
      }
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
        identity: {
          address: identity, eth: r.identityEth ?? null, delegate: r.identityInfo?.[0] ?? null,
          power: r.identityInfo?.[1] ?? null, fee: r.fee ?? null, allowedDelegator: r.allowed ?? null,
        },
        vault: vault ? {
          address: vault, eth: r.vaultEth ?? null, satori: r.satori ?? null, delegate: r.vaultInfo?.[0] ?? null,
          lockedUntil: r.lockedUntil ?? null,
          lock: r.lockedUntil == null || round == null ? null : transferLock(r.lockedUntil, round),
        } : null,
        claimable: vault ? { rewards: r.rewards?.[0] ?? null, rewardsComplete: r.rewards?.[1] ?? null, airdrop: r.airdrop ?? null } : null,
        errors,
      };
    },

    /**
     * Lite's ensure_delegation (base_predict.py:273-290) and the dapp's setup
     * (GameWalletPanel.tsx:536-595): the identity's fee to 0, the identity
     * accepts only this vault, the vault delegates to the identity. Each step
     * only when needed. → { steps: [{ step, by, hash }], settled }
     */
    async delegate({ identity, vault }) {
      const I = toAccount(identity);
      const V = toAccount(vault);
      const look = () => many([rewards('effectivePredictorFee', [I.address]), hub('allowedDelegator', [I.address]),
        rewards('predictionDelegateInfo', [V.address])]);
      const [fee, allowed, [delegate]] = await look();
      const steps = [];
      const step = async (name, by, key, call) => steps.push({ step: name, by, hash: (await write(key, call)).hash });
      if (fee !== 0) await step('setPredictorFee(0)', 'identity', I, rewards('setPredictorFee', [0]));
      if (!same(allowed, V.address)) await step('setAllowedDelegator(vault)', 'identity', I, hub('setAllowedDelegator', [V.address]));
      if (!same(delegate, I.address)) await step('delegatePredictionPower(identity)', 'vault', V, hub('delegatePredictionPower', [I.address]));
      const ok = !steps.length || await settled(async () => {
        const [f, a, [d]] = await look();
        return f === 0 && same(a, V.address) && same(d, I.address);
      });
      return { steps, settled: ok };
    },

    /** Stop delegating: the vault delegates to 0x0 (base_predict.py:292-301). → { steps, settled } */
    async undelegate({ vault }) {
      const V = toAccount(vault);
      if (same(await delegateOf(V.address), zeroAddress)) return { steps: [], settled: true };
      const { hash } = await write(V, hub('delegatePredictionPower', [zeroAddress]));
      const ok = await settled(async () => same(await delegateOf(V.address), zeroAddress));
      return { steps: [{ step: 'delegatePredictionPower(0x0)', by: 'vault', hash }], settled: ok };
    },

    /** What the batch's due rule reads (start.py:1171-1176): the round, chain time, incoming power, this round's count. */
    async batchState(identity) {
      const [round, chainTime, [, power]] = await many([token('getCurrentRound'), mc3('getCurrentBlockTimestamp'),
        rewards('predictionDelegateInfo', [identity])]);
      const predicted = await read(engine('predictedStreamsCount', [identity, round]));
      return { round: Number(round), chainTime: Number(chainTime), power, predicted: Number(predicted) };
    },

    /**
     * The registry's streams that have a binary game: [{ streamId, gameId,
     * named, cadenceMinutes, latestHour, count }]. isNamedStream reverts for
     * an unknown id on D6: a failure reads as not named (base_predict.py:223-230).
     */
    async streams() {
      const ids = await read(registry('getAllDataStreams'));
      if (!ids.length) return [];
      const res = await client.multicall({ allowFailure: true, contracts: ids.flatMap((id) => [
        games('binaryGameByStream', [id]), registry('isNamedStream', [id]), registry('getLatestUpdateInfo', [id]),
      ]) });
      return ids.map((streamId, i) => {
        const [game, named, info] = res.slice(3 * i, 3 * i + 3);
        const [count, latestHour, , cadenceMinutes] = info.status === 'success' ? info.result : [0, 0n, 0n, 0];
        return {
          streamId, gameId: game.status === 'success' ? game.result : 0, named: named.status === 'success' && named.result,
          cadenceMinutes, latestHour: Number(latestHour), count,
        };
      }).filter((g) => g.gameId !== 0);
    },

    /** A stream's history, oldest first: [{ hour, value: bigint }] (the whole ring, SatoriRegistry.sol:1375-1393). */
    async history(streamId) {
      const [values, hours] = await read(registry('getHistoryPage', [streamId, 0n, BigInt(HISTORY)]));
      return hours.map((hour, i) => ({ hour, value: values[i] }));
    },

    /** One game alone, from the identity, without sending: null when it would pass, else the revert's name. RPC errors throw. */
    async simulateGame(identity, { gameId, direction }) {
      try {
        await client.simulateContract({ ...engine('predictMultipleWithPayloads', [[{ gameId, payload: payload(direction) }]]),
          account: addressOf(identity) });
        return null;
      } catch (err) {
        const name = revertName(err);
        if (name === null) throw err;
        return name;
      }
    },

    /** The day's batch from the identity. → { hash, at (the block's time), blockNumber } */
    async sendBatch(identity, list) {
      const { hash, receipt } = await write(identity,
        engine('predictMultipleWithPayloads', [list.map((g) => ({ gameId: g.gameId, payload: payload(g.direction) }))]));
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      return { hash, at: Number(block.timestamp), blockNumber: Number(receipt.blockNumber) };
    },

    /** On-chain rewards: hub.claim() from the vault (the dapp, useDashboard.ts:288-311). */
    claimRewards: (vault) => write(vault, hub('claim')),
    alreadyMinted: (addr) => read(merkle('alreadyMintedTo', [addr])),
    /** claimMerkle(lifetimeEntitlement, proof) from the vault (base_claim.py:99-104). */
    claimMerkle: (vault, { amountWei, proof }) => write(vault, merkle('claimMerkle', [BigInt(amountWei), proof])),
    claimAirdrop: (vault) => write(vault, airdrop('claimAirdrop')),

    /** SATORI from the vault (the token refuses while transfer-locked: the simulate says Locked). */
    sendSatori: (vault, to, amount) => write(vault, token('transfer', [to, amount])),
    /** ETH from the vault: estimated first (a failure throws before sending), then as any write. */
    sendEth: (vault, to, value) => queued(async () => {
      const account = toAccount(vault);
      await client.estimateGas({ account, to, value });
      const gasPrice = await client.getGasPrice();
      const wallet = createWalletClient({ account, chain, transport });
      const hash = await wallet.sendTransaction({ to, value, maxFeePerGas: 2n * gasPrice, maxPriorityFeePerGas: gasPrice });
      return receiptOf(hash, 'transfer');
    }),
  };
}
