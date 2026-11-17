// Scan (docs/design/base.md#scan-a-qr-code): Send's To read from a QR code by the camera, the back one on a phone. Its
// frames go to jsQR, loaded on the first Scan as its own chunk, a few a second until one holds a 0x address.
import { getAddress, isAddress } from 'viem';

export const SCAN_TEXT = {
  point: 'Point the camera at the QR code of a 0x address.',
  none: 'That QR code holds no 0x address. Try another.',
  blocked: "The camera is blocked for this app: allow it in the browser's settings, or type the address.",
  missing: 'No camera was found: type the address.',
};

// EIP-681: ethereum:[pay-]<0x target>[@chain][/function][?params]; a token transfer pays its `address`, not the token
const EIP681 = /^ethereum:(?:pay-)?(0x[0-9a-f]{40})(?:@\d+)?(?:\/(\w+))?(?:\?(.*))?$/i;

/**
 * The 0x address a QR code holds, checksummed, or '': the code is the address alone, or an EIP-681 link to it
 * (`ethereum:0x…@8453`); an ERC-20 transfer link (`ethereum:<token>/transfer?address=<to>`) gives its `address`, and
 * any other function none. A URL or text that merely contains an address gives none.
 */
export function addressFromQr(text) {
  const s = String(text ?? '').trim();
  const m = s.match(EIP681);
  const to = !m ? s : !m[2] ? m[1] : m[2] === 'transfer' ? new URLSearchParams(m[3] ?? '').get('address') ?? '' : '';
  const plain = /^0x[0-9A-F]{40}$/.test(to) ? to.toLowerCase() : to; // all capitals (a QR's compact mode) has no checksum, as all small
  return isAddress(plain) ? getAddress(plain) : '';
}

/** Why the camera could not start, for the person (getUserMedia's error). */
export function cameraText(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') return SCAN_TEXT.blocked;
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return SCAN_TEXT.missing;
  return `The camera could not start: ${err?.message || err}.`;
}

let jsQR;
const EDGE = 640; // a frame is read at most this many pixels on its long side

/**
 * The camera into `video`, each frame read until `read(text)` returns an address (resolves with it) or `alive()` turns
 * false (resolves ''); the camera is off either way. Throws getUserMedia's error when the camera can't start.
 */
export async function scanFor(video, { read, alive }) {
  jsQR ??= (await import('jsqr')).default;
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  try {
    video.muted = true;
    video.srcObject = stream;
    await video.play().catch(() => {}); // a stream without sound may start by itself
    while (alive()) {
      if (video.videoWidth) {
        const k = Math.min(1, EDGE / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * k);
        canvas.height = Math.round(video.videoHeight * k);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        const to = code ? read(code.data) : '';
        if (to) return to;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return '';
  } finally {
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
  }
}
