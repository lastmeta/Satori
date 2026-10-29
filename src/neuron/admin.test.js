// The admin's levers (docs/design/admin.md) against test/fake-satori.js: capability bits 0, 1, 5, 7 on, as live.
import { beforeEach, describe, expect, test } from 'vitest';
import { zeroAddress } from 'viem';
import { publicKey, evmAddress, signDigest } from '../keys/keys.js';
import { DEFAULTS } from '../chain/config.js';
import { createChain, revertName } from '../chain/index.js';
import { fakeSatori, ADMIN } from '../../test/fake-satori.js';
import { adminOps, adminRole, adminState } from './admin.js';

const signerOf = (hex) => {
  const secret = Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
  return { evmAddress: evmAddress(publicKey(secret)), signDigest: (h) => signDigest(secret, h) };
};
const wallet = signerOf('22'.repeat(32));
const V = wallet.evmAddress.toLowerCase();
const NEW = `0x${'ab'.repeat(20)}`;
const run = { step: () => {}, opts: () => ({}) };

let s, chain;
beforeEach(() => {
  const f = fakeSatori({ eth: { [V]: 10n ** 16n } });
  s = f.s;
  s.streams[2] = { game: 2, named: false, cadence: 1440, history: [], name: 'btc' };
  chain = createChain({ config: DEFAULTS, transport: f.rpc.transport, pollingInterval: 1, settle: { tries: 5, ms: 1 } });
});

test('the role: only the admin is it', async () => {
  expect(await adminRole(chain, wallet.evmAddress)).toEqual({ admin: expect.stringMatching(/^0xa0a0/i), isAdmin: false });
  s.admin = V;
  expect((await adminRole(chain, wallet.evmAddress)).isAdmin).toBe(true);
});

test("the levers as they stand: the capabilities bit by bit, the relayer, the fee, the reporter, each stream's game", async () => {
  const a = await adminState(chain);
  expect(a.capabilities.filter((c) => c.on).map((c) => c.bit)).toEqual([0, 1, 5, 7]);
  expect(a).toMatchObject({ relayer: zeroAddress, registrationFee: 10n ** 15n, reporter: zeroAddress });
  expect(a.games).toEqual([{ streamId: 1, gameId: 1, name: 'satori', approved: true, isDefault: true },
    { streamId: 2, gameId: 2, name: 'btc', approved: false, isDefault: false }]);
});

describe('the actions', () => {
  beforeEach(() => { s.admin = V; });

  test('capabilities: the whole mask at once', async () => {
    await adminOps.capabilities(chain, wallet, [0, 1, 5, 6, 7], run);
    expect(s.caps).toBe(0xe3n);
    await expect(adminOps.capabilities(chain, wallet, [9], run)).rejects.toThrow('not one of the capabilities');
  });

  test('a game approved and disapproved; the default game refused', async () => {
    await adminOps.game(chain, wallet, 2, true, run);
    expect(s.approved[2]).toBe(true);
    expect((await adminState(chain)).games[1].approved).toBe(true);
    await adminOps.game(chain, wallet, 2, false, run);
    expect(s.approved[2]).toBe(false);
    await expect(adminOps.game(chain, wallet, 1, false, run)).rejects.toThrow('always approved');
  });

  test('the relayer, the reporter (empty: none), the registration fee', async () => {
    await adminOps.relayer(chain, wallet, NEW, run);
    expect(s.relayer).toBe(NEW);
    await adminOps.relayer(chain, wallet, '', run);
    expect(s.relayer).toBe(zeroAddress);
    await adminOps.reporter(chain, wallet, NEW, run);
    expect(s.reporter).toBe(NEW);
    await adminOps.registrationFee(chain, wallet, '2.5', run);
    expect(s.regFee).toBe(25n * 10n ** 17n);
    await expect(adminOps.registrationFee(chain, wallet, '0', run)).rejects.toThrow('above 0');
    await expect(adminOps.relayer(chain, wallet, 'nope', run)).rejects.toThrow('not a valid address');
  });

  test('an official adapter registered, of either kind', async () => {
    await adminOps.registerAdapter(chain, wallet, 'stream', NEW, ' Prices ', run);
    await adminOps.registerAdapter(chain, wallet, 'game', NEW, 'Ranges', run);
    expect(s.adapters).toEqual([{ kind: 'stream', impl: NEW, name: 'Prices' }, { kind: 'game', impl: NEW, name: 'Ranges' }]);
    await expect(adminOps.registerAdapter(chain, wallet, 'game', NEW, '', run)).rejects.toThrow('name');
  });

  test('the admin handed on; then the chain refuses this wallet', async () => {
    await adminOps.transfer(chain, wallet, NEW, run);
    expect(s.admin).toBe(NEW);
    expect(revertName(await adminOps.relayer(chain, wallet, NEW, run).catch((e) => e))).toBe('Unauthorized');
    expect(ADMIN).not.toBe(NEW);
  });
});
