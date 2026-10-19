import { describe, test, expect } from 'vitest';
import { checkRewardAddress, rewardFrom, createReward, NOT_BASE, BAD_CHECKSUM } from './reward.js';
import { ZERO_ADDRESS } from './base.js';
import { createWork } from './work.js';
import { CentralError } from '../central/index.js';

const ADDR = '0x3a91ecc0dde5bfea5773345D5f61c894bc84B6E7'; // EIP-55
const LOWER = ADDR.toLowerCase();

describe('checkRewardAddress: a Base address, checked before any call', () => {
  test('a checksummed, all-lowercase or all-uppercase address → checksummed; spaces trimmed', () => {
    expect(checkRewardAddress(ADDR)).toBe(ADDR);
    expect(checkRewardAddress(LOWER)).toBe(ADDR);
    expect(checkRewardAddress(`0x${ADDR.slice(2).toUpperCase()}`)).toBe(ADDR);
    expect(checkRewardAddress(`  ${LOWER}\n`)).toBe(ADDR);
  });
  test('anything that is not 0x and 40 hex characters is refused in plain words', () => {
    for (const bad of ['', '   ', null, undefined, '0x', ADDR.slice(0, -1), `${ADDR}0`, ADDR.slice(2), `0x${'g'.repeat(40)}`,
      'EXaMPLEevrmoreAddre55Lookin6L1keThis', `0X${ADDR.slice(2)}`, 42]) {
      expect(() => checkRewardAddress(bad), String(bad)).toThrow(NOT_BASE);
    }
    expect(NOT_BASE).toBe('A reward address is a Base address: 0x and 40 hex characters.');
  });
  test('mixed case that does not match its checksum: a typo', () => {
    const typo = ADDR.replace('D5f', 'd5f');
    expect(() => checkRewardAddress(typo)).toThrow(BAD_CHECKSUM);
    expect(BAD_CHECKSUM).toBe("That address's capital letters don't match its checksum: check it for a typo.");
  });
  test('the zero address burns: refused, as Send refuses it', () => {
    expect(() => checkRewardAddress(`0x${'0'.repeat(40)}`)).toThrow(ZERO_ADDRESS);
  });
});

describe("rewardFrom: central's answer → the address, or null (not set: the vault)", () => {
  test('a 0x address, checksummed whatever its case', () => {
    expect(rewardFrom({ reward_address: ADDR })).toBe(ADDR);
    expect(rewardFrom({ reward_address: LOWER })).toBe(ADDR);
    expect(rewardFrom({ reward_address: ` ${ADDR} ` })).toBe(ADDR);
  });
  test('null, empty, an old value from before Base, the zero address or no answer: not set, never thrown', () => {
    for (const v of [null, undefined, '', 'None', 'EXaMPLEevrmoreAddre55Lookin6L1keThis', `0x${'0'.repeat(40)}`, 7, {}, ADDR.slice(0, -1)]) {
      expect(rewardFrom({ reward_address: v }), String(v)).toBeNull();
    }
    expect(rewardFrom(null)).toBeNull();
    expect(rewardFrom('oops')).toBeNull();
  });
});

/** A central with the reward-address calls: `stored` is what it keeps; `fail` the next call's error. */
function fakeCentral(stored = null) {
  const c = {
    stored, fail: null, calls: [],
    async rewardAddress({ onStep = () => {} } = {}) {
      c.calls.push(['read']);
      onStep('login');
      onStep('read');
      if (c.fail) { const e = c.fail; c.fail = null; throw e; }
      return { reward_address: c.stored };
    },
    async setRewardAddress(address, { onStep = () => {} } = {}) {
      c.calls.push(['set', address]);
      onStep('login');
      onStep(address ? 'save' : 'clear');
      if (c.fail) { const e = c.fail; c.fail = null; throw e; }
      c.stored = address;
      return { reward_address: c.stored };
    },
  };
  return c;
}

describe('createReward: read and set, with the status', () => {
  const at = () => 1_800_000_000;
  test('before a read: unknown; a read → the address, quiet (no work); an old value reads as not set', async () => {
    const central = fakeCentral(LOWER);
    const work = createWork();
    const seen = [];
    const r = createReward({ central: () => central, work, now: at, onChange: (s) => seen.push(s) });
    expect(r.status).toEqual({ address: null, at: null, error: null, reading: false });
    const reading = r.read();
    expect(r.status.reading).toBe(true);
    expect(work.all()).toEqual({}); // a read is not Home's work
    expect(await reading).toEqual({ address: ADDR, at: 1_800_000_000, error: null, reading: false });
    expect(seen.at(-1)).toEqual(r.status);
    central.stored = 'EXaMPLEevrmoreAddre55Lookin6L1keThis';
    expect((await r.read()).address).toBeNull();
  });
  test("a read that fails keeps what was known and says why; it never throws", async () => {
    const central = fakeCentral(ADDR);
    const r = createReward({ central: () => central, now: at });
    await r.read();
    central.fail = new CentralError(0, 'network', 'Satori Network unreachable: Failed to fetch');
    expect(await r.read()).toEqual({ address: ADDR, at: 1_800_000_000, error: 'Satori Network unreachable: Failed to fetch', reading: false });
    expect(r.known).toBe(true);
    const fresh = createReward({ central: () => fakeCentral(), now: at });
    expect(fresh.known).toBe(false);
  });
  test('set: checked, then saved signed in, as the reward task (login → save); changed only when it differs', async () => {
    const central = fakeCentral(null);
    const steps = [];
    const work = createWork({ onChange: () => { const w = work.of('reward'); if (w) steps.push(w.step); } });
    const r = createReward({ central: () => central, work, now: at });
    await r.read();
    expect(await r.set(LOWER)).toEqual({ address: ADDR, changed: true });
    expect(central.calls.at(-1)).toEqual(['set', ADDR]); // sent checksummed
    expect(steps).toEqual(['login', 'save']);
    expect(work.all()).toEqual({}); // ended
    expect(r.status).toMatchObject({ address: ADDR, error: null });
    expect(await r.set(ADDR)).toEqual({ address: ADDR, changed: false }); // the same again: no change
  });
  test("clear: null or '' → null sent; a bad address is refused before any call", async () => {
    const central = fakeCentral(ADDR);
    const r = createReward({ central: () => central, now: at });
    await r.read();
    expect(await r.set(null)).toEqual({ address: null, changed: true });
    expect(await r.set('  ')).toEqual({ address: null, changed: false });
    expect(central.calls.filter(([k]) => k === 'set').map(([, a]) => a)).toEqual([null, null]);
    const n = central.calls.length;
    await expect(r.set('0x123')).rejects.toThrow(NOT_BASE);
    expect(central.calls).toHaveLength(n);
  });
  test("central's refusal is thrown in its words, the status keeps what was known; unknown before means changed", async () => {
    const central = fakeCentral(null);
    const work = createWork();
    const r = createReward({ central: () => central, work, now: at });
    central.fail = new CentralError(400, 'Invalid Base address');
    await expect(r.set(ADDR)).rejects.toThrow('Satori Network 400: Invalid Base address');
    expect(work.all()).toEqual({});
    expect(r.status).toEqual({ address: null, at: null, error: null, reading: false });
    expect(await r.set(ADDR)).toEqual({ address: ADDR, changed: true }); // never read: counted as a change
  });
  test('a set while a read is in flight wins: the older read does not overwrite it', async () => {
    const central = fakeCentral(null);
    let release;
    const slow = { ...central, rewardAddress: () => new Promise((res) => { release = () => res({ reward_address: null }); }) };
    const r = createReward({ central: () => slow, now: at });
    const reading = r.read();
    await r.set(ADDR);
    release();
    await reading;
    expect(r.status.address).toBe(ADDR);
  });
  test('reset (another Satori Network): unknown again', async () => {
    const r = createReward({ central: () => fakeCentral(ADDR), now: at });
    await r.read();
    r.reset();
    expect(r.status).toEqual({ address: null, at: null, error: null, reading: false });
    expect(r.known).toBe(false);
  });
});
