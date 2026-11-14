/* =======================================================
   SyncTact — Runtime Config
   Website: localhost uses the local API, anything else uses production.
   Mobile app: Capacitor (or ?native=1) uses a saved server URL.
   ======================================================= */

const PRODUCTION_API = 'https://synctact-backend.onrender.com';

function _savedServer() {
  try {
    return (localStorage.getItem('synctact_server') || '').trim().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

const IN_CAPACITOR = !!(
  window.Capacitor &&
  typeof window.Capacitor.isNativePlatform === 'function' &&
  window.Capacitor.isNativePlatform()
);

const NATIVE_PREVIEW = new URLSearchParams(location.search).has('native');

/** True inside the iOS/Android app, and when previewing that shell in a browser. */
const IN_NATIVE_APP = IN_CAPACITOR || NATIVE_PREVIEW;

const _ON_LOOPBACK =
  location.hostname === 'localhost' || location.hostname === '127.0.0.1';

const API_BASE = IN_NATIVE_APP
  ? (_savedServer() || (NATIVE_PREVIEW && _ON_LOOPBACK ? 'http://localhost:8000' : PRODUCTION_API))
  : (_ON_LOOPBACK ? 'http://localhost:8000' : PRODUCTION_API);

/** WebSocket base URL. http(s) -> ws(s), including the saved mobile server. */
const WS_BASE = API_BASE.replace(/^http/, 'ws');

/**
 * Optional extra ICE servers, appended to whatever /ice-servers returns.
 * The TURN relay itself is configured on the backend (METERED_TURN_DOMAIN +
 * METERED_TURN_API_KEY, or TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL).
 */
const EXTRA_ICE_SERVERS = [];
