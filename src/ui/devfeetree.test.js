// The Dev Fee picture's layout (src/ui/devfeetree.js) for test/fake-satori.js's tree: A 60 % C, 40 % B; C and B 50/50.
import { expect, test } from 'vitest';
import { publicKey, evmAddress } from '../keys/keys.js';
import { DEFAULTS } from '../chain/config.js';
import { createChain } from '../chain/index.js';
import { devFeeOf } from '../neuron/devfee.js';
import { fakeSatori, E18, SPLIT_A, SPLIT_B, SPLIT_C } from '../../test/fake-satori.js';
import { treeLayout } from './devfeetree.js';

const V = evmAddress(publicKey(Uint8Array.from({ length: 32 }, () => 0x22))).toLowerCase();
const read = async (arrange) => {
  const f = fakeSatori();
  arrange(f.s);
  return devFeeOf(createChain({ config: DEFAULTS, transport: f.rpc.transport, pollingInterval: 1 }), V);
};
const of = (L, kind) => L.items.filter((n) => n.kind === kind);

test('a payee of C: the top, C and B with their authorities, four payees with what they have not claimed; the wallet green, its two lines worded', async () => {
  const L = treeLayout(await read((s) => {
    s.splitters[SPLIT_C].slots[0].payee = V;
    s.balance[SPLIT_A] = 100n * E18;
    s.balance[SPLIT_C] = 10n * E18;
  }));
  expect(of(L, 'box').map((b) => [b.title, ...b.lines.map((l) => l.text)])).toEqual([
    ['Top splitter 0x6C57…4238', "The token's dev fee goes here"],
    ['Splitter 0x52b7…d2ed', expect.stringMatching(/^(Authority 0x|No authority)/), '90% must agree to redirect'],
    ['Splitter 0xc082…F5f7', expect.stringMatching(/^(Authority 0x|No authority)/), '90% must agree to redirect']]);
  expect(of(L, 'pct').map((p) => p.text)).toEqual(['60%', '50%', '50%', '40%', '50%', '50%']);
  // C's payees: 5 each in C plus 30 each waiting in A; B's: 20 each waiting in A
  expect(of(L, 'dot').map((d) => [d.name, d.amount, d.me])).toEqual([
    ['You', '35 SATORI', true], [expect.stringMatching(/^0x/), '35 SATORI', false],
    [expect.stringMatching(/^0x/), '20 SATORI', false], [expect.stringMatching(/^0x/), '20 SATORI', false]]);
  expect(of(L, 'word').map((w) => w.text)).toEqual(['vote', 'move']);
  expect(L.legend.map((l) => l.word)).toEqual(['vote', 'move']);
  expect(L.legend[0].text).toBe('Redirect Splitter 0x52b7…d2ed: change where the top splitter sends its 60%. 90% of its shares must agree; you hold 50%.');
  expect(L.mine.split('M').length - 1).toBe(2);
  expect(L.minWidth).toBe(336);
});

test("B's authority: its box green, its line worded redirect; no dot is the wallet", async () => {
  const L = treeLayout(await read((s) => { s.splitters[SPLIT_B].authority = V; }));
  expect(of(L, 'box')[2]).toMatchObject({ mine: true, lines: [{ text: 'Authority: you', me: true }, expect.anything()] });
  expect(of(L, 'word').map((w) => w.text)).toEqual(['redirect']);
  expect(of(L, 'dot').some((d) => d.me)).toBe(false);
  expect(treeLayout(null)).toBe(null);
});
