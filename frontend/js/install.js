/* Install SyncTact on a phone from the same website. */
(function () {
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  const btn = document.getElementById('installAppBtn');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  if (standalone || !btn) return;

  let promptEvent = null;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);

  function show() { btn.hidden = false; }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    promptEvent = event;
    show();
  });
  if (ios) show();

  btn.addEventListener('click', async () => {
    if (promptEvent) {
      promptEvent.prompt();
      try { await promptEvent.userChoice; } catch (err) { /* the browser closed the prompt */ }
      promptEvent = null;
      btn.hidden = true;
      return;
    }
    const how = ios
      ? 'On iPhone: tap Share, then Add to Home Screen.'
      : 'Open the browser menu and tap Install app, or Add to Home screen.';
    if (typeof showToast === 'function') showToast(how);
    else alert(how);
  });
})();
