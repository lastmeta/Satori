import { expect, test } from 'vitest';
import { isPublicHost, openRelay, PRIVATE_HOST, METAMASK } from './relay.js';
import { DEFAULTS } from '../chain/config.js';

test('a relay needs a public host: a LAN address, localhost, .local or a bare name cannot be reached (as the dapp)', () => {
  for (const h of ['app.satorinet.io', 'games.satorinet.io', 'satori.test']) expect(isPublicHost(h), h).toBe(true);
  for (const h of ['', 'localhost', '192.168.1.20', '10.0.0.5', 'box.local', 'devbox', '[::1]']) expect(isPublicHost(h), h).toBe(false);
});

test('connecting from a private address is refused before any library loads, said plainly', async () => {
  globalThis.location = { hostname: '192.168.1.20', origin: 'http://192.168.1.20' };
  try {
    await expect(openRelay(METAMASK, { config: DEFAULTS, connect: true })).rejects.toThrow(PRIVATE_HOST);
  } finally {
    delete globalThis.location;
  }
});
