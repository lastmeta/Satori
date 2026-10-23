// What the neuron is doing now (docs/design/health.md#work): the work state's transitions and its words.
import { describe, expect, test, vi } from 'vitest';
import { createWork, workText, leading, ORDER, HERO } from './work.js';

const clock = (t = 1000) => {
  const c = () => c.t;
  c.t = t;
  return c;
};

describe('createWork', () => {
  test('nothing in progress: current() and of() are null, all() is empty', () => {
    const w = createWork();
    expect(w.current()).toBeNull();
    expect(w.of('central')).toBeNull();
    expect(w.all()).toEqual({});
  });

  test('a task: started, its steps (since: when the step began; a count keeps it), ended', () => {
    const now = clock();
    const onChange = vi.fn();
    const w = createWork({ now, onChange });
    const job = w.start('central');
    expect(w.of('central')).toBeNull(); // no step yet: nothing to show
    job.step('register');
    expect(w.current()).toEqual({ task: 'central', step: 'register', done: null, total: null, since: 1000, critical: false });
    now.t = 1500;
    job.step('history', 0, 82);
    now.t = 1700;
    job.step('history', 34, 82);
    expect(w.current()).toEqual({ task: 'central', step: 'history', done: 34, total: 82, since: 1500, critical: false });
    expect(w.all()).toEqual({ central: w.current() });
    job.end();
    expect(w.current()).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(4); // three steps and the end
  });

  test('two holders of one task (the load-time history and a poll): it ends with the last, the steps are shared', () => {
    const w = createWork();
    const a = w.start('central');
    const b = w.start('central');
    a.step('history', 1, 2);
    b.step('models', 0, 2);
    a.end();
    expect(w.of('central')).toMatchObject({ step: 'models' });
    a.end(); // twice: once counts
    expect(w.of('central')).toMatchObject({ step: 'models' });
    b.end();
    expect(w.of('central')).toBeNull();
  });

  test('a step from a job that ended changes nothing', () => {
    const w = createWork();
    const job = w.start('base');
    job.end();
    job.step('check');
    expect(w.of('base')).toBeNull();
  });

  test('run(task, fn): fn gets the step function; the task ends when fn settles, thrown or not', async () => {
    const w = createWork();
    const out = await w.run('base', async (step) => {
      step('check');
      expect(w.of('base')).toMatchObject({ step: 'check' });
      return 7;
    });
    expect(out).toBe(7);
    expect(w.of('base')).toBeNull();
    await expect(w.run('claim', (step) => { step('rewards'); throw new Error('x'); })).rejects.toThrow('x');
    expect(w.of('claim')).toBeNull();
  });

  test(`current(): a critical task first (closing now would lose work), else the first in ${ORDER.join(', ')} order`, () => {
    const w = createWork();
    w.start('discover').step('ask', 0, 2);
    expect(w.current()).toMatchObject({ task: 'discover' });
    const claim = w.start('claim');
    claim.step('rewards');
    expect(w.current()).toMatchObject({ task: 'claim', critical: true });
    const base = w.start('base');
    base.step('check');
    expect(w.current()).toMatchObject({ task: 'claim' }); // critical wins
    claim.end();
    expect(w.current()).toMatchObject({ task: 'base' });
    w.start('central').step('observations');
    expect(w.current()).toMatchObject({ task: 'central' });
    base.step('send');
    expect(w.current()).toMatchObject({ task: 'base', step: 'send', critical: true });
  });

  test('critical: sending predictions, the Base batch sent and confirming, and every step of the wallet\'s actions', () => {
    const w = createWork();
    const crit = (task, step) => { const j = w.start(task); j.step(step); const c = w.of(task).critical; j.end(); return c; };
    expect(['register', 'observations', 'history', 'models', 'send'].map((st) => crit('central', st))).toEqual([false, false, false, false, true]);
    expect(['check', 'send', 'confirm'].map((st) => crit('base', st))).toEqual([false, true, true]);
    expect([['stake', 'send'], ['stake', 'settle'], ['unstake', 'confirm'], ['claim', 'drop'], ['send', 'send']]
      .map(([t, st]) => crit(t, st))).toEqual([true, true, true, true, true]);
    expect([crit('discover', 'ask'), crit('subscribe', 'find')]).toEqual([false, false]);
    expect(crit('keys', 'save')).toBe(true); // the keys written (an earlier version's record, upgraded at Unlock)
  });

  test(`leading(all, tasks): the hero's task among ${HERO.join(', ')}: a critical one first, else the first; the network's never`, () => {
    const e = (task, step, critical = false) => ({ task, step, done: null, total: null, since: 0, critical });
    expect(leading({}, HERO)).toBeNull();
    expect(leading({ discover: e('discover', 'ask') }, HERO)).toBeNull();
    expect(leading({ watch: e('watch', 'verify') }, HERO)).toBeNull(); // the scan for prediction streams: the Streams tab's
    expect(leading({ base: e('base', 'check'), central: e('central', 'history') }, HERO)).toMatchObject({ task: 'central' });
    expect(leading({ claim: e('claim', 'confirm', true), central: e('central', 'history') }, HERO)).toMatchObject({ task: 'claim' });
  });

  test('the training pass (`train`) is the hero\'s, never critical, and gives way to a poll or the Base batch', () => {
    const e = (task, step, critical = false) => ({ task, step, done: 3, total: 81, since: 0, critical });
    expect(HERO).toContain('train');
    expect(ORDER.slice(0, 3)).toEqual(['central', 'base', 'train']);
    expect(leading({ train: e('train', 'score') }, HERO)).toMatchObject({ task: 'train' });
    expect(leading({ train: e('train', 'score'), central: e('central', 'observations') }, HERO)).toMatchObject({ task: 'central' });
    expect(leading({ train: e('train', 'score'), base: e('base', 'check') }, HERO)).toMatchObject({ task: 'base' });
    const w = createWork();
    w.start('train').step('score', 0, 81);
    expect(w.of('train')).toMatchObject({ critical: false });
  });

  test("the reward address (`reward`) is the hero's after the keys, never critical: it is saved or it is not", () => {
    const e = (task, step) => ({ task, step, done: null, total: null, since: 0, critical: false });
    expect(ORDER.slice(ORDER.indexOf('keys'), ORDER.indexOf('keys') + 2)).toEqual(['keys', 'reward']);
    expect(HERO).toContain('reward');
    expect(leading({ reward: e('reward', 'save'), central: e('central', 'observations') }, HERO)).toMatchObject({ task: 'central' });
    expect(leading({ reward: e('reward', 'save') }, HERO)).toMatchObject({ task: 'reward' });
    const w = createWork();
    for (const step of ['login', 'save', 'clear']) {
      w.start('reward').step(step);
      expect(w.of('reward')).toMatchObject({ critical: false });
    }
  });

  test('Retrain (`retrain`) is the hero\'s after the training pass, never critical; its entry carries the model\'s name', () => {
    const e = (task, step) => ({ task, step, done: 3, total: null, since: 0, critical: false });
    expect(ORDER.slice(0, 4)).toEqual(['central', 'base', 'train', 'retrain']);
    expect(HERO).toContain('retrain');
    expect(leading({ retrain: e('retrain', 'search'), central: e('central', 'observations') }, HERO)).toMatchObject({ task: 'central' });
    expect(leading({ retrain: e('retrain', 'search'), train: e('train', 'score') }, HERO)).toMatchObject({ task: 'train' });
    const w = createWork();
    w.start('retrain').step('search', 40, null, { name: 'eth' });
    expect(w.of('retrain')).toMatchObject({ task: 'retrain', step: 'search', done: 40, name: 'eth', critical: false });
  });
});

describe('workText: plain words, from the person\'s side', () => {
  const e = (task, step, done = null, total = null) => ({ task, step, done, total, since: 0 });
  test.each([
    [e('central', 'register'), 'Signing in to the Satori Network…'],
    [e('central', 'observations'), "Fetching today's observations…"],
    [e('central', 'history', 34, 82), 'Loading history · 34 of 82 streams'],
    [e('central', 'models', 40, 82), 'Building models · 40 of 82'],
    [e('central', 'send', null, 82), 'Sending 82 predictions…'],
    [e('central', 'send', null, 1), 'Sending 1 prediction…'],
    [e('base', 'check'), "Checking today's Satori contract games…"],
    [e('base', 'send'), 'Sending the Satori contract batch…'],
    [e('base', 'confirm'), 'Waiting for Base to confirm…'],
    [e('stake', 'send', 1, 3), 'Step 1 of 3: sending…'],
    [e('stake', 'confirm', 2, 3), 'Step 2 of 3: waiting for Base to confirm…'],
    [e('stake', 'send', 1, 1), 'Sending…'],
    [e('stake', 'confirm', 1, 1), 'Waiting for Base to confirm…'],
    [e('stake', 'settle'), 'Checking it on Base…'],
    [e('claim', 'rewards'), 'Claiming rewards…'],
    [e('claim', 'drop'), 'Claiming the reward drop…'],
    [e('claim', 'airdrop'), 'Claiming the airdrop…'],
    [e('claim', 'confirm'), 'Waiting for Base to confirm…'],
    [e('discover', 'ask', 1, 2), 'Asking the relays · 1 of 2'],
    [e('subscribe', 'find'), 'Finding the stream on the relays…'],
    [e('watch', 'ask', 1, 2), 'Finding prediction streams · asking the relays 1 of 2'],
    [e('watch', 'verify', 400, 1061), 'Finding prediction streams · checking signatures 400 of 1,061'],
    [e('keys', 'save'), 'Saving your keys…'],
    [e('reward', 'login'), 'Signing in to the Satori Network…'],
    [e('reward', 'save'), 'Saving the reward address…'],
    [e('reward', 'clear'), 'Clearing the reward address…'],
    [e('train', 'score', 12, 81), 'Scoring models · 12 of 81'],
    [{ ...e('retrain', 'search', 0), name: 'eth' }, 'Retraining eth…'],
    [{ ...e('retrain', 'search', 40), name: 'eth' }, 'Retraining eth · tried 40'],
  ])('%o → %s', (entry, text) => {
    expect(workText(entry)).toBe(text);
  });
  test('a critical step says to keep Satori open, briefly', () => {
    expect(workText({ ...e('central', 'send', null, 82), critical: true })).toBe('Keep Satori open · Sending 82 predictions…');
    expect(workText({ ...e('stake', 'confirm', 2, 3), critical: true })).toBe('Keep Satori open · Step 2 of 3: waiting for Base to confirm…');
  });
  test('on a phone (keepOpen) every step says it: a phone puts a tab to sleep as soon as it leaves the screen', () => {
    expect(workText(e('central', 'history', 34, 82), { keepOpen: true })).toBe('Keep Satori open · Loading history · 34 of 82 streams');
    expect(workText({ ...e('central', 'send', null, 82), critical: true }, { keepOpen: true })).toBe('Keep Satori open · Sending 82 predictions…'); // once
    expect(workText(e('central', 'history', 34, 82), { keepOpen: false })).toBe('Loading history · 34 of 82 streams');
    expect(workText(null, { keepOpen: true })).toBe('');
  });
  test('null and unknown steps', () => {
    expect(workText(null)).toBe('');
    expect(workText(e('central', 'nope'))).toBe('Working…');
  });
});
