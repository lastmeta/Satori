// How a browser without Chromium's install prompt adds Satori (docs/design/pwa.md#install), from its user agent.
import { describe, expect, test } from 'vitest';
import { addToOf } from './platform.js';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
};

describe('addToOf', () => {
  test.each([
    ['iphoneSafari', 0, 'ios'], ['iphoneChrome', 5, 'ios'], ['iphoneFirefox', 5, 'ios'], // every iOS browser's Share menu (iOS 16.4+)
    ['ipadDesktop', 5, 'ios'], // iPadOS asks for the desktop site, as a Mac with a touch screen
    ['macSafari', 0, 'mac'], // File › Add to Dock (macOS 14+)
    ['androidFirefox', 5, 'android'], // its menu › Add app to Home screen
    ['macChrome', 0, null], ['androidChrome', 5, null], ['windowsEdge', 0, null], // Chromium: its install prompt instead
    ['macFirefox', 0, null], // nothing to offer
  ])('%s → %s', (name, touch, want) => {
    expect(addToOf(UA[name], touch)).toBe(want);
  });
});
