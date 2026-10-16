// A reload or a crash with no checkpoint (docs/design/storage.md#the-checkpoint-rule).
// DuckDB-WASM 1.32.0 (DuckDB 1.4.3) cannot replay a WAL that holds migration 3,
// an ALTER TABLE … ADD COLUMN on a table with a nextval default (duckdb#18259):
// the owner's "Satori could not start" after a reload on the Setup screen. So
// every commit is checkpointed (no WAL is left), and a WAL an older version
// left is set aside, never deleted, with a notice.
import { expect, test, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { MIGRATIONS } from '../src/db/schema.js';
import { publicKey, evmAddress } from '../src/keys/keys.js';
import { openApp, reloadApp, loaded } from './load.js';
import { stubCentral } from './stub.js';
import { opfsFiles, opfsCopy } from './opfs.js';

const DB = 'satori-mvp.duckdb';
const NOTICE = 'Recovered the database: unsaved changes from the last session were set aside.';
const walBytes = (files, name = DB) => files.find(([f]) => f === `${name}.wal`)?.[1] ?? 0;
const setAside = (files, kind = 'unreplayed') => files.filter(([f]) => f.startsWith(`${DB}.wal.${kind}-`));
const recovered = (page) => page.evaluate(() => window.satori.status().then((s) => s.recovered));
const sqlText = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'`;
const probe = (page, args) => page.evaluate((a) => window.probe(a), args);
/** What the app before this fix left on a first load: its 6 migrations, committed, not checkpointed (6 kB of WAL). */
const OLD_FIRST_LOAD = ['CREATE TABLE IF NOT EXISTS meta (key VARCHAR PRIMARY KEY, value VARCHAR)', ...MIGRATIONS.slice(0, 6),
  "INSERT OR REPLACE INTO meta VALUES ('schema_version', '6')"];

test('a fresh profile: reloaded on the Setup screen it opens, and no WAL is left', async ({ page }) => {
  expect(await openApp(page)).toBe('setup');
  expect(walBytes(await opfsFiles(page))).toBe(0);
  expect(await reloadApp(page)).toBe('setup'); // was 'fatal': "Failure while replaying WAL file"
  expect(await reloadApp(page)).toBe('setup');
  await expect(page.locator('[data-test=notice]')).toBeHidden();
  expect(setAside(await opfsFiles(page))).toEqual([]);
});

test('a fresh profile reloaded while it loads (during DuckDB, the open, the migrations): it opens', async ({ browser }) => {
  const timing = await browser.newContext();
  const p0 = await timing.newPage();
  const t0 = Date.now();
  expect(await openApp(p0)).toBe('setup');
  const full = Date.now() - t0;
  await timing.close();
  for (const f of [0.2, 0.4, 0.55, 0.7, 0.8, 0.9, 0.95]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');
    await page.waitForTimeout(Math.round(full * f));
    await page.reload({ waitUntil: 'commit' });
    await page.waitForTimeout(Math.round(full * f / 2)); // and once more, sooner
    expect(await reloadApp(page), `reloaded at ${f} of ${full} ms`).toBe('setup');
    await expect(page.locator('[data-test=notice]')).toBeHidden();
    await context.close();
  }
});

test('direct: a write with no explicit CHECKPOINT survives a reload and leaves no WAL', async ({ page }) => {
  await page.goto('/e2e/store/');
  const path = 'opfs://e2e-wal.duckdb';
  const expected = { setting: 'nock', values: [10, 20, 30], version: MIGRATIONS.length, recovered: null };
  expect(await probe(page, { cmd: 'write-no-checkpoint', token: 'nock', path })).toEqual(expected);
  expect(walBytes(await opfsFiles(page), 'e2e-wal.duckdb')).toBe(0);
  await page.reload();
  expect(await probe(page, { cmd: 'read', token: 'nock', path })).toEqual(expected);
});

test("setup's keys are in the database file itself when setup returns; a reload right after keeps them", async ({ context, page }) => {
  await stubCentral(context);
  expect(await openApp(page)).toBe('setup');
  const { identity, vault } = await page.evaluate(() => window.satori.setup({ passphrase: 'pass phrase' }));
  const files = await opfsFiles(page);
  await opfsCopy(page, DB, 'e2e-keys-copy.duckdb'); // the file alone, without any WAL
  await page.reload();
  expect(walBytes(files)).toBe(0);
  expect(await loaded(page)).toBe('home');
  expect((await page.evaluate(() => window.satori.status())).identity).toBe(identity);

  await page.goto('/e2e/store/');
  const r = await probe(page, { cmd: 'raw', path: 'opfs://e2e-keys-copy.duckdb', sql: ["SELECT key, value FROM meta WHERE key = 'keys'"] });
  expect(r.rows?.[0]?.map((x) => x.key), JSON.stringify(r)).toEqual(['keys']);
  expect(evmAddress(JSON.parse(r.rows[0][0].value).vault.pubkey)).toBe(vault);
});

test('Chrome killed right after setup: the keys are there at the next start', async () => {
  const dir = test.info().outputPath(`profile-kill-${Date.now()}`);
  const launch = async () => {
    const context = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless: true });
    await stubCentral(context);
    return { context, page: context.pages()[0] ?? await context.newPage() };
  };
  let { context, page } = await launch();
  await page.goto('http://localhost:5180/');
  expect(await loaded(page)).toBe('setup');
  const { identity } = await page.evaluate(() => window.satori.setup({ passphrase: 'pass phrase' }));
  // no shutdown of any kind: every process of this profile, at once
  const pids = execFileSync('pgrep', ['-f', dir]).toString().trim().split('\n').map(Number);
  for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  await context.close().catch(() => {});

  ({ context, page } = await launch());
  try {
    await page.goto('http://localhost:5180/');
    expect(await loaded(page)).toBe('home');
    expect((await page.evaluate(() => window.satori.status())).identity).toBe(identity);
  } finally {
    await context.close();
  }
});

/** A set-up neuron's key rows as the version before this fix stored them (test/fixtures/profiles.json), and its identity. */
function neuronFiles() {
  const { profiles } = JSON.parse(readFileSync(new URL('../test/fixtures/profiles.json', import.meta.url)));
  const p = profiles.find((x) => x.label.startsWith('step 5 on'));
  const identity = evmAddress(publicKey(Uint8Array.from(p.expect.identity.match(/../g), (b) => parseInt(b, 16))));
  return { identity, rows: Object.entries(p.meta) };
}
const keyRows = (rows) => `INSERT OR REPLACE INTO meta VALUES ${rows.map(([k, v]) => `('${k}', ${sqlText(v)})`).join(', ')}`;

test("the owner's profile: a WAL DuckDB cannot replay is set aside, never deleted; Setup opens with a notice", async ({ context, page }) => {
  await stubCentral(context);
  // A first load of the app before this fix, then a reload: "Satori could not start".
  await page.goto('/e2e/store/');
  expect(await probe(page, { cmd: 'raw', path: `opfs://${DB}`, sql: OLD_FIRST_LOAD })).toHaveProperty('rows');
  const wal = walBytes(await opfsFiles(page));
  expect(wal).toBeGreaterThan(0);
  expect(await openApp(page)).toBe('setup');
  const notice = page.locator('[data-test=notice]');
  await expect(notice).toContainText(NOTICE);
  expect(await recovered(page)).toMatch(/^satori-mvp\.duckdb\.wal\.unreplayed-\d{4}-\d\d-\d\dT[\d-]+Z$/);
  const files = await opfsFiles(page);
  expect(setAside(files).map(([, n]) => n)).toEqual([wal]); // kept whole
  expect(walBytes(files)).toBe(0);

  // It goes on as usual: setup; the notice can be dismissed, and a reload has none.
  const { identity } = await page.evaluate(() => window.satori.setup({ passphrase: 'pass phrase' }));
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toBeHidden();
  expect(await reloadApp(page)).toBe('home');
  await expect(notice).toBeHidden();
  expect(await recovered(page)).toBeNull();
  expect((await page.evaluate(() => window.satori.status())).identity).toBe(identity);
  expect(setAside(await opfsFiles(page))).toHaveLength(1);
});

// The app before this fix, set up: setup checkpointed the keys in the first session, and each later
// session's checkpoint rewrote the WAL; OPFS never truncates it, so it still holds what came before.
const OLD_PROFILES = {
  'set up, never reloaded': () => [],
  'reloaded since': () => [["INSERT OR REPLACE INTO meta VALUES ('base_max_fee_gwei', '1')", 'CHECKPOINT']],
};
for (const [shape, laterSessions] of Object.entries(OLD_PROFILES)) {
  test(`an older version's set-up neuron (${shape}): its WAL is set aside once, silently; the keys and later writes stay`, async ({ context, page }) => {
    const { identity, rows } = neuronFiles();
    await stubCentral(context);
    await page.goto('/e2e/store/');
    expect(await probe(page, { cmd: 'raw', path: `opfs://${DB}`, sql: [...OLD_FIRST_LOAD, keyRows(rows), 'CHECKPOINT'] })).toHaveProperty('rows');
    for (const sql of laterSessions()) {
      await page.reload();
      expect(await probe(page, { cmd: 'raw', path: `opfs://${DB}`, sql })).toHaveProperty('rows');
    }
    const wal = walBytes(await opfsFiles(page));
    expect(wal).toBeGreaterThan(0);

    // A Settings save after the update, then loads: what the old WAL held is never applied again, nor does an open fail.
    expect(await openApp(page)).toBe('home');
    expect((await page.evaluate(() => window.satori.setBaseMaxFee(5))).maxFeeSetting).toBe(5);
    const notice = page.locator('[data-test=notice]');
    for (let i = 0; i < 6; i++) { // each load checkpoints a few times (the schedule, Nostr, Base): any count is fine
      expect(await reloadApp(page), `load ${i}`).toBe('home');
      const st = await page.evaluate(() => window.satori.status());
      expect([st.identity, st.base.maxFeeSetting, st.recovered], `load ${i}`).toEqual([identity, 5, null]);
      await expect(notice).toBeHidden();
      await page.evaluate(() => window.satori.setBaseMaxFee(5)); // one more checkpoint: odd and even counts
    }
    const files = await opfsFiles(page);
    expect(setAside(files, 'checkpointed').map(([, n]) => n)).toEqual([wal]);
    expect(setAside(files)).toEqual([]);
    expect(walBytes(files)).toBe(0);
  });
}

test('keys checkpointed and an unreplayable WAL on top: only the WAL\'s changes are set aside, the keys stay', async ({ context, page }) => {
  const { identity, rows } = neuronFiles();
  await stubCentral(context);
  await page.goto('/e2e/store/');
  expect(await probe(page, { cmd: 'raw', path: `opfs://${DB}`, sql: [
    "SET checkpoint_threshold = '0b'", ...OLD_FIRST_LOAD, keyRows(rows), // each commit checkpointed: the keys are in the file
    "SET checkpoint_threshold = '16MB'", 'ALTER TABLE predictions ADD COLUMN e2e DOUBLE', // DuckDB's default: these stay in the WAL
    "INSERT OR REPLACE INTO meta VALUES ('e2e_unsaved', '1')"] })).toHaveProperty('rows');
  expect(walBytes(await opfsFiles(page))).toBeGreaterThan(0);

  expect(await openApp(page)).toBe('home');
  await expect(page.locator('[data-test=notice]')).toContainText(NOTICE);
  expect(await recovered(page)).toMatch(/unreplayed/);
  expect((await page.evaluate(() => window.satori.status())).identity).toBe(identity);
  await page.goto('/e2e/store/'); // the app's tab is gone: its database can be read
  const meta = await probe(page, { cmd: 'app-meta', key: 'e2e_unsaved' });
  expect(meta).not.toHaveProperty('error');
  expect(meta.value).toBeUndefined();
});
