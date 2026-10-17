// What the neuron is doing now (docs/design/health.md#work): one entry per task in progress, { task, step, done, total,
// since }, set by the poll cycle (its history, engine and submission), the Base batch and the vault's and the network's
// actions. Home draws it: the hero's ring turns and its line says the step, slowly enough to read (src/ui/hold.js);
// agents read health().work. since: when the step began (ms); a count ticking keeps it.
//
//   const job = work.start('central'); job.step('history', 34, 82); job.end();   // or work.run(task, (step) => …)

/** The tasks, the neuron's own first: current() is the first in progress. */
export const ORDER = ['central', 'base', 'delegate', 'undelegate', 'claim', 'send', 'discover', 'subscribe'];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** A vault action's transaction: "Step 2 of 3: …" when there are several. */
const tx = (e, what) => (e.total > 1 ? `Step ${e.done} of ${e.total}: ${what[0].toLowerCase()}${what.slice(1)}` : what);

const TEXT = {
  'central:register': () => 'Signing in to central…',
  'central:observations': () => "Fetching today's observations…",
  'central:history': (e) => `Loading history · ${e.done} of ${e.total} streams`,
  'central:models': (e) => `Building models · ${e.done} of ${e.total}`,
  'central:send': (e) => `Sending ${plural(e.total, 'prediction')}…`,
  'base:check': () => "Checking today's Base games…",
  'base:send': () => 'Sending the Base batch…',
  'base:confirm': () => 'Waiting for Base to confirm…',
  'claim:rewards': () => 'Claiming rewards…',
  'claim:drop': () => 'Claiming the reward drop…',
  'claim:airdrop': () => 'Claiming the airdrop…',
  'discover:ask': (e) => `Asking the relays · ${e.done} of ${e.total}`,
  'subscribe:find': () => 'Finding the stream on the relays…',
  // a vault action's steps (Delegate, Stop delegating, Send; Claim's confirm)
  send: (e) => tx(e, 'Sending…'),
  confirm: (e) => tx(e, 'Waiting for Base to confirm…'),
  settle: () => 'Checking it on Base…',
};

/** An entry's words, as Home shows them ('' for none). */
export function workText(e) {
  if (!e) return '';
  const f = TEXT[`${e.task}:${e.step}`] ?? TEXT[e.step];
  return f ? f(e) : 'Working…';
}

/**
 * @param {{now?: () => number, onChange?: () => void}} [o] now: ms
 * @returns {{start, run, of, current, all}}
 */
export function createWork({ now = () => Date.now(), onChange = () => {} } = {}) {
  const tasks = new Map(); // task → { holders, entry }

  /** One more holder of `task` (the load-time history and a poll can both hold central's): → { step, end }. */
  function start(task) {
    const t = tasks.get(task) ?? { holders: 0, entry: null };
    tasks.set(task, t);
    t.holders++;
    let open = true;
    return {
      /** The task's step now; the same step with a new count keeps its `since`. Nothing once this job ended. */
      step(step, done = null, total = null) {
        if (!open) return;
        t.entry = { task, step, done, total, since: t.entry?.step === step ? t.entry.since : now() };
        onChange();
      },
      /** This holder is done; the task ends with its last. */
      end() {
        if (!open) return;
        open = false;
        if (--t.holders > 0) return;
        tasks.delete(task);
        if (t.entry) onChange();
      },
    };
  }

  const of = (task) => tasks.get(task)?.entry ?? null;
  return {
    start,
    /** fn(step) as a holder of `task`, which ends when fn settles. */
    async run(task, fn) {
      const job = start(task);
      try {
        return await fn(job.step);
      } finally {
        job.end();
      }
    },
    of,
    /** The first task in progress (ORDER), or null. */
    current: () => ORDER.map(of).find(Boolean) ?? [...tasks.values()].find((t) => t.entry)?.entry ?? null,
    /** Every task in progress: { [task]: entry } (the UI's state). */
    all: () => Object.fromEntries([...tasks].filter(([, t]) => t.entry).map(([k, t]) => [k, t.entry])),
  };
}
