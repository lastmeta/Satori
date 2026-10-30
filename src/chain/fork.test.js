// The chain module against the real D6 contracts on an anvil fork of Base
// Sepolia. Skipped unless BASE_FORK names one (never a public chain):
//   node scripts/fork.mjs start --port 8546
//   BASE_FORK=http://127.0.0.1:8546 npx vitest run src/chain/fork.test.js
// Fresh throwaway keys each run; the fork's clock moves forward.
import { describe, expect, test } from 'vitest';
import { createWalletClient, encodeAbiParameters, http, keccak256, parseAbi, toHex, zeroAddress } from 'viem';
import { baseSepolia } from 'viem/chains';
import { generateSecret, publicKey, evmAddress, signDigest } from '../keys/keys.js';
import { DEFAULTS } from './config.js';
import { createChain, revertName, DOWN, INDEFINITE } from './index.js';
import { fund, airdrop, merkle, advance, clients, stream } from '../../scripts/fork.mjs';
import { createBase, runBatch } from '../neuron/base.js';
import { devFeeOf, devFeeOps } from '../neuron/devfee.js';
import { adminOps, adminRole, adminState } from '../neuron/admin.js';
import { roleAct, rolesOf } from '../neuron/roles.js';
import { CentralError } from '../central/index.js';

const RPC = process.env.BASE_FORK;
const DEFAULTS_TOP = '0x6C5722C65041341C16D892235ea6076F05Cf4238'; // the token's PLATFORM_FEE_RECIPIENT: splitter A
const E18 = 10n ** 18n;
const chain = () => createChain({ config: DEFAULTS, transport: http(RPC), pollingInterval: 250, settle: { tries: 5, ms: 500 } });
const signer = () => {
  const secret = generateSecret();
  return { evmAddress: evmAddress(publicKey(secret)), signDigest: (h) => signDigest(secret, h) };
};

describe.skipIf(!RPC || !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RPC))('on a local fork of Base Sepolia', () => {
  test('stake, the batch, claims, unstake, the transfer rule, a send', { timeout: 180_000 }, async () => {
    const alias = signer();
    const wallet = signer();
    const I = alias.evmAddress;
    const V = wallet.evmAddress;
    const chain = createChain({ config: DEFAULTS, transport: http(RPC), pollingInterval: 250, settle: { tries: 5, ms: 500 } });
    const st = () => chain.status({ alias: I, wallet: V });
    await fund(RPC, [I], { eth: '0.1' });
    await fund(RPC, [V], { eth: '0.1', satori: '100' });

    const before = await st();
    expect(before).toMatchObject({ errors: [], alias: { fee: 1000, power: 0n }, wallet: { satori: 100n * E18, delegate: zeroAddress, lockedUntil: 0 } });

    const d = await chain.delegate({ alias, wallet });
    expect(d.steps.map((x) => x.step)).toEqual(['setPredictorFee(0)', 'setAllowedDelegator(wallet)', 'delegatePredictionPower(alias)']);
    const on = await st();
    expect(on.alias).toMatchObject({ fee: 0, power: 100n * E18, allowedDelegator: V });
    expect(on.wallet).toMatchObject({ delegate: I, lockedUntil: INDEFINITE, lock: { locked: true, indefinite: true } });

    const junk = await stream(RPC, `junk-${Date.now()}`); // anyone's stream: a game, but no voting weight
    expect(junk.gameId).toBeGreaterThan(0);
    const streams = await chain.streams();
    expect(streams.find((g) => g.streamId === 1)).toMatchObject({ gameId: 1, named: false, cadenceMinutes: 1440 });
    expect(streams.find((g) => g.streamId === junk.streamId)).toBeUndefined();
    expect((await chain.history(1)).length).toBeGreaterThan(1);
    expect(await chain.batchState(I)).toMatchObject({ round: on.round, power: 100n * E18, predicted: 0 });
    expect(await chain.simulateGame(alias, { gameId: 1, direction: DOWN })).toBe(null);
    const batch = await chain.sendBatch(alias, [{ gameId: 1, direction: DOWN }]);
    expect(batch.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await chain.batchState(I)).predicted).toBe(1);
    expect(await chain.simulateGame(alias, { gameId: 1, direction: DOWN })).toBe('AlreadyPredicted');

    // Claims a round later: the airdrop (loaded now), the merkle drop (the reserve accrues per round).
    await airdrop(RPC, V, 600);
    const proof = await merkle(RPC, V, 5);
    await advance(RPC, 1);
    const later = await st();
    expect(later.claimable.airdrop).toBeGreaterThan(0n);
    await chain.claimAirdrop(wallet);
    expect(await chain.alreadyMinted(V)).toBe(0n);
    await chain.claimMerkle(wallet, proof);
    expect(await chain.alreadyMinted(V)).toBe(5n * E18);
    const claimed = await st();
    expect(claimed.wallet.satori).toBeGreaterThan(105n * E18);
    // The token's hook kept the alias's power in step with the wallet's new balance (HOOK_GAS):
    // with the bare estimate it fails silently and the unstake below panics (0x11).
    expect(claimed.alias.power).toBe(claimed.wallet.satori);

    // Unstake: transfer-locked through the next round (>=), then free.
    const off = await chain.undelegate({ wallet });
    expect(off.steps).toHaveLength(1);
    const stopped = await st();
    expect(stopped.wallet.lock).toMatchObject({ locked: true, untilRound: stopped.round + 1 });
    const to = '0x000000000000000000000000000000000000dEaD';
    expect(revertName(await chain.sendSatori(wallet, to, E18).catch((e) => e))).toBe('Locked');
    await advance(RPC, 1);
    expect((await st()).wallet.lock.locked).toBe(true); // round N itself is still locked (Lite would say free)
    expect(revertName(await chain.sendSatori(wallet, to, E18).catch((e) => e))).toBe('Locked');
    await advance(RPC, 1);
    expect((await st()).wallet.lock.locked).toBe(false);
    await chain.sendSatori(wallet, to, E18);
    const { pub } = clients(RPC);
    const ethBefore = await pub.getBalance({ address: to });
    await chain.sendEth(wallet, to, 10n ** 15n);
    expect(await pub.getBalance({ address: to })).toBe(ethBefore + 10n ** 15n);
  });

  // A batch that never mines (docs/design/base.md#a-batch-that-never-mines): anvil's mining stopped (interval mining off,
  // no automine), the batch waits in its pool; after STUCK_S (0 here) its nonce is still pending, so it is sent again at
  // that nonce with a quarter more fee, which the pool takes in its place; mining again, the replacement is mined.
  test('a batch that never mines: replaced at its nonce with a higher fee, within the ceiling; past it, said and not sent', { timeout: 180_000 }, async () => {
    const { test: anvil, pub } = clients(RPC);
    const mem = () => {
      const m = new Map();
      return { m, get: async (k) => m.get(k), set: async (k, v) => void m.set(k, structuredClone(v)), checkpoint: async () => {} };
    };
    const chain = createChain({ config: DEFAULTS, transport: http(RPC), pollingInterval: 250, settle: { tries: 5, ms: 500 } });
    const staked = async () => {
      const alias = signer();
      const wallet = signer();
      await fund(RPC, [alias.evmAddress], { eth: '0.1' });
      await fund(RPC, [wallet.evmAddress], { eth: '0.1', satori: '10' });
      await chain.delegate({ alias, wallet });
      return alias;
    };
    const flat = () => ({ model: 'naive', value: 1, horizon: 86_400 }); // any forecast: the stuck path is the point
    const one = await staked();
    const two = await staked();
    let t = 1_000;
    const run = (alias, db, o = {}) => runBatch({ chain, alias, db, forecast: flat, now: () => t, pendingWaitMs: 500, sendWaitMs: 3000,
      maxFeeWei: 10n ** 9n * 2n, ...o });
    await anvil.setAutomine(false);
    await anvil.setIntervalMining({ interval: 0 }); // Base stops mining
    try {
      const db = mem();
      expect(await run(one, db)).toMatchObject({ skipped: expect.stringMatching(/^waiting for the batch already sent/), pendingAt: 1000 });
      const p = db.m.get('base_pending_batch');
      expect(await pub.getTransactionCount({ address: one.evmAddress, blockTag: 'latest' })).toBe(p.nonce); // still pending
      t += 600;
      const r = await run(one, db);
      expect(r).toMatchObject({ stuck: { replaced: 1 }, skipped: expect.stringMatching(/^stuck: retrying with a higher fee/) });
      const q = db.m.get('base_pending_batch');
      expect(q.hashes).toEqual([p.hash, q.hash]);
      expect(BigInt(q.fees.maxFeePerGas) * 4n).toBeGreaterThanOrEqual(BigInt(p.fees.maxFeePerGas) * 5n);

      // past the ceiling: nothing sent, said (another alias's batch, stuck the same way)
      const db2 = mem();
      await run(two, db2);
      const p2 = db2.m.get('base_pending_batch');
      t += 600;
      const c = await run(two, db2, { maxFeeWei: BigInt(p2.fees.maxFeePerGas) });
      expect(c).toMatchObject({ stuck: { ceiling: true }, skipped: expect.stringMatching(/would pass the max fee/) });
      expect(db2.m.get('base_pending_batch').hash).toBe(p2.hash);

      await anvil.mine({ blocks: 1 }); // Base mines again: the replacement, not the first
      const done = await run(one, db);
      expect(done).toMatchObject({ sent: { hash: q.hash } });
      expect((await chain.batchState(one.evmAddress)).predicted).toBe(1);
      expect(await pub.getTransactionReceipt({ hash: p.hash }).catch(() => null)).toBe(null); // the first never mined
      expect((await run(two, db2)).sent).toMatchObject({ hash: p2.hash }); // the other, as it was, at the old fee
    } finally {
      await anvil.setIntervalMining({ interval: 2 }); // as fork.mjs starts it
    }
  });

  // The claim rules of contract humble 5a091427 (SatoriEngine#10 / SatoriRewards#15). Skipped until the fork's
  // SatoriRewards has them (officialRelayer()): upgrade it there first, or fork after the live upgrade.
  test('claims: anyone to the owner, a named claimer anywhere, nothing elsewhere after predicting; the alias claims with no Unlock',
    { timeout: 180_000 }, async (ctx) => {
      const { test: anvil, pub } = clients(RPC);
      const R = DEFAULTS.rewards;
      const relayer = await pub.readContract({ address: R, abi: parseAbi(['function officialRelayer() view returns (address)']), functionName: 'officialRelayer' }).catch(() => null);
      if (!relayer) return ctx.skip();
      const hub = parseAbi(['function claimFor(address owner, address recipient) returns (uint256)', 'function delegateClaimAbility(address delegate)',
        'error Unauthorized()', 'error ClaimElsewhereAfterPredicting()', 'error ClaimDelegatedAway()', 'error CapabilityDisabled()']);
      // Rewards owed, written in (contract storage-layouts/): unclaimedRewards (rewards slot 13), and room to mint them,
      // which scoring would have reported (the hub's onChainMinted, slot 6, to 0).
      const owed = async (who, satori) => {
        await anvil.setStorageAt({ address: R, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, 13n])),
          value: toHex(BigInt(satori) * E18, { size: 32 }) });
        await anvil.setStorageAt({ address: DEFAULTS.hub, index: toHex(6n, { size: 32 }), value: toHex(0n, { size: 32 }) });
      };
      const as = async (from, functionName, args) => {
        await anvil.impersonateAccount({ address: from });
        await anvil.setBalance({ address: from, value: 10n ** 17n });
        try {
          await pub.simulateContract({ account: from, address: DEFAULTS.hub, abi: hub, functionName, args });
        } catch (err) { return revertName(err); }
        const hash = await createWalletClient({ account: from, chain: baseSepolia, transport: http(RPC) })
          .writeContract({ address: DEFAULTS.hub, abi: hub, functionName, args });
        return (await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 })).status;
      };
      const satori = (a) => pub.readContract({ address: DEFAULTS.token, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [a] });
      const stranger = signer().evmAddress;
      const elsewhere = signer().evmAddress;
      const give = async (who, n) => { // SATORI to spend (fork.mjs's fund takes it from the deployer, empty since 2026-10-28)
        await fund(RPC, [who], { eth: '0.1' });
        await owed(who, n);
        expect(await as(stranger, 'claimFor', [who, who])).toBe('success');
      };

      // Anyone may claim to the owner, never elsewhere.
      const V = signer().evmAddress;
      await owed(V, 3);
      expect(await as(stranger, 'claimFor', [V, elsewhere])).toBe('Unauthorized');
      expect(await as(stranger, 'claimFor', [V, V])).toBe('success');
      expect(await satori(V)).toBe(3n * E18);

      // A named claimer still claims anywhere; then no stranger claims, and the owner names itself to opt out.
      // Naming one is a capability (6), off on Base Sepolia for all but the admin: switched on here (rewards' _CAP_SLOT).
      const CAP = '0x27cad01dc4254e9bdafe1f698ebd1d17b1c95ec4178340a9736b0bd1b3f5eb71';
      const caps = BigInt(await pub.getStorageAt({ address: R, slot: CAP }));
      await anvil.setStorageAt({ address: R, index: CAP, value: toHex(caps | (1n << 6n), { size: 32 }) });
      const C = signer().evmAddress;
      expect(await as(V, 'delegateClaimAbility', [C])).toBe('success');
      await owed(V, 2);
      expect(await as(stranger, 'claimFor', [V, V])).toBe('Unauthorized');
      expect(await as(C, 'claimFor', [V, elsewhere])).toBe('success');
      expect(await satori(elsewhere)).toBe(2n * E18);

      // After the owner predicts this round, nothing goes elsewhere, by its claimer or itself; to itself still works.
      const self = signer();
      const W = self.evmAddress;
      await give(W, 10);
      await advance(RPC, 1); // a round the deployer's earlier predictions don't share
      await chain().sendBatch(self, [{ gameId: 1, direction: DOWN }]);
      await owed(W, 1);
      expect(await as(W, 'claimFor', [W, elsewhere])).toBe('ClaimElsewhereAfterPredicting');
      expect(await as(W, 'delegateClaimAbility', [C])).toBe('success');
      expect(await as(C, 'claimFor', [W, elsewhere])).toBe('ClaimElsewhereAfterPredicting');
      expect(await as(C, 'claimFor', [W, W])).toBe('success');

      // The app: a staked wallet's rewards, claimed by its alias, the wallet never unlocked.
      const alias = signer();
      const wallet = signer();
      await fund(RPC, [alias.evmAddress], { eth: '0.1' });
      await give(wallet.evmAddress, 10);
      await chain().delegate({ alias, wallet });
      await owed(wallet.evmAddress, 4);
      expect(await chain().canClaimFor(alias.evmAddress, wallet.evmAddress)).toBe(null);
      const m = new Map();
      const base = createBase({ db: { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v), checkpoint: async () => {} },
        alias, walletAddress: wallet.evmAddress, wallet: () => null, transport: http(RPC), setTimeout: () => 0, clearTimeout: () => {},
        central: () => ({ url: 'https://central2.example', baseConfig: async () => { throw new CentralError(404, 'Not Found'); },
          merkleProof: async () => { throw new CentralError(404, 'no reward drop has been published yet'); } }) });
      expect(await base.claimNeedsWallet()).toBe(false);
      const before = await satori(wallet.evmAddress);
      const r = await base.claim();
      expect(r.rewards).toMatchObject({ by: 'alias', hash: expect.stringMatching(/^0x/) });
      expect(await satori(wallet.evmAddress)).toBe(before + 4n * E18);
    });

  // The dev fee's splitters as deployed (docs/design/devfee.md): a payee of C hands its slot to a throwaway wallet
  // (impersonated, here only), which then reads the tree and claims, what waits in A moved down first.
  test('the dev fee: a slot in C read from the token down, then claimed through A', { timeout: 120_000 }, async () => {
    const { test: anvil, pub } = clients(RPC);
    const sp = parseAbi(['function getSlot(uint256) view returns (address, uint256)', 'function rotateRecipient(address)']);
    const C = '0x52b7ee858379509F7bDBc239da0F1ff36bEAd2ed';
    const [payee] = await pub.readContract({ address: C, abi: sp, functionName: 'getSlot', args: [0n] });
    const w = signer();
    await anvil.impersonateAccount({ address: payee });
    await anvil.setBalance({ address: payee, value: 10n ** 17n });
    const hash = await createWalletClient({ account: payee, chain: baseSepolia, transport: http(RPC) })
      .writeContract({ address: C, abi: sp, functionName: 'rotateRecipient', args: [w.evmAddress] });
    await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    await fund(RPC, [w.evmAddress], { eth: '0.1' });

    const t = await devFeeOf(chain(), w.evmAddress);
    expect(t.shown).toBe(true);
    expect(t.nodes.map((n) => n.address)).toEqual([DEFAULTS_TOP, C, '0xc082CCc8D827b58bC848d5918Ca92eEe5C06F5f7']);
    const mine = t.mine[0];
    expect(mine).toMatchObject({ node: C, slotId: 0, shares: 5000n, wholeBps: 3000n });
    const owed = mine.claimable + mine.waiting;
    expect(owed).toBeGreaterThan(0n); // A holds the dev fee of every round since D8
    const txs = await devFeeOps.claim(chain(), w, t, C, { step: () => {}, opts: () => ({}) });
    expect(txs.map((x) => x.label)).toEqual(mine.waiting > 0n ? ['Moved down', 'Claimed'] : ['Claimed']);
    const got = await pub.readContract({ address: DEFAULTS.token, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [w.evmAddress] });
    expect(got).toBeGreaterThanOrEqual(owed); // and a little more: rounds the fork's clock moved on add to A
    const after = (await devFeeOf(chain(), w.evmAddress)).mine[0];
    expect(after.claimable).toBe(0n);
  });

  // The admin as deployed (docs/design/admin.md): the admin (impersonated, here only) hands it to a throwaway wallet,
  // which reads the levers and pulls each one.
  test('the admin: handed to a throwaway, which reads and sets the capabilities, the relayer, the fee, the reporter', { timeout: 120_000 }, async () => {
    const { test: anvil, pub } = clients(RPC);
    const w = signer();
    const before = await adminRole(chain(), w.evmAddress);
    expect(before.isAdmin).toBe(false);
    await anvil.impersonateAccount({ address: before.admin });
    await anvil.setBalance({ address: before.admin, value: 10n ** 17n });
    const hash = await createWalletClient({ account: before.admin, chain: baseSepolia, transport: http(RPC) })
      .writeContract({ address: DEFAULTS.rewards, abi: parseAbi(['function setAdmin(address)']), functionName: 'setAdmin', args: [w.evmAddress] });
    await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    await fund(RPC, [w.evmAddress], { eth: '0.1' });
    const run = { step: () => {}, opts: () => ({}) };

    expect((await adminRole(chain(), w.evmAddress)).isAdmin).toBe(true);
    const was = await adminState(chain());
    expect(was.games[0]).toMatchObject({ streamId: 1, gameId: 1, isDefault: true, approved: true });
    const on = was.capabilities.filter((c) => c.on).map((c) => c.bit);
    await adminOps.capabilities(chain(), w, [...on, 6], run);
    await adminOps.relayer(chain(), w, w.evmAddress, run);
    await adminOps.registrationFee(chain(), w, '2', run);
    await adminOps.reporter(chain(), w, w.evmAddress, run);
    const now = await adminState(chain());
    expect(now.capabilities.filter((c) => c.on).map((c) => c.bit)).toEqual([...on, 6].sort());
    expect(now).toMatchObject({ relayer: w.evmAddress, registrationFee: 2n * 10n ** 18n, reporter: w.evmAddress });
    await expect(adminOps.game(chain(), w, 1, false, run)).rejects.toThrow('always approved');
    await adminOps.transfer(chain(), w, before.admin, run);
    expect((await adminRole(chain(), w.evmAddress)).isAdmin).toBe(false);
  });

  // The other special keys as deployed (docs/design/roles.md): each handed to a throwaway wallet by its holder
  // (impersonated, here only: the Safe for appoint and wiring, the deployer for the rest), which reads them all and
  // pulls a lever of each.
  test('the special keys: handed to a throwaway, which reads each page and acts on it', { timeout: 180_000 }, async () => {
    const { test: anvil, pub } = clients(RPC);
    const w = signer();
    const as = async (from, address, sig, args) => {
      await anvil.impersonateAccount({ address: from });
      await anvil.setBalance({ address: from, value: 10n ** 17n });
      const hash = await createWalletClient({ account: from, chain: baseSepolia, transport: http(RPC) })
        .writeContract({ address, abi: parseAbi([`function ${sig}`]), functionName: sig.split('(')[0], args });
      await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    };
    const read = (address, sig) => pub.readContract({ address, abi: parseAbi([`function ${sig}`]), functionName: sig.split('(')[0] });
    const root = await read(DEFAULTS.token, 'rootAuthority() view returns (address)');
    const admin = await read(DEFAULTS.rewards, 'admin() view returns (address)');
    const publisher = await read(DEFAULTS.merkle, 'rootPublisher() view returns (address)');
    await as(root, DEFAULTS.token, 'setAppointAuthority(address)', [w.evmAddress]);
    await as(root, DEFAULTS.token, 'setWiringAuthority(address)', [w.evmAddress]);
    await as(admin, DEFAULTS.rewards, 'setEmissionSplitAuthority(address)', [w.evmAddress]);
    await as(admin, DEFAULTS.hub, 'setEmissionAuthority(address)', [w.evmAddress]);
    await as(publisher, DEFAULTS.merkle, 'setRootPublisher(address)', [w.evmAddress]);
    await fund(RPC, [w.evmAddress], { eth: '0.1' });
    const run = { step: () => {}, opts: () => ({}) };
    const act = async (role, action, typed) => roleAct(chain(), w, await rolesOf(chain(), w.evmAddress), role, action, typed, run);

    let r = await rolesOf(chain(), w.evmAddress);
    expect(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [v.isHolder, v.isPending]]))).toEqual({
      split: [true, false], schedule: [true, false], publisher: [false, true], appoint: [true, false], wiring: [true, false] });
    await act('publisher', 'accept');
    await act('split', 'share', '40');
    await act('schedule', 'ratio', '1');
    await act('appoint', 'floor', '3');
    await act('wiring', 'voteLock', r.wiring.values.voteLock);
    r = await rolesOf(chain(), w.evmAddress);
    expect(r.publisher.isHolder).toBe(true);
    expect(r.split.values.share).toBe(4000n);
    expect(r.schedule.values.e[5]).toBe(10n ** 18n);
    expect(r.appoint.values.curve[0]).toBe(3n);
    await expect(act('appoint', 'bottom', '1')).rejects.toThrow("can't be below the top gradient");
  });
});
