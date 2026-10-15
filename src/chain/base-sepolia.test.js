// READ-ONLY integration test against the public Base Sepolia RPC: checks the
// bundled addresses and ABIs against the live deployment. Only eth_call /
// eth_getBlock; no transaction is ever built or sent. Skipped when offline.
import { describe, expect, test } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { engineAbi } from './abi.js';
import { DEFAULTS } from './config.js';
import { GATE, createChain } from './index.js';

async function online() {
  try {
    const res = await fetch(DEFAULTS.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(5000),
    });
    return (await res.json()).result === '0x14a34';
  } catch {
    return false;
  }
}

// A throwaway key: never funded, used only as `from` in eth_call.
const nobody = privateKeyToAccount('0x' + '5a'.repeat(32));

describe.skipIf(!(await online()))('Base Sepolia (read-only)', { timeout: 30_000 }, () => {
  const chain = createChain({ config: DEFAULTS });
  let games;

  test('round is today (UTC)', async () => {
    expect(Math.abs(await chain.round() - Math.floor(Date.now() / 86400_000))).toBeLessThanOrEqual(1);
  });

  test('registry streams with binary games', async () => {
    games = await chain.baseGames();
    expect(games.length).toBeGreaterThan(0);
    for (const g of games) expect(g.gameId).toBeGreaterThan(0);
  });

  test('history and latest info agree', async () => {
    const [info] = await chain.latestInfo([games[0].streamId]);
    const h = await chain.history(games[0].streamId);
    expect(h).toHaveLength(info.count);
    if (h.length) expect(h.at(-1).hour).toBe(info.latestHour);
    for (let i = 1; i < h.length; i++) expect(h[i].hour).toBeGreaterThan(h[i - 1].hour);
  });

  test('delegation, batch due, balances, claims read for an empty address', async () => {
    const a = nobody.address;
    expect(await chain.delegationStatus({ vault: a, identity: a })).toMatchObject({ power: 0n, lockedUntilRound: 0 });
    expect(await chain.batchDue(a)).toMatchObject({ due: false, reason: 'no-power' });
    expect(await chain.balances({ vault: a, identity: a })).toEqual({
      vault: { eth: 0n, satori: 0n }, identity: { eth: 0n, satori: 0n }, gate: { required: GATE, met: false },
    });
    expect(await chain.airdropStatus(a)).toEqual({ allocation: 0n, claimed: 0n, claimable: 0n });
    expect(await chain.merkleStatus(a, { amountWei: '0' })).toEqual({ entitlement: 0n, alreadyMinted: 0n, claimable: 0n });
    expect(await chain.rewardsStatus({ vault: a, identity: a })).toEqual({ vault: 0n, identity: 0n });
  });

  test('engine accepts the predict calldata (simulate only)', async () => {
    const sim = chain.client.simulateContract({
      account: nobody, address: DEFAULTS.engine, abi: engineAbi,
      functionName: 'predictMultipleWithPayloads', args: [[{ gameId: games[0].gameId, payload: '0x01' }]],
    });
    // Either it would pass, or it reverts with a decoded custom error, never an unknown selector.
    await sim.then(() => {}, (e) => expect(e.message).not.toMatch(/function selector was not recognized|0x[0-9a-f]{8}\b.*not found/i));
  });
});
