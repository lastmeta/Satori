// What the neuron is doing now (docs/design/health.md#work): one entry per task in progress, { task, step, done, total,
// since, critical }, set by the poll cycle (its history, engine and submission), the Base batch and the vault's and the
// network's actions, and the training pass. Home draws it: the hero's ring turns and its line says the step, slowly enough to read
// (src/ui/hold.js); agents read health().work. since: when the step began (ms); a count ticking keeps it. critical:
// closing Satori now would lose work (the hero goes vivid green and says to keep it open).
//
//   const job = work.start('central'); job.step('history', 34, 82); job.end();   // or work.run(task, (step) => …)
//   job.step('search', 40, null, { name: 'eth' })                                 // extra fields on the entry (a Retrain's model)

/**
 * The tasks, the neuron's own first; HERO: the ones Home's hero shows (the network's show on the Streams tab). `train`:
 * the training pass (src/neuron/train.js), after a poll and the Base batch, which it waits for; `retrain`: a model's
 * Retrain (src/neuron/retrain.js), which waits for a poll too.
 */
export const ORDER = ['central', 'base', 'train', 'retrain', 'stake', 'unstake', 'claim', 'send', 'keys', 'discover', 'subscribe'];
export const HERO = ORDER.slice(0, 9);
const VAULT = new Set(['stake', 'unstake', 'claim', 'send', 'keys']);
/**
 * Closing now would lose work: predictions being sent, a Base batch or a vault transaction sent and not yet confirmed,
 * the keys being written.
 */
const isCritical = (task, step) => VAULT.has(task) || ['central:send', 'base:send', 'base:confirm'].includes(`${task}:${step}`);

/** The entry that leads among `tasks` in progress (`all`: { [task]: entry }): a critical one first, else the first. */
export function leading(all, tasks = ORDER) {
  const list = tasks.map((t) => all[t]).filter(Boolean);
  return list.find((e) => e.critical) ?? list[0] ?? null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** A vault action's transaction: "Step 2 of 3: …" when there are several. */
const tx = (e, what) => (e.total > 1 ? `Step ${e.done} of ${e.total}: ${what[0].toLowerCase()}${what.slice(1)}` : what);

const TEXT = {
  'central:register': () => 'Signing in to the Satori Network…',
  'central:observations': () => "Fetching today's observations…",
  'central:history': (e) => `Loading history · ${e.done} of ${e.total} streams`,
  'central:models': (e) => `Building models · ${e.done} of ${e.total}`,
  'central:send': (e) => `Sending ${plural(e.total, 'prediction')}…`,
  'base:check': () => "Checking today's Satori contract games…",
  'base:send': () => 'Sending the Satori contract batch…',
  'base:confirm': () => 'Waiting for Base to confirm…',
  'claim:rewards': () => 'Claiming rewards…',
  'claim:drop': () => 'Claiming the reward drop…',
  'claim:airdrop': () => 'Claiming the airdrop…',
  'discover:ask': (e) => `Asking the relays · ${e.done} of ${e.total}`,
  'discover:verify': (e) => `Checking the announcements' signatures · ${e.done} of ${e.total}`,
  'subscribe:find': () => 'Finding the stream on the relays…',
  'keys:save': () => 'Saving your keys…',
  'train:score': (e) => `Scoring models · ${e.done} of ${e.total}`,
  'retrain:search': (e) => (e.done ? `Retraining ${e.name} · tried ${e.done}` : `Retraining ${e.name}…`),
  // a vault action's steps (Stake, Unstake, Send; Claim's confirm)
  send: (e) => tx(e, 'Sending…'),
  confirm: (e) => tx(e, 'Waiting for Base to confirm…'),
  settle: () => 'Checking it on Base…',
};

/**
 * An entry's words, as Home shows them ('' for none); a critical one asks to keep Satori open, and so does every step
 * when `keepOpen` (Home's hero on a phone, which stops a tab as soon as it leaves the screen).
 */
export function workText(e, { keepOpen = false } = {}) {
  if (!e) return '';
  const f = TEXT[`${e.task}:${e.step}`] ?? TEXT[e.step];
  return `${e.critical || keepOpen ? 'Keep Satori open · ' : ''}${f ? f(e) : 'Working…'}`;
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
      /** The task's step now (extra: what it is about, e.g. { name }); the same step with a new count keeps its `since`. Nothing once this job ended. */
      step(step, done = null, total = null, extra = {}) {
        if (!open) return;
        t.entry = { task, step, done, total, ...extra, since: t.entry?.step === step ? t.entry.since : now(), critical: isCritical(task, step) };
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
  const all = () => Object.fromEntries([...tasks].filter(([, t]) => t.entry).map(([k, t]) => [k, t.entry]));
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
    /** The task in progress that leads (a critical one, else the first in ORDER), or null. */
    current: () => leading(all()),
    /** Every task in progress: { [task]: entry } (the UI's state, healthOf's input). */
    all,
  };
}
