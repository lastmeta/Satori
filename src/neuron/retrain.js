// Retrain, as the app runs it (docs/design/models.md#retrain; docs/intent/engine.md: never rest with work pending): a
// user's request to keep training one Satori Network model until one beats no change, then stop. The request is kept
// with the spec (model_specs.retrain) when asked, with the search's place every few seconds, so a closed app continues
// on open. One retrain at a time, in the order asked; it waits while central's work runs (one writer of a spec), then
// continues on the new data with the champion read again. From stored history only: it never predicts, never submits
// and never calls central.
//
//   const rt = createRetrain({ db, work, seed, nameOf, after, onChange })
//   await rt.start(uuid) → status (a request kept and queued)    rt.stop(uuid) → status    rt.done(uuid) → the result, when it ends
//   rt.status(uuid) → { running, waiting, after, tried, best, result }    rt.all() → { [uuid]: status }
//   await rt.resume() (on open: every request still running)     rt.wake() (central's work ended)
import { retrainer, canRetrain } from '../engine/retrain.js';
import { fitter } from '../engine/evolve.js';
import { fitKey, statsFrom } from './train.js';

/** A turn for the page: scheduler.yield where the browser has it (no 4 ms clamp), else a task. */
const turn = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r, 0)));

/** Why a retrain can't start: thrown to the caller (the UI shows it; an agent reads it). */
export class RetrainError extends Error {}

/**
 * @param {{db, work, seed: () => string, nameOf?: (uuid: string) => string, after?: (uuid, result) => Promise<void>,
 *   onChange?: () => void, busy?: () => boolean, now?: () => number, clock?: () => number, pause?: () => Promise<void>,
 *   sliceMs?: number, showMs?: number, saveMs?: number}} o seed: the identity's public key; busy: central's work runs
 *   (a poll, its sign-in, the history); after: once a retrain ended and was stored (the app reads the list again)
 */
export function createRetrain({ db, work, seed, nameOf = (u) => u, after = async () => {}, onChange = () => {},
  busy = () => !!work.of('central'), now = () => Date.now() / 1000, clock = () => performance.now(), pause = turn,
  sliceMs = 10, showMs = 250, saveMs = 2000 }) {
  const queue = []; // [{ uuid, entry }] in the order asked: the first runs
  const live = new Map(); // uuid → { tried, best, waiting, stop }
  const results = new Map(); // uuid → the last result (stored, or this session's note)
  const ends = new Map(); // uuid → [resolve] for done(uuid)
  let waiters = [];
  let running = null;

  const status = (uuid) => {
    const l = live.get(uuid);
    const first = queue[0]?.uuid;
    return { running: !!l, waiting: l ? (first !== uuid ? 'queue' : l.waiting) : null, after: l && first !== uuid ? nameOf(first) : null,
      tried: l?.tried ?? results.get(uuid)?.tried ?? 0, best: l?.best ?? results.get(uuid)?.search ?? null, result: results.get(uuid) ?? null };
  };
  const changed = () => { try { onChange(); } catch (err) { console.error('[satori] retrain status', err); } };
  /** Until central's work is over (wake() is called when it ends; busy() is read again then), or it is stopped. */
  async function idle(l) {
    if (!busy() || l.stop) return;
    l.waiting = 'poll';
    changed();
    while (busy() && !l.stop) await new Promise((r) => { waiters.push(r); });
    l.waiting = null;
  }

  /** One retrain, from its kept request (entry) to its stored result. */
  async function runOne(uuid, entry) {
    const l = live.get(uuid);
    const name = nameOf(uuid);
    let job = null;
    const show = () => {
      job ??= work.start('retrain');
      job.step('search', l.tried, null, { name });
      changed();
    };
    let ms = entry.ms ?? 0; // the search's time over every session
    let r = null;
    let histories = null;
    let championText = null;
    let state = entry.state ?? null;
    let tSlice = clock();
    const save = (extra = {}) => db.setRetrain(uuid, { ...entry, state, tried: l.tried, ms: Math.round(ms), ...extra });
    /** The data and the champion, read now (again after a poll); null: its spec is gone (another central). */
    async function load() {
      histories = await db.centralHistories();
      const row = (await db.specs()).get(uuid);
      if (!row) return false;
      championText = JSON.stringify(row.spec);
      r = retrainer({ target: uuid, histories, champion: row.spec, seed: seed(), n: entry.n, from: state });
      return true;
    }
    const stopped = () => finish(r?.ok ? r.end('stopped') : { outcome: 'stopped', kept: 'current', tried: l.tried });
    try {
      await idle(l); // one writer: never while a poll runs
      if (l.stop) return stopped();
      show();
      if (!(await load())) return finish(null);
      if (!r.ok) return finish({ outcome: 'history', kept: 'current', tried: 0 });
      tSlice = clock();
      let tShow = tSlice;
      let tSave = tSlice;
      for (;;) {
        if (l.stop) return stopped();
        const res = r.step();
        if (res) return finish(res);
        const t = clock();
        if (t - tSlice < sliceMs) continue;
        ms += t - tSlice;
        ({ tried: l.tried, best: l.best } = r.progress());
        state = r.state();
        if (t - tShow >= showMs) { show(); tShow = t; }
        if (t - tSave >= saveMs) { await save(); tSave = t; }
        await pause();
        if (busy()) { // a poll began: keep the place, wait, then go on with its data and its champion
          await save();
          job?.end();
          job = null;
          await idle(l);
          if (l.stop) return stopped();
          show();
          if (!(await load())) return finish(null);
        }
        tSlice = clock();
      }
    } finally {
      job?.end();
    }

    /** Store the result (the new champion with it when one is kept), then tell. */
    async function finish(res) {
      if (r?.ok) ms += clock() - tSlice;
      if (res && l.tried < res.tried) l.tried = res.tried;
      const result = res && { n: entry.n, at: now(), outcome: res.outcome, kept: res.kept, ratio: res.ratio ?? null, was: res.was ?? null,
        search: res.search ?? null, tried: res.tried ?? 0, checks: res.checks ?? 0, looked: !!res.looked, heldEnd: res.heldEnd ?? null,
        ms: Math.round(ms), ...(res.kept === 'new' ? { spec: res.spec, from: JSON.parse(championText) } : {}) };
      const done = { n: entry.n, status: 'done', asked_at: entry.asked_at, result };
      if (result?.kept === 'new') {
        const f = fitter({ histories })(uuid, res.spec);
        const stored = await db.saveRetrained({ uuid, from: championText, spec: res.spec, score: f.score, persist: f.persist,
          influence: f.influence, fit_key: fitKey(uuid, res.spec, statsFrom(histories)), retrain: done }, Math.floor(now()));
        if (!stored) { // the spec changed under it after all (it waits for every poll): the champion stays
          Object.assign(result, { kept: 'current', ratio: result.was, changed: true });
          delete result.spec;
          await db.setRetrain(uuid, done);
        }
      } else {
        await db.setRetrain(uuid, done);
      }
      await db.checkpoint();
      if (result) results.set(uuid, result);
      return result;
    }
  }

  /** The queue, one at a time, until it is empty. */
  function kick() {
    running ??= (async () => {
      while (queue.length) {
        const { uuid, entry } = queue[0];
        let result = null;
        try {
          result = await runOne(uuid, entry);
        } catch (err) {
          console.error('[satori] retrain', uuid, err);
          result = { n: entry.n, at: now(), outcome: 'error', kept: 'current', error: String(err?.message ?? err), tried: live.get(uuid)?.tried ?? 0 };
          results.set(uuid, result);
          await db.setRetrain(uuid, { n: entry.n, status: 'done', asked_at: entry.asked_at, result }).catch(() => {});
        }
        queue.shift();
        live.delete(uuid);
        changed();
        try { await after(uuid, result); } catch (err) { console.error('[satori] after a retrain', err); }
        for (const f of ends.get(uuid) ?? []) f(result);
        ends.delete(uuid);
      }
    })().finally(() => { running = null; });
    return running;
  }

  const enqueue = (uuid, entry) => {
    live.set(uuid, { tried: entry.tried ?? 0, best: null, waiting: null, stop: false });
    queue.push({ uuid, entry });
    changed();
    kick();
  };

  return {
    status,
    all: () => Object.fromEntries([...new Set([...results.keys(), ...live.keys()])].map((u) => [u, status(u)])),
    /**
     * Ask for a retrain of a central target: kept with its spec, then queued. Refused (RetrainError) without a spec or
     * the history to split; a target whose last retrain looked at the same recent data gets that note, no search.
     */
    async start(uuid) {
      if (live.has(uuid)) return status(uuid);
      const row = (await db.specs()).get(uuid);
      if (!row) throw new RetrainError(`No Satori Network model for ${uuid}: it has not predicted yet.`);
      const can = canRetrain({ target: uuid, histories: await db.histories([uuid]) });
      if (!can.ok) throw new RetrainError('Retrain needs about four weeks of this stream\'s history.');
      const last = row.retrain?.result;
      if (last?.looked && last.heldEnd === can.heldEnd) { // one look per observation: the same data again would be another look
        results.set(uuid, { ...last, note: 'same-data' });
        changed();
        return status(uuid);
      }
      const entry = { n: (row.retrain?.n ?? 0) + 1, status: 'running', asked_at: now(), state: null };
      await db.setRetrain(uuid, entry);
      await db.checkpoint();
      results.delete(uuid);
      enqueue(uuid, entry);
      return status(uuid);
    },
    /** Stop it (c): it ends at its next try and keeps the current champion. */
    stop(uuid) {
      const l = live.get(uuid);
      if (l) {
        l.stop = true;
        for (const w of waiters) w(); // a retrain waiting for a poll ends now too
        waiters = [];
      }
      return status(uuid);
    },
    /** The result once the retrain of `uuid` ends (now, when it is not running). */
    done(uuid) {
      if (!live.has(uuid)) return Promise.resolve(results.get(uuid) ?? null);
      return new Promise((r) => ends.set(uuid, [...(ends.get(uuid) ?? []), r]));
    },
    /** On open: every request still running continues where it was, in the order asked; the last results are read. */
    async resume() {
      const specs = await db.specs();
      const asked = [...specs].filter(([u, s]) => s.retrain?.status === 'running' && !live.has(u))
        .sort(([, a], [, b]) => (a.retrain.asked_at ?? 0) - (b.retrain.asked_at ?? 0));
      for (const [u, s] of specs) if (s.retrain?.result && !results.has(u)) results.set(u, s.retrain.result);
      for (const [u, s] of asked) enqueue(u, s.retrain);
      changed();
      return asked.length;
    },
    /** Central's work ended: a retrain waiting for it goes on. */
    wake() {
      const w = waiters;
      waiters = [];
      for (const f of w) f();
    },
  };
}
