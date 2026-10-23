// The chain module (docs/design/base.md) against test/fake-satori.js: viem over a
// custom transport to a small stateful D7. Keys are our signers (src/keys),
// so every transaction here is signed the way the app signs it.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, custom, encodeErrorResult, zeroAddress } from 'viem';
import { tokenAbi } from './abi.js';
import { publicKey, evmAddress, signDigest } from '../keys/keys.js';
import { DEFAULTS } from './config.js';
import { fakeSatori, E18 } from '../../test/fake-satori.js';
import { fakeWallet } from '../../test/fake-wallet.js';
import { connectedWallet } from '../keys/connect.js';

import { createChain, transferLock, payload, revertName, errorText, panicOf, UP, DOWN, HOOK_GAS, INDEFINITE } from './index.js';

const signerOf = (hex) => {
  const secret = Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
  return { evmAddress: evmAddress(publicKey(secret)), signDigest: (h) => signDigest(secret, h) };
};
const alias = signerOf('11'.repeat(32));
const wallet = signerOf('22'.repeat(32));
const I = alias.evmAddress.toLowerCase();
const V = wallet.evmAddress.toLowerCase();
const ROUND = 20741;

let s, rpc, chain;
beforeEach(() => {
  ({ s, rpc } = fakeSatori({ round: ROUND, hour: 9, eth: { [I]: 10n ** 16n, [V]: 10n ** 16n } }));
  s.balance[V] = 100n * E18;
  chain = createChain({ config: DEFAULTS, transport: rpc.transport, pollingInterval: 1, settle: { tries: 5, ms: 1 } });
});
const sentBy = () => rpc.sent.map((t) => [t.from === I ? 'alias' : t.from === V ? 'wallet' : t.from, t.functionName, t.args]);

describe('the transfer lock: blocked while lockedUntil >= round (SatoriToken.sol:816-821)', () => {
  test('free, while staked, after unstaking (through the next round), then free', () => {
    expect(transferLock(0, ROUND)).toEqual({ locked: false, indefinite: false, untilRound: null, freeAt: null });
    expect(transferLock(INDEFINITE, ROUND)).toEqual({ locked: true, indefinite: true, untilRound: null, freeAt: null });
    expect(transferLock(ROUND + 1, ROUND)).toEqual({ locked: true, indefinite: false, untilRound: ROUND + 1, freeAt: (ROUND + 2) * 86400 });
    expect(transferLock(ROUND + 1, ROUND + 1).locked).toBe(true); // Lite's `>` shows this round as free: it is not
    expect(transferLock(ROUND + 1, ROUND + 2).locked).toBe(false);
  });
});

describe('status: one multicall', () => {
  test('balances, the stake, fee, the transfer rule, the round, claimables', async () => {
    s.rewards[V] = 3n * E18;
    s.airdrop[V] = 7n * E18;
    const before = rpc.log.length;
    const st = await chain.status({ alias: alias.evmAddress, wallet: wallet.evmAddress });
    expect(rpc.log.slice(before).filter((m) => m === 'eth_call')).toHaveLength(1);
    expect(st).toMatchObject({
      round: ROUND, chainTime: ROUND * 86400 + 9 * 3600, gasPrice: 1_000_000n,
      alias: { eth: 10n ** 16n, delegate: zeroAddress, power: 0n, fee: 1000, allowedDelegator: zeroAddress },
      wallet: { eth: 10n ** 16n, satori: 100n * E18, delegate: zeroAddress, lockedUntil: 0, lock: { locked: false }, referral: zeroAddress },
      claimable: { rewards: 3n * E18, rewardsComplete: true, airdrop: 7n * E18 },
      errors: [],
    });
  });
});

describe('stake: delegatePredictionPower(alias) (Lite\'s Enable staking + the dapp\'s instant signing)', () => {
  test('fee → 0 and allowedDelegator → wallet (alias), then the wallet\'s delegatePredictionPower(alias); the reads show it', async () => {
    const r = await chain.delegate({ alias, wallet });
    expect(sentBy()).toEqual([
      ['alias', 'setPredictorFee', [0]],
      ['alias', 'setAllowedDelegator', [wallet.evmAddress]],
      ['wallet', 'delegatePredictionPower', [alias.evmAddress]],
    ]);
    expect(r).toEqual({ settled: true, steps: rpc.sent.map((t, i) => ({ ...r.steps[i], hash: t.hash })) });
    const st = await chain.status({ alias: alias.evmAddress, wallet: wallet.evmAddress });
    expect(st.alias).toMatchObject({ fee: 0, power: 100n * E18, allowedDelegator: wallet.evmAddress });
    expect(st.wallet).toMatchObject({ delegate: alias.evmAddress, lockedUntil: INDEFINITE, lock: { locked: true, indefinite: true } });
  });
  test('only the missing steps: nothing at all when in place', async () => {
    s.feeStored[I] = 1000; // fee already 0
    await chain.delegate({ alias, wallet });
    expect(sentBy().map((x) => x[1])).toEqual(['setAllowedDelegator', 'delegatePredictionPower']);
    expect(await chain.delegate({ alias, wallet })).toEqual({ steps: [], settled: true });
    expect(rpc.sent).toHaveLength(2);
  });
  describe('a referrer (docs/design/base.md#referral-invite-links)', () => {
    const R = '0x' + 'ab'.repeat(20);
    test('the wallet registers it first, once; the status reads it', async () => {
      const r = await chain.delegate({ alias, wallet, referrer: R });
      expect(sentBy().map((x) => x.slice(0, 2).join(':'))).toEqual(['wallet:setReferral', 'alias:setPredictorFee', 'alias:setAllowedDelegator',
        'wallet:delegatePredictionPower']);
      expect(sentBy()[0][2].map((a) => a.toLowerCase())).toEqual([R]);
      expect(r.steps[0]).toMatchObject({ step: 'setReferral(referrer)', by: 'wallet' });
      expect((await chain.status({ alias: alias.evmAddress, wallet: wallet.evmAddress })).wallet.referral.toLowerCase()).toBe(R);
    });
    test('none when the wallet has a referral already (set once)', async () => {
      s.referral[V] = '0x' + 'cd'.repeat(20);
      await chain.delegate({ alias, wallet, referrer: R });
      expect(sentBy().map((x) => x[1])).toEqual(['setPredictorFee', 'setAllowedDelegator', 'delegatePredictionPower']);
      expect(s.referral[V]).toBe('0x' + 'cd'.repeat(20));
    });
    test('none when it is the wallet itself (the contract refuses it), or when none is held', async () => {
      await chain.delegate({ alias, wallet, referrer: wallet.evmAddress });
      expect(sentBy().map((x) => x[1])).toEqual(['setPredictorFee', 'setAllowedDelegator', 'delegatePredictionPower']);
      expect(s.referral[V]).toBeUndefined();
    });
  });
  test('a fee set once to something else: the simulate says AlreadySet, nothing is sent', async () => {
    s.feeStored[I] = 500;
    const err = await chain.delegate({ alias, wallet }).catch((e) => e);
    expect(revertName(err)).toBe('AlreadySet');
    expect(errorText(err)).toBe('reverted: AlreadySet');
    expect(rpc.sent).toHaveLength(0);
  });
  test('a frozen stake: unstaking underflows (Panic 0x11), named by panicOf; nothing is sent', async () => {
    await chain.delegate({ alias, wallet });
    rpc.sent.length = 0;
    s.skipHook(V, 1n);
    const err = await chain.undelegate({ wallet }).catch((e) => e);
    expect([revertName(err), panicOf(err)]).toEqual(['Panic', 0x11]);
    expect(rpc.sent).toHaveLength(0);
    expect(panicOf(new Error('x'))).toBeNull();
  });
  test("a starved transfer (HookFailedWithoutReason, D7): a plain line", () => {
    const data = encodeErrorResult({ abi: tokenAbi, errorName: 'HookFailedWithoutReason' });
    const err = new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: tokenAbi, data, functionName: 'transfer' }),
      { abi: tokenAbi, functionName: 'transfer', args: [] });
    expect(revertName(err)).toBe('HookFailedWithoutReason');
    expect(errorText(err)).toBe('The transaction ran out of gas; try again');
  });
  test('a lagging read after the receipt: re-read 5 × (Lite), then trust the receipt', async () => {
    let lag = 99;
    const real = s.delegateOf;
    s.delegateOf = new Proxy(real, { get: (t, k) => (k === V && lag-- > 0 ? undefined : t[k]) });
    const r = await chain.delegate({ alias, wallet });
    expect(r.settled).toBe(false);
    expect(rpc.sent).toHaveLength(3);
  });
  test('unstake: delegatePredictionPower(0x0); SATORI can\'t be sent through the next round', async () => {
    await chain.delegate({ alias, wallet });
    const r = await chain.undelegate({ wallet });
    expect(sentBy().at(-1)).toEqual(['wallet', 'delegatePredictionPower', [zeroAddress]]);
    expect(r).toMatchObject({ settled: true, steps: [{ step: 'delegatePredictionPower(0x0)', by: 'wallet' }] });
    const st = await chain.status({ alias: alias.evmAddress, wallet: wallet.evmAddress });
    expect(st.wallet.lock).toEqual({ locked: true, indefinite: false, untilRound: ROUND + 1, freeAt: (ROUND + 2) * 86400 });
    expect(st.alias.power).toBe(0n);
    expect(await chain.undelegate({ wallet })).toEqual({ steps: [], settled: true });
  });
  test('accounts as 0x private keys too (scripts, the fork test)', async () => {
    await chain.delegate({ alias: '0x' + '11'.repeat(32), wallet: '0x' + '22'.repeat(32) });
    expect(rpc.sent.map((t) => t.from)).toEqual([I, I, V]);
  });
});

describe('the batch\'s pieces', () => {
  test('batchState: round, chain time, the alias\'s power and this round\'s count', async () => {
    expect(await chain.batchState(alias.evmAddress)).toEqual({ round: ROUND, chainTime: ROUND * 86400 + 9 * 3600, power: 0n, predicted: 0 });
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
  test('a revert of isNamedStream (unknown ids) reads as not named', async () => {
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
    expect(await chain.simulateGame(alias, { gameId: 1, direction: DOWN })).toBe(null);
    s.deadGames[1] = 'StaleValue';
    expect(await chain.simulateGame(alias, { gameId: 1, direction: DOWN })).toBe('StaleValue');
    s.streams[4] = { game: 4, named: false, cadence: 60, history: [{ hour: 1, value: 1n }] };
    s.deadGames[4] = ''; // a bare revert: no error data
    expect(await chain.simulateGame(alias, { gameId: 4, direction: UP })).toBe('reverted');
    rpc.state.down = true; // the node's internal error (-32603), which viem reads as a revert with a message
    await expect(chain.simulateGame(alias, { gameId: 1, direction: DOWN })).rejects.toThrow();
  });
  test('sendBatch: one tx from the alias; the hash as soon as it is sent; the receipt\'s block time', async () => {
    s.streams[3] = { game: 9, named: false, cadence: 60, history: [{ hour: 1, value: 5n }] };
    const seen = [];
    const r = await chain.sendBatch(alias, [{ gameId: 1, direction: DOWN }, { gameId: 9, direction: UP }],
      { onSent: (hash) => seen.push([hash, rpc.sent.length]) });
    expect(sentBy()).toEqual([['alias', 'predictMultipleWithPayloads', [[{ gameId: 1, payload: '0x02' }, { gameId: 9, payload: '0x01' }]]]]);
    expect(r).toEqual({ hash: rpc.sent[0].hash, at: ROUND * 86400 + 9 * 3600, blockNumber: 1 });
    expect(seen).toEqual([[r.hash, 1]]);
    expect(s.predicted[`${I}:${ROUND}`]).toBe(2);
    await expect(chain.sendBatch(alias, [{ gameId: 1, direction: DOWN }])).rejects.toThrow(/AlreadyPredicted/);
    expect(rpc.sent).toHaveLength(1); // the simulate stopped it: no gas
  });
});

describe('fees, receipts, the chain id', () => {
  test('the tip from eth_maxPriorityFeePerGas, max fee = 2 × the base fee + the tip; the limit the estimate + HOOK_GAS', async () => {
    rpc.state.tip = 3n;
    rpc.state.baseFee = 7n;
    expect(await chain.fees()).toEqual({ maxFeePerGas: 17n, maxPriorityFeePerGas: 3n });
    await chain.claimAirdrop(wallet).catch(() => {});
    s.airdrop[V] = 1n;
    await chain.claimAirdrop(wallet);
    expect(rpc.sent[0]).toMatchObject({ maxFeePerGas: 17n, maxPriorityFeePerGas: 3n, gas: 0x30000n + HOOK_GAS });
    await chain.sendEth(wallet, '0x' + '55'.repeat(20), 1n);
    expect(rpc.sent[1]).toMatchObject({ maxFeePerGas: 17n, maxPriorityFeePerGas: 3n, gas: 0x30000n }); // a plain transfer: no hook, no pad
  });
  test('given fees are used as they are (the batch checks them against its ceiling first)', async () => {
    await chain.sendBatch(alias, [{ gameId: 1, direction: DOWN }], { fees: { maxFeePerGas: 99n, maxPriorityFeePerGas: 9n } });
    expect(rpc.sent[0]).toMatchObject({ maxFeePerGas: 99n, maxPriorityFeePerGas: 9n });
  });
  test('receipt: the status and the block time of a sent tx; null while it is not mined', async () => {
    const { hash } = await chain.sendBatch(alias, [{ gameId: 1, direction: DOWN }]);
    expect(await chain.receipt(hash)).toEqual({ status: 'success', at: ROUND * 86400 + 9 * 3600, blockNumber: 1, hash });
    expect(await chain.receipt('0x' + '12'.repeat(32), { timeout: 50 })).toBe(null);
  });
  test('minedAny: the one of a batch and its replacements that was mined; the nonce, mined and sent', async () => {
    const A = alias.evmAddress;
    expect([await chain.nonce(A), await chain.nonce(A, 'pending')]).toEqual([0, 0]);
    rpc.state.mine = false;
    const sent = [];
    // its own wait ends (timeout) before the replacement: writes are one at a time, the wait included
    const p = chain.sendBatch(alias, [{ gameId: 1, direction: DOWN }], { timeout: 300, onSent: (hash, tx) => sent.push({ hash, ...tx }) });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ nonce: 0, gas: expect.any(BigInt), maxFeePerGas: expect.any(BigInt), maxPriorityFeePerGas: expect.any(BigInt) });
    expect([await chain.nonce(A), await chain.nonce(A, 'pending')]).toEqual([0, 1]); // sent, not mined
    expect(await chain.minedAny([sent[0].hash], { timeout: 50 })).toBe(null);
    const fees = { maxFeePerGas: sent[0].maxFeePerGas * 2n, maxPriorityFeePerGas: sent[0].maxPriorityFeePerGas * 2n };
    const again = await chain.replaceBatch(alias, [{ gameId: 1, direction: DOWN }], { nonce: 0, gas: sent[0].gas, fees });
    expect(rpc.sent.map((t) => [t.nonce, !!t.replaced])).toEqual([[0, true], [0, false]]);
    rpc.release();
    expect(await chain.minedAny([sent[0].hash, again], { timeout: 1000 })).toMatchObject({ status: 'success', hash: again });
    await expect(p).rejects.toThrow(/Timed out/); // the first's own wait: it timed out, then it was replaced
  }, 20_000);
  test('chainId: what the RPC says', async () => {
    expect(await chain.chainId()).toBe(84532);
  });
});

describe('claims and sends (the wallet)', () => {
  test('hub.claim()', async () => {
    s.rewards[V] = 3n * E18;
    const { hash } = await chain.claimRewards(wallet);
    expect(sentBy()).toEqual([['wallet', 'claim', undefined]]);
    expect(hash).toBe(rpc.sent[0].hash);
    expect(s.balance[V]).toBe(103n * E18);
  });
  test('claimMerkle with central\'s proof; a wrong proof is refused before sending', async () => {
    const proof = ['0x' + 'ab'.repeat(32)];
    s.merkle.drop[V] = { amount: 5n * E18, proof };
    await expect(chain.claimMerkle(wallet, { amountWei: '5000000000000000000', proof: ['0x' + 'cd'.repeat(32)] }))
      .rejects.toThrow(/InvalidProof/);
    expect(await chain.alreadyMinted(wallet.evmAddress)).toBe(0n);
    await chain.claimMerkle(wallet, { amountWei: '5000000000000000000', proof });
    expect(sentBy()).toEqual([['wallet', 'claimMerkle', [5n * E18, proof]]]);
    expect(await chain.alreadyMinted(wallet.evmAddress)).toBe(5n * E18);
  });
  test('claimAirdrop', async () => {
    s.airdrop[V] = 7n * E18;
    await chain.claimAirdrop(wallet);
    expect(sentBy()).toEqual([['wallet', 'claimAirdrop', undefined]]);
    expect(s.balance[V]).toBe(107n * E18);
  });
  test('SATORI: the token reverts Locked while staked, sent when free', async () => {
    const to = '0x' + '33'.repeat(20);
    await chain.delegate({ alias, wallet });
    await expect(chain.sendSatori(wallet, to, E18)).rejects.toThrow(/Locked/);
    s.lock[V] = 0;
    await chain.sendSatori(wallet, to, E18);
    expect(s.balance[to]).toBe(E18);
  });
  test('ETH: estimated first; more than the balance throws before sending', async () => {
    const to = '0x' + '44'.repeat(20);
    await expect(chain.sendEth(wallet, to, 10n ** 18n)).rejects.toThrow();
    expect(rpc.sent).toHaveLength(0);
    await chain.sendEth(wallet, to, 10n ** 15n);
    expect(rpc.eth[to]).toBe(10n ** 15n);
  });
});

describe('the max fee on every transaction (the security review, 2026-10-19)', () => {
  const GWEI = 10n ** 9n;
  test("above the ceiling, each write is refused before it is sent: stake's three steps, unstake, claims, sends, the batch; and the quote", async () => {
    const capped = createChain({ config: DEFAULTS, transport: rpc.transport, pollingInterval: 1, settle: { tries: 5, ms: 1 },
      maxFee: async () => 2n * GWEI });
    rpc.state.tip = 3n * GWEI; // a max fee of 3 gwei + 2 wei
    s.rewards[V] = E18;
    s.airdrop[V] = E18;
    s.merkle.drop[V] = { amount: E18, proof: ['0x' + 'ab'.repeat(32)] };
    const to = '0x' + '44'.repeat(20);
    const over = /above the max fee: 3.000000002 gwei > 2 gwei/;
    await expect(capped.delegate({ alias, wallet })).rejects.toThrow(over); // the alias's setPredictorFee(0), the first step
    await expect(capped.undelegate({ wallet })).resolves.toEqual({ steps: [], settled: true }); // not staked: nothing to send
    await expect(capped.claimRewards(wallet)).rejects.toThrow(over);
    await expect(capped.claimMerkle(wallet, { amountWei: E18.toString(), proof: ['0x' + 'ab'.repeat(32)] })).rejects.toThrow(over);
    await expect(capped.claimAirdrop(wallet)).rejects.toThrow(over);
    await expect(capped.sendEth(wallet, to, 1n)).rejects.toThrow(over);
    await expect(capped.sendSatori(wallet, to, 1n)).rejects.toThrow(over);
    await expect(capped.sendBatch(alias, [{ gameId: 1, direction: DOWN }])).rejects.toThrow(over);
    await expect(capped.sendFee(wallet.evmAddress, { asset: 'ETH', to, wei: 1n })).rejects.toThrow(over); // the send's review says it
    expect(rpc.sent).toHaveLength(0);
    rpc.state.tip = 10n ** 6n; // Base's usual 0.001 gwei
    await capped.delegate({ alias, wallet });
    await capped.undelegate({ wallet });
    expect(rpc.sent.map((t) => t.functionName)).toEqual(['setPredictorFee', 'setAllowedDelegator', 'delegatePredictionPower', 'delegatePredictionPower']);
  });
  test('no ceiling given (tests, scripts): no check', async () => {
    rpc.state.tip = 3n * GWEI;
    s.airdrop[V] = 1n;
    await chain.claimAirdrop(wallet);
    expect(rpc.sent).toHaveLength(1);
  });
});

describe("viem's CCIP-read is off (the security review, 2026-10-19)", () => {
  test('a revert asking for an off-chain lookup (EIP-3668) is a revert: the page fetches nothing', async () => {
    const lookup = encodeErrorResult({
      abi: [{ type: 'error', name: 'OffchainLookup', inputs: [{ name: 'sender', type: 'address' }, { name: 'urls', type: 'string[]' },
        { name: 'callData', type: 'bytes' }, { name: 'callbackFunction', type: 'bytes4' }, { name: 'extraData', type: 'bytes' }] }],
      errorName: 'OffchainLookup', args: [DEFAULTS.registry, ['https://evil.example/{sender}/{data}.json'], '0x1234', '0x12345678', '0x'],
    });
    const transport = custom({
      async request({ method }) {
        if (method === 'eth_chainId') return '0x14a34';
        if (method === 'eth_call') throw Object.assign(new Error('execution reverted'), { code: 3, data: lookup });
        throw new Error(`no ${method}`);
      },
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"data":"0x"}'));
    try {
      const c = createChain({ config: DEFAULTS, transport, pollingInterval: 1 });
      await expect(c.history(1n)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});

describe('a connected wallet (docs/design/wallets.md#a-connected-wallet): its wallet app signs and sends', () => {
  const connected = (app) => connectedWallet({ address: app.address, name: 'TestWallet', provider: app.provider });
  test('Stake: the alias\'s steps signed here, the wallet\'s sent by its wallet app; the reads show it', async () => {
    const app = fakeWallet({ key: `0x${'33'.repeat(32)}`, transport: rpc.transport });
    const W = app.address.toLowerCase();
    rpc.eth[W] = 10n ** 16n;
    s.balance[W] = 100n * E18;
    const r = await chain.delegate({ alias, wallet: connected(app) });
    expect(r.steps.map((x) => [x.step, x.by])).toEqual([['setPredictorFee(0)', 'alias'], ['setAllowedDelegator(wallet)', 'alias'],
      ['delegatePredictionPower(alias)', 'wallet']]);
    expect(rpc.sent.at(-1)).toMatchObject({ from: W, functionName: 'delegatePredictionPower' });
    expect(app.calls.filter((m) => m === 'eth_sendTransaction')).toHaveLength(1);
    expect(app.calls.indexOf('eth_requestAccounts')).toBeLessThan(app.calls.indexOf('eth_sendTransaction')); // its account checked first
    expect(r.settled).toBe(true);
  });
  test('a wallet on another chain is switched first; one that does not know Base Sepolia is offered it (EIP-3085)', async () => {
    const app = fakeWallet({ key: `0x${'44'.repeat(32)}`, transport: rpc.transport, chainId: 1, knowsChain: false });
    rpc.eth[app.address.toLowerCase()] = 10n ** 16n;
    await chain.sendEth(connected(app), '0x' + '55'.repeat(20), 1000n);
    expect(app.state.added).toEqual([expect.objectContaining({ chainId: '0x14a34', rpcUrls: [DEFAULTS.rpcUrl], blockExplorerUrls: [DEFAULTS.explorerUrl] })]);
    expect(app.state.chainId).toBe(84532);
    expect(rpc.sent.at(-1)).toMatchObject({ from: app.address.toLowerCase(), value: 1000n });
  });
  test('on another account, or declined: said plainly, nothing sent', async () => {
    const app = fakeWallet({ key: `0x${'66'.repeat(32)}`, transport: rpc.transport });
    rpc.eth[app.address.toLowerCase()] = 10n ** 16n;
    const before = rpc.sent.length;
    app.state.accounts = ['0x' + '77'.repeat(20)];
    await expect(chain.sendEth(connected(app), '0x' + '55'.repeat(20), 1n)).rejects.toThrow(`TestWallet is on another account: choose ${app.address} in it`);
    app.state.accounts = [app.address];
    app.state.reject = true;
    const err = await chain.sendEth(connected(app), '0x' + '55'.repeat(20), 1n).catch((e) => e);
    expect(errorText(err)).toBe('Declined in the wallet app.');
    expect(rpc.sent.length).toBe(before);
  });
});
