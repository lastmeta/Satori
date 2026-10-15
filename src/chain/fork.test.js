// The chain module against the real D6 contracts on an anvil fork of Base
// Sepolia. Skipped unless BASE_FORK names one (never a public chain):
//   node scripts/fork.mjs start --port 8546
//   BASE_FORK=http://127.0.0.1:8546 npx vitest run src/chain/fork.test.js
// Fresh throwaway keys each run; the fork's clock moves forward.
import { describe, expect, test } from 'vitest';
import { http, zeroAddress } from 'viem';
import { generateEntropy, publicKeys, evmAddress, signDigest } from '../keys/keys.js';
import { DEFAULTS } from './config.js';
import { createChain, revertName, DOWN, INDEFINITE } from './index.js';
import { fund, airdrop, merkle, advance, clients, stream } from '../../scripts/fork.mjs';

const RPC = process.env.BASE_FORK;
const E18 = 10n ** 18n;
const signer = () => {
  const secret = generateEntropy();
  return { evmAddress: evmAddress(publicKeys(secret).pubkey), signDigest: (h) => signDigest(secret, h) };
};

describe.skipIf(!RPC || !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RPC))('on a local fork of Base Sepolia', () => {
  test('delegate, the batch, claims, stop, the lock, a send', { timeout: 180_000 }, async () => {
    const identity = signer();
    const vault = signer();
    const I = identity.evmAddress;
    const V = vault.evmAddress;
    const chain = createChain({ config: DEFAULTS, transport: http(RPC), pollingInterval: 250, settle: { tries: 5, ms: 500 } });
    const st = () => chain.status({ identity: I, vault: V });
    await fund(RPC, [I], { eth: '0.1' });
    await fund(RPC, [V], { eth: '0.1', satori: '100' });

    const before = await st();
    expect(before).toMatchObject({ errors: [], identity: { fee: 1000, power: 0n }, vault: { satori: 100n * E18, delegate: zeroAddress, lockedUntil: 0 } });

    const d = await chain.delegate({ identity, vault });
    expect(d.steps.map((x) => x.step)).toEqual(['setPredictorFee(0)', 'setAllowedDelegator(vault)', 'delegatePredictionPower(identity)']);
    const on = await st();
    expect(on.identity).toMatchObject({ fee: 0, power: 100n * E18, allowedDelegator: V });
    expect(on.vault).toMatchObject({ delegate: I, lockedUntil: INDEFINITE, lock: { locked: true, indefinite: true } });

    const junk = await stream(RPC, `junk-${Date.now()}`); // anyone's stream: a game, but no voting weight
    expect(junk.gameId).toBeGreaterThan(0);
    const streams = await chain.streams();
    expect(streams.find((g) => g.streamId === 1)).toMatchObject({ gameId: 1, named: false, cadenceMinutes: 1440 });
    expect(streams.find((g) => g.streamId === junk.streamId)).toBeUndefined();
    expect((await chain.history(1)).length).toBeGreaterThan(1);
    expect(await chain.batchState(I)).toMatchObject({ round: on.round, power: 100n * E18, predicted: 0 });
    expect(await chain.simulateGame(identity, { gameId: 1, direction: DOWN })).toBe(null);
    const batch = await chain.sendBatch(identity, [{ gameId: 1, direction: DOWN }]);
    expect(batch.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await chain.batchState(I)).predicted).toBe(1);
    expect(await chain.simulateGame(identity, { gameId: 1, direction: DOWN })).toBe('AlreadyPredicted');

    // Claims a round later: the airdrop (loaded now), the merkle drop (the reserve accrues per round).
    await airdrop(RPC, V, 600);
    const proof = await merkle(RPC, V, 5);
    await advance(RPC, 1);
    const later = await st();
    expect(later.claimable.airdrop).toBeGreaterThan(0n);
    await chain.claimAirdrop(vault);
    expect(await chain.alreadyMinted(V)).toBe(0n);
    await chain.claimMerkle(vault, proof);
    expect(await chain.alreadyMinted(V)).toBe(5n * E18);
    const claimed = await st();
    expect(claimed.vault.satori).toBeGreaterThan(105n * E18);
    // The token's hook kept the delegate's power in step with the vault's new balance (HOOK_GAS):
    // with the bare estimate it fails silently and the undelegate below panics (0x11).
    expect(claimed.identity.power).toBe(claimed.vault.satori);

    // Stop: transfer-locked through the next round (>=), then free.
    const off = await chain.undelegate({ vault });
    expect(off.steps).toHaveLength(1);
    const stopped = await st();
    expect(stopped.vault.lock).toMatchObject({ locked: true, untilRound: stopped.round + 1 });
    const to = '0x000000000000000000000000000000000000dEaD';
    expect(revertName(await chain.sendSatori(vault, to, E18).catch((e) => e))).toBe('Locked');
    await advance(RPC, 1);
    expect((await st()).vault.lock.locked).toBe(true); // round N itself is still locked (Lite would say free)
    expect(revertName(await chain.sendSatori(vault, to, E18).catch((e) => e))).toBe('Locked');
    await advance(RPC, 1);
    expect((await st()).vault.lock.locked).toBe(false);
    await chain.sendSatori(vault, to, E18);
    const { pub } = clients(RPC);
    const ethBefore = await pub.getBalance({ address: to });
    await chain.sendEth(vault, to, 10n ** 15n);
    expect(await pub.getBalance({ address: to })).toBe(ethBefore + 10n ** 15n);
  });
});
