// Reordering a list by dragging its rows up or down (the Wallets card). A mouse drags as soon as it moves; a finger
// presses and holds first, so a swipe over the list still scrolls the page. While dragging, the rows only move by
// transform; on the drop, onOrder(ids) gets the rows' data-id values in the new order (and the list re-renders in it).
//   const drag = dragToOrder('.wallet-row', (ids) => …)
//   html`<ul @pointerdown="${drag.pointerdown}" @touchstart="${drag.touchstart}" @touchmove="${drag.touchmove}"
//     @touchend="${drag.touchend}" @touchcancel="${drag.touchcancel}" @contextmenu="${drag.contextmenu}">`
const HOLD_MS = 350; // a finger's press and hold before the row lifts
const SLOP = 8; // px a finger may wander while holding; more is a scroll
const MOUSE_SLOP = 4; // px a mouse moves before a press is a drag

export function dragToOrder(rowSelector, onOrder) {
  let d = null; // the press: { list, rows, from, to, y0, x0, on, timer, rects }

  const start = (e, y, x) => {
    const row = e.target.closest?.(rowSelector);
    const list = e.currentTarget;
    if (!row || !list.contains(row)) return false;
    const rows = [...list.querySelectorAll(rowSelector)];
    if (rows.length < 2) return false;
    d = { list, rows, row, from: rows.indexOf(row), to: rows.indexOf(row), y0: y, x0: x, on: false, timer: null };
    return true;
  };
  const lift = () => {
    if (!d) return;
    d.on = true;
    d.rects = d.rows.map((r) => r.getBoundingClientRect());
    d.row.classList.add('dragging');
    d.list.classList.add('sorting');
  };
  const move = (y) => {
    const { rows, rects, from } = d;
    const h = rects[from].height;
    const dy = Math.min(Math.max(y - d.y0, rects[0].top - rects[from].top), rects.at(-1).bottom - rects[from].bottom);
    // a row is passed once the dragged one's leading edge crosses its middle
    const [top, bottom] = [rects[from].top + dy, rects[from].bottom + dy];
    const mid = (i) => rects[i].top + rects[i].height / 2;
    d.to = from - rects.filter((r, i) => i < from && top < mid(i)).length + rects.filter((r, i) => i > from && bottom > mid(i)).length;
    rows.forEach((r, i) => {
      const shift = i === from ? dy : from < i && i <= d.to ? -h : d.to <= i && i < from ? h : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  /** The drop: the transforms go and onOrder has the new order, in the same task, so nothing jumps back first. */
  const finish = () => {
    const was = d;
    d = null;
    if (!was) return false;
    clearTimeout(was.timer);
    if (!was.on) return false;
    const ids = was.rows.map((r) => Number(r.dataset.id));
    const [id] = ids.splice(was.from, 1);
    ids.splice(was.to, 0, id);
    was.rows.forEach((r) => { r.style.transform = ''; });
    was.row.classList.remove('dragging');
    was.list.classList.remove('sorting');
    if (was.to !== was.from) onOrder(ids);
    return true;
  };

  const mousemove = (e) => {
    if (!d) return;
    if (!d.on && Math.abs(e.clientY - d.y0) > MOUSE_SLOP) lift();
    if (d.on) move(e.clientY);
  };
  const mouseup = () => {
    window.removeEventListener('pointermove', mousemove);
    window.removeEventListener('pointerup', mouseup);
    window.removeEventListener('pointercancel', mouseup);
    if (!finish()) return;
    // the button the drag began on (Remove, the radio, the address) is not pressed by its drop
    const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
  };

  return {
    pointerdown(e) {
      if (e.pointerType === 'touch' || e.button !== 0 || !start(e, e.clientY, e.clientX)) return;
      window.addEventListener('pointermove', mousemove);
      window.addEventListener('pointerup', mouseup);
      window.addEventListener('pointercancel', mouseup);
    },
    touchstart(e) {
      if (e.touches.length !== 1) { finish(); return; }
      const t = e.touches[0];
      if (start(e, t.clientY, t.clientX)) d.timer = setTimeout(lift, HOLD_MS);
    },
    touchmove(e) {
      if (!d) return;
      const t = e.touches[0];
      if (!d.on) {
        if (Math.abs(t.clientY - d.y0) > SLOP || Math.abs(t.clientX - d.x0) > SLOP) { clearTimeout(d.timer); d = null; } // a scroll
        return;
      }
      e.preventDefault(); // the page stays still under the dragged row
      move(t.clientY);
    },
    touchend(e) {
      if (finish()) e.preventDefault(); // no tap on what the finger let go over
    },
    touchcancel() { finish(); },
    contextmenu(e) {
      if (d) e.preventDefault(); // a long press is the hold, not the browser's menu
    },
  };
}
