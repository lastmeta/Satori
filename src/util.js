// Small helpers shared by the modules.

/**
 * A line: the functions passed to it run one at a time, in call order, and
 * one that fails doesn't stop the ones after it. line(fn) → fn's promise;
 * line.idle() → a promise that settles when everything queued so far is done.
 */
export function serial() {
  let tail = Promise.resolve();
  const line = (fn) => {
    const p = tail.then(fn);
    tail = p.catch(() => {});
    return p;
  };
  line.idle = () => tail;
  return line;
}
