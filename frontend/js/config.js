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
 * Extra ICE servers appended to the public STUN list in webrtc.js.
 * Calls between peers behind symmetric NAT / strict firewalls need a TURN
 * relay, e.g. { urls: 'turn:turn.example.com:3478', username: '...', credential: '...' }
 */
const EXTRA_ICE_SERVERS = [];
