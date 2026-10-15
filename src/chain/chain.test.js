// The chain module (docs/design/base.md) against test/fake-satori.js: viem over a
// custom transport to a small stateful D6. Keys are our signers (src/keys),
// so every transaction here is signed the way the app signs it.
import { beforeEach, describe, expect, test } from 'vitest';
import { zeroAddress } from 'viem';
import { publicKeys, evmAddress, signDigest } from '../keys/keys.js';
import { DEFAULTS } from './config.js';
import { fakeSatori, E18 } from '../../test/fake-satori.js';

import { createChain, transferLock, payload, revertName, errorText, UP, DOWN, HOOK_GAS, INDEFINITE } from './index.js';

const signerOf = (hex) => {
  const secret = Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
  return { evmAddress: evmAddress(publicKeys(secret).pubkey), signDigest: (h) => signDigest(secret, h) };
};
const identity = signerOf('11'.repeat(32));
const vault = signerOf('22'.repeat(32));
const I = identity.evmAddress.toLowerCase();
const V = vault.evmAddress.toLowerCase();
const ROUND = 20741;

let s, rpc, chain;
beforeEach(() => {
  ({ s, rpc } = fakeSatori({ round: ROUND, hour: 9, eth: { [I]: 10n ** 16n, [V]: 10n ** 16n } }));
  s.balance[V] = 100n * E18;
  chain = createChain({ config: DEFAULTS, transport: rpc.transport, pollingInterval: 1, settle: { tries: 5, ms: 1 } });
});
const sentBy = () => rpc.sent.map((t) => [t.from === I ? 'identity' : t.from === V ? 'vault' : t.from, t.functionName, t.args]);

describe('the transfer lock: blocked while lockedUntil >= round (SatoriToken.sol:816-821)', () => {
  test('free, while delegated, after stopping (through the next round), then free', () => {
    expect(transferLock(0, ROUND)).toEqual({ locked: false, indefinite: false, untilRound: null, freeAt: null });
    expect(transferLock(INDEFINITE, ROUND)).toEqual({ locked: true, indefinite: true, untilRound: null, freeAt: null });
    expect(transferLock(ROUND + 1, ROUND)).toEqual({ locked: true, indefinite: false, untilRound: ROUND + 1, freeAt: (ROUND + 2) * 86400 });
    expect(transferLock(ROUND + 1, ROUND + 1).locked).toBe(true); // Lite's `>` shows this round as free: it is not
    expect(transferLock(ROUND + 1, ROUND + 2).locked).toBe(false);
  });
});

describe('status: one multicall', () => {
  test('balances, delegation, fee, the lock, the round, claimables', async () => {
    s.rewards[V] = 3n * E18;
    s.airdrop[V] = 7n * E18;
    const before = rpc.log.length;
    const st = await chain.status({ identity: identity.evmAddress, vault: vault.evmAddress });
    expect(rpc.log.slice(before).filter((m) => m === 'eth_call')).toHaveLength(1);
    expect(st).toMatchObject({
      round: ROUND, chainTime: ROUND * 86400 + 9 * 3600, gasPrice: 1_000_000n,
      identity: { eth: 10n ** 16n, delegate: zeroAddress, power: 0n, fee: 1000, allowedDelegator: zeroAddress },
      vault: { eth: 10n ** 16n, satori: 100n * E18, delegate: zeroAddress, lockedUntil: 0, lock: { locked: false } },
      claimable: { rewards: 3n * E18, rewardsComplete: true, airdrop: 7n * E18 },
      errors: [],
    });
  });
});

describe('delegate prediction power (Lite\'s Enable staking + the dapp\'s instant signing)', () => {
  test('fee → 0 and allowedDelegator → vault (identity), then the vault delegates; the reads show it', async () => {
    const r = await chain.delegate({ identity, vault });
    expect(sentBy()).toEqual([
      ['identity', 'setPredictorFee', [0]],
      ['identity', 'setAllowedDelegator', [vault.evmAddress]],
      ['vault', 'delegatePredictionPower', [identity.evmAddress]],
    ]);
    expect(r).toEqual({ settled: true, steps: rpc.sent.map((t, i) => ({ ...r.steps[i], hash: t.hash })) });
    const st = await chain.status({ identity: identity.evmAddress, vault: vault.evmAddress });
    expect(st.identity).toMatchObject({ fee: 0, power: 100n * E18, allowedDelegator: vault.evmAddress });
    expect(st.vault).toMatchObject({ delegate: identity.evmAddress, lockedUntil: INDEFINITE, lock: { locked: true, indefinite: true } });
  });
  test('only the missing steps: nothing at all when in place', async () => {
    s.feeStored[I] = 1000; // fee already 0
    await chain.delegate({ identity, vault });
    expect(sentBy().map((x) => x[1])).toEqual(['setAllowedDelegator', 'delegatePredictionPower']);
    expect(await chain.delegate({ identity, vault })).toEqual({ steps: [], settled: true });
    expect(rpc.sent).toHaveLength(2);
  });
  test('a fee set once to something else: the simulate says AlreadySet, nothing is sent', async () => {
    s.feeStored[I] = 500;
    const err = await chain.delegate({ identity, vault }).catch((e) => e);
    expect(revertName(err)).toBe('AlreadySet');
    expect(errorText(err)).toBe('reverted: AlreadySet');
    expect(rpc.sent).toHaveLength(0);
  });
  test('a lagging read after the receipt: re-read 5 × (Lite), then trust the receipt', async () => {
    let lag = 99;
    const real = s.delegateOf;
    s.delegateOf = new Proxy(real, { get: (t, k) => (k === V && lag-- > 0 ? undefined : t[k]) });
    const r = await chain.delegate({ identity, vault });
    expect(r.settled).toBe(false);
    expect(rpc.sent).toHaveLength(3);
  });
  test('stop: the vault delegates to 0x0; SATORI is transfer-locked through the next round', async () => {
    await chain.delegate({ identity, vault });
    const r = await chain.undelegate({ vault });
    expect(sentBy().at(-1)).toEqual(['vault', 'delegatePredictionPower', [zeroAddress]]);
    expect(r).toMatchObject({ settled: true, steps: [{ step: 'delegatePredictionPower(0x0)', by: 'vault' }] });
    const st = await chain.status({ identity: identity.evmAddress, vault: vault.evmAddress });
    expect(st.vault.lock).toEqual({ locked: true, indefinite: false, untilRound: ROUND + 1, freeAt: (ROUND + 2) * 86400 });
    expect(st.identity.power).toBe(0n);
    expect(await chain.undelegate({ vault })).toEqual({ steps: [], settled: true });
  });
  test('accounts as 0x private keys too (scripts, the fork test)', async () => {
    await chain.delegate({ identity: '0x' + '11'.repeat(32), vault: '0x' + '22'.repeat(32) });
    expect(rpc.sent.map((t) => t.from)).toEqual([I, I, V]);
  });
});

describe('the batch\'s pieces', () => {
  test('batchState: round, chain time, the identity\'s power and this round\'s count', async () => {
    expect(await chain.batchState(identity.evmAddress)).toEqual({ round: ROUND, chainTime: ROUND * 86400 + 9 * 3600, power: 0n, predicted: 0 });
  });
  test('streams with a game the engine pays (voting weight > 0, SatoriEngine.sol:828); named; the cadence', async () => {
    s.streams[2] = { game: 0, named: false, cadence: 60, history: [] }; // no game
    s.streams[3] = { game: 9, named: true, cadence: 60, history: [{ hour: ROUND * 24 + 8, value: 5n }] };
    s.streams[4] = { game: 10, named: false, cadence: 60, history: [{ hour: ROUND * 24 + 8, value: 5n }] }; // anyone's stream: weight 0
    s.weights[9] = 5n * E18;
    expect(await chain.streams()).toEqual([
      { streamId: 1, gameId: 1, named: false, cadenceMinutes: 1440, latestHour: ROUND * 24, count: 2, weight: E18 },
      { streamId: 3, gameId: 9, named: true, cadenceMinutes: 60, latestHour: ROUND * 24 + 8, count: 1, weight: 5n * E18 },
    ]);
  });
  test('a revert of isNamedStream (D6: unknown ids) reads as not named', async () => {
    s.streams[3] = { game: 9, named: true, cadence: 60, history: [{ hour: 1, value: 5n }], namedReverts: true };
    s.weights[9] = 1n;
    expect((await chain.streams()).find((g) => g.streamId === 3).named).toBe(false);
  });
  test('history: the whole ring, oldest first', async () => {
    s.streams[1].history = Array.from({ length: 900 }, (_, i) => ({ hour: i, value: BigInt(i) }));
    const h = await chain.history(1);
    expect(h).toHaveLength(768);
    expect(h[0]).toEqual({ hour: 132, value: 132n });
    expect(h.at(-1)).toEqual({ hour: 899, value: 899n });
  });
  test('the payload is the direction byte, 0x01 UP / 0x02 DOWN (solidityPacked uint8)', () => {
    expect([payload(UP), payload(DOWN)]).toEqual(['0x01', '0x02']);
  });
  test('simulateGame: null when it passes, the error name when not; an RPC failure throws', async () => {
    expect(await chain.simulateGame(identity, { gameId: 1, direction: DOWN })).toBe(null);
    s.deadGames[1] = 'StaleValue';
    expect(await chain.simulateGame(identity, { gameId: 1, direction: DOWN })).toBe('StaleValue');
    s.streams[4] = { game: 4, named: false, cadence: 60, history: [{ hour: 1, value: 1n }] };
    s.deadGames[4] = ''; // a bare revert: no error data
    expect(await chain.simulateGame(identity, { gameId: 4, direction: UP })).toBe('reverted');
    rpc.state.down = true; // the node's internal error (-32603), which viem reads as a revert with a message
    await expect(chain.simulateGame(identity, { gameId: 1, direction: DOWN })).rejects.toThrow();
  });
  test('sendBatch: one tx from the identity; the hash as soon as it is sent; the receipt\'s block time', async () => {
    s.streams[3] = { game: 9, named: false, cadence: 60, history: [{ hour: 1, value: 5n }] };
    const seen = [];
    const r = await chain.sendBatch(identity, [{ gameId: 1, direction: DOWN }, { gameId: 9, direction: UP }],
      { onSent: (hash) => seen.push([hash, rpc.sent.length]) });
    expect(sentBy()).toEqual([['identity', 'predictMultipleWithPayloads', [[{ gameId: 1, payload: '0x02' }, { gameId: 9, payload: '0x01' }]]]]);
    expect(r).toEqual({ hash: rpc.sent[0].hash, at: ROUND * 86400 + 9 * 3600, blockNumber: 1 });
    expect(seen).toEqual([[r.hash, 1]]);
    expect(s.predicted[`${I}:${ROUND}`]).toBe(2);
    await expect(chain.sendBatch(identity, [{ gameId: 1, direction: DOWN }])).rejects.toThrow(/AlreadyPredicted/);
    expect(rpc.sent).toHaveLength(1); // the simulate stopped it: no gas
  });
});

describe('fees, receipts, the chain id', () => {
  test('the tip from eth_maxPriorityFeePerGas, max fee = 2 × the base fee + the tip; the limit the estimate + HOOK_GAS', async () => {
    rpc.state.tip = 3n;
    rpc.state.baseFee = 7n;
    expect(await chain.fees()).toEqual({ maxFeePerGas: 17n, maxPriorityFeePerGas: 3n });
    await chain.claimAirdrop(vault).catch(() => {});
    s.airdrop[V] = 1n;
    await chain.claimAirdrop(vault);
    expect(rpc.sent[0]).toMatchObject({ maxFeePerGas: 17n, maxPriorityFeePerGas: 3n, gas: 0x30000n + HOOK_GAS });
    await chain.sendEth(vault, '0x' + '55'.repeat(20), 1n);
    expect(rpc.sent[1]).toMatchObject({ maxFeePerGas: 17n, maxPriorityFeePerGas: 3n, gas: 0x30000n }); // a plain transfer: no hook, no pad
  });
  test('given fees are used as they are (the batch checks them against its ceiling first)', async () => {
    await chain.sendBatch(identity, [{ gameId: 1, direction: DOWN }], { fees: { maxFeePerGas: 99n, maxPriorityFeePerGas: 9n } });
    expect(rpc.sent[0]).toMatchObject({ maxFeePerGas: 99n, maxPriorityFeePerGas: 9n });
  });
  test('receipt: the status and the block time of a sent tx; null while it is not mined', async () => {
    const { hash } = await chain.sendBatch(identity, [{ gameId: 1, direction: DOWN }]);
    expect(await chain.receipt(hash)).toEqual({ status: 'success', at: ROUND * 86400 + 9 * 3600, blockNumber: 1 });
    expect(await chain.receipt('0x' + '12'.repeat(32), { timeout: 50 })).toBe(null);
  });
  test('chainId: what the RPC says', async () => {
    expect(await chain.chainId()).toBe(84532);
  });
});

describe('claims and sends (the vault)', () => {
  test('hub.claim()', async () => {
    s.rewards[V] = 3n * E18;
    const { hash } = await chain.claimRewards(vault);
    expect(sentBy()).toEqual([['vault', 'claim', undefined]]);
    expect(hash).toBe(rpc.sent[0].hash);
    expect(s.balance[V]).toBe(103n * E18);
  });
  test('claimMerkle with central\'s proof; a wrong proof is refused before sending', async () => {
    const proof = ['0x' + 'ab'.repeat(32)];
    s.merkle.drop[V] = { amount: 5n * E18, proof };
    await expect(chain.claimMerkle(vault, { amountWei: '5000000000000000000', proof: ['0x' + 'cd'.repeat(32)] }))
      .rejects.toThrow(/InvalidProof/);
    expect(await chain.alreadyMinted(vault.evmAddress)).toBe(0n);
    await chain.claimMerkle(vault, { amountWei: '5000000000000000000', proof });
    expect(sentBy()).toEqual([['vault', 'claimMerkle', [5n * E18, proof]]]);
    expect(await chain.alreadyMinted(vault.evmAddress)).toBe(5n * E18);
  });
  test('claimAirdrop', async () => {
    s.airdrop[V] = 7n * E18;
    await chain.claimAirdrop(vault);
    expect(sentBy()).toEqual([['vault', 'claimAirdrop', undefined]]);
    expect(s.balance[V]).toBe(107n * E18);
  });
  test('SATORI: Locked while delegated, sent when free', async () => {
    const to = '0x' + '33'.repeat(20);
    await chain.delegate({ identity, vault });
    await expect(chain.sendSatori(vault, to, E18)).rejects.toThrow(/Locked/);
    s.lock[V] = 0;
    await chain.sendSatori(vault, to, E18);
    expect(s.balance[to]).toBe(E18);
  });
  test('ETH: estimated first; more than the balance throws before sending', async () => {
    const to = '0x' + '44'.repeat(20);
    await expect(chain.sendEth(vault, to, 10n ** 18n)).rejects.toThrow();
    expect(rpc.sent).toHaveLength(0);
    await chain.sendEth(vault, to, 10n ** 15n);
    expect(rpc.eth[to]).toBe(10n ** 15n);
  });
});
