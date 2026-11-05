// The pool this wallet stakes with, for off-chain scoring (docs/design/central.md#the-pool), as Satori Lite's Stake page:
// the Satori Service counts the wallet's stake toward the pool and shares its rewards. The Satori Service keeps it
// (GET /lender/status, GET /pool/open; POST and DELETE /lender/lend, signed in by the alias: no wallet, no gas).
//   checkPoolAddress(input, { wallet, alias }) → checksummed, or throws in plain words (before any call)
//   createPool({ central, wallet, alias }) → { status, known, read(), stake(address), unstake(), reset() }
import { getAddress, isAddress, zeroAddress } from 'viem';

export const NOT_BASE = 'A pool address is a Base address: 0x and 40 hex characters.';
export const BAD_CHECKSUM = "That address's capital letters don't match its checksum: check it for a typo.";
export const OWN = "That is this app's own address, not a pool.";
export const NOT_STAKED = "This wallet doesn't stake with a pool.";

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const nowS = () => Date.now() / 1000;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** A pool address typed or given → it, EIP-55 checksummed; refused: not 0x and 40 hex, a bad checksum, zero, this app's own. */
export function checkPoolAddress(input, { wallet = null, alias = null } = {}) {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!HEX40.test(s) || s.toLowerCase() === zeroAddress) throw new Error(NOT_BASE);
  const hex = s.slice(2);
  if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase() && !isAddress(s)) throw new Error(BAD_CHECKSUM);
  if (same(s, wallet) || same(s, alias)) throw new Error(OWN);
  return getAddress(s);
}

/**
 * The pool as this page knows it: status { address (the pool's, or null: none), name, commission, isPool (this wallet
 * runs a pool, so it can't stake with one), open: [{ address, name, commission }] (lowest fee first), at, error,
 * reading }. read() never throws (the status says); stake() and unstake() throw the check's words or the Satori Service's.
 * @param {{central: () => object, wallet: string, alias?: string|null, now?: () => number, onChange?: (s: object) => void}} o
 */
export function createPool({ central, wallet, alias = null, now = nowS, onChange = () => {} }) {
  let st = { address: null, name: null, commission: null, isPool: false, open: [], at: null, error: null, reading: false };
  let asked = 0; // the latest read wins
  const put = (patch) => {
    st = { ...st, ...patch };
    const p = st.open.find((x) => same(x.address, st.address));
    st.name = p?.name ?? null;
    st.commission = p?.commission ?? null;
    onChange({ ...st });
  };

  async function read() {
    const n = ++asked;
    put({ reading: true });
    try {
      const [s, o] = await Promise.all([central().lenderStatus(wallet), central().openPools()]);
      const open = (o?.pools ?? []).filter((p) => HEX40.test(p?.address ?? ''))
        .map((p) => ({ address: getAddress(p.address), name: p.pool_name || null, commission: p.commission ?? null }))
        .sort((a, b) => (a.commission ?? 0) - (b.commission ?? 0));
      const address = HEX40.test(s?.pool_address ?? '') ? getAddress(s.pool_address) : null;
      if (n === asked) put({ address, isPool: !!s?.is_pool, open, at: now(), error: null, reading: false });
    } catch (err) {
      if (n === asked) put({ error: String(err?.message ?? err), reading: false });
    }
    return { ...st };
  }

  return {
    get status() { return { ...st }; },
    /** The Satori Service has answered since the last reset. */
    get known() { return st.at != null; },
    read,
    /** Stake with the pool at `input` (another replaces the one it had) → the status, read again. */
    async stake(input) {
      const address = checkPoolAddress(input, { wallet, alias });
      await central().stakeWithPool(address);
      return read();
    },
    /** Stop staking with the pool → the status, read again. */
    async unstake() {
      if (st.at != null && !st.address) throw new Error(NOT_STAKED);
      await central().unstakeFromPool();
      return read();
    },
    /** Another Satori Service: nothing is known of it yet. */
    reset() {
      asked++;
      put({ address: null, isPool: false, open: [], at: null, error: null, reading: false });
    },
  };
}
