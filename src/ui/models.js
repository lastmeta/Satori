// Models (docs/design/models.md, docs/intent/ui.md): the engine's status on top (working or resting, how many models
// of each kind, when it last trained and runs next, how good they are against no change), then every model, each
// named for the stream it predicts; a tap opens its drill-in (#models/<id>): In, the Model, Out, top to bottom, the
// neuron's pipeline without a canvas. What each part says comes from ./drill.js (pure, tested); this places it.
// The data stays out of the reactive state (box.list, box.detail, box.retrains; state.modelsRev, modelRev and retrainRev
// say it changed): ArrowJS 1.0.6 makes nested objects reactive in place, and shared ones break its expressions.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { summaryOf, engineStatus, sortModels, filterModels } from '../neuron/models.js';
import { rowView, statusView, drillView, chartOf, numText, retrainView } from './drill.js';
import { fmtWhen } from './format.js';
import { menuKey } from './prefs.js';

/** The models (models()), the open model (model(id)) and Retrain's statuses (central uuid → status), set by main.js. */
export const box = { list: [], detail: null, retrains: {} };

// where predictions go, by the words people see (docs/intent/ui.md): the Satori Network, the Satori contract, the Satori relays
const TO = { network: 'Network', contract: 'Contract', relays: 'Relays' };
const FILTERS = [['network', 'Network'], ['contract', 'Contract'], ['relays', 'Relays']]; // toggles, all on at first
const SORTS = [['quality', 'Quality'], ['name', 'Name']];

/** The models' hash route: ids are `<source>:<key>`, kept readable. */
export const modelHref = (id) => `#models/${encodeURIComponent(id).replace(/%3A/gi, ':')}`;

// Inside a list's item, an expression keeps one kind of value (always text, or always a template): ArrowJS 1.0.6 syncs
// a reused item's slots in place, and a slot that was text and is now a template printed the template's source.
// So what is shown or not is `hidden`, never a conditional template.
/** Where predictions go: a tiny text tag (the owner could not read the pictograms). */
const dest = (to) => html`<span class="tag" data-to="${to}">${TO[to]}</span>`;

function row(a, v) {
  // One root node, no whitespace around it (see streams.js: ArrowJS 1.0.6's keyed lists).
  return html`<a class="mrow" href="${modelHref(v.id)}" data-test="model-row" data-id="${v.id}" data-mark="${v.mark}" @click="${(e) => { e.preventDefault(); a.openModel(v.id); }}"><span class="q" data-q="${v.mark}" title="${v.markTitle}"><b data-test="model-mark" data-short="${v.markShort}">${v.markText}</b></span><span class="mname"><b data-test="model-name">${v.name}</b><small hidden="${!v.as}">${`publishes ${v.as}`}</small></span><span class="mmeta"><span class="mkind"><span class="${v.kind === 'bvar' ? 'chip' : 'chip n'}" data-test="model-kind">${v.kind}</span></span><span class="mins" data-test="model-inputs"><span class="mreads" hidden="${!v.chips.length}">reads</span>${v.chips.map((c) => html`<span class="ichip">${c}</span>`)}</span><span class="mval" data-test="model-forecast" title="${`${v.nowText}, ${v.nextText} ${v.arrow}`}"><span class="mnow" hidden="${!v.horizon}"><span class="muted">Now</span> ${v.latest}</span><span class="mnext"><span class="muted" hidden="${!v.horizon}">${`in ${v.horizon}`}</span> <b>${v.forecast}</b> <span class="dir" data-dir="${v.arrow}">${v.arrow}</span></span></span></span><span class="mto" data-test="model-to">${v.dests.map(dest)}</span></a>`;
}

/** The list's view, read again when the models, the sort or the filter change. */
const listed = () => {
  void state.modelsRev;
  return sortModels(filterModels(box.list, state.modelTo), state.modelSort).map(rowView);
};
const summary = () => {
  void state.modelsRev;
  return summaryOf(box.list);
};

function status() {
  const st = () => engineStatus({ summary: summary(), central: state.central, work: state.engineWork, now: state.now });
  const sv = () => statusView(summary());
  const legendOf = (k) => sv().legend.find((x) => x.mark === k); // the bar's legend: the rows' words, each in its colour
  // the quality bar: a fixed segment per mark in a 100-wide box (preserveAspectRatio none; the gaps are the surface).
  // Fixed SVG children with reactive attributes: ArrowJS builds an inserted chunk outside the SVG namespace.
  const seg = (mark) => () => {
    let x = 0;
    for (const s of sv().bar) {
      if (s.mark === mark) return { x, w: s.pct };
      x += s.pct;
    }
    return { x, w: 0 };
  };
  const x = (mark) => () => seg(mark)().x;
  const w = (mark) => () => seg(mark)().w;
  return html`
  <section class="tile engine" data-test="engine" data-tone="${() => st().tone}">
    <div class="engine-state">
      <span class="state" data-tone="${() => st().tone}"><i class="ico"></i></span>
      <div><b data-test="engine-title">${() => st().title}</b><p data-test="engine-line">${() => st().line}</p></div>
    </div>
    <div class="engine-fact"><span class="label">Models</span><span data-test="engine-kinds">${() => sv().kinds}</span></div>
    <div class="engine-fact" hidden="${() => !summary().total}">
      <span class="label">Against no change</span>
      <svg class="qbar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="seg" data-q="better" x="${x('better')}" y="0" width="${w('better')}" height="8"></rect><rect class="seg" data-q="tie" x="${x('tie')}" y="0" width="${w('tie')}" height="8"></rect><rect class="seg" data-q="worse" x="${x('worse')}" y="0" width="${w('worse')}" height="8"></rect><rect class="seg" data-q="unscored" x="${x('unscored')}" y="0" width="${w('unscored')}" height="8"></rect></svg>
      <span class="qlegend" data-test="engine-quality" aria-label="${() => sv().marks}">${['better', 'tie', 'worse', 'unscored'].map((k) => html`<span class="qleg" data-q="${k}" hidden="${() => !legendOf(k)}"><i aria-hidden="true"></i>${() => legendOf(k)?.text ?? ''}</span> `)}</span>
    </div>
  </section>`;
}

// ── the Sort menu: a menu button (WAI-ARIA), its items the choices with a check on the current one ──
const sortItems = () => [...document.querySelectorAll('[data-test=models-sort-menu] [role=menuitemradio]')];
const sortButton = () => document.querySelector('[data-test=models-sort]');
/** Open it, the current choice focused (after it is drawn). */
function openSort() {
  state.sortOpen = true;
  requestAnimationFrame(() => (sortItems().find((el) => el.getAttribute('aria-checked') === 'true') ?? sortItems()[0])?.focus());
}
/** Close it; `restore`: focus back on the button (Escape, a choice), not when focus moved on (Tab, a tap elsewhere). */
function closeSort(restore = false) {
  if (!state.sortOpen) return;
  state.sortOpen = false;
  if (restore) sortButton()?.focus();
}
function sortKeys(e) {
  const items = sortItems();
  const i = items.indexOf(e.target);
  if (i < 0) { // on the button: the arrows open it too
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); openSort(); }
    return;
  }
  const k = menuKey(e.key, i, items.length);
  if (!k) return;
  if (k.focus != null) { e.preventDefault(); items[k.focus].focus(); }
  if (k.close) {
    if (k.restore) e.preventDefault();
    closeSort(k.restore);
  }
}
// a tap anywhere else closes it
globalThis.document?.addEventListener('pointerdown', (e) => {
  if (state.sortOpen && !e.target.closest?.('.msort')) closeSort();
});

function sortMenu(a) {
  const current = () => SORTS.find(([k]) => k === state.modelSort)?.[1] ?? SORTS[0][1];
  return html`<div class="msort" @keydown="${sortKeys}"><button class="sortbtn" data-test="models-sort" aria-haspopup="menu" aria-controls="models-sort-menu" aria-expanded="${() => String(state.sortOpen)}" @click="${() => (state.sortOpen ? closeSort(true) : openSort())}"><i class="sorti" aria-hidden="true"></i><span>Sort<span class="sortv">${() => `: ${current()}`}</span></span></button><div class="sortmenu" id="models-sort-menu" role="menu" aria-label="Sort the models by" data-test="models-sort-menu" hidden="${() => !state.sortOpen}">${SORTS.map(([k, word]) => html`<button class="sortitem" role="menuitemradio" tabindex="-1" data-test="${`models-sort-${k}`}" aria-checked="${() => String(state.modelSort === k)}" @click="${() => { a.setModelView({ sort: k }); closeSort(true); }}">${word}</button>`)}</div></div>`;
}

function controls(a) {
  return html`
  <div class="mcontrols">
    <div class="segmented" role="group" aria-label="Show the models whose predictions go to">${FILTERS.map(([k, word]) => html`<button class="small-btn" data-test="${`models-filter-${k}`}" aria-pressed="${() => String(state.modelTo.includes(k))}" @click="${() => a.setModelView({ to: k })}">${word}</button>`)}</div>
    ${sortMenu(a)}
  </div>`;
}

function list(a) {
  return html`
  <section class="tile mlist" data-test="models">
    <div class="mrow head" aria-hidden="true"><span>Quality</span><span>Predicts</span><span>Model</span><span>Inputs</span><span class="r">Now · forecast</span><span class="r">Goes to</span></div>
    <div>${() => listed().map((v) => row(a, v).key(`${v.id}|${v.markText}|${v.kind}|${v.chips}|${v.latest}|${v.forecast}|${v.dests}`))}</div>
    <p class="muted small" data-test="models-empty" hidden="${() => listed().length > 0}">${() => (box.list.length ? 'No model sends its predictions there yet.' : 'No models yet: the first poll builds one for each stream the Satori Network serves.')}</p>
  </section>`;
}

// ── the drill-in ──

let memo = { key: '', view: null };
/** The drill-in's view, recomputed when the model, the output chosen, the width or the minute change. */
const dv = () => {
  const key = `${state.modelRev}:${state.modelOutput}:${state.modelWidth}:${Math.floor(state.now / 60)}:${state.base.explorer}`;
  if (memo.key !== key) {
    memo = { key, view: box.detail ? drillView(box.detail, { now: state.now, explorer: state.base.explorer, output: state.modelOutput }) : null };
  }
  return memo.view;
};
const CHART_H = 160;
let charts = { detail: null, w: 0, list: [] };
/**
 * Each output's chart at the out block's measured width (px for px: text and dots at their size). Keyed on the detail
 * itself, not state.modelRev: the out blocks are rebuilt when it changes (their key holds it), and an expression inside
 * one that also followed modelRev would be queued and released in the same flush, which stops ArrowJS 1.0.6's queue
 * ("expressionPool[effect] is not a function") and leaves the rest of that flush's expressions frozen.
 */
const chartAt = (i) => {
  const w = state.modelWidth;
  if (charts.detail !== box.detail || charts.w !== w) {
    charts = { detail: box.detail, w, list: (box.detail?.outputs ?? []).map((o) => chartOf(o, { w: Math.max(240, w), h: CHART_H })) };
  }
  return charts.list[i] ?? null;
};

const bar = (x) => html`<div class="ibar" data-test="model-input" data-own="${x.own}"><span class="iname" title="${x.own ? `${x.name} (itself: its own last step)` : x.name}">${x.name}</span><svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><line class="track" x1="0" y1="5" x2="100" y2="5"></line><line class="fill" x1="0" y1="5" x2="${x.share ? Math.max(x.share * 100, 0.5) : 0}" y2="5" hidden="${!x.share}"></line></svg><b class="ipct">${x.pct}</b></div>`;

const destRow = (d) => html`<li class="drow" data-test="model-destination" data-to="${d.to}"><span class="tag dlabel">${d.label}</span><a class="dtext" href="${d.href || false}" target="_blank" rel="noopener">${d.text}</a></li>`;

/** The readout under a chart: the point under the pointer, else the forecast's endpoint. */
function readout(o, i) {
  const h = state.modelHover;
  const c = chartAt(i);
  const p = h?.out === i ? c?.hover[h.i] : null;
  if (p) return `${p.ahead ? 'Forecast for ' : ''}${fmtWhen(p.ts)} · ${numText(p.value)}`;
  const end = c?.points.at(-1);
  return end ? `Forecast for ${fmtWhen(end.ts)} · ${numText(end.value)}` : o.latestWhen ? `Latest ${o.latestWhen}` : '';
}

function hover(e, i) {
  const c = chartAt(i);
  if (!c?.hover.length) return;
  const svg = e.currentTarget;
  const x = ((e.clientX - svg.getBoundingClientRect().left) / svg.clientWidth) * c.w;
  let best = 0;
  c.hover.forEach((p, k) => { if (Math.abs(p.x - x) < Math.abs(c.hover[best].x - x)) best = k; });
  state.modelHover = { out: i, i: best };
}
function step(e, i) {
  const c = chartAt(i);
  if (!c?.hover.length || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();
  const at = state.modelHover?.out === i ? state.modelHover.i : c.hover.length - 1;
  state.modelHover = { out: i, i: Math.max(0, Math.min(c.hover.length - 1, at + (e.key === 'ArrowLeft' ? -1 : 1))) };
}

/**
 * The chart: fixed SVG children with reactive attributes (ArrowJS builds an inserted chunk outside the SVG
 * namespace): the made-at hairline, the history, the forecast dashed from the last point, the latest point, one
 * step's point and the endpoint (the value sent, emphasized), the crosshair, the range's labels.
 */
function chart(o, i) {
  const c = () => chartAt(i);
  const hp = () => (state.modelHover?.out === i ? c()?.hover[state.modelHover.i] : null);
  const pt = (k) => () => { const p = c()?.points ?? []; return k === 'end' ? p.at(-1) : p.length > 1 ? p[0] : null; };
  const end = pt('end');
  const mid = pt('mid');
  const y = (k) => () => c()?.yLabels[k];
  const tl = (k) => () => c()?.timeLabels[k]; // how far ahead each forecast point is ("12 h", "24 h")
  const x = (k) => () => c()?.xLabels[k];
  const label = `${o.name}: recent history and the forecast. Latest ${o.latest}; ${o.forecast}.`; // the block's own output (static)
  const top = () => c()?.pad.t ?? 0;
  const bottom = () => CHART_H - (c()?.pad.b ?? 0);
  return html`<svg class="mchart" data-test="model-chart" viewBox="${() => `0 0 ${c()?.w ?? 300} ${CHART_H}`}" height="${CHART_H}" role="img" aria-label="${label}" tabindex="0" @pointermove="${(e) => hover(e, i)}" @pointerleave="${() => { state.modelHover = null; }}" @keydown="${(e) => step(e, i)}"><line class="grid" x1="${() => c()?.pad.l ?? 0}" x2="${() => (c() ? c().w - c().pad.r : 0)}" y1="${() => c()?.grid[0] ?? -10}" y2="${() => c()?.grid[0] ?? -10}"></line><line class="grid" x1="${() => c()?.pad.l ?? 0}" x2="${() => (c() ? c().w - c().pad.r : 0)}" y1="${() => c()?.grid[1] ?? -10}" y2="${() => c()?.grid[1] ?? -10}"></line><line class="now" x1="${() => c()?.now ?? -10}" x2="${() => c()?.now ?? -10}" y1="${top}" y2="${bottom}"></line><path class="hist" d="${() => c()?.line ?? ''}"></path><path class="ahead" d="${() => c()?.ahead ?? ''}"></path><line class="cross" hidden="${() => !hp()}" x1="${() => hp()?.x ?? -10}" x2="${() => hp()?.x ?? -10}" y1="${top}" y2="${bottom}"></line><circle class="last" r="3.5" hidden="${() => !c()?.last}" cx="${() => c()?.last?.x ?? -10}" cy="${() => c()?.last?.y ?? -10}"></circle><circle class="fpt" r="4" hidden="${() => !mid()}" cx="${() => mid()?.x ?? -10}" cy="${() => mid()?.y ?? -10}"></circle><circle class="fpt end" data-test="model-endpoint" r="5.5" hidden="${() => !end()}" cx="${() => end()?.x ?? -10}" cy="${() => end()?.y ?? -10}"></circle><circle class="hot" r="4.5" hidden="${() => !hp()}" cx="${() => hp()?.x ?? -10}" cy="${() => hp()?.y ?? -10}"></circle><text class="ylab" x="${() => c()?.pad.l ?? 0}" y="${() => y(0)()?.y ?? -10}">${() => y(0)()?.text ?? ''}</text><text class="ylab" x="${() => c()?.pad.l ?? 0}" y="${() => y(1)()?.y ?? -10}">${() => y(1)()?.text ?? ''}</text><text class="xlab" x="${() => x(0)()?.x ?? 0}" y="${CHART_H - 1}">${() => x(0)()?.text ?? ''}</text><text class="xlab" text-anchor="end" x="${() => x(1)()?.x ?? 0}" y="${CHART_H - 1}">${() => x(1)()?.text ?? ''}</text><text class="elab" text-anchor="end" x="${() => c()?.endLabel?.x ?? -10}" y="${() => c()?.endLabel?.y ?? -10}">${() => c()?.endLabel?.text ?? ''}</text><text class="tlab" data-test="model-ahead" text-anchor="${() => tl(0)()?.anchor ?? 'middle'}" x="${() => tl(0)()?.x ?? -10}" y="${() => tl(0)()?.y ?? -10}">${() => tl(0)()?.text ?? ''}</text><text class="tlab" data-test="model-ahead" text-anchor="${() => tl(1)()?.anchor ?? 'middle'}" x="${() => tl(1)()?.x ?? -10}" y="${() => tl(1)()?.y ?? -10}">${() => tl(1)()?.text ?? ''}</text></svg>`;
}

function outBlock(o, i) {
  return html`<div class="oblock" data-test="model-output" data-stream="${o.key}"><div class="ohead"><b data-test="model-output-name">${o.name}</b><small class="muted" hidden="${!o.as}">${`published as ${o.as}`}</small></div><div class="ovals"><span class="olatest">Latest <b>${o.latest}</b><small class="muted">${o.latestWhen ? ` · ${o.latestWhen}` : ''}</small></span><span class="oforecast" data-test="model-output-forecast">${o.forecast} <span class="dir" data-dir="${o.arrow}">${o.arrow}</span></span></div>${chart(o, i)}<p class="readout muted small" data-test="model-readout">${() => readout(o, i)}</p>${o.outcomes ? html`<figure class="rchart" data-test="model-outcomes"><figcaption class="small"><b>How it did</b></figcaption>${o.outcomes.actual ? html`<svg viewBox="0 0 300 80" preserveAspectRatio="none" role="img" aria-label="${`The last ${o.outcomes.n} outcomes and what this model forecast for each, from ${o.outcomes.bottom} to ${o.outcomes.top}`}"><path class="ra" d="${o.outcomes.actual}"></path><path class="rp" d="${o.outcomes.predicted}"></path></svg><figcaption class="small muted"><span class="lg la">Actual</span><span class="lg lp">Predicted</span><span>${o.outcomes.caption}</span></figcaption>` : html`<p class="small muted" data-test="model-outcomes-note">${o.outcomes.note}</p>`}</figure>` : ''}<ul class="dests">${o.destinations.map(destRow)}</ul></div>`;
}

/** Retrain in the header (docs/design/models.md#retrain): the open model's runner status (box.retrains), or an error starting it. */
const rv = () => {
  void state.modelRev;
  void state.retrainRev;
  const d = box.detail;
  if (!d) return null;
  const uuid = d.source === 'central' ? d.id.slice('central:'.length) : null;
  const view = retrainView(d, uuid ? box.retrains[uuid] : null);
  return state.retrainError ? { ...view, line: state.retrainError, tone: 'bad' } : view;
};

function drill(a) {
  const v = () => dv();
  return html`
  <section class="drill" data-test="model-detail" hidden="${() => !state.modelOpen}">
    <a class="back" href="#models" data-test="model-back" @click="${(e) => { e.preventDefault(); a.closeModel(); }}">← Models</a>
    <p class="muted" data-test="model-loading" hidden="${() => !!v() || !!state.modelError}">Opening the model…</p>
    <p class="error" role="alert" data-test="model-error" hidden="${() => !state.modelError}">${() => state.modelError}</p>
    <div class="stages" hidden="${() => !v()}">
      <header class="drill-h">
        <h2 data-test="model-title">${() => v()?.title ?? ''}</h2>
        <div class="drill-a">
          <span class="q big" data-test="model-quality" data-q="${() => v()?.quality.mark ?? 'none'}" title="${() => (v() ? `vs no change: ${v().quality.text}` : '')}"><b>${() => v()?.quality.short ?? ''}</b></span>
          <button class="${() => (rv()?.button?.primary ? 'primary rbtn' : 'rbtn')}" data-test="model-retrain" data-action="${() => rv()?.button?.action ?? ''}" hidden="${() => !rv()?.button}" @click="${() => a.retrainModel(rv()?.button?.action)}">${() => rv()?.button?.label ?? ''}</button>
        </div>
        <p class="kindlabel" data-test="model-kind-label">${() => v()?.kindLabel ?? ''}</p>
        <p class="muted small sub">${() => v()?.sub ?? ''}</p>
        <p class="rline" role="status" data-test="model-retrain-line" data-r="${() => rv()?.tone ?? ''}" hidden="${() => !rv()?.line}"><span class="state" data-tone="working" hidden="${() => rv()?.tone !== 'working'}"><i class="ico"></i></span><span>${() => rv()?.line ?? ''}</span></p>
        <p class="muted small rnote" data-test="model-retrain-note" hidden="${() => !rv()?.note}">${() => rv()?.note ?? ''}</p>
      </header>
      <section class="tile stage" data-test="model-in">
        <div class="stage-h"><b>In</b><span>${() => v()?.note ?? ''}</span></div>
        <div class="segmented" role="group" aria-label="The inputs of" hidden="${() => !v()?.choose}">${() => (v()?.choose ?? []).map((name, k) => html`<button class="small-btn" aria-pressed="${() => String(state.modelOutput === k)}" @click="${() => { state.modelOutput = k; }}">${name}</button>`.key(`${k}:${name}`))}</div>
        <div class="bars">${() => (v()?.inputs ?? []).map((x) => bar(x).key(`${x.stream}:${x.pct}:${x.own}`))}</div>
      </section>
      <div class="flow" aria-hidden="true"></div>
      <section class="tile stage" data-test="model-model">
        <div class="stage-h"><b>Model</b><span class="${() => (v()?.kind === 'bvar' ? 'chip' : 'chip n')}">${() => v()?.kind ?? ''}</span></div>
        <div class="mlines">${() => (v()?.model.lines ?? []).map((l) => html`<p class="mline" data-test="model-line">${l}</p>`.key(l))}</div>
        <details class="mdetails" data-test="model-details" hidden="${() => !v()?.model.details.length}"><summary>Details</summary><dl class="facts">${() => (v()?.model.details ?? []).map(([k, x]) => html`<div class="fact"><dt>${k}</dt><dd>${x}</dd></div>`.key(`${k}:${x}`))}</dl></details>
      </section>
      <div class="flow" aria-hidden="true"></div>
      <section class="tile stage" data-test="model-out">
        <div class="stage-h"><b>Out</b><span>${() => { const n = v()?.outputs.length ?? 0; return n === 1 ? 'the stream it predicts, and where the forecast went' : `${n} streams it predicts, and where each forecast went`; }}</span></div>
        <div class="outs">${() => (v()?.outputs ?? []).map((o, i) => outBlock(o, i).key(`${state.modelRev}:${i}:${o.key}`))}</div>
      </section>
    </div>
  </section>`;
}

export function modelsTab(a) {
  return html`
  <section class="tab-page models-page" data-test="models-tab" hidden="${() => state.tab !== 'models'}">
    <div class="mlist-page" hidden="${() => !!state.modelOpen}">
      ${status()}
      ${controls(a)}
      ${list(a)}
    </div>
    ${drill(a)}
  </section>`;
}

/** The drill-in's charts are drawn at the out block's width: measured here, as it changes. */
export function watchModelWidth(root) {
  const el = root.querySelector('[data-test=model-out]');
  if (!el || !globalThis.ResizeObserver) return;
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w > 0 && Math.abs(w - state.modelWidth) > 4) state.modelWidth = w;
  }).observe(el);
}
