/* =======================================================
   Crewly — Runtime Config
   Auto-detects dev (localhost) vs production (Render)
   ======================================================= */

const _IS_LOCAL =
  location.hostname === 'localhost' || location.hostname === '127.0.0.1';

/** REST API base URL */
const API_BASE = _IS_LOCAL
  ? 'http://localhost:8000'
  : 'https://crewly-backend.onrender.com';

/** WebSocket base URL */
const WS_BASE = _IS_LOCAL
  ? 'ws://localhost:8000'
  : 'wss://crewly-backend.onrender.com';
