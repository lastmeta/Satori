// Home (docs/design/health.md, the approved docs/design/home-mockup.html): one glance answers "is my neuron
// predicting every day on its own, and is anything broken?" The phone shows the health, the one action card, the
// last 14 days, the three connections and the claimable rewards; a computer adds the streams, the wallet and the
// activity feed, as a dashboard.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { mark, sparkPath, unlockPrompt } from './parts.js';
import { fmtNum, figure, modelText, amountText, daysText, claimParts, claimableText, openingText } from './format.js';
import { fmtAgo } from '../neuron/health.js';
import { chipCard } from './contract.js';
import { howCard } from './how.js';

const EMPTY = { status: 'idle', tone: 'idle', title: 'Starting', line: '', action: null, days: [], reasons: [], feed: [], notices: [],
  channels: { network: { state: 'idle', tone: 'idle', text: '–' }, contract: { state: 'idle', tone: 'idle', text: '–' },
    relays: { state: 'idle', tone: 'idle', text: '–' } } };
/** The last visit's Home is on screen (docs/design/health.md#the-last-visit): a revisit, until the neuron's own arrives. */
const cachedNow = () => !!state.cached && state.screen !== 'home';
const h = () => state.health ?? (cachedNow() ? { ...EMPTY, ...state.cached.health } : EMPTY);
/** What the wallet tile reads: the chain's status, or the last visit's. */
function B() {
  const live = state.base; // read first, whichever shows: the expression keeps following it once the last visit's goes
  if (!cachedNow()) return live;
  const c = state.cached.base;
  return { ...live, ...c, alias: { ...live.alias, ...c?.alias }, wallet: { ...live.wallet, ...c?.wallet } };
}
/**
 * The hero: the health, or the step the neuron is on (src/ui/hold.js's pace; docs/design/health.md#work). The last
 * visit's: its title and colour (sky with "Predicted", the owner 2026-10-28: not working green under it), the ring
 * turning while the neuron opens, the line saying what it waits for.
 */
function hero() {
  if (cachedNow()) {
    const c = h();
    const tone = c.status === 'warn' || c.status === 'bad' ? c.status : 'idle';
    return { status: c.status, tone, title: c.title, key: 'open', working: true, line: openingText(state.engine) };
  }
  return state.hero ?? { ...h(), key: 'idle', working: false };
}
const HOME_ROWS = 8;
const DAY_WORDS = { full: 'Predicted', part: 'Part of the day', error: 'Only failures', closed: 'App closed', before: 'Before this app' };
// the Satori Service (free to submit to), the Satori contract (uses gas), the Satori relays (docs/intent/ui.md)
const CHANNEL_TAB = { network: 'streams', contract: 'wallet', relays: 'streams' };

const fullDays = (n) => daysText(h().days.slice(-n));

const HALF_WORDS = { ok: 'predicted', error: 'errors only', none: 'nothing' };
function dayTitle(d) {
  const when = new Date(`${d.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const word = d.code === 'closed' && d.ran ? 'Nothing due' : DAY_WORDS[d.code];
  const halves = d.code === 'before' || !d.network ? '' : `. Satori Service: ${HALF_WORDS[d.network]}; Satori contract: ${HALF_WORDS[d.contract]}`;
  return `${when}${d.today ? ' (today)' : ''}: ${word}${halves}`;
}

// Plain values only, no live ones: the strip is drawn again when they change (its key). A live value in a cell can be
// queued just as the strip redraws (the last visit's Home giving way to the live one) and run for a cell gone, which
// throws inside ArrowJS 1.0.6 and stops every update queued with it: Home froze.
const cell = (a, d) => html`<button class="${d.today ? 'cell today' : 'cell'}" data-test="day" data-date="${d.date}" data-code="${d.code}" title="${dayTitle(d)}" aria-label="${dayTitle(d)}" aria-pressed="${String(state.dayOpen === d.date)}" disabled="${d.code === 'before' || cachedNow()}" @click="${() => a.openDay(d.date)}"><i class="half" data-half="${d.network ?? 'none'}"></i><i class="half" data-half="${d.contract ?? 'none'}"></i></button>`;

// ── a day opened (src/neuron/day.js) ──
// the contract's lines are one text (pre-line): a list of templates of one text showed the first day's lines on every day
const clock = (s) => new Date(s * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function networkDay(n) {
  if (!n.sent) return 'No predictions sent.';
  const m = n.marks;
  const scored = m.better + m.tie + m.worse;
  const when = clock(n.first) === clock(n.last) ? `at ${clock(n.first)}` : `${clock(n.first)} to ${clock(n.last)}`;
  const parts = [`Sent ${plural(n.sent, 'prediction')}, ${when}.`];
  if (scored) parts.push(`Against no change: ${m.better} better, ${m.tie} the same, ${m.worse} worse.`);
  return parts.join(' ');
}
const RESULT = { right: 'right', wrong: 'wrong' };
const callText = (c) => `${c.named ? 'Sentiment stream' : 'Stream'} ${c.streamId}: ${c.direction}, ${RESULT[c.result] ?? 'not scored yet'}`;
function contractDay(c) {
  if (!c.batches.length) return [c.skipped ? `Not sent: ${c.skipped.split(':')[0].replace(/\.$/, '')}.` : 'Not sent.'];
  return c.batches.flatMap((b) => [`Sent at ${clock(b.at)}: ${plural(b.games, 'game')}.`, ...(b.calls ?? []).map(callText)]);
}
function dayBody(d) {
  if (d.error) return html`<p class="error small">${d.error}</p>`;
  const title = new Date(`${d.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  return html`<div class="day-body" data-test="day-body" data-date="${d.date}"><b>${title}</b><dl class="facts">
    <div class="fact"><dt>Satori Service</dt><dd data-test="day-network">${networkDay(d.network)}</dd></div>
    <div class="fact"><dt>Satori contract</dt><dd class="lines" data-test="day-contract">${contractDay(d.contract).join('\n')}</dd></div>
  </dl>${!d.open && !d.network.sent ? html`<p class="muted small">The app wasn't open this day.</p>` : ''}</div>`;
}

function chip(a, key, name, cost = '') {
  const c = () => h().channels[key];
  // a chip opens its card under the chips (src/ui/contract.js)
  return html`<a class="chan" href="${`#${CHANNEL_TAB[key]}`}" data-test="chip" data-channel="${key}" data-state="${() => c().state}" data-tone="${() => c().tone}" aria-expanded="${() => String(state.chipOpen === key)}" @click="${(e) => { e.preventDefault(); if (!cachedNow()) a.toggleChip(key); }}"><span class="row1"><span class="state" data-tone="${() => c().tone}"><i class="ico"></i></span>${name}<small class="cost" hidden="${!cost}">${cost}</small></span><span class="sub" data-test="chip-text">${() => c().text}</span></a>`;
}

/** The claimable rewards: the total of the parts known (staking rewards, the Satori Service's drop, the airdrop). */
const claimable = () => (B().claimable?.total == null ? '–' : fmtNum(Number(B().claimable.total)));
/** The parts behind it, those above 0 ('3.62 from the Satori Service'); all of them on hover. */
const claimBreakdown = () => claimParts(B().claimable).filter(([, x]) => Number(x) > 0).map(([what, x]) => `${fmtNum(Number(x))} ${what}`).join(' · ');
const claimTitle = () => claimableText(B().claimable);

/** Under the wallet's SATORI: its ETH. */
const walletLine = () => (B().wallet.eth == null ? '–' : amountText(B().wallet.eth, 'ETH'));
/** On the card's right (owner, 2026-10-26): "Staked" when staked here; a Stake button when it isn't but holds SATORI; else nothing. */
const stakedHere = () => B().wallet.staked === 'alias';
const canStake = () => ['none', 'other'].includes(B().wallet.staked) && Number(B().wallet.satori) > 0;

/** The alias's gas as days of daily batches (one a day). */
const gasLine = () => {
  const n = B().alias.batchesLeft;
  if (n == null) return '–';
  if (n === 0) return 'No gas for the daily batch';
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
        <p class="stale small" data-test="health-stale" hidden="${() => !cachedNow()}">${() => (cachedNow() ? `From your last visit, ${fmtAgo(Date.now() / 1000 - state.cached.at / 1000)}` : '')}</p>
        <div class="notes" data-test="notices" hidden="${() => !(h().notices ?? []).length}">${() => (h().notices ?? []).map((n) => html`<p class="note small" data-test="notice-line" data-what="${n.what}">${n.text} · ${fmtAgo(state.now - n.at)}</p>`.key(`${n.at}:${n.text}:${fmtAgo(state.now - n.at)}`))}</div></div>
    </section>

    <div class="action" data-test="action" data-action="${() => h().action?.id ?? false}" data-tone="${actionTone}" hidden="${() => !h().action}">
      <p data-test="action-text">${() => h().action?.text ?? ''}</p>
      <button class="primary" data-test="action-button" hidden="${() => !h().action?.button}" disabled="${() => !!state.baseBusy}" @click="${() => a.act(h().action)}">${() => (h().action?.do === 'stake' && state.baseBusy === 'stake' ? 'Staking…' : h().action?.do === 'relink' && state.baseBusy === 'link' ? 'Linking…' : h().action?.button ?? '')}</button>
      <button data-test="action-dismiss" hidden="${() => !h().action?.dismiss}" @click="${() => a.dismissAdvice(h().action?.id)}">${() => h().action?.dismiss ?? ''}</button>
      ${unlockPrompt(a, 'card', () => (h().action?.do === 'relink' ? 'link' : 'stake'))}
      <p class="error small" role="alert" hidden="${() => !(['stake', 'link'].includes(state.baseDid) && state.baseError)}">${() => state.baseError}</p>
    </div>

    <section class="tile days-tile">
      <div class="tile-h"><b class="phone-only">Last 14 days</b><b class="desk-only">Last 30 days</b><span class="phone-only" data-test="days-summary">${() => fullDays(14)}</span><span class="desk-only">${() => fullDays(30)}</span></div>
      <div class="strip" data-test="days">${() => h().days.map((d) => cell(a, d).key(`${d.date}:${d.code}:${d.network}:${d.contract}:${d.ran}:${d.today}:${state.dayOpen === d.date}:${cachedNow()}`))}</div>
      <div class="day-panel" data-test="day-detail" data-open="${() => String(!!state.dayOpen && !!state.day)}"><div class="day-inner">${() => (state.day ? dayBody(state.day).key(`${state.day.date}:${JSON.stringify(state.day).length}`) : '')}</div></div>
      <div class="legend desk-only"><span><i data-half="ok"></i>Predicted</span><span><i data-half="error"></i>Errors only</span><span><i data-half="none"></i>Nothing</span><span hidden="${() => !h().days.some((d) => d.code === 'before')}"><i data-code="before"></i>Before this app</span></div>
    </section>

    <section class="chans" data-test="channels">${chip(a, 'network', 'Service', 'free')}${chip(a, 'contract', 'Contract', 'uses gas')}${chip(a, 'relays', 'Relays')}${chipCard(a)}</section>

    <section class="tile streams-tile desk-only" hidden="${cachedNow}">
      <div class="tile-h"><b>Streams</b><span>${streamsSummary}</span></div>
      <div class="hrows">
        <div class="hrow head" aria-hidden="true"><span>Stream</span><span class="r">Latest</span><span class="r">Forecast 24 h</span><span>Model</span><span>Trend</span></div>
        <div>${() => {
          const names = new Map(state.streams.map((r) => [r.uuid, r.name]));
          return state.streams.slice(0, HOME_ROWS).map((r) => homeRow(r, names).key(`${r.uuid}:${r.obs_ts}:${r.made_at}:${state.sparks[r.uuid]?.length}`));
        }}</div>
      </div>
      <p class="small" hidden="${() => state.streams.length <= HOME_ROWS}"><a href="#streams" @click="${(e) => { e.preventDefault(); a.go('streams'); document.querySelector('[data-test=streams]').open = true; }}">${() => `All ${state.streams.length} streams`}</a></p>
    </section>

    <div class="money">
      <section class="tile wallet-tile" data-test="home-wallet-card">
        <div class="tile-h desk-only"><b>Wallet</b><span>Base</span></div>
        <div class="earn"><div><div class="sub">Wallet</div><div class="big"><span data-test="home-satori">${() => figure(B().wallet.satori)}</span><small>SATORI</small></div><div class="sub" data-test="home-wallet">${walletLine}</div></div>
          <b class="staked" data-test="home-staked" hidden="${() => !stakedHere()}">Staked</b>
          <button class="primary" data-test="home-stake" hidden="${() => !canStake()}" disabled="${() => !!state.baseBusy || cachedNow()}" @click="${() => a.walletAction('home-stake', 'baseDelegate')}">${() => (state.baseBusy === 'stake' ? 'Staking…' : 'Stake')}</button>
        </div>
        ${unlockPrompt(a, 'home-stake', 'stake from the Wallet card')}
        <p class="small" role="status" data-test="home-stake-result" hidden="${() => !(state.baseDid === 'stake' && (state.baseResult || state.baseError))}">${() => state.baseResult || state.baseError}</p>
        <div class="line desk-only"><span>Gas for the Satori contract</span><span data-test="home-gas">${gasLine}</span></div>
      </section>
      <section class="tile wallet-tile" data-test="claimable">
        <div class="earn">
          <div><div class="sub">Claimable rewards</div><div class="big" title="${claimTitle}"><span data-test="claimable-amount">${claimable}</span><small>SATORI</small></div><div class="sub" data-test="claimable-parts" hidden="${() => !claimBreakdown()}">${claimBreakdown}</div></div>
          <button class="soft" data-test="claim" disabled="${() => !!state.baseBusy || cachedNow()}" @click="${() => a.walletAction('claim', 'baseClaim')}">${() => (state.baseBusy === 'claim' ? 'Claiming…' : 'Claim')}</button>
        </div>
        ${unlockPrompt(a, 'claim', 'claim')}
        <p class="small" role="status" data-test="claim-result" hidden="${() => !(state.baseDid === 'claim' && (state.baseResult || state.baseError))}">${() => state.baseResult || state.baseError}</p>
      </section>
    </div>

    ${howCard()}
    <details class="tile feed-tile" data-test="activity">
      <summary>Activity</summary>
      <div class="feed" data-test="feed">${() => h().feed.map((f) => feedRow(f).key(`${f.at}:${f.text}:${fmtAgo(state.now - f.at)}`))}</div>
      <p class="muted small" hidden="${() => h().feed.length > 0}">Nothing yet.</p>
    </details>
  </section>`;
}
