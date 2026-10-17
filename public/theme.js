// Before the first paint (a classic script in index.html's head, not a module, so nothing waits for it): the theme
// chosen in Settings → Appearance on this device (localStorage 'satori-theme', src/ui/theme.js) as <html data-theme>.
// None (System) leaves the colours to prefers-color-scheme.
(function () {
  try {
    var t = localStorage.getItem('satori-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* storage blocked: the system's */ }
})();
