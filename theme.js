(function () {
  const K = 'lintas-theme';
  const get = () => localStorage.getItem(K) || 'dark';
  function apply(t) {
    document.documentElement.dataset.theme = t;
    document.querySelectorAll('iframe').forEach(f => { try { f.contentDocument.documentElement.dataset.theme = t; } catch (e) {} });
  }
  window.setTheme = (t) => { localStorage.setItem(K, t); apply(t); };
  window.toggleTheme = () => setTheme(get() === 'dark' ? 'light' : 'dark');
  window.addEventListener('storage', (e) => { if (e.key === K) apply(get()); });
  apply(get());

  // sinyal "halaman siap" ke shell
  let sent = false;
  window.__ready = () => {
    if (sent || top === self) return;
    sent = true;
    parent.postMessage({ lintasReady: 1 }, location.origin);
  };
  // halaman tanpa module (pengaturan): siap saat load
  window.addEventListener('load', () => {
    if (!document.querySelector('script[type="module"]')) window.__ready();
  });
})();