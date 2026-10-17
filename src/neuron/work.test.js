// What the neuron is doing now (docs/design/health.md#work): the work state's transitions and its words.
import { describe, expect, test, vi } from 'vitest';
import { createWork, workText, ORDER } from './work.js';

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
    expect(w.current()).toEqual({ task: 'central', step: 'register', done: null, total: null, since: 1000 });
    now.t = 1500;
    job.step('history', 0, 82);
    now.t = 1700;
    job.step('history', 34, 82);
    expect(w.current()).toEqual({ task: 'central', step: 'history', done: 34, total: 82, since: 1500 });
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

  test(`current(): the first task in progress in ${ORDER.join(', ')} order`, () => {
    const w = createWork();
    w.start('claim').step('rewards');
    expect(w.current()).toMatchObject({ task: 'claim' });
    w.start('base').step('check');
    expect(w.current()).toMatchObject({ task: 'base' });
    w.start('central').step('observations');
    expect(w.current()).toMatchObject({ task: 'central' });
  });
});

describe('workText: plain words, from the person\'s side', () => {
  const e = (task, step, done = null, total = null) => ({ task, step, done, total, since: 0 });
  test.each([
    [e('central', 'register'), 'Signing in to central…'],
    [e('central', 'observations'), "Fetching today's observations…"],
    [e('central', 'history', 34, 82), 'Loading history · 34 of 82 streams'],
    [e('central', 'models', 40, 82), 'Building models · 40 of 82'],
    [e('central', 'send', null, 82), 'Sending 82 predictions…'],
    [e('central', 'send', null, 1), 'Sending 1 prediction…'],
    [e('base', 'check'), "Checking today's Base games…"],
    [e('base', 'send'), 'Sending the Base batch…'],
    [e('base', 'confirm'), 'Waiting for Base to confirm…'],
    [e('delegate', 'send', 1, 3), 'Step 1 of 3: sending…'],
    [e('delegate', 'confirm', 2, 3), 'Step 2 of 3: waiting for Base to confirm…'],
    [e('delegate', 'send', 1, 1), 'Sending…'],
    [e('delegate', 'confirm', 1, 1), 'Waiting for Base to confirm…'],
    [e('delegate', 'settle'), 'Checking it on Base…'],
    [e('claim', 'rewards'), 'Claiming rewards…'],
    [e('claim', 'drop'), 'Claiming the reward drop…'],
    [e('claim', 'airdrop'), 'Claiming the airdrop…'],
    [e('claim', 'confirm'), 'Waiting for Base to confirm…'],
    [e('discover', 'ask', 1, 2), 'Asking the relays · 1 of 2'],
    [e('subscribe', 'find'), 'Finding the stream on the relays…'],
  ])('%o → %s', (entry, text) => {
    expect(workText(entry)).toBe(text);
  });
  test('null and unknown steps', () => {
    expect(workText(null)).toBe('');
    expect(workText(e('central', 'nope'))).toBe('Working…');
  });
});
