/* =======================================================
   SyncTact — Runtime Config
   Auto-detects dev (localhost) vs production (Render)
   ======================================================= */

const _IS_LOCAL =
  location.hostname === 'localhost' || location.hostname === '127.0.0.1';

/** REST API base URL */
const API_BASE = _IS_LOCAL
  ? 'http://localhost:8000'
  : 'https://synctact-backend.onrender.com';

/** WebSocket base URL */
const WS_BASE = _IS_LOCAL
  ? 'ws://localhost:8000'
  : 'wss://synctact-backend.onrender.com';

/**
 * Optional extra ICE servers, appended to whatever /ice-servers returns.
 * The TURN relay itself is configured on the backend (METERED_TURN_DOMAIN +
 * METERED_TURN_API_KEY, or TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL).
 */
const EXTRA_ICE_SERVERS = [];
