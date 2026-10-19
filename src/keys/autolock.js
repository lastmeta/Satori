// The vault locks on its own (docs/design/keys.md#the-vault-locks-on-its-own): IDLE_MS after the last interaction while
// it is open (unlocked, or a backup on screen), never in the middle of a vault action (it waits for the action to end),
// and at the first check after a wake past the deadline (browser timers don't count the time a device sleeps).
//
//   const auto = createAutoLock({ onLock, busy, onChange })
//   auto.start()   // the vault was unlocked: lock IDLE_MS from now
//   auto.touch()   // an interaction (a key, a tap, a vault action): IDLE_MS from now again, while open
//   auto.stop()    // locked by hand
//   auto.check()   // the catch-up: lock now if the deadline has passed

export const IDLE_MS = 5 * 60_000;
const BUSY_RETRY_MS = 5_000; // a vault action is running: look again this soon

/**
 * @param {object} o
 * @param {() => void} o.onLock lock the vault (and hide what is shown)
 * @param {() => boolean} [o.busy] a vault action runs: it is not cut off
 * @param {(at: number|null) => void} [o.onChange] when it will lock (ms), or null: nothing open
 */
export function createAutoLock({ onLock, busy = () => false, onChange = () => {}, idleMs = IDLE_MS, now = () => Date.now(),
  setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout }) {
  let at = null; // when it locks (ms), or null
  let timer = null;

  const arm = (ms) => {
    ct(timer);
    timer = st(fire, Math.max(0, ms));
  };
  function fire() {
    timer = null;
    if (at == null) return;
    if (now() < at) return arm(at - now()); // touched since: the rest of the wait
    if (busy()) return arm(BUSY_RETRY_MS);
    at = null;
    onChange(null);
    onLock();
  }
  const set = () => {
    at = now() + idleMs;
    onChange(at);
  };

  return {
    start() {
      set();
      arm(idleMs);
    },
    /** An interaction moves the deadline; the timer, when it fires early, waits out the rest. */
    touch() {
      if (at != null) set();
    },
    stop() {
      ct(timer);
      timer = null;
      if (at == null) return;
      at = null;
      onChange(null);
    },
    check() {
      if (at != null && now() >= at) fire();
    },
    get lockAt() { return at; },
  };
}
