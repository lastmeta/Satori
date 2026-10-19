// Home (docs/design/health.md, the approved docs/design/home-mockup.html): one glance answers "is my neuron
// predicting every day on its own, and is anything broken?" The phone shows the health, the one action card, the
// last 14 days, the three connections and the claimable rewards; a computer adds the streams, the wallet and the
// activity feed, as a dashboard.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { mark, sparkPath, unlockPrompt } from './parts.js';
import { fmtNum, modelText, amountText, daysText, claimParts, claimableText, openingText } from './format.js';
import { fmtAgo } from '../neuron/health.js';

const EMPTY = { status: 'idle', tone: 'idle', title: 'Starting', line: '', action: null, days: [], reasons: [], feed: [],
  channels: { network: { state: 'idle', tone: 'idle', text: '–' }, contract: { state: 'idle', tone: 'idle', text: '–' },
    relays: { state: 'idle', tone: 'idle', text: '–' } } };
/** The last visit's Home is on screen (docs/design/health.md#the-last-visit): a revisit, until the neuron's own arrives. */
const cachedNow = () => !!state.cached && state.screen !== 'home';
const h = () => state.health ?? (cachedNow() ? { ...EMPTY, ...state.cached.health } : EMPTY);
/** What the wallet tile reads: the chain's status, or the last visit's. */
const B = () => (cachedNow() ? { ...state.base, ...state.cached.base, identity: { ...state.base.identity, ...state.cached.base?.identity },
  vault: { ...state.base.vault, ...state.cached.base?.vault } } : state.base);
/**
 * The hero: the health, or the step the neuron is on (src/ui/hold.js's pace; docs/design/health.md#work). The last
 * visit's: its title and colour, the ring turning while the neuron opens, the line saying what it waits for.
 */
function hero() {
  if (cachedNow()) {
    const c = h();
    const tone = c.status === 'warn' || c.status === 'bad' ? c.status : 'working';
    return { status: c.status, tone, title: c.title, key: 'open', working: true, line: openingText(state.engine) };
  }
  return state.hero ?? { ...h(), key: 'idle', working: false };
}
const HOME_ROWS = 8;
const DAY_WORDS = { full: 'Predicted', part: 'Part of the day', error: 'Only failures', closed: 'App closed', before: 'Before this neuron' };
// the Satori Network (free to submit to), the Satori contract (uses gas), the Satori relays (docs/intent/ui.md)
const CHANNEL_TAB = { network: 'streams', contract: 'wallet', relays: 'streams' };

const fullDays = (n) => daysText(h().days.slice(-n));

function dayTitle(d) {
  const when = new Date(`${d.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const word = d.code === 'closed' && d.ran ? 'Nothing due' : DAY_WORDS[d.code];
  return `${when}${d.today ? ' (today)' : ''}: ${word}`;
}

const cell = (d) => html`<div class="${d.today ? 'cell today' : 'cell'}" data-test="day" data-date="${d.date}" data-code="${d.code}" title="${dayTitle(d)}"></div>`;

function chip(a, key, name, cost = '') {
  const c = () => h().channels[key];
  return html`<a class="chan" href="${`#${CHANNEL_TAB[key]}`}" data-test="chip" data-channel="${key}" data-state="${() => c().state}" data-tone="${() => c().tone}" @click="${(e) => { e.preventDefault(); if (!cachedNow()) a.go(CHANNEL_TAB[key]); }}"><span class="row1"><span class="state" data-tone="${() => c().tone}"><i class="ico"></i></span>${name}<small class="cost" hidden="${!cost}">${cost}</small></span><span class="sub" data-test="chip-text">${() => c().text}</span></a>`;
}

/** The claimable rewards: the total of the parts known (staking rewards, the Satori Network's drop, the airdrop). */
const claimable = () => (B().claimable?.total == null ? '–' : fmtNum(Number(B().claimable.total)));
/** The parts behind it, those above 0 ('3.62 from the Satori Network'); all of them on hover. */
const claimBreakdown = () => claimParts(B().claimable).filter(([, x]) => Number(x) > 0).map(([what, x]) => `${fmtNum(Number(x))} ${what}`).join(' · ');
const claimTitle = () => claimableText(B().claimable);

function vaultLine() {
  const v = B().vault;
  if (v.satori == null) return '–';
  const d = { identity: 'staked', none: 'not staked', other: 'staked elsewhere' }[v.staked] ?? '';
  return `${amountText(v.satori, 'SATORI')}${d ? ` · ${d}` : ''}`;
}

/** The identity's gas as days of daily batches (one a day). */
const gasLine = () => {
  const n = B().identity.batchesLeft;
  if (n == null) return '–';
  if (n === 0) return 'No ETH on the identity';
  return `${n >= 1000 ? '1,000+' : n} day${n === 1 ? '' : 's'} left`;
};

function homeRow(r, names) {
  const d = sparkPath(state.sparks[r.uuid]);
  return html`<div class="hrow" data-test="home-stream"><span title="${r.name}">${r.name}</span><span class="r">${fmtNum(r.obs_value)}</span><span class="r">${fmtNum(r.t2)}</span><span><span class="${r.model === 'bvar' ? 'chip' : 'chip n'}">${modelText(r, names)}</span></span><span><svg class="spark" viewBox="0 0 70 20" aria-hidden="true"><path d="${d}"></path></svg></span></div>`;
}

function streamsSummary() {
  const s = state.streams;
  const predicted = s.filter((r) => r.model).length;
  const bvar = s.filter((r) => r.model === 'bvar').length;
  return s.length ? `${predicted} predicted · ${bvar} on bvar` : 'none yet';
}

const feedRow = (f) => html`<div class="feed-row" data-test="feed-item" data-level="${f.level}">${mark(f.level)}<span>${f.text}</span><time title="${new Date(f.at * 1000).toLocaleString()}">${fmtAgo(state.now - f.at)}</time></div>`;

/** The action card's tone: its own reason's level (warn, bad; advice, nothing wrong: sky). */
const actionTone = () => {
  const s = h().reasons.find((r) => r.id === h().action?.id)?.status ?? h().status;
  return s === 'warn' || s === 'bad' ? s : 'idle';
};

export function home(a) {
  return html`
  <section class="dash" data-test="home" hidden="${() => state.tab !== 'home'}">
    <section class="hero" data-test="health" data-s="${() => hero().status}" data-tone="${() => hero().tone}" data-from="${() => hero().from ?? false}" data-work="${() => (hero().working ? hero().key : false)}" aria-busy="${() => (hero().working ? 'true' : false)}">
      <div class="ring" aria-hidden="true"><i class="ico"></i></div>
      <div><h2 data-test="health-title">${() => hero().title}</h2><p data-test="health-line">${() => hero().line}</p>
        <p class="stale small" data-test="health-stale" hidden="${() => !cachedNow()}">${() => (cachedNow() ? `From your last visit, ${fmtAgo(Date.now() / 1000 - state.cached.at / 1000)}` : '')}</p></div>
    </section>

    <div class="action" data-test="action" data-action="${() => h().action?.id ?? false}" data-tone="${actionTone}" hidden="${() => !h().action}">
      <p data-test="action-text">${() => h().action?.text ?? ''}</p>
      <button class="primary" data-test="action-button" hidden="${() => !h().action?.button}" disabled="${() => !!state.baseBusy}" @click="${() => a.act(h().action)}">${() => (h().action?.do === 'stake' && state.baseBusy === 'stake' ? 'Staking…' : h().action?.button ?? '')}</button>
      ${unlockPrompt(a, 'card', 'stake')}
      <p class="error small" role="alert" hidden="${() => !(state.baseDid === 'stake' && state.baseError)}">${() => state.baseError}</p>
    </div>

    <section class="tile days-tile">
      <div class="tile-h"><b class="phone-only">Last 14 days</b><b class="desk-only">Last 30 days</b><span class="phone-only" data-test="days-summary">${() => fullDays(14)}</span><span class="desk-only">${() => fullDays(30)}</span></div>
      <div class="strip" data-test="days">${() => h().days.map((d) => cell(d).key(`${d.date}:${d.code}:${d.ran}:${d.today}`))}</div>
      <div class="legend desk-only"><span><i data-code="full"></i>Predicted</span><span><i data-code="part"></i>Part of the day</span><span><i data-code="closed"></i>App closed</span><span><i data-code="error"></i>Error</span><span hidden="${() => !h().days.some((d) => d.code === 'before')}"><i data-code="before"></i>Before this neuron</span></div>
    </section>

    <section class="chans" data-test="channels">${chip(a, 'network', 'Network', 'free')}${chip(a, 'contract', 'Contract', 'uses gas')}${chip(a, 'relays', 'Relays')}</section>

    <section class="tile streams-tile desk-only" hidden="${cachedNow}">
      <div class="tile-h"><b>Streams</b><span>${streamsSummary}</span></div>
      <div class="hrows">
        <div class="hrow head" aria-hidden="true"><span>Stream</span><span class="r">Latest</span><span class="r">Forecast 24 h</span><span>Model</span><span>Trend</span></div>
        <div>${() => {
          const names = new Map(state.streams.map((r) => [r.uuid, r.name]));
          return state.streams.slice(0, HOME_ROWS).map((r) => homeRow(r, names).key(`${r.uuid}:${r.obs_ts}:${r.made_at}:${state.sparks[r.uuid]?.length}`));
        }}</div>
      </div>
      <p class="small" hidden="${() => state.streams.length <= HOME_ROWS}"><a href="#streams" @click="${(e) => { e.preventDefault(); a.go('streams'); }}">${() => `All ${state.streams.length} streams`}</a></p>
    </section>

    <section class="tile wallet-tile" data-test="claimable">
      <div class="tile-h desk-only"><b>Wallet</b><span>Base</span></div>
      <div class="earn">
        <div><div class="sub">Claimable rewards</div><div class="big" title="${claimTitle}"><span data-test="claimable-amount">${claimable}</span><small>SATORI</small></div><div class="sub" data-test="claimable-parts" hidden="${() => !claimBreakdown()}">${claimBreakdown}</div><div class="sub phone-only">${vaultLine}</div></div>
        <button class="soft" data-test="claim" disabled="${() => !!state.baseBusy || cachedNow()}" @click="${() => a.vaultAction('claim', 'baseClaim')}">${() => (state.baseBusy === 'claim' ? 'Claiming…' : 'Claim')}</button>
      </div>
      ${unlockPrompt(a, 'claim', 'claim')}
      <p class="small" role="status" data-test="claim-result" hidden="${() => !(state.baseDid === 'claim' && (state.baseResult || state.baseError))}">${() => state.baseResult || state.baseError}</p>
      <div class="line desk-only"><span>Vault</span><span data-test="home-vault">${vaultLine}</span></div>
      <div class="line desk-only"><span>Gas for the Satori contract</span><span data-test="home-gas">${gasLine}</span></div>
    </section>

    <details class="tile feed-tile" data-test="activity">
      <summary>Activity</summary>
      <div class="feed" data-test="feed">${() => h().feed.map((f) => feedRow(f).key(`${f.at}:${f.text}:${fmtAgo(state.now - f.at)}`))}</div>
      <p class="muted small" hidden="${() => h().feed.length > 0}">Nothing yet.</p>
    </details>
  </section>`;
}
