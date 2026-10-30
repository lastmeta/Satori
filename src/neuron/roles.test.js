// The special keys (docs/design/roles.md) against test/fake-satori.js: the admin's address holds them all, as live.
import { beforeEach, describe, expect, test } from 'vitest';
import { zeroAddress } from 'viem';
import { publicKey, evmAddress, signDigest } from '../keys/keys.js';
import { DEFAULTS } from '../chain/config.js';
import { createChain } from '../chain/index.js';
import { fakeSatori, E18 } from '../../test/fake-satori.js';
import { ROLES, doneText, roleAct, rolesOf, valueOf } from './roles.js';

const signerOf = (hex) => {
  const secret = Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
  return { evmAddress: evmAddress(publicKey(secret)), signDigest: (h) => signDigest(secret, h) };
};
const wallet = signerOf('22'.repeat(32));
const V = wallet.evmAddress.toLowerCase();
const NEW = `0x${'ab'.repeat(20)}`;
const run = { step: () => {}, opts: () => ({}) };

let s, chain;
const roles = () => rolesOf(chain, wallet.evmAddress);
const act = async (role, action, typed) => roleAct(chain, wallet, await roles(), role, action, typed, run);
beforeEach(() => {
  const f = fakeSatori({ eth: { [V]: 10n ** 16n } });
  s = f.s;
  chain = createChain({ config: DEFAULTS, transport: f.rpc.transport, pollingInterval: 1, settle: { tries: 5, ms: 1 } });
});

test('none held: no values read; the holders as the contracts say (split and schedule: the admin, unless set)', async () => {
  const r = await roles();
  expect(Object.values(r).every((x) => !x.held && x.values === null)).toBe(true);
  expect(r.split.holder.toLowerCase()).toBe(s.admin);
  s.splitSet = NEW;
  expect((await roles()).split.holder.toLowerCase()).toBe(NEW);
});

test('all held (the deployer, as live): each page reads its values', async () => {
  Object.assign(s, { admin: V, appoint: V, wiring: V, publisher: V });
  const r = await roles();
  expect(ROLES.map((x) => r[x.id].isHolder)).toEqual([true, true, true, true, true]);
  expect(ROLES.find((x) => x.id === 'split').facts(r.split.values)).toEqual([['Off-chain share', '50%'], ['On-chain share', '50%']]);
  expect(ROLES.find((x) => x.id === 'schedule').facts(r.schedule.values)).toContainEqual(['Multiplier', '× 0.999708061412966511']);
  expect(r.appoint.values.curve).toEqual([2n, 3n, 12n, 0n]);
  expect(r.wiring.values.voteLockFrozen).toBe(false);
});

describe('the actions', () => {
  beforeEach(() => { Object.assign(s, { admin: V, appoint: V, wiring: V, publisher: V }); });

  test('the split: a share, then handed on (empty gives it back to the admin)', async () => {
    await act('split', 'share', '12.5');
    expect(s.share).toBe(1250n);
    await expect(act('split', 'share', '100')).rejects.toThrow('below 100');
    await expect(act('split', 'share', '1.234')).rejects.toThrow('Give a percent');
    await act('split', 'hand', NEW);
    expect(s.splitSet).toBe(NEW);
    expect((await roles()).split.isHolder).toBe(false);
    await expect(act('split', 'share', '10')).rejects.toThrow("doesn't hold the emission split key");
  });

  test('the schedule: the multiplier, never under 0.001', async () => {
    await act('schedule', 'ratio', '1');
    expect(s.emission.ratioWad).toBe(E18);
    await expect(act('schedule', 'ratio', '0.0001')).rejects.toThrow('at least 0.001');
    expect(doneText('schedule', 'ratio', '1')).toBe('The multiplier is × 1.0 from the next step.');
  });

  test('the publisher: a root; the job offered, accepted by the other', async () => {
    const root = `0x${'34'.repeat(32)}`;
    await act('publisher', 'root', root);
    expect(s.root).toBe(root);
    await expect(act('publisher', 'root', '0x12')).rejects.toThrow('64 hex digits');
    await act('publisher', 'offer', NEW);
    expect(s.pendingPublisher).toBe(NEW);
    await expect(act('publisher', 'accept')).rejects.toThrow("can't do that");
  });

  test('offered the publisher job: shown, Accept only', async () => {
    Object.assign(s, { publisher: `0x${'99'.repeat(20)}`, pendingPublisher: V });
    const r = (await roles()).publisher;
    expect(r).toMatchObject({ held: true, isHolder: false, isPending: true });
    await expect(act('publisher', 'root', `0x${'34'.repeat(32)}`)).rejects.toThrow('accept it first');
    await act('publisher', 'accept');
    expect(s.publisher).toBe(V);
  });

  test('appoint: the admin and the job holders replaced; the curve within its bounds, g ≤ r', async () => {
    await act('appoint', 'loader', NEW);
    expect(s.loader).toBe(NEW);
    await act('appoint', 'schedule', NEW);
    expect(s.scheduleSet).toBe(NEW);
    await act('appoint', 'floor', '4');
    await act('appoint', 'target', '40');
    expect([s.curve[0], s.target]).toEqual([4n, 4000n]);
    await expect(act('appoint', 'top', '13')).rejects.toThrow('from 1 to 8');
    await expect(act('appoint', 'bottom', '2')).rejects.toThrow("can't be below the top gradient (3)");
    await act('appoint', 'admin', NEW);
    expect(s.admin).toBe(NEW);
  });

  test('wiring: a lever moved; a frozen one refused; the vote-lock frozen for good', async () => {
    await act('wiring', 'bridge', NEW);
    expect(s.bridge).toBe(NEW);
    await expect(act('wiring', 'controller', '')).rejects.toThrow('not a valid address');
    s.frozen.hook = true;
    await expect(act('wiring', 'hook', NEW)).rejects.toThrow('Transfer hook is frozen');
    await act('wiring', 'freezeVoteLock');
    expect(s.frozen.voteLock).toBe(true);
    await expect(act('wiring', 'freezeVoteLock')).rejects.toThrow("can't do that");
    expect(valueOf('wiring', 'voteLock', '')).toBe(zeroAddress);
  });
});
