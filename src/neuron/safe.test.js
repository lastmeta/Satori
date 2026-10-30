// The Safe's keys (docs/design/safe.md) against test/fake-satori.js's Safe (3 of 5) and a faked Safe service.
import { beforeEach, expect, test } from 'vitest';
import { publicKey, evmAddress, signDigest } from '../keys/keys.js';
import { DEFAULTS } from '../chain/config.js';
import { createChain, revertName } from '../chain/index.js';
import { safeService } from '../chain/safe.js';
import { fakeSatori, E18 } from '../../test/fake-satori.js';
import { fakeSafeService } from '../../test/fake-safe-service.js';
import { describe, executeSafe, pendingOf, proposeSafe, safesOf, signSafe } from './safe.js';

const signerOf = (hex) => {
  const secret = Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
  return { evmAddress: evmAddress(publicKey(secret)), signDigest: (h) => signDigest(secret, h) };
};
const [me, two, three] = ['22', '33', '44'].map((x) => signerOf(x.repeat(32)));
const NEW = `0x${'ab'.repeat(20)}`;
const run = { step: () => {}, opts: () => ({}) };

let s, chain, svc, service;
beforeEach(() => {
  const f = fakeSatori({ eth: { [me.evmAddress.toLowerCase()]: 10n ** 16n } });
  s = f.s;
  s.safe.owners.splice(0, 3, me.evmAddress, two.evmAddress, three.evmAddress);
  chain = createChain({ config: DEFAULTS, transport: f.rpc.transport, pollingInterval: 1, settle: { tries: 5, ms: 1 } });
  svc = fakeSafeService();
  service = safeService({ url: 'https://api.safe.global/tx-service/basesep', fetch: svc.fetch });
});
const safe = async (who = me) => (await safesOf(chain, who.evmAddress)).safes[0];
const pending = async (who = me) => pendingOf(chain, service, await safe(who), who.evmAddress);

test('an owner sees the Safe, its keys and their values; anyone else none', async () => {
  const x = await safe();
  expect(x).toMatchObject({ threshold: 3n, nonce: 0n });
  expect(Object.keys(x.keys)).toEqual(['root', 'fee', 'upgrade', 'freeze', 'loader']);
  expect(x.keys.fee).toMatchObject({ bps: 1500n, pending: 0n, frozen: false });
  expect((await safesOf(chain, NEW)).safes).toEqual([]);
});

test('proposed by one owner, signed by two more, executed: the dev fee proposed through the Safe', async () => {
  const { safeTxHash, nonce } = await proposeSafe(chain, service, me, await safe(), [], 'fee', 'propose', '12');
  expect(nonce).toBe(0n);
  let p = await pending();
  expect(p).toEqual([expect.objectContaining({ safeTxHash, description: 'Propose a dev fee of 12%', signedByMe: true, enough: false, next: true })]);
  await expect(signSafe(chain, service, me, await safe(), p, safeTxHash)).rejects.toThrow('signed it already');
  await expect(executeSafe(chain, me, await safe(), p, safeTxHash, run)).rejects.toThrow('needs 3 signatures; it has 1');
  await signSafe(chain, service, two, await safe(two), await pending(two), safeTxHash);
  await signSafe(chain, service, three, await safe(three), await pending(three), safeTxHash);
  p = await pending();
  expect(p[0]).toMatchObject({ enough: true });
  await executeSafe(chain, me, await safe(), p, safeTxHash, run);
  expect(s.devFee.pending).toBe(1200n);
  expect(s.safe.nonce).toBe(1n);
});

test('a second proposal takes the next nonce; it waits for the first', async () => {
  const a = await proposeSafe(chain, service, me, await safe(), [], 'freeze', 'hook');
  const b = await proposeSafe(chain, service, me, await safe(), await pending(), 'upgrade', 'upgrade', `hub ${NEW}`);
  expect([a.nonce, b.nonce]).toEqual([0n, 1n]);
  const p = await pending();
  expect(p.map((t) => t.description.toLowerCase())).toEqual(['freeze the transfer hook, for good', 'upgrade hub to 0xabab…abab']);
  await expect(executeSafe(chain, me, await safe(), p, b.safeTxHash, run)).rejects.toThrow("Execute the Safe's transaction 0 first");
});

test("the checks the contracts make, before anything is signed", async () => {
  await expect(proposeSafe(chain, service, me, await safe(), [], 'fee', 'propose', '30')).rejects.toThrow('from 5% to 25%');
  await expect(proposeSafe(chain, service, me, await safe(), [], 'fee', 'accept')).rejects.toThrow('not now');
  await expect(proposeSafe(chain, service, me, await safe(), [], 'upgrade', 'upgrade', `token ${NEW}`)).rejects.toThrow('Pick a contract');
  await expect(proposeSafe(chain, service, me, await safe(), [], 'loader', 'load', `${NEW}, 5\n${NEW}, 6`)).rejects.toThrow('in the batch twice');
  expect(svc.txs).toEqual([]);
});

test('an airdrop batch through the Safe; a call the app does not know is said as such', async () => {
  const { safeTxHash } = await proposeSafe(chain, service, me, await safe(), [], 'loader', 'load', `${NEW}, 1000\n0x${'cd'.repeat(20)}, 250.5`);
  for (const o of [two, three]) await signSafe(chain, service, o, await safe(o), await pending(o), safeTxHash);
  const p = await pending();
  expect(p[0].description).toBe('Load 2 airdrop rows, 1,250.5 SATORI in all');
  await executeSafe(chain, me, await safe(), p, safeTxHash, run);
  expect(s.airdropLoaded).toBe(12505n * E18 / 10n);
  expect(describe(chain, { to: NEW, data: '0x12345678' })).toBe('A call to 0xabab…abab (not one of Satori\'s)');
  expect(revertName(new Error('x'))).toBe(null);
});
