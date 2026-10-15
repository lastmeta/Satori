// One timer for the neuron's two schedules: central's poll (index.js) and the
// Base batch check (base.js). Nostr's hourly reconcile is a plain setInterval.

/**
 * Runs `run` when armed (after start()) or at once with run(), one at a time:
 * a call during a run returns it. After each run, whatever its result, the
 * next is armed at after(). onArm(at) (awaited) and onChange() follow it.
 */
export function createSchedule(run, { after, onArm = () => {}, onChange = () => {}, now = () => Date.now() / 1000,
  setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, name = 'schedule' }) {
  let timer = null;
  let next = null;
  let running = null;
  let started = false;

  async function arm(at) {
    next = at;
    ct(timer);
    timer = started ? st(() => void runNow().catch((err) => console.error(`[satori] ${name}`, err)), Math.max(0, (at - now()) * 1000)) : null;
    onChange();
    await onArm(at);
  }

  function runNow() {
    if (!running) {
      ct(timer);
      running = Promise.resolve().then(run).finally(async () => {
        running = null;
        await arm(after());
      });
      onChange();
    }
    return running;
  }

  return {
    /** Arm the first run and every one after. */
    start: (at) => { started = true; return arm(at); },
    stop() { started = false; ct(timer); timer = null; },
    arm,
    run: runNow,
    /** Resolves when the run in progress (if any) is done; starts none. */
    idle: () => Promise.resolve(running).catch(() => {}),
    get next() { return next; },
    get running() { return !!running; },
  };
}
