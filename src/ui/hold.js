// The pace of what Home says the neuron is doing (docs/design/health.md#work): slow enough to read, never far behind.
// A view is { key, working, … }: key is the step ('central:history') or 'idle'. A step stays at least HOLD_MS on screen
// before another replaces it: its time begins once it is painted (the frame that draws it, then a task after that
// paint), not when it was set, since a busy page (Home's first frame) paints late. At most two views wait: the next in
// order (so a short step that began meanwhile still shows) and the latest (later ones take its place), so the screen
// is at most about two seconds behind. The same step with a new count shows at once, waiting or not. The end of the
// work waits at least GRACE_MS, and gives way to work that comes meanwhile, so two tasks back to back (register, then
// the poll) read as one. With `delay`, work shows only once it has lasted that long (the network's actions: a quick
// one never flickers).

export const HOLD_MS = 1000;
export const GRACE_MS = 300;

/**
 * @param {{show: (view: object) => void, now?: () => number, setTimeout?: Function, clearTimeout?: Function,
 *   delay?: number, painted?: (fn: () => void) => void}} o now: ms; painted: calls fn once what was just shown is on
 *   screen (default: the next frame, then a task; at once where there are no frames)
 * @returns {(view: {key: string, working: boolean}) => void} set: the view wanted now
 */
export function createHold({ show, now = () => Date.now(), setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout,
  delay = 0, painted = globalThis.requestAnimationFrame ? (fn) => requestAnimationFrame(() => st(fn, 0)) : (fn) => fn() }) {
  let current = null; // the view shown: { key, working, at } (at: when it was painted, or set until then)
  let queue = []; // waiting: [{ view, since }], at most 2
  let timer = null;

  function put(view) {
    if (view.key !== current?.key) {
      const shown = current = { key: view.key, working: view.working, at: now() };
      painted(() => { if (current === shown) shown.at = now(); }); // a waiting view's timer reads it again (pump)
    }
    show(view);
  }

  /** When a waiting view may replace the one shown. */
  function due({ view, since }) {
    if (!current.working) return view.working ? since + delay : now();
    const rest = current.at + HOLD_MS;
    return view.working ? rest : Math.max(rest, since + GRACE_MS);
  }

  function pump() {
    ct(timer);
    timer = null;
    while (queue.length) {
      const at = due(queue[0]);
      if (at > now()) {
        timer = st(pump, at - now());
        return;
      }
      put(queue.shift().view);
    }
  }

  return function set(view) {
    if (!current || view.key === current.key) {
      queue = [];
      ct(timer);
      return put(view);
    }
    const same = queue.find((q) => q.view.key === view.key);
    if (same) {
      same.view = view;
    } else {
      queue = queue.filter((q) => q.view.working); // a waiting end gives way to work that came after it
      const item = { view, since: now() };
      if (queue.length < 2) queue.push(item);
      else queue[1] = item;
    }
    pump();
  };
}
