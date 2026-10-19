// How this browser adds Satori when it has no install prompt (docs/design/pwa.md#install). Chromium (Chrome, Edge,
// Samsung Internet, on any system) offers its prompt instead (beforeinstallprompt); Firefox on a computer offers nothing.
//   'ios'     iPhone, iPad: Share › Add to Home Screen, in Safari and, since iOS 16.4, the other browsers
//   'mac'     Safari on macOS 14+: File › Add to Dock
//   'android' Firefox on Android: its menu › Add app to Home screen

/** → 'ios' | 'mac' | 'android' | null. touchPoints: navigator.maxTouchPoints (iPadOS says it is a Mac). */
export function addToOf(ua = '', touchPoints = 0) {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios';
  if (/Macintosh/.test(ua) && /Version\/[\d.]+ Safari\//.test(ua) && !/Chrom|Firefox|Edg/.test(ua)) return 'mac';
  if (/Android/.test(ua) && /Firefox\//.test(ua)) return 'android';
  return null;
}
