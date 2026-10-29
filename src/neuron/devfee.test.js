// The dev fee's splitters (docs/design/devfee.md) against test/fake-satori.js's tree: A 60 % C, 40 % B; C and B 50/50.
import { beforeEach, describe, expect, test } from 'vitest';
import { zeroAddress } from 'viem';
import { publicKey, evmAddress, signDigest } from '../keys/keys.js';
import { DEFAULTS } from '../chain/config.js';
import { createChain, revertName } from '../chain/index.js';
import { fakeSatori, E18, SPLIT_A, SPLIT_B, SPLIT_C } from '../../test/fake-satori.js';
import { devFeeOf, devFeeOps, proposalOf } from './devfee.js';

const signerOf = (hex) => {
  const secret = Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
  return { evmAddress: evmAddress(publicKey(secret)), signDigest: (h) => signDigest(secret, h) };
};
const wallet = signerOf('22'.repeat(32));
const other = signerOf('33'.repeat(32));
const V = wallet.evmAddress.toLowerCase();
const O = other.evmAddress.toLowerCase();
const NEW = `0x${'ab'.repeat(20)}`;
const run = { step: () => {}, opts: () => ({}) };

let s, chain;
const setup = (arrange = () => {}) => {
  const f = fakeSatori({ eth: { [V]: 10n ** 16n, [O]: 10n ** 16n } });
  s = f.s;
  arrange(s);
  chain = createChain({ config: DEFAULTS, transport: f.rpc.transport, pollingInterval: 1, settle: { tries: 5, ms: 1 } });
};
const tree = () => devFeeOf(chain, wallet.evmAddress);
const lc = (a) => a.toLowerCase();

describe('the tree and the wallet in it', () => {
  test('not in it: not shown; the tree walked from the token (A, then C and B)', async () => {
    setup();
    const t = await tree();
    expect(t.shown).toBe(false);
    expect(lc(t.top)).toBe(SPLIT_A);
    expect(t.nodes.map((n) => [lc(n.address), n.parent && lc(n.parent), n.parentSlotId])).toEqual([[SPLIT_A, null, null], [SPLIT_C, SPLIT_A, 0], [SPLIT_B, SPLIT_A, 1]]);
    expect(t.mine).toEqual([]);
  });

  test("a slot in C: shown, its share of C and of the whole fee, claimable, and what waits in A for C", async () => {
    setup((x) => {
      x.splitters[SPLIT_C].slots[0].payee = V;
      x.balance[SPLIT_A] = 100n * E18; // C's 60 % is 60, the wallet's half of it 30
      x.balance[SPLIT_C] = 10n * E18; // already in C: the wallet's half, 5
    });
    const t = await tree();
    expect(t.shown).toBe(true);
    expect(t.mine).toEqual([{ node: expect.stringMatching(/^0x52b7/i), slotId: 0, shares: 5000n, wholeBps: 3000n, claimable: 5n * E18,
      waiting: 30n * E18, trigger: zeroAddress }]);
  });

  test("the authority, or offered it: shown with no slot", async () => {
    setup((x) => { x.splitters[SPLIT_B].authority = V; });
    expect((await tree()).shown).toBe(true);
    setup((x) => { x.splitters[SPLIT_C].pending = V; });
    const t = await tree();
    expect(t.shown).toBe(true);
    expect(t.nodes.find((n) => lc(n.address) === SPLIT_C)).toMatchObject({ isOffered: true, isAuthority: false });
  });
});

describe('the actions', () => {
  beforeEach(() => setup((x) => {
    x.splitters[SPLIT_C].slots[0].payee = V;
    x.balance[SPLIT_A] = 100n * E18;
    x.balance[SPLIT_C] = 10n * E18;
  }));

  test('Claim: what waits in A moved down to C first, then the slot paid: 35 SATORI to the wallet', async () => {
    const steps = [];
    const txs = await devFeeOps.claim(chain, wallet, await tree(), SPLIT_C, { ...run, step: (...x) => steps.push(x) });
    expect(txs.map((x) => x.label)).toEqual(['Moved down', 'Claimed']);
    expect(steps).toEqual([['move', 1, 2], ['claim', 2, 2]]);
    expect(s.balance[V]).toBe(35n * E18);
    const t = await tree();
    expect(t.mine[0]).toMatchObject({ claimable: 0n, waiting: 0n });
    await expect(devFeeOps.claim(chain, wallet, t, SPLIT_C, run)).rejects.toThrow('Nothing to claim yet.');
  });

  test('nothing waiting above: one transaction', async () => {
    s.balance[SPLIT_A] = 0n;
    const txs = await devFeeOps.claim(chain, wallet, await tree(), SPLIT_C, run);
    expect(txs.map((x) => x.label)).toEqual(['Claimed']);
    expect(s.balance[V]).toBe(5n * E18);
  });

  test('who may trigger the payout: one address, then anyone again', async () => {
    await devFeeOps.trigger(chain, wallet, await tree(), SPLIT_C, O, run);
    expect((await tree()).mine[0].trigger.toLowerCase()).toBe(O);
    const r = await chain.splitterWrite(other, SPLIT_B, 'withdraw', [DEFAULTS.token, 0n]).catch((e) => e); // another slot: nothing there
    expect(revertName(r)).toBe('NothingToWithdraw');
    await devFeeOps.trigger(chain, wallet, await tree(), SPLIT_C, '', run);
    expect((await tree()).mine[0].trigger).toBe(zeroAddress);
  });

  test('Move the slot: refused for the splitter itself and a payee already there; else moved, and the wallet is out', async () => {
    const t = await tree();
    await expect(devFeeOps.moveSlot(chain, wallet, t, SPLIT_C, SPLIT_C, run)).rejects.toThrow('the slot would be lost for good');
    await expect(devFeeOps.moveSlot(chain, wallet, t, SPLIT_C, `0x${'c2'.repeat(20)}`, run)).rejects.toThrow('already holds a slot');
    await expect(devFeeOps.moveSlot(chain, wallet, t, SPLIT_C, 'nope', run)).rejects.toThrow('not a valid address');
    await devFeeOps.moveSlot(chain, wallet, t, SPLIT_C, NEW, run);
    expect(s.splitters[SPLIT_C].slots[0].payee).toBe(NEW);
    expect((await tree()).shown).toBe(false);
  });

  test('Redirect C: the tally, my agreement and taking it back; carried out once enough agree (C needs 90 %: both)', async () => {
    let p = await proposalOf(chain, await tree(), SPLIT_C, NEW);
    expect(p).toMatchObject({ agreedBps: 0n, thresholdBps: 9000n, cleared: false, iAgreed: false });
    await devFeeOps.vote(chain, wallet, await tree(), SPLIT_C, NEW, run);
    p = await proposalOf(chain, await tree(), SPLIT_C, NEW);
    expect(p).toMatchObject({ agreedBps: 5000n, cleared: false, iAgreed: true });
    const early = await devFeeOps.redirect(chain, wallet, await tree(), SPLIT_C, NEW, run).catch((e) => e);
    expect(revertName(early)).toBe('InsufficientConsent');
    await devFeeOps.unvote(chain, wallet, await tree(), SPLIT_C, NEW, run);
    expect((await proposalOf(chain, await tree(), SPLIT_C, NEW)).iAgreed).toBe(false);
    s.splitters[SPLIT_C].approvals = {}; // both agree
    await devFeeOps.vote(chain, wallet, await tree(), SPLIT_C, NEW, run);
    s.splitters[SPLIT_C].slots[1].payee = O;
    await devFeeOps.vote(chain, other, await devFeeOf(chain, other.evmAddress), SPLIT_C, NEW, run);
    expect((await proposalOf(chain, await tree(), SPLIT_C, NEW)).cleared).toBe(true);
    await devFeeOps.redirect(chain, wallet, await tree(), SPLIT_C, NEW, run);
    expect(s.splitters[SPLIT_A].slots[0].payee).toBe(NEW);
    await expect(devFeeOps.redirect(chain, wallet, await tree(), SPLIT_A, NEW, run)).rejects.toThrow('The top splitter has no slot');
  });

  test('the authority: redirects alone; offers it, the other accepts; gives it up', async () => {
    s.splitters[SPLIT_B].authority = V;
    await devFeeOps.redirect(chain, wallet, await tree(), SPLIT_B, NEW, run);
    expect(s.splitters[SPLIT_A].slots[1].payee).toBe(NEW);
    setup((x) => { x.splitters[SPLIT_B].authority = V; });
    await devFeeOps.offer(chain, wallet, await tree(), SPLIT_B, O, run);
    expect(s.splitters[SPLIT_B].pending).toBe(O);
    await devFeeOps.accept(chain, other, await devFeeOf(chain, other.evmAddress), SPLIT_B, run);
    expect(s.splitters[SPLIT_B].authority).toBe(O);
    await devFeeOps.giveUp(chain, other, await devFeeOf(chain, other.evmAddress), SPLIT_B, run);
    expect(s.splitters[SPLIT_B].authority).toBe(zeroAddress);
  });
});
