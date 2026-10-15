import { expect, test } from 'vitest';
import { serial } from './util.js';

test('serial: one at a time, in call order; a failure does not stop the line; idle() waits for all queued', async () => {
  const line = serial();
  const log = [];
  const step = (name, ms, fail) => line(async () => {
    log.push(`${name}+`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${name}-`);
    if (fail) throw new Error(name);
    return name;
  });
  const a = step('a', 20);
  const b = step('b', 1, true);
  const c = step('c', 1);
  await line.idle();
  expect(log).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
  expect(await a).toBe('a');
  await expect(b).rejects.toThrow('b');
  expect(await c).toBe('c');
});
