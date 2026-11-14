/* Server switcher for the iOS/Android shell. The website leaves this idle. */
(function () {
  if (typeof IN_NATIVE_APP === 'undefined' || !IN_NATIVE_APP) return;

  document.documentElement.classList.add('native-app');

  const style = document.createElement('style');
  style.textContent = [
    '.native-server-btn{position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:800;',
    'border:1px solid #2f3133;background:#222529;color:#f2f3f5;border-radius:999px;padding:8px 14px;',
    'font:700 0.82rem/1 Lato,sans-serif;cursor:pointer;}',
    '.native-server-sheet{position:fixed;inset:0;z-index:900;background:rgba(0,0,0,.62);',
    'display:flex;align-items:flex-end;justify-content:center;padding:16px;',
    'padding-bottom:calc(16px + env(safe-area-inset-bottom));}',
    '.native-server-sheet.hidden{display:none;}',
    '.native-server-card{width:min(440px,100%);background:#222529;border:1px solid #2f3133;',
    'border-radius:16px;padding:22px;color:#d1d2d3;}',
    '.native-server-card h2{color:#f2f3f5;font-size:1.15rem;margin:0 0 8px;}',
    '.native-server-card p{color:#828689;font-size:.88rem;margin:0 0 14px;}',
    '.native-server-card .modal-input{width:100%;background:#1a1d21;border:1px solid #2f3133;',
    'border-radius:8px;padding:10px 14px;color:#f2f3f5;font:inherit;}',
    '.native-server-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;}',
    '.native-server-actions .btn{border-radius:8px;padding:10px 16px;font:700 .9rem/1 inherit;cursor:pointer;}',
    '.native-server-actions .btn-primary{background:#7c3aed;color:#fff;border:none;}',
    '.native-server-actions .btn-ghost{background:transparent;color:#d1d2d3;border:1px solid #2f3133;}'
  ].join('');
  document.head.appendChild(style);

  function openSheet() {
    const existing = document.getElementById('nativeServerSheet');
    if (existing) {
      existing.classList.remove('hidden');
      return;
    }
    const sheet = document.createElement('div');
    sheet.id = 'nativeServerSheet';
    sheet.className = 'native-server-sheet';
    sheet.innerHTML =
      '<form class="native-server-card" id="nativeServerForm">' +
        '<h2>API server</h2>' +
        '<p>The mobile app uses this address for chat, accounts, and meetings.</p>' +
        '<input class="modal-input" id="nativeServerInput" type="url" inputmode="url" autocomplete="off" required />' +
        '<div class="native-server-actions">' +
          '<button type="button" class="btn btn-ghost" id="nativeServerCancel">Cancel</button>' +
          '<button type="submit" class="btn btn-primary">Save</button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(sheet);
    const input = sheet.querySelector('#nativeServerInput');
    input.value = (typeof API_BASE !== 'undefined' && API_BASE) || '';
    sheet.querySelector('#nativeServerCancel').addEventListener('click', () => {
      sheet.classList.add('hidden');
    });
    sheet.addEventListener('click', (event) => {
      if (event.target === sheet) sheet.classList.add('hidden');
    });
    sheet.querySelector('#nativeServerForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const url = input.value.trim().replace(/\/$/, '');
      if (!/^https?:\/\//i.test(url)) {
        input.setCustomValidity('Use a full http or https URL');
        input.reportValidity();
        return;
      }
      localStorage.setItem('synctact_server', url);
      location.reload();
    });
    input.focus();
  }

  function mount() {
    if (document.getElementById('nativeServerBtn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'nativeServerBtn';
    btn.className = 'native-server-btn';
    btn.textContent = 'Server';
    btn.title = 'Choose the API server';
    btn.addEventListener('click', openSheet);
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
