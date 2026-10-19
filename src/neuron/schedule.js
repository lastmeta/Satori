// One timer for the neuron's two schedules: central's poll (index.js) and the
// Base batch check (base.js). Nostr's hourly reconcile is a plain setInterval.
// Browser timers don't count the time a device sleeps (a closed lid, a phone's
// screen off, a suspended tab), so a timer can fire hours after its deadline:
// catchUp() runs a deadline that has passed, and catchUpAll() is the app's
// catch-up pass over every job (docs/plans/runtime.md#catch-up-pass).

/**
 * Runs `run` when armed (after start()) or at once with run(), one at a time:
 * a call during a run returns it. After each run, the next is armed at
 * after(outcome), outcome { result } or { error }. onArm(at) (awaited) and
 * onChange() follow it. catchUp(): the run now if its deadline has passed and
 * none is running (the timer slept), else null.
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
      let outcome;
      running = Promise.resolve().then(run).then((result) => { outcome = { result }; return result; },
        (error) => { outcome = { error }; throw error; })
        .finally(async () => {
          running = null;
          await arm(after(outcome));
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
    /** The run, now, when its deadline has passed and none is running; else null (not due, running, or not started). */
    catchUp: () => (started && !running && next != null && now() >= next ? runNow() : null),
    /** Resolves when the run in progress (if any) is done; starts none. */
    idle: () => Promise.resolve(running).catch(() => {}),
    get next() { return next; },
    get running() { return !!running; },
  };
}

/**
 * The catch-up pass: each job (name → () => the run it started, or null/undefined when it has nothing due or is
 * running) once; a job's failure is logged and never stops the others. → the names of the jobs that started a run.
 */
export function catchUpAll(jobs, why) {
  const ran = [];
  for (const [name, job] of Object.entries(jobs)) {
    try {
      const p = job();
      if (p && typeof p.then === 'function') {
        ran.push(name);
        p.catch((err) => console.error(`[satori] catch-up ${name}`, err));
      }
    } catch (err) {
      console.error(`[satori] catch-up ${name}`, err);
    }
  }
  if (ran.length) console.info(`[satori] catch-up (${why}): ${ran.join(', ')}`);
  return ran;
}
