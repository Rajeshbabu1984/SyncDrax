/* =======================================================
   SyncDrax — WebRTC Signaling & Peer Management
   ======================================================= */

const MAX_PARTICIPANTS = 30;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

class SyncDraxRTC {
  constructor({ roomCode, displayName, onPeerJoined, onPeerLeft, onPeerStream, onMessage, onParticipantsUpdate }) {
    this.roomCode   = roomCode;
    this.localName  = displayName;
    this.peerId     = this._genId();

    this.peers      = new Map();  // peerId -> { pc, stream, name }
    this.localStream = null;
    this.screenStream = null;

    this.ws = null;
    this.wsUrl = this._resolveWS();

    // Callbacks
    this.onPeerJoined         = onPeerJoined         || (() => {});
    this.onPeerLeft           = onPeerLeft           || (() => {});
    this.onPeerStream         = onPeerStream         || (() => {});
    this.onMessage            = onMessage            || (() => {});
    this.onParticipantsUpdate = onParticipantsUpdate || (() => {});
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
  async connect(localStream) {
    this.localStream = localStream;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        console.log('[SyncDraxRTC] WebSocket connected');
        resolve();
      };

      this.ws.onerror = (e) => {
        console.error('[SyncDraxRTC] WS error', e);
        reject(e);
      };

      this.ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          this._handleMessage(msg);
        } catch (e) {
          console.error('[SyncDraxRTC] bad message', e);
        }
      };

      this.ws.onclose = () => {
        console.log('[SyncDraxRTC] WS disconnected');
        // attempt reconnect after 3s
        setTimeout(() => {
          if (document.visibilityState !== 'hidden') this._reconnect();
        }, 3000);
      };
    });
  }

  _reconnect() {
    if (this._disconnecting) return;
    console.log('[SyncDraxRTC] Reconnecting…');
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onopen    = () => console.log('[SyncDraxRTC] Reconnected');
    this.ws.onmessage = (evt) => {
      try { this._handleMessage(JSON.parse(evt.data)); } catch (e) {}
    };
    this.ws.onclose = () => setTimeout(() => this._reconnect(), 3000);
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
        // Existing peers in room
        for (const peer of (msg.peers || [])) {
          if (peer.id !== this.peerId) {
            await this._createOffer(peer.id, peer.name);
          }
        }
        this.onParticipantsUpdate(msg.peers || []);
        break;
      }

      case 'peer_joined': {
        // New peer — they'll send us an offer
        this.onPeerJoined(msg.peer_id, msg.name);
        this._updateParticipantList(msg.peer_id, msg.name, 'join');
        break;
      }

      case 'peer_left': {
        this._closePeer(msg.peer_id);
        this.onPeerLeft(msg.peer_id);
        this._updateParticipantList(msg.peer_id, null, 'leave');
        break;
      }

      case 'offer': {
        await this._handleOffer(msg.from_id, msg.from_name, msg.sdp);
        break;
      }

      case 'answer': {
        const peer = this.peers.get(msg.from_id);
        if (peer) {
          await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
        }
        break;
      }

      case 'ice': {
        const peer = this.peers.get(msg.from_id);
        if (peer && msg.candidate) {
          try {
            await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch (e) {
            console.warn('[RTC] ice candidate error', e);
          }
        }
        break;
      }

      case 'chat': {
        this.onMessage({ from: msg.from_name, text: msg.text, ts: msg.ts, self: false });
        break;
      }

      case 'room_full': {
        alert(`This meeting is full (max ${MAX_PARTICIPANTS} participants).`);
        window.location.href = 'index.html';
        break;
      }
    }
  }

  _updateParticipantList(peerId, name, action) {
    if (action === 'join') {
      const peer = this.peers.get(peerId) || {};
      peer.name = name;
      this.peers.set(peerId, peer);
    } else if (action === 'leave') {
      this.peers.delete(peerId);
    }
    this.onParticipantsUpdate([...this.peers.entries()].map(([id, p]) => ({ id, name: p.name })));
  }

  /* =========== PEER CONNECTION =========== */
  _buildPeerConnection(peerId) {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
    }

    // Receive remote tracks
    pc.ontrack = (evt) => {
      const [stream] = evt.streams;
      const peer = this.peers.get(peerId) || {};
      peer.stream = stream;
      this.peers.set(peerId, peer);
      this.onPeerStream(peerId, stream);
    };

    // ICE candidates
    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        this._send({ type: 'ice', to_id: peerId, candidate: evt.candidate.toJSON() });
      }
    };

    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        this._closePeer(peerId);
        this.onPeerLeft(peerId);
      }
    };

    return pc;
  }

  async _createOffer(peerId, peerName) {
    if (this.peers.size >= MAX_PARTICIPANTS - 1) return;
    const pc = this._buildPeerConnection(peerId);
    this.peers.set(peerId, { pc, name: peerName });

    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    this._send({ type: 'offer', to_id: peerId, from_name: this.localName, sdp: offer.sdp });
  }

  async _handleOffer(fromId, fromName, sdp) {
    const pc = this._buildPeerConnection(fromId);
    this.peers.set(fromId, { pc, name: fromName });

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._send({ type: 'answer', to_id: fromId, sdp: answer.sdp });
  }

  _closePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer && peer.pc) {
      peer.pc.close();
    }
    this.peers.delete(peerId);
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
      this.peers.forEach(peer => {
        const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
      });
      screenTrack.onended = () => this.stopScreenShare();
      return true;
    } catch { return false; }
  }

  stopScreenShare() {
    if (!this.localStream) return;
    const camTrack = this.localStream.getVideoTracks()[0];
    this.peers.forEach(peer => {
      const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender && camTrack) sender.replaceTrack(camTrack);
    });
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }
  }

  /* Replace video track on all peer connections (for virtual backgrounds) */
  async replaceVideoTrack(newTrack) {
    const promises = [];
    this.peers.forEach(peer => {
      const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) promises.push(sender.replaceTrack(newTrack));
    });
    await Promise.all(promises);
  }

  /* =========== CHAT =========== */
  sendChatMessage(text) {
    if (!text.trim()) return;
    this._send({ type: 'chat', text: text.trim() });
    this.onMessage({ from: this.localName, text: text.trim(), ts: Date.now(), self: true });
  }

  /* =========== DISCONNECT =========== */
  disconnect() {
    this._disconnecting = true;
    this.peers.forEach((_, id) => this._closePeer(id));
    if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
    if (this.screenStream) this.screenStream.getTracks().forEach(t => t.stop());
    if (this.ws) this.ws.close();
  }
}

window.SyncDraxRTC = SyncDraxRTC;
