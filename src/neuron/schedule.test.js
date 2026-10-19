// The neuron's schedules after the device sleeps (docs/plans/runtime.md#catch-up-pass): browser timers don't count
// sleep, so a deadline that passed while the page was alive but asleep is run by the catch-up pass, once.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createSchedule, catchUpAll } from './schedule.js';

const H = 3600;
const T = 1_792_000_000; // seconds
const nowS = () => Date.now() / 1000;

beforeEach(() => { vi.useFakeTimers({ now: T * 1000 }); });
afterEach(() => { vi.useRealTimers(); });

/** A schedule every 11 h with a run held until release(). */
function every11h() {
  const runs = [];
  let release = null;
  const s = createSchedule(() => new Promise((r) => {
    runs.push(nowS());
    release = r;
  }), { after: () => nowS() + 11 * H });
  return { s, runs, release: (v) => release(v) };
}

describe('createSchedule: catchUp() runs a deadline that passed while the timers slept', () => {
  test('the wall clock jumps 12 h (a sleeping device), the timer has not fired: catchUp runs it once, then 11 h on', async () => {
    const { s, runs, release } = every11h();
    await s.start(T + 11 * H); // its timer: 11 h of timer time
    expect(s.catchUp()).toBeNull(); // not due yet
    await vi.advanceTimersByTimeAsync(H); // awake for an hour
    vi.setSystemTime((T + 12 * H) * 1000); // then asleep: Date.now() jumps 11 h; no timer fires (they don't count sleep)
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual([]);
    expect(s.next).toBeLessThan(nowS()); // overdue, and nothing runs: the bug

    const run = s.catchUp();
    expect(run).toBeInstanceOf(Promise);
    expect(s.running).toBe(true);
    expect(s.catchUp()).toBeNull(); // single flight: a second pass while it runs starts none
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual([T + 12 * H]);
    release('done');
    expect(await run).toBe('done');
    expect(s.next).toBe(T + 23 * H);

    // the old timer was cleared: when it would have fired (10 h of timer time on), nothing; the new one, 11 h on
    await vi.advanceTimersByTimeAsync(10 * H * 1000);
    expect(runs).toEqual([T + 12 * H]);
    await vi.advanceTimersByTimeAsync(H * 1000);
    expect(runs).toEqual([T + 12 * H, T + 23 * H]);
  });

  test('nothing before start(), and nothing after stop()', async () => {
    const { s } = every11h();
    vi.setSystemTime((T + 12 * H) * 1000);
    expect(s.catchUp()).toBeNull();
    await s.start(T);
    s.stop();
    expect(s.catchUp()).toBeNull();
  });

  test('after(outcome): the run\'s result, or its error, decides the next deadline', async () => {
    const seen = [];
    const s = createSchedule(async () => { if (seen.length) throw new Error('boom'); return 'ok'; },
      { after: (o) => { seen.push(o); return nowS() + H; } });
    await s.start(T + H);
    await s.run();
    await expect(s.run()).rejects.toThrow('boom');
    expect(seen).toEqual([{ result: 'ok' }, { error: new Error('boom') }]);
  });
});

describe('catchUpAll: one pass over the jobs', () => {
  test('starts every job that is due and not running; lists the ones that started; a failing job never stops the pass', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const started = [];
    const ran = catchUpAll({
      poll: () => { started.push('poll'); return Promise.resolve('polled'); },
      base: () => null, // not due
      relays: () => { throw new Error('relay gone'); },
      train: () => { started.push('train'); return undefined; }, // fire and forget: not listed
      late: () => Promise.reject(new Error('later')),
    }, 'tick');
    expect(ran).toEqual(['poll', 'late']);
    expect(started).toEqual(['poll', 'train']);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[satori] catch-up late', expect.any(Error)));
    expect(error).toHaveBeenCalledWith('[satori] catch-up relays', expect.any(Error));
    expect(info).toHaveBeenCalledWith('[satori] catch-up (tick): poll, late');
    expect(catchUpAll({ poll: () => null }, 'visible')).toEqual([]);
    expect(info).toHaveBeenCalledTimes(1); // a pass that started nothing says nothing
    error.mockRestore();
    info.mockRestore();
  });
});
