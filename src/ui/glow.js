// Home's chips glow while their channel has real traffic (src/traffic.js; docs/design/health.md#traffic). A burst
// is one style update in the next frame; the glow then holds until GLOW_MS after the last message (one timer that
// re-arms itself, none per message) and fades out in CSS. With prefers-reduced-motion it is a still tint for STILL_MS,
// with no fades (style.css).

export const GLOW_MS = 1500;
export const STILL_MS = 3000;

/**
 * @param {object} o
 * @param {(channel: string, on: boolean) => void} o.apply sets the card's live state
 * @param {() => boolean} [o.reduced] prefers-reduced-motion
 * @returns {(channel: string) => void} hit: traffic on that channel
 */
export function createGlow({ apply, reduced = () => false, now = () => Date.now(),
  frame = (fn) => requestAnimationFrame(fn), later = (fn, ms) => setTimeout(fn, ms) }) {
  const cards = new Map(); // channel → { last, on, queued }
  const hold = () => (reduced() ? STILL_MS : GLOW_MS);

  function check(channel, c) {
    const left = c.last + hold() - now();
    if (left > 0) return void later(() => check(channel, c), left);
    c.on = false;
    apply(channel, false);
  }

  return function hit(channel) {
    let c = cards.get(channel);
    if (!c) cards.set(channel, (c = { last: 0, on: false, queued: false }));
    c.last = now();
    if (c.on || c.queued) return; // glowing (its timer reads `last`), or this frame's update is coming
    c.queued = true;
    frame(() => {
      c.queued = false;
      c.on = true;
      apply(channel, true);
      later(() => check(channel, c), hold());
    });
  };
}
