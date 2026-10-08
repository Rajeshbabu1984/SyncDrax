/* =======================================================
   SyncTact — WebRTC Signaling & Peer Management
   ======================================================= */

const MAX_PARTICIPANTS = 30;

// STUN only finds public addresses. Users behind symmetric NAT or strict firewalls also need a
// TURN relay: set EXTRA_ICE_SERVERS in config.js (e.g. from Twilio, Metered or your own coturn).
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    ...(typeof EXTRA_ICE_SERVERS !== 'undefined' && Array.isArray(EXTRA_ICE_SERVERS) ? EXTRA_ICE_SERVERS : []),
  ],
};

// How long a 'disconnected' peer gets to recover before we try an ICE restart / give up.
const DISCONNECT_GRACE_MS = 8000;

class SyncTactRTC {
  constructor({ roomCode, displayName, onPeerJoined, onPeerLeft, onPeerStream, onMessage, onParticipantsUpdate, onData }) {
    this.roomCode   = roomCode;
    this.localName  = displayName;
    this.peerId     = this._genId();

    this.peers      = new Map();  // peerId -> { pc, stream, name, pendingIce, disconnectTimer }
    this.localStream = null;
    this.screenStream = null;

    this.ws = null;
    this.wsUrl = this._resolveWS();
    this._queue = Promise.resolve();
    this._retryDelay = 1000;

    // Callbacks
    this.onPeerJoined         = onPeerJoined         || (() => {});
    this.onPeerLeft           = onPeerLeft           || (() => {});
    this.onPeerStream         = onPeerStream         || (() => {});
    this.onMessage            = onMessage            || (() => {});
    this.onParticipantsUpdate = onParticipantsUpdate || (() => {});
    this.onData               = onData               || (() => {});  // custom events
  }

  _resolveWS() {
    const base = typeof WS_BASE !== 'undefined'
      ? WS_BASE
      : (location.protocol === 'https:' ? 'wss' : 'ws') + '://' +
        (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
          ? `${location.hostname}:8000`
          : location.host);
    return `${base}/ws/${this.roomCode}/${this.peerId}/${encodeURIComponent(this.localName)}`;
  }

  _genId() {
    return 'peer_' + Math.random().toString(36).substring(2, 10);
  }

  /* =========== CONNECT =========== */
  connect(localStream) {
    this.localStream = localStream;
    return new Promise((resolve, reject) => this._openSocket(resolve, reject));
  }

  _openSocket(resolve, reject) {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      console.log('[SyncTactRTC] WebSocket connected');
      this._retryDelay = 1000;
      if (resolve) resolve();
    };
    ws.onerror = (e) => {
      console.error('[SyncTactRTC] WS error', e);
      if (reject) reject(e);
    };
    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (e) { console.error('[SyncTactRTC] bad message', e); return; }
      // Signaling must be processed in order: an ICE candidate handled while the offer is
      // still being applied would be rejected and dropped.
      this._queue = this._queue
        .then(() => this._handleMessage(msg))
        .catch(e => console.warn('[SyncTactRTC] message handling error', e));
    };
    ws.onclose = () => {
      if (this._disconnecting || this.ws !== ws) return;
      console.log('[SyncTactRTC] WS disconnected, retrying in', this._retryDelay, 'ms');
      setTimeout(() => { if (!this._disconnecting) this._openSocket(); }, this._retryDelay);
      this._retryDelay = Math.min(this._retryDelay * 2, 30000);
    };
  }

  _send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /* =========== SIGNALING HANDLER =========== */
  async _handleMessage(msg) {
    switch (msg.type) {

      case 'room_state': {
        // Existing peers in room (also sent again after we reconnect)
        for (const peer of (msg.peers || [])) {
          if (peer.id !== this.peerId) {
            this._ensurePeerEntry(peer.id, peer.name, true);
            await this._createOffer(peer.id, peer.name);
          }
        }
        this._emitParticipants();
        break;
      }

      case 'peer_joined': {
        // New peer (or one that reconnected) — they'll send us a fresh offer
        const peer = this._ensurePeerEntry(msg.peer_id, msg.name, true);
        this._closePeerConnection(peer);
        this._emitParticipants();
        break;
      }

      case 'peer_left': {
        this._removePeer(msg.peer_id);
        break;
      }

      case 'offer': {
        await this._handleOffer(msg.from_id, msg.from_name, msg.sdp);
        break;
      }

      case 'answer': {
        const peer = this.peers.get(msg.from_id);
        if (peer && peer.pc && peer.pc.signalingState === 'have-local-offer') {
          await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
          await this._flushIce(peer);
        }
        break;
      }

      case 'ice': {
        const peer = this.peers.get(msg.from_id);
        if (!peer || !msg.candidate) break;
        if (!peer.pc || !peer.pc.remoteDescription) {
          (peer.pendingIce = peer.pendingIce || []).push(msg.candidate);
          break;
        }
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch (e) {
          console.warn('[RTC] ice candidate error', e);
        }
        break;
      }

      case 'chat': {
        this.onMessage({ from: msg.from_name, text: msg.text, ts: msg.ts, self: false });
        break;
      }

      case 'raise_hand':
      case 'reaction':
      case 'whiteboard': {
        // The server echoes these to the sender too; we already applied our own locally.
        if (msg.from_id === this.peerId) break;
        this.onData(msg);
        break;
      }

      case 'room_full': {
        alert(`This meeting is full (max ${MAX_PARTICIPANTS} participants).`);
        window.location.href = 'index.html';
        break;
      }
    }
  }

  _ensurePeerEntry(peerId, name, announce) {
    let peer = this.peers.get(peerId);
    const isNew = !peer;
    if (!peer) { peer = { pendingIce: [] }; this.peers.set(peerId, peer); }
    if (name) peer.name = name;
    if (isNew && announce) this.onPeerJoined(peerId, peer.name || 'Guest');
    return peer;
  }

  _emitParticipants() {
    this.onParticipantsUpdate([...this.peers.entries()].map(([id, p]) => ({ id, name: p.name })));
  }

  async _flushIce(peer) {
    const pending = peer.pendingIce || [];
    peer.pendingIce = [];
    for (const c of pending) {
      try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); }
      catch (e) { console.warn('[RTC] queued ice candidate error', e); }
    }
  }

  /* =========== PEER CONNECTION =========== */
  _buildPeerConnection(peerId) {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
    }

    pc.ontrack = (evt) => {
      const [stream] = evt.streams;
      const peer = this.peers.get(peerId);
      if (!peer || peer.pc !== pc) return;
      peer.stream = stream;
      this.onPeerStream(peerId, stream, peer.name);
    };

    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        this._send({ type: 'ice', to_id: peerId, candidate: evt.candidate.toJSON() });
      }
    };

    pc.onconnectionstatechange = () => {
      const peer = this.peers.get(peerId);
      if (!peer || peer.pc !== pc) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = null;
        peer.restarted = false;
      } else if (state === 'disconnected') {
        // Often temporary (Wi-Fi blip); give it time before acting.
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = setTimeout(() => this._recoverPeer(peerId, pc), DISCONNECT_GRACE_MS);
      } else if (state === 'failed') {
        this._recoverPeer(peerId, pc);
      }
    };

    return pc;
  }

  async _recoverPeer(peerId, pc) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.pc !== pc || pc.connectionState === 'connected') return;
    if (!peer.restarted && peer.isOfferer) {
      // One ICE restart attempt from the side that made the original offer.
      peer.restarted = true;
      try {
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        this._send({ type: 'offer', to_id: peerId, from_name: this.localName, sdp: offer.sdp });
        return;
      } catch (e) {
        console.warn('[RTC] ICE restart failed', e);
      }
    }
    if (!peer.isOfferer && !peer.restarted) { peer.restarted = true; return; }  // wait for the offerer to restart
    this._closePeerConnection(peer);
    this.onPeerLeft(peerId);
  }

  async _createOffer(peerId, peerName) {
    if (this.peers.size > MAX_PARTICIPANTS - 1) return;
    const peer = this._ensurePeerEntry(peerId, peerName, false);
    this._closePeerConnection(peer);
    const pc = this._buildPeerConnection(peerId);
    peer.pc = pc;
    peer.isOfferer = true;
    peer.pendingIce = [];

    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    this._send({ type: 'offer', to_id: peerId, from_name: this.localName, sdp: offer.sdp });
  }

  async _handleOffer(fromId, fromName, sdp) {
    const peer = this._ensurePeerEntry(fromId, fromName, true);
    // An offer on an existing healthy connection is an ICE restart / renegotiation; reuse it.
    // Otherwise (first contact or the other side reconnected) start fresh.
    const reuse = peer.pc && !peer.isOfferer && peer.pc.signalingState === 'stable' &&
                  !['closed', 'failed'].includes(peer.pc.connectionState);
    if (!reuse) {
      const queued = peer.pendingIce || [];
      this._closePeerConnection(peer);
      peer.pc = this._buildPeerConnection(fromId);
      peer.isOfferer = false;
      peer.pendingIce = queued;
    }
    const pc = peer.pc;
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    await this._flushIce(peer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._send({ type: 'answer', to_id: fromId, sdp: answer.sdp });
  }

  _closePeerConnection(peer) {
    if (!peer) return;
    clearTimeout(peer.disconnectTimer);
    peer.disconnectTimer = null;
    if (peer.pc) {
      peer.pc.onconnectionstatechange = null;
      peer.pc.ontrack = null;
      peer.pc.onicecandidate = null;
      peer.pc.close();
    }
    peer.pc = null;
    peer.stream = null;
  }

  _removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this._closePeerConnection(peer);
    this.peers.delete(peerId);
    this.onPeerLeft(peerId);
    this._emitParticipants();
  }

  _videoSenders(kind = 'video') {
    const senders = [];
    this.peers.forEach(peer => {
      if (!peer.pc || peer.pc.connectionState === 'closed') return;
      const s = peer.pc.getSenders().find(x => x.track && x.track.kind === kind);
      if (s) senders.push(s);
    });
    return senders;
  }

  /* =========== MEDIA CONTROLS =========== */
  toggleMic(enabled) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach(t => t.enabled = enabled);
  }

  toggleCamera(enabled) {
    if (!this.localStream) return;
    this.localStream.getVideoTracks().forEach(t => t.enabled = enabled);
  }

  async startScreenShare() {
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const screenTrack = this.screenStream.getVideoTracks()[0];
      await Promise.all(this._videoSenders('video').map(s => s.replaceTrack(screenTrack)));
      screenTrack.onended = () => this.stopScreenShare();
      return true;
    } catch (e) {
      console.warn('[RTC] screen share failed', e);
      if (this.screenStream) this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
      return false;
    }
  }

  stopScreenShare() {
    const camTrack = this.localStream && this.localStream.getVideoTracks()[0];
    if (camTrack) this._videoSenders('video').forEach(s => s.replaceTrack(camTrack).catch(() => {}));
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }
  }

  /* Replace video track on all peer connections (for virtual backgrounds) */
  async replaceVideoTrack(newTrack) {
    await Promise.all(this._videoSenders('video').map(s => s.replaceTrack(newTrack)));
  }

  /* =========== CHAT =========== */
  sendChatMessage(text) {
    if (!text.trim()) return;
    this._send({ type: 'chat', text: text.trim(), ts: Date.now() });
  }

  /* =========== CUSTOM DATA (raise_hand, reaction, whiteboard) =========== */
  sendData(type, data = {}) {
    this._send({ type, ...data });
  }

  /* Replace audio track on all peer connections (for noise suppression) */
  async replaceAudioTrack(newTrack) {
    await Promise.all(this._videoSenders('audio').map(s => s.replaceTrack(newTrack)));
  }

  /* =========== DISCONNECT =========== */
  disconnect() {
    this._disconnecting = true;
    this.peers.forEach(peer => this._closePeerConnection(peer));
    this.peers.clear();
    if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
    if (this.screenStream) this.screenStream.getTracks().forEach(t => t.stop());
    if (this.ws) this.ws.close();
  }
}

window.SyncTactRTC = SyncTactRTC;
