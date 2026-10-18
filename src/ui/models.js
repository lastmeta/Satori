// Models (docs/design/models.md, docs/intent/ui.md): the engine's status on top (working or resting, how many models
// of each kind, when it last trained and runs next, how good they are against no change), then every model, each
// named for the stream it predicts; a tap opens its drill-in (#models/<id>): In, the Model, Out, top to bottom, the
// neuron's pipeline without a canvas. What each part says comes from ./drill.js (pure, tested); this places it.
// The data stays out of the reactive state (box.list, box.detail; state.modelsRev and modelRev say it changed).
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { summaryOf, engineStatus, sortModels, filterModels } from '../neuron/models.js';
import { rowView, statusView, drillView, chartOf } from './drill.js';
import { fmtNum, fmtWhen } from './format.js';

/** The models (models()) and the open model (model(id)), set by main.js. */
export const box = { list: [], detail: null };

const ICON = {
  central: () => html`<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="4.5" rx="1.5"></rect><rect x="2.5" y="9" width="11" height="4.5" rx="1.5"></rect></svg>`,
  base: () => html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z"></path></svg>`,
  network: () => html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="9" r="1.6"></circle><path d="M4.8 5.8a4.5 4.5 0 0 0 0 6.4M11.2 5.8a4.5 4.5 0 0 1 0 6.4M2.6 3.6a7.6 7.6 0 0 0 0 10.8M13.4 3.6a7.6 7.6 0 0 1 0 10.8"></path></svg>`,
};
const TO = { central: 'Central', base: 'Base', network: 'Network' };
const FILTERS = [['all', 'All'], ['central', 'Central'], ['base', 'Base'], ['network', 'Network']];
const SORTS = [['quality', 'Quality'], ['name', 'Name']];

/** The models' hash route: ids are `<source>:<key>`, kept readable. */
export const modelHref = (id) => `#models/${encodeURIComponent(id).replace(/%3A/gi, ':')}`;

const dest = (to) => html`<span class="dest" data-to="${to}" title="${TO[to]}" aria-label="${TO[to]}">${ICON[to]()}</span>`;

function row(a, v) {
  // One root node, no whitespace around it (see streams.js: ArrowJS 1.0.6's keyed lists).
  return html`<a class="mrow" href="${modelHref(v.id)}" data-test="model-row" data-id="${v.id}" data-mark="${v.mark}" @click="${(e) => { e.preventDefault(); a.openModel(v.id); }}"><span class="q" data-q="${v.mark}" title="${v.markTitle}"><i class="qi"></i><b data-test="model-mark">${v.markText}</b></span><span class="mname"><b data-test="model-name">${v.name}</b><small hidden="${!v.as}">${`→ ${v.as}`}</small></span><span class="mmeta"><span class="mkind"><span class="${v.kind === 'bvar' ? 'chip' : 'chip n'}" data-test="model-kind">${v.kind}</span></span><span class="mins" data-test="model-inputs">${v.chips.map((c) => html`<span class="ichip">${c}</span>`)}</span><span class="mval" data-test="model-forecast" title="${`latest → forecast ${v.horizon} ahead`}"><span class="muted">${v.latest}</span><span class="to-arrow">→</span><b>${v.forecast}</b><span class="dir" data-dir="${v.arrow}">${v.arrow}</span></span></span><span class="mto" data-test="model-to">${v.dests.map(dest)}</span></a>`;
}

/** The list's view, read again when the models, the sort or the filter change. */
const listed = () => {
  void state.modelsRev;
  return sortModels(filterModels(box.list, state.modelFilter), state.modelSort).map(rowView);
};
const summary = () => {
  void state.modelsRev;
  return summaryOf(box.list);
};
const count = (to) => {
  void state.modelsRev;
  return filterModels(box.list, to).length;
};

function status() {
  const st = () => engineStatus({ summary: summary(), central: state.central, work: state.engineWork, now: state.now });
  const sv = () => statusView(summary());
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
      <span data-test="engine-quality">${() => sv().marks}</span>
      <span class="muted small" data-test="engine-median">${() => sv().median}</span>
    </div>
  </section>`;
}

function controls(a) {
  return html`
  <div class="mcontrols">
    <div class="segmented" role="group" aria-label="Show the models whose predictions go to">${FILTERS.map(([k, word]) => html`<button class="small-btn" data-test="${`models-filter-${k}`}" aria-pressed="${() => String(state.modelFilter === k)}" @click="${() => a.setModelView({ filter: k })}">${word} <span class="n">${() => count(k)}</span></button>`)}</div>
    <div class="segmented" role="group" aria-label="Sort the models by">${SORTS.map(([k, word]) => html`<button class="small-btn" data-test="${`models-sort-${k}`}" aria-pressed="${() => String(state.modelSort === k)}" @click="${() => a.setModelView({ sort: k })}">${word}</button>`)}</div>
  </div>`;
}

function list(a) {
  return html`
  <section class="tile mlist" data-test="models">
    <div class="mrow head" aria-hidden="true"><span>Quality</span><span>Predicts</span><span>Model</span><span>Inputs</span><span class="r">Latest → forecast</span><span class="r">To</span></div>
    <div>${() => listed().map((v) => row(a, v).key(`${v.id}|${v.markText}|${v.kind}|${v.chips}|${v.latest}|${v.forecast}|${v.dests}`))}</div>
    <p class="muted small" data-test="models-empty" hidden="${() => listed().length > 0}">${() => (box.list.length ? 'No model sends its predictions there yet.' : 'No models yet: the first poll builds one for each stream central serves.')}</p>
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
const CHART_H = 150;
let charts = { key: '', list: [] };
/** Each output's chart at the out block's measured width (px for px: text and dots at their size). */
const chartAt = (i) => {
  const key = `${state.modelRev}:${state.modelWidth}`;
  if (charts.key !== key) {
    charts = { key, list: (box.detail?.outputs ?? []).map((o) => chartOf(o, { w: Math.max(240, state.modelWidth), h: CHART_H })) };
  }
  return charts.list[i] ?? null;
};

const bar = (x) => html`<div class="ibar" data-test="model-input" data-own="${x.own}"><span class="iname">${x.name}${x.own ? html`<small> (itself)</small>` : ''}</span><svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><line class="track" x1="0" y1="5" x2="100" y2="5"></line><line class="fill" x1="0" y1="5" x2="${x.share ? Math.max(x.share * 100, 0.5) : 0}" y2="5" hidden="${!x.share}"></line></svg><b class="ipct">${x.pct}</b></div>`;

const destRow = (d) => html`<li class="drow" data-test="model-destination" data-to="${d.to}">${dest(d.to)}<span class="dlabel">${d.label}</span>${d.href ? html`<a href="${d.href}" target="_blank" rel="noopener">${d.text}</a>` : html`<span>${d.text}</span>`}</li>`;

/** The readout under a chart: the point under the pointer, else the forecast's endpoint. */
function readout(o, i) {
  const h = state.modelHover;
  const c = chartAt(i);
  const p = h?.out === i ? c?.hover[h.i] : null;
  if (p) return `${p.ahead ? 'Forecast for ' : ''}${fmtWhen(p.ts)} · ${fmtNum(p.value)}`;
  const end = c?.points.at(-1);
  return end ? `Forecast for ${fmtWhen(end.ts)} · ${fmtNum(end.value)}` : o.latestWhen ? `Latest ${o.latestWhen}` : '';
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
function chart(i) {
  const c = () => chartAt(i);
  const hp = () => (state.modelHover?.out === i ? c()?.hover[state.modelHover.i] : null);
  const pt = (k) => () => { const p = c()?.points ?? []; return k === 'end' ? p.at(-1) : p.length > 1 ? p[0] : null; };
  const end = pt('end');
  const mid = pt('mid');
  const y = (k) => () => c()?.yLabels[k];
  const x = (k) => () => c()?.xLabels[k];
  const label = () => {
    const o = dv()?.outputs[i];
    return o ? `${o.name}: recent history and the forecast. Latest ${o.latest}; ${o.forecast}.` : '';
  };
  const top = () => c()?.pad.t ?? 0;
  const bottom = () => CHART_H - (c()?.pad.b ?? 0);
  return html`<svg class="mchart" data-test="model-chart" viewBox="${() => `0 0 ${c()?.w ?? 300} ${CHART_H}`}" height="${CHART_H}" role="img" aria-label="${label}" tabindex="0" @pointermove="${(e) => hover(e, i)}" @pointerleave="${() => { state.modelHover = null; }}" @keydown="${(e) => step(e, i)}"><line class="now" x1="${() => c()?.now ?? -10}" x2="${() => c()?.now ?? -10}" y1="${top}" y2="${bottom}"></line><path class="hist" d="${() => c()?.line ?? ''}"></path><path class="ahead" d="${() => c()?.ahead ?? ''}"></path><line class="cross" hidden="${() => !hp()}" x1="${() => hp()?.x ?? -10}" x2="${() => hp()?.x ?? -10}" y1="${top}" y2="${bottom}"></line><circle class="last" r="3.5" hidden="${() => !c()?.last}" cx="${() => c()?.last?.x ?? -10}" cy="${() => c()?.last?.y ?? -10}"></circle><circle class="fpt" r="4" hidden="${() => !mid()}" cx="${() => mid()?.x ?? -10}" cy="${() => mid()?.y ?? -10}"></circle><circle class="fpt end" data-test="model-endpoint" r="5.5" hidden="${() => !end()}" cx="${() => end()?.x ?? -10}" cy="${() => end()?.y ?? -10}"></circle><circle class="hot" r="4.5" hidden="${() => !hp()}" cx="${() => hp()?.x ?? -10}" cy="${() => hp()?.y ?? -10}"></circle><text class="ylab" x="${() => (c()?.pad.l ?? 0) + 2}" y="${() => (y(0)()?.y ?? 0) + 11}">${() => y(0)()?.text ?? ''}</text><text class="ylab" x="${() => (c()?.pad.l ?? 0) + 2}" y="${() => (y(1)()?.y ?? 0) - 4}">${() => y(1)()?.text ?? ''}</text><text class="xlab" x="${() => x(0)()?.x ?? 0}" y="${CHART_H - 1}">${() => x(0)()?.text ?? ''}</text><text class="xlab" text-anchor="end" x="${() => x(1)()?.x ?? 0}" y="${CHART_H - 1}">${() => x(1)()?.text ?? ''}</text><text class="elab" text-anchor="end" x="${() => c()?.endLabel?.x ?? -10}" y="${() => c()?.endLabel?.y ?? -10}">${() => c()?.endLabel?.text ?? ''}</text></svg>`;
}

function outBlock(o, i) {
  return html`<div class="oblock" data-test="model-output" data-stream="${o.key}"><div class="ohead"><b data-test="model-output-name">${o.name}</b><small class="muted" hidden="${!o.as}">${`published as ${o.as}`}</small></div><div class="ovals"><span class="olatest">Latest <b>${o.latest}</b><small class="muted">${o.latestWhen ? ` · ${o.latestWhen}` : ''}</small></span><span class="oforecast" data-test="model-output-forecast">${o.forecast} <span class="dir" data-dir="${o.arrow}">${o.arrow}</span></span></div>${chart(i)}<p class="readout muted small" data-test="model-readout">${() => readout(o, i)}</p><ul class="dests">${o.destinations.map(destRow)}</ul></div>`;
}

function drill(a) {
  const v = () => dv();
  return html`
  <section class="drill" data-test="model-detail" hidden="${() => !state.modelOpen}">
    <a class="back" href="#models" data-test="model-back" @click="${(e) => { e.preventDefault(); a.closeModel(); }}">← Models</a>
    <p class="muted" data-test="model-loading" hidden="${() => !!v() || !!state.modelError}">Opening the model…</p>
    <p class="error" role="alert" data-test="model-error" hidden="${() => !state.modelError}">${() => state.modelError}</p>
    <div class="stages" hidden="${() => !v()}">
      <header class="drill-h">
        <div><h2 data-test="model-title">${() => v()?.title ?? ''}</h2><p class="muted small">${() => v()?.sub ?? ''}</p></div>
        <span class="q big" data-q="${() => v()?.quality.mark ?? 'none'}" title="${() => (v() ? `vs no change: ${v().quality.text}` : '')}"><i class="qi"></i><b>${() => v()?.quality.short ?? ''}</b></span>
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
