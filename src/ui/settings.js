// Settings: the technical detail, behind Home (docs/intent/ui.md): the keys and their addresses with Unlock and Lock,
// the backup, the reward address (where the Satori Network sends the rewards), the Satori Network's server (central's URL), the Satori relays, the Base RPC and the batch's max fee, the appearance (System, Light,
// Dark: src/ui/theme.js), and this device (storage, install, update). Each section has an id (#settings-<name>) Home's
// action card scrolls to.
import { html } from '@arrow-js/core';
import { state } from './state.js';
import { form, idRow, wordList } from './parts.js';
import { storageText, relayText, BLOCKED_NOTE, shortHash } from './format.js';
import { ADD_TO } from '../neuron/health.js';

/** How Satori runs (docs/intent/ui.md: say it plainly), on Setup and in Settings › This device. */
export const RUNS_WHILE_OPEN = "Satori works while it's open. Leave it open, or install it, and it predicts on its own.";

/**
 * Install Satori (Chromium's prompt), or this browser's way to add it (iOS, Safari on a Mac, Firefox on Android:
 * src/pwa/platform.js); hidden once installed (docs/design/pwa.md#install).
 */
export const install = (a) => html`<div class="install" hidden="${() => state.app.installed || !(state.app.canInstall || ADD_TO[state.app.addTo])}">
  <button class="small-btn primary" data-test="install" hidden="${() => !state.app.canInstall}" @click="${a.install}">Install Satori</button>
  <span class="muted small" data-test="install-hint">${() => (state.app.canInstall ? 'Keeps your keys, and runs in its own window.' : ADD_TO[state.app.addTo] ?? '')}</span>
</div>`;

function keys(a) {
  return html`
  <section class="card settings-section" id="settings-keys">
    <h2>Keys</h2>
    <div class="key">
      <h3>Identity</h3>
      ${idRow('Address', 'identity', () => state.identity, a)}
      <p class="muted small">Runs the neuron on its own: signs in to the Satori Network and sends the daily batch to the Satori contract. Unencrypted.</p>
    </div>
    <div class="key">
      <h3>Vault <span class="${() => (state.unlocked ? 'badge on' : 'badge')}" data-test="vault-state">${() => (state.unlocked ? 'Unlocked' : 'Locked')}</span></h3>
      ${idRow('Address', 'vault', () => state.vault, a)}
      <p class="muted small">Holds your funds. Encrypted with your passphrase.</p>
      <form class="unlock" hidden="${() => state.unlocked}" @submit="${(e) => a.unlock(form(e), e.target)}">
        <input name="pass" type="password" aria-label="Vault passphrase" placeholder="Vault passphrase" autocomplete="current-password" required>
        <button class="primary" type="submit" data-test="unlock" disabled="${() => !!state.busy}">${() => (state.busy === 'unlock' ? 'Unlocking…' : 'Unlock')}</button>
      </form>
      <div class="actions" hidden="${() => !state.unlocked}"><button data-test="lock-vault" @click="${a.lock}">Lock the vault</button></div>
      <p class="error small" role="alert" hidden="${() => !state.vaultError}">${() => state.vaultError}</p>
    </div>
    <div class="key">
      <h3>Nostr</h3>
      ${idRow('Pubkey', 'nostr-pubkey', () => state.nostr.pubkey, a, () => state.nostr.npub)}
      <p class="muted small">Signs the neuron's Nostr events on its own. Unencrypted, as the identity.</p>
    </div>
  </section>`;
}

function backup(a) {
  return html`
  <section class="card settings-section" id="settings-backup">
    <h2>Backup</h2>
    <p class="muted small">The identity and the vault are 24 words each; Restore from words brings them back. The Nostr
      key is random, not from the words, so it is backed up on its own. Showing them asks for the vault's passphrase each time.</p>
    <div class="backup-row">
      <button class="small-btn" @click="${() => a.askBackup('identity')}">Identity words</button>
      <button class="small-btn" @click="${() => a.askBackup('vault')}">Vault words</button>
      <button class="small-btn" @click="${() => a.askBackup('nostr')}">Nostr key</button>
    </div>
    <form class="inline-unlock" data-test="backup-prompt" hidden="${() => !state.backupAsk}" @submit="${(e) => a.showBackup(form(e), e.target)}"><input name="pass" type="password" aria-label="Vault passphrase to show the backup" placeholder="Vault passphrase" autocomplete="current-password" required><button class="primary" type="submit" disabled="${() => state.revealing}">${() => (state.revealing ? 'Checking…' : 'Show')}</button><button type="button" @click="${a.cancelBackup}">Cancel</button><p class="error small" role="alert" hidden="${() => !state.backupError}">${() => state.backupError}</p></form>
    <div class="backup" hidden="${() => !state.backup}">
      <div hidden="${() => state.backup === 'nostr'}">
        <h3>${() => (state.backup === 'vault' ? 'Vault' : 'Identity')} words</h3>
        ${wordList(() => state.backupWords.split(' ').filter(Boolean))}
        <div class="label">Private key (imports into a Base wallet)</div>
      </div>
      <div hidden="${() => state.backup !== 'nostr'}">
        <h3>Nostr key</h3>
        <div class="label">nsec</div>
      </div>
      <code class="block" data-test="backup-key">${() => state.backupKey}</code>
      <div hidden="${() => !state.backupHex}">
        <div class="label">Secret (hex)</div>
        <code class="block" data-test="backup-hex">${() => state.backupHex}</code>
      </div>
      <div class="actions"><button @click="${a.hideBackup}">Hide</button></div>
    </div>
  </section>`;
}

/**
 * The reward address (docs/design/central.md#the-reward-address): where the Satori Network sends this neuron's rewards
 * instead of the vault. Read when Settings opens; saved or cleared signed in by the identity (no passphrase, no gas).
 */
function rewardWhen(r) {
  if (r.address) return '';
  if (r.at != null) return 'Not set · rewards go to your vault';
  return r.reading || !r.error ? 'Reading it from the Satori Network…' : "Couldn't read it from the Satori Network.";
}

function rewardCard(a) {
  const r = () => state.reward;
  const busy = () => !!state.rewardBusy;
  return html`
  <section class="card settings-section" id="settings-reward">
    <form class="fields reward-form" @submit="${(e) => a.saveReward(form(e), e.target)}">
      <h2>Reward address</h2>
      <p class="muted small">Where the Satori Network sends this neuron's rewards. Not set, they go to your vault. A Base address (0x…) sends them there instead, such as a pool's.</p>
      <div class="id reward-now"><span class="label">Now</span><code data-test="reward-address" title="${() => r().address ?? ''}" hidden="${() => !r().address}">${() => shortHash(r().address)}</code><button class="small-btn" type="button" hidden="${() => !r().address}" @click="${() => a.copy('reward-address', r().address)}">${() => (state.copied === 'reward-address' ? 'Copied' : 'Copy')}</button><span data-test="reward-none" hidden="${() => !!r().address}">${() => rewardWhen(r())}</span></div>
      <p class="error small" role="alert" data-test="reward-read-error" hidden="${() => !r().error}">${() => r().error ?? ''} <button class="small-btn" type="button" data-test="reward-retry" disabled="${() => r().reading}" @click="${a.readReward}">Try again</button></p>
      <label>New reward address
        <input name="address" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="0x…" required>
      </label>
      <p class="small" role="status" data-test="reward-line" hidden="${() => !(state.rewardLine || state.rewardDone)}">${() => state.rewardLine || state.rewardDone}</p>
      <p class="error small" role="alert" data-test="reward-error" hidden="${() => !state.rewardError}">${() => state.rewardError}</p>
      <div class="actions">
        <button class="primary" type="submit" data-test="reward-save" disabled="${busy}">${() => (state.rewardBusy === 'save' ? 'Saving…' : 'Save')}</button>
        <button type="button" data-test="reward-clear" hidden="${() => !r().address}" disabled="${busy}" @click="${a.clearReward}">${() => (state.rewardBusy === 'clear' ? 'Clearing…' : 'Clear')}</button>
      </div>
      <p class="muted small">Free: the identity signs it, so it needs no passphrase and no gas. It doesn't change staking. Home notes a change for a day.</p>
    </form>
  </section>`;
}

function centralForm(a) {
  return html`
  <section class="card settings-section" id="settings-central">
    <form class="fields" @submit="${(e) => a.saveCentral(form(e), e.target)}">
      <h2>Satori Network</h2>
      <p class="muted small">Where the neuron gets its streams and sends its predictions. Free: sending costs nothing.</p>
      <label>Satori Network server
        <input name="url" type="url" inputmode="url" autocomplete="off" placeholder="${() => state.centralDefault}">
      </label>
      <p class="muted small">Now: <code data-test="central-url">${() => state.central.url}</code>. Empty: the default, ${() => state.centralDefault}.
        Saving registers there at once, and Home notes the change for a day.</p>
      <p class="error" role="alert" hidden="${() => !state.settingsError}">${() => state.settingsError}</p>
      <div class="actions"><button class="primary" type="submit">Save</button></div>
    </form>
  </section>`;
}

function relaysForm(a) {
  return html`
  <section class="card settings-section" id="settings-relays">
    <form class="fields relays-form" @submit="${(e) => a.saveRelays(form(e), e.target)}">
      <h2>Satori relays</h2>
      <ul class="relays">${() => state.nostr.relays.map((r) => html`<li class="relay" data-test="relay"><code>${r.url}</code><span class="${r.state === 'open' ? 'badge on' : 'badge'}" data-test="relay-state">${relayText(r)}</span></li>`.key(`${r.url} ${r.state} ${r.write}`))}</ul>
      <p class="muted small" data-test="relays-blocked" hidden="${() => !state.nostr.relays.some((r) => r.state === 'blocked')}">${BLOCKED_NOTE}</p>
      <label>Your relays (Nostr; one per line, ws:// or wss://)
        <textarea name="relays" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
      </label>
      <label class="check"><input name="centralWrite" type="checkbox"> Publish to the Satori Network's relays</label>
      <p class="muted small">The Satori Network's relays are always read. Unticked, they are read only: the dev server's default,
        so a checkout never writes to the production relay. The relays above are always written to.</p>
      <p class="error" role="alert" hidden="${() => !state.relaysError}">${() => state.relaysError}</p>
      <div class="actions"><button class="primary" type="submit">Save relays</button></div>
    </form>
  </section>`;
}

function baseForm(a) {
  return html`
  <section class="card settings-section" id="settings-base">
    <form class="fields base-rpc-form" @submit="${(e) => a.saveBase(form(e), e.target)}">
      <h2>Satori contract</h2>
      <p class="muted small">The daily batch of predictions on Base. It uses gas: the identity pays each batch in Base ETH.</p>
      <label>Base RPC
        <input name="rpc" autocomplete="off" spellcheck="false" placeholder="the default">
      </label>
      <p class="muted small" title="The default: the build's RPC (sepolia.base.org), then publicnode; on the dev server, /rpc, a local fork of Base Sepolia on 127.0.0.1:8545 (node scripts/fork.mjs start).">
        An https:// URL, or a path on this site. Empty: the default (on the dev server, the local test chain). A saved one replaces it,
        and Home notes the change for a day.</p>
      <label>Max fee (gwei)
        <input name="maxFee" inputmode="decimal" autocomplete="off" placeholder="2">
      </label>
      <p class="muted small">The most any transaction pays per gas. Above it the daily batch waits for the next check, and Stake,
        Claim and Send say so. Base's fees are about 0.01 gwei. Empty: 2 gwei.</p>
      <p class="error" role="alert" hidden="${() => !state.baseRpcError}">${() => state.baseRpcError}</p>
      <div class="actions"><button class="primary" type="submit">Save contract settings</button></div>
    </form>
  </section>`;
}

const THEME_WORDS = { system: 'System', light: 'Light', dark: 'Dark' };

function appearance(a) {
  return html`
  <section class="card settings-section" id="settings-appearance">
    <h2>Appearance</h2>
    <div class="segmented" role="group" aria-label="Theme">${Object.entries(THEME_WORDS).map(([t, word]) => html`<button class="small-btn" data-test="${`theme-${t}`}" aria-pressed="${() => String(state.theme === t)}" @click="${() => a.setTheme(t)}">${word}</button>`)}</div>
    <p class="muted small">System follows this device's light or dark setting. Kept on this device only.</p>
  </section>`;
}

function device(a) {
  return html`
  <section class="card settings-section" id="settings-device">
    <h2>This device</h2>
    <p class="${() => (state.storage?.persisted ? 'small muted' : 'small')}" data-test="storage">${() => storageText(state.storage)}</p>
    ${install(a)}
    <p class="small" data-test="runs-while-open">${RUNS_WHILE_OPEN}</p>
    <p class="muted small" data-test="version">Version ${() => state.version}</p>
    <div class="actions" hidden="${() => !state.app.update}"><button class="primary" data-test="update-settings" @click="${a.update}">Update ready, reload</button></div>
  </section>`;
}

export function settingsTab(a) {
  return html`
  <section class="tab-page" data-test="settings-tab" hidden="${() => state.tab !== 'settings'}">
    ${keys(a)}
    ${backup(a)}
    ${rewardCard(a)}
    ${centralForm(a)}
    ${relaysForm(a)}
    ${baseForm(a)}
    ${appearance(a)}
    ${device(a)}
  </section>`;
}
