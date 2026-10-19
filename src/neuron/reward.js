// The reward address (docs/design/central.md#the-reward-address): where the Satori Network sends this neuron's
// rewards instead of the vault, such as a pool. A Base (0x) address; none set: the vault. The Satori Network keeps
// it (GET and POST /peer/reward-address, signed in by the identity: no vault, no gas); this app keeps no copy.
//   checkRewardAddress(input) → checksummed, or throws in plain words (before any call)
//   rewardFrom(answer)        → central's answer as an address, or null (not set; an old value from before Base too)
//   createReward({ central, work }) → { status, known, read(), set(address | null), reset() }
import { getAddress, isAddress, zeroAddress } from 'viem';
import { ZERO_ADDRESS } from './base.js';

export const NOT_BASE = 'A reward address is a Base address: 0x and 40 hex characters.';
export const BAD_CHECKSUM = "That address's capital letters don't match its checksum: check it for a typo.";

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const nowS = () => Date.now() / 1000;

/**
 * A reward address typed or given → it, EIP-55 checksummed. Refused: anything but 0x and 40 hex characters, mixed case
 * that does not match its checksum (viem's isAddress, strict, as Send's recipient), and the zero address. All lower or
 * all upper case carries no checksum (EIP-55), so it is taken as it is.
 */
export function checkRewardAddress(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!HEX40.test(s)) throw new Error(NOT_BASE);
  const hex = s.slice(2);
  if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase() && !isAddress(s)) throw new Error(BAD_CHECKSUM);
  if (s.toLowerCase() === zeroAddress) throw new Error(ZERO_ADDRESS);
  return getAddress(s);
}

/**
 * Central's { reward_address } → the address, checksummed, or null: not set, so the Satori Network pays the vault.
 * Anything else central may still hold (a value from before Base, until its migration) is null too: never shown.
 */
export function rewardFrom(answer) {
  const a = typeof answer?.reward_address === 'string' ? answer.reward_address.trim() : '';
  return HEX40.test(a) && a.toLowerCase() !== zeroAddress ? getAddress(a) : null;
}

/**
 * The reward address as this page knows it: status { address, at, error, reading } (at: when the Satori Network last
 * answered, null: not known yet). read() is quiet (Settings' row says it); set() is the `reward` task in `work` (its
 * steps: login, then save or clear: src/neuron/work.js). The caller runs one set() at a time.
 * @param {{central: () => object, work?: object|null, now?: () => number, onChange?: (status: object) => void}} o
 */
export function createReward({ central, work = null, now = nowS, onChange = () => {} }) {
  let st = { address: null, at: null, error: null, reading: false };
  let asked = 0; // the latest read or set wins: an older read's answer is dropped
  const put = (patch) => {
    st = { ...st, ...patch };
    onChange({ ...st });
  };

  return {
    get status() { return { ...st }; },
    /** The Satori Network has answered (a read or a set) since the last reset. */
    get known() { return st.at != null; },

    /** Read it from the Satori Network → the status. Never throws: a failure keeps what was known, with `error`. */
    async read() {
      const n = ++asked;
      put({ reading: true });
      try {
        const address = rewardFrom(await central().rewardAddress());
        if (n === asked) put({ address, at: now(), error: null, reading: false });
      } catch (err) {
        if (n === asked) put({ error: String(err?.message ?? err), reading: false });
      }
      return { ...st };
    },

    /**
     * Set it (an address, checked first) or clear it (null or '') → { address, changed } (changed: it differs from
     * what was known, or nothing was). Throws the check's words or the Satori Network's.
     */
    async set(input) {
      const address = input == null || (typeof input === 'string' && !input.trim()) ? null : checkRewardAddress(input);
      const job = work?.start('reward');
      try {
        const answer = await central().setRewardAddress(address, { onStep: (step) => job?.step(step) });
        const stored = rewardFrom(answer);
        const changed = st.at == null || stored !== st.address;
        asked++;
        put({ address: stored, at: now(), error: null, reading: false });
        return { address: stored, changed };
      } finally {
        job?.end();
      }
    },

    /** Another Satori Network: nothing is known of it yet. */
    reset() {
      asked++;
      put({ address: null, at: null, error: null, reading: false });
    },
  };
}
