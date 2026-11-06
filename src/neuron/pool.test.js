// The pool this wallet stakes with (docs/design/central.md#the-pool).
import { describe, expect, test, vi } from 'vitest';
import { createPool, checkPoolAddress, NOT_BASE, BAD_CHECKSUM, OWN, NOT_STAKED, NOT_WORKER } from './pool.js';

const WALLET = '0x3a91ecc0dde5bfea5773345D5f61c894bc84B6E7';
const ALIAS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const POOL = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';
const CHEAP = '0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69';

function fakeCentral({ staked = null, isPool = false, workerOf = null } = {}) {
  const c = {
    staked,
    workerOf,
    poolMembership: vi.fn(async () => ({ pool_address: c.workerOf, pool_name: c.workerOf ? 'grabby' : null })),
    leavePool: vi.fn(async () => { c.workerOf = null; return { message: 'Left the pool' }; }),
    lenderStatus: vi.fn(async () => ({ pool_address: c.staked, pool_wallet_address: c.staked, pool_id: c.staked ? 9 : null, is_pool: isPool })),
    openPools: vi.fn(async () => ({ pools: [{ address: POOL.toLowerCase(), pool_name: 'big', commission: 40 },
      { address: CHEAP, pool_name: '', commission: 5 }, { address: 'not an address', commission: 1 }] })),
    stakeWithPool: vi.fn(async (a) => { c.staked = a; return { id: 1 }; }),
    unstakeFromPool: vi.fn(async () => { c.staked = null; return {}; }),
  };
  return c;
}

describe('checkPoolAddress', () => {
  test('a Base address, checksummed; refused: not one, a bad checksum, zero, this app\'s wallet or alias', () => {
    expect(checkPoolAddress(` ${POOL.toLowerCase()} `, { wallet: WALLET, alias: ALIAS })).toBe(POOL);
    expect(() => checkPoolAddress('0x123')).toThrow(NOT_BASE);
    expect(() => checkPoolAddress(`0x${'0'.repeat(40)}`)).toThrow(NOT_BASE);
    expect(() => checkPoolAddress(POOL.replace('B5A', 'b5A'))).toThrow(BAD_CHECKSUM);
    expect(() => checkPoolAddress(WALLET.toLowerCase(), { wallet: WALLET })).toThrow(OWN);
    expect(() => checkPoolAddress(ALIAS, { alias: ALIAS })).toThrow(OWN);
  });
});

describe('createPool', () => {
  test('read: the pool it stakes with (named from the open list) and the open pools, lowest fee first', async () => {
    const c = fakeCentral({ staked: POOL });
    const pool = createPool({ central: () => c, wallet: WALLET, alias: ALIAS, now: () => 5 });
    expect(pool.known).toBe(false);
    const st = await pool.read();
    expect(c.lenderStatus).toHaveBeenCalledWith(WALLET);
    expect(st).toMatchObject({ address: POOL, name: 'big', commission: 40, isPool: false, at: 5, error: null, reading: false });
    expect(st.open).toEqual([{ address: CHEAP, name: null, commission: 5 }, { address: POOL, name: 'big', commission: 40 }]);
    expect(pool.known).toBe(true);
  });
  test('stake with one, then unstake: each read again; a refusal is the Satori Service\'s words', async () => {
    const c = fakeCentral();
    const pool = createPool({ central: () => c, wallet: WALLET });
    await pool.read();
    expect((await pool.stake(CHEAP.toLowerCase())).address).toBe(CHEAP);
    expect(c.stakeWithPool).toHaveBeenCalledWith(CHEAP);
    expect((await pool.unstake()).address).toBe(null);
    await expect(pool.unstake()).rejects.toThrow(NOT_STAKED);
    c.stakeWithPool.mockRejectedValueOnce(new Error('Satori Service 400: Pool is not accepting new lenders'));
    await expect(pool.stake(POOL)).rejects.toThrow('not accepting new lenders');
    expect(pool.status.address).toBe(null);
  });
  test('a failed read keeps what was known, with the error; reset forgets it all', async () => {
    const c = fakeCentral({ staked: POOL, isPool: true });
    const pool = createPool({ central: () => c, wallet: WALLET });
    await pool.read();
    c.lenderStatus.mockRejectedValueOnce(new Error('Satori Service unreachable'));
    const st = await pool.read();
    expect(st).toMatchObject({ address: POOL, isPool: true, error: 'Satori Service unreachable' });
    pool.reset();
    expect(pool.status).toMatchObject({ address: null, open: [], at: null, error: null });
  });

  test('read: the pool that lists this app as its worker, or null; leave() takes it off and reads again', async () => {
    const c = fakeCentral({ workerOf: POOL.toLowerCase() });
    const pool = createPool({ central: () => c, wallet: WALLET, alias: ALIAS });
    expect((await pool.read()).worker).toEqual({ address: POOL, name: 'grabby' });
    const st = await pool.leave();
    expect(c.leavePool).toHaveBeenCalledTimes(1);
    expect(st.worker).toBe(null);
    await expect(pool.leave()).rejects.toThrow(NOT_WORKER);
    expect(c.leavePool).toHaveBeenCalledTimes(1);
  });

  test('a Satori Service without the worker call (an older one) still reads the pool it stakes with', async () => {
    const c = fakeCentral({ staked: POOL });
    c.poolMembership = vi.fn(async () => { throw new Error('Satori Service 404: Not Found'); });
    const st = await createPool({ central: () => c, wallet: WALLET, alias: ALIAS }).read();
    expect(st).toMatchObject({ address: POOL, worker: null, workerError: 'Satori Service 404: Not Found', error: null });
  });
});
