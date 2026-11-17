// Send's Scan (docs/design/base.md#scan-a-qr-code), on a phone: the camera, stubbed with a canvas showing a QR code,
// eases open under the form; a code with no address is said and scanning goes on; one with an address fills To, the
// camera goes off and the amount is asked. Cancel turns the camera off; a camera the browser blocks says what to do.
// SHOTS=1 writes docs/screenshots/scan-open-phone.png.
import { expect, test } from '@playwright/test';
import qrcode from 'qrcode-generator';
import { fakeSatori } from '../test/fake-satori.js';
import { openApp, LOAD_TIMEOUT } from './load.js';
import { stubCentral } from './stub.js';

const CHECKED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const grid = (text) => {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (__, c) => qr.isDark(r, c)));
};

// getUserMedia: a canvas's stream showing window.showQr(grid)'s code, its tracks kept at window.camera; or, blocked, the
// browser's NotAllowedError
const fakeCamera = (page, blocked = false) => page.addInitScript((blocked) => {
  window.camera = [];
  navigator.mediaDevices.getUserMedia = async () => {
    if (blocked) throw new DOMException('Permission denied', 'NotAllowedError');
    const c = document.createElement('canvas');
    c.width = c.height = 480;
    const g = c.getContext('2d');
    let shown = [];
    const draw = () => {
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 480, 480);
      const s = Math.floor(400 / (shown.length || 1));
      g.fillStyle = '#000';
      shown.forEach((row, r) => row.forEach((dark, k) => dark && g.fillRect(40 + k * s, 40 + r * s, s, s)));
    };
    window.showQr = (q) => { shown = q; };
    setInterval(draw, 50);
    const stream = c.captureStream(15);
    window.camera.push(...stream.getTracks());
    return stream;
  };
}, blocked);
const cameraOff = (page) => page.evaluate(() => window.camera.length > 0 && window.camera.every((t) => t.readyState === 'ended'));

async function walletTab(context, page) {
  const { rpc } = fakeSatori();
  await stubCentral(context, { rpc });
  await openApp(page);
  await page.evaluate(() => window.satori.setup({ passphrase: 'correct horse battery' }));
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home', { timeout: LOAD_TIMEOUT });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.satori.go('wallet'));
}

test('Scan: a code with no address is said, one with an address fills To; the camera then off, the amount next', async ({ context, page }) => {
  await fakeCamera(page);
  await walletTab(context, page);
  const panel = page.locator('[data-test=scan-panel]');
  await expect(panel).toHaveAttribute('data-open', 'false');
  await expect(page.locator('[data-test=base-buy]')).toHaveCount(0); // Buy on Uniswap: mainnet's build only

  await page.locator('[data-test=send-scan]').click();
  await expect(panel).toHaveAttribute('data-open', 'true');
  await expect(page.locator('[data-test=scan-note]')).toHaveText('Point the camera at the QR code of a 0x address.');
  await expect(page.locator('[data-test=scan-video]')).toBeVisible();
  await page.evaluate((q) => window.showQr(q), grid(`https://app.satorinet.io/?ref=${CHECKED}`));
  await expect(page.locator('[data-test=scan-note]')).toHaveText('That QR code holds no 0x address. Try another.');
  await expect(panel).toHaveAttribute('data-open', 'true');
  await page.waitForTimeout(400);
  if (process.env.SHOTS) await page.screenshot({ path: 'docs/screenshots/scan-open-phone.png' });

  await page.evaluate((q) => window.showQr(q), grid(`ethereum:${CHECKED.toLowerCase()}@8453`));
  await expect(page.locator('form.send [name=to]')).toHaveValue(CHECKED);
  await expect(panel).toHaveAttribute('data-open', 'false');
  await expect(page.locator('form.send [name=amount]')).toBeFocused();
  expect(await cameraOff(page)).toBe(true);
});

test('Scan, then Cancel: the camera off; another tab ends it too', async ({ context, page }) => {
  await fakeCamera(page);
  await walletTab(context, page);
  const panel = page.locator('[data-test=scan-panel]');
  await page.locator('[data-test=send-scan]').click();
  await expect(panel).toHaveAttribute('data-open', 'true');
  await expect.poll(() => page.evaluate(() => window.camera.length)).toBe(1);
  await page.locator('[data-test=scan-cancel]').click();
  await expect(panel).toHaveAttribute('data-open', 'false');
  await expect.poll(() => cameraOff(page)).toBe(true);

  await page.locator('[data-test=send-scan]').click();
  await expect.poll(() => page.evaluate(() => window.camera.length)).toBe(2);
  await page.evaluate(() => window.satori.go('home'));
  await expect.poll(() => cameraOff(page)).toBe(true);
  await page.evaluate(() => window.satori.go('wallet'));
  await expect(panel).toHaveAttribute('data-open', 'false');
});

test('Scan with the camera blocked: what to do, no camera shown; Cancel closes it', async ({ context, page }) => {
  await fakeCamera(page, true);
  await walletTab(context, page);
  const panel = page.locator('[data-test=scan-panel]');
  await page.locator('[data-test=send-scan]').click();
  await expect(page.locator('[data-test=scan-note]')).toHaveText("The camera is blocked for this app: allow it in the browser's settings, or type the address.");
  await expect(page.locator('[data-test=scan-video]')).toBeHidden();
  await page.locator('[data-test=scan-cancel]').click();
  await expect(panel).toHaveAttribute('data-open', 'false');
});
