// Settings: the technical detail, behind Home (docs/intent/ui.md): the keys and their addresses with Unlock and Lock,
// the backup, central's URL, the Nostr relays, the Base RPC and the batch's max fee, and this device (storage, install,
// update). Each section has an id (#settings-<name>) Home's action card scrolls to.
import { html } from '@arrow-js/core';
import { version } from '../../package.json';
import { state } from './state.js';
import { form, idRow, unlockPrompt, wordList } from './parts.js';
import { storageText } from './format.js';

/** Install Satori (Chromium's prompt), or Safari's way to add it; hidden once installed (docs/design/pwa.md). */
const SAFARI_ADD = 'To keep your keys, add Satori to the Dock (File › Add to Dock) or Home Screen (Share › Add to Home Screen). '
  + 'The added app starts empty: set it up there, or restore it from your 24 words.';
export const install = (a) => html`<div class="install" hidden="${() => state.app.installed || !(state.app.canInstall || state.safari)}">
  <button class="small-btn primary" data-test="install" hidden="${() => !state.app.canInstall}" @click="${a.install}">Install Satori</button>
  <span class="muted small" data-test="install-hint">${() => (state.app.canInstall ? 'Keeps your keys, and runs in its own window.' : state.safari ? SAFARI_ADD : '')}</span>
</div>`;

function keys(a) {
  return html`
  <section class="card settings-section" id="settings-keys">
    <h2>Keys</h2>
    <div class="key">
      <h3>Identity</h3>
      ${idRow('Address', 'identity', () => state.identity, a)}
      <p class="muted small">Runs the neuron on its own: signs in to central and sends the daily Base batch. Unencrypted.</p>
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
      key is random, not from the words, so it is backed up on its own. Showing them needs the vault's passphrase.</p>
    <div class="backup-row">
      <button class="small-btn" @click="${() => a.showBackup('identity')}">Identity words</button>
      <button class="small-btn" @click="${() => a.showBackup('vault')}">Vault words</button>
      <button class="small-btn" @click="${() => a.showBackup('nostr')}">Nostr key</button>
    </div>
    ${unlockPrompt(a, 'backup', 'back up')}
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

function centralForm(a) {
  return html`
  <section class="card settings-section" id="settings-central">
    <form class="fields" @submit="${(e) => a.saveCentral(form(e), e.target)}">
      <h2>Central</h2>
      <label>Central URL
        <input name="url" type="url" inputmode="url" autocomplete="off" placeholder="${() => state.centralDefault}">
      </label>
      <p class="muted small">Now: ${() => state.central.url}. Empty: the default, ${() => state.centralDefault}.
        Saving registers there at once.</p>
      <p class="error" role="alert" hidden="${() => !state.settingsError}">${() => state.settingsError}</p>
      <div class="actions"><button class="primary" type="submit">Save</button></div>
    </form>
  </section>`;
}

function relaysForm(a) {
  return html`
  <section class="card settings-section" id="settings-relays">
    <form class="fields relays-form" @submit="${(e) => a.saveRelays(form(e), e.target)}">
      <h2>Nostr relays</h2>
      <label>Nostr relays (one per line, ws:// or wss://)
        <textarea name="relays" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
      </label>
      <label class="check"><input name="centralWrite" type="checkbox"> Publish to central's relays</label>
      <p class="muted small">Central's relays are always read. Unticked, they are read only: the dev server's default,
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
      <h2>Base</h2>
      <label>Base RPC
        <input name="rpc" autocomplete="off" spellcheck="false" placeholder="the default">
      </label>
      <p class="muted small" title="The default: in a build, central's RPC (sepolia.base.org), then publicnode; on the dev server, /rpc, a local fork of Base Sepolia on 127.0.0.1:8545 (node scripts/fork.mjs start).">
        An https:// URL, or a path on this site. Empty: the default (on the dev server, the local test chain). A saved one replaces it.</p>
      <label>Daily batch: max fee (gwei)
        <input name="maxFee" inputmode="decimal" autocomplete="off" placeholder="2">
      </label>
      <p class="muted small">The identity sends the batch on its own; above this max fee per gas it waits for the next check.
        Base's fees are about 0.01 gwei. Empty: 2 gwei.</p>
      <p class="error" role="alert" hidden="${() => !state.baseRpcError}">${() => state.baseRpcError}</p>
      <div class="actions"><button class="primary" type="submit">Save Base settings</button></div>
    </form>
  </section>`;
}

function device(a) {
  return html`
  <section class="card settings-section" id="settings-device">
    <h2>This device</h2>
    <p class="${() => (state.storage?.persisted ? 'small muted' : 'small')}" data-test="storage">${() => storageText(state.storage)}</p>
    ${install(a)}
    <p class="muted small">Satori ${version}. The neuron runs while Satori is open, in a tab or as an installed app.</p>
    <div class="actions" hidden="${() => !state.app.update}"><button class="primary" data-test="update-settings" @click="${a.update}">Update ready, reload</button></div>
  </section>`;
}

export function settingsTab(a) {
  return html`
  <section class="tab-page" data-test="settings-tab" hidden="${() => state.tab !== 'settings'}">
    ${keys(a)}
    ${backup(a)}
    ${centralForm(a)}
    ${relaysForm(a)}
    ${baseForm(a)}
    ${device(a)}
  </section>`;
}
