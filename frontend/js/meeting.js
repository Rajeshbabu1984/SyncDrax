/* =======================================================
   SyncDrax — Meeting Orchestrator (meeting.js)
   ======================================================= */

(async function () {
  /* -------------------- URL PARAMS -------------------- */
  const params    = new URLSearchParams(location.search);
  const ROOM_CODE = (params.get('room') || '').toUpperCase();
  const IS_HOST   = params.get('host') === 'true';

  if (!ROOM_CODE) { location.href = 'index.html'; return; }

  /* -------------------- DOM REFS -------------------- */
  const lobby           = document.getElementById('lobby');
  const meetingRoom     = document.getElementById('meetingRoom');
  const lobbyPreview    = document.getElementById('lobbyPreview');
  const lobbyCanvas     = document.getElementById('lobbyCanvas');
  const lobbyNoCam      = document.getElementById('lobbyNoCam');
  const lobbyAvatar     = document.getElementById('lobbyAvatar');
  const toggleLobbyMic  = document.getElementById('toggleLobbyMic');
  const toggleLobbyCam  = document.getElementById('toggleLobbyCam');
  const displayNameInput= document.getElementById('displayName');
  const roomCodeDisplay = document.getElementById('roomCodeDisplay');
  const copyRoomBtn     = document.getElementById('copyRoomBtn');
  const joinNowBtn      = document.getElementById('joinNowBtn');

  const sidebarRoomCode      = document.getElementById('sidebarRoomCode');
  const sidebarRoomCodeCopy  = document.getElementById('sidebarRoomCodeCopy');
  const copyMeetingLink      = document.getElementById('copyMeetingLink');
  const participantList      = document.getElementById('participantList');
  const participantCount     = document.getElementById('participantCount');
  const meetingTimerEl       = document.getElementById('meetingTimer');
  const topbarTitle          = document.getElementById('topbarTitle');

  const videoGrid        = document.getElementById('videoGrid');
  const localVideo       = document.getElementById('localVideo');
  const localCanvas      = document.getElementById('localCanvas');
  const localNoCam       = document.getElementById('localNoCam');
  const localAvatar      = document.getElementById('localAvatar');
  const localNameEl      = document.getElementById('localName');
  const localMicIcon     = document.getElementById('localMicIcon');
  const localSpeakingRing= document.getElementById('localSpeakingRing');

  const toggleMicBtn    = document.getElementById('toggleMic');
  const toggleCamBtn    = document.getElementById('toggleCam');
  const toggleScreenBtn = document.getElementById('toggleScreen');
  const toggleBgBtn     = document.getElementById('toggleBgBtn');
  const openChatToolbar = document.getElementById('openChatToolbar');
  const leaveBtn        = document.getElementById('leaveBtn');

  const toggleChatBtn   = document.getElementById('toggleChatBtn');
  const chatBadge       = document.getElementById('chatBadge');
  const chatPanel       = document.getElementById('chatPanel');
  const closeChatBtn    = document.getElementById('closeChatBtn');
  const chatMessages    = document.getElementById('chatMessages');
  const chatInput       = document.getElementById('chatInput');
  const sendChatBtn     = document.getElementById('sendChatBtn');
  const emojiBtn        = document.getElementById('emojiBtn');
  const emojiPicker     = document.getElementById('emojiPicker');

  const bgPanel         = document.getElementById('bgPanel');
  const closeBgPanel    = document.getElementById('closeBgPanel');
  const bgOptions       = document.querySelectorAll('.bg-option');

  const leaveModal      = document.getElementById('leaveModal');
  const cancelLeave     = document.getElementById('cancelLeave');
  const confirmLeave    = document.getElementById('confirmLeave');
  const toggleLayout    = document.getElementById('toggleLayout');

  /* -------------------- STATE -------------------- */
  let localStream   = null;
  let micEnabled    = true;
  let camEnabled    = true;
  let screenSharing = false;
  let chatOpen      = false;
  let bgEngineLocal = null;
  let rtc           = null;
  let displayName   = 'Guest';
  let startTime     = null;
  let timerInterval = null;
  let layoutMode    = 'grid'; // 'grid' | 'spotlight'

  // Auth — chat is only available to signed-in users
  const IS_SIGNED_IN = !!localStorage.getItem('syncdrax_user');

  const AVATAR_COLORS = ['#7c3aed','#059669','#dc2626','#d97706','#0284c7','#db2777','#16a34a','#9333ea'];
  const peerTileMap   = new Map(); // peerId -> tile element

  /* -------------------- HELPERS -------------------- */
  function avatarColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  }

  function initials(name) {
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => showToast('Copied!'));
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position:'fixed', bottom:'100px', left:'50%', transform:'translateX(-50%)',
      background:'rgba(124,58,237,0.95)', color:'#fff', padding:'8px 20px',
      borderRadius:'999px', fontSize:'0.85rem', fontWeight:'700',
      zIndex:'9999', pointerEvents:'none', transition:'opacity 0.3s'
    });
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 1800);
  }

  /* -------------------- LOBBY SETUP -------------------- */
  roomCodeDisplay.textContent = ROOM_CODE;
  const _storedUser = (() => { try { return JSON.parse(localStorage.getItem('syncdrax_user')); } catch { return null; } })();
  displayNameInput.value = (_storedUser && _storedUser.name) || localStorage.getItem('syncdrax_name') || '';

  // Get local media
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    lobbyPreview.srcObject = localStream;
    await lobbyPreview.play().catch(() => {});
  } catch (err) {
    console.warn('[SyncDrax] getUserMedia failed:', err.name, err.message);
    // Show cam-denied message if permission was denied
    const deniedMsg = document.getElementById('camDeniedMsg');
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      if (deniedMsg) deniedMsg.classList.remove('hidden');
    }
    // Try audio only if video fails
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    } catch {
      localStream = null;
    }
  }
  updateLobbyPreview();

  function updateLobbyPreview() {
    if (localStream && localStream.getVideoTracks().length && camEnabled) {
      lobbyNoCam.classList.add('hidden');
      lobbyPreview.style.display = '';
    } else {
      lobbyNoCam.classList.remove('hidden');
      lobbyPreview.style.display = 'none';
    }
  }

  // Lobby toggle mic
  toggleLobbyMic.addEventListener('click', () => {
    micEnabled = !micEnabled;
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    toggleLobbyMic.classList.toggle('muted', !micEnabled);
    toggleLobbyMic.querySelector('i').className = micEnabled
      ? 'fa-solid fa-microphone'
      : 'fa-solid fa-microphone-slash';
  });

  // Lobby toggle cam
  toggleLobbyCam.addEventListener('click', () => {
    camEnabled = !camEnabled;
    if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
    toggleLobbyCam.classList.toggle('muted', !camEnabled);
    toggleLobbyCam.querySelector('i').className = camEnabled
      ? 'fa-solid fa-video'
      : 'fa-solid fa-video-slash';
    updateLobbyPreview();
  });

  copyRoomBtn.addEventListener('click', () => copyToClipboard(ROOM_CODE));

  /* -------------------- JOIN -------------------- */
  joinNowBtn.addEventListener('click', async () => {
    displayName = (displayNameInput.value.trim() || 'Guest').substring(0, 24);
    localStorage.setItem('syncdrax_name', displayName);

    // If no stream from getUserMedia, create a silent stream
    if (!localStream) {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      localStream = dest.stream;
    }

    lobby.classList.add('hidden');
    meetingRoom.classList.remove('hidden');
    enterMeeting();
  });

  /* -------------------- ENTER MEETING -------------------- */
  function enterMeeting() {
    // Populate sidebar info
    sidebarRoomCode.textContent    = ROOM_CODE;
    sidebarRoomCodeCopy.textContent = ROOM_CODE;
    topbarTitle.textContent        = `SyncDrax — ${ROOM_CODE}`;
    localNameEl.textContent        = displayName;
    localAvatar.textContent        = initials(displayName);
    localAvatar.style.background   = avatarColor(displayName);
    lobbyAvatar.textContent        = initials(displayName);

    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack && camEnabled) {
        localVideo.srcObject = localStream;
        localVideo.play().catch(() => {});
        localNoCam.classList.add('hidden');
      } else {
        localNoCam.classList.remove('hidden');
        localAvatar.textContent = initials(displayName);
      }
    } else {
      localNoCam.classList.remove('hidden');
    }

    // Setup background engine
    bgEngineLocal = new BackgroundEngine(localVideo, localCanvas);

    // Setup chat
    const chat = new ChatController({
      messagesEl:  chatMessages,
      inputEl:     chatInput,
      sendBtn:     sendChatBtn,
      emojiBtn:    emojiBtn,
      emojiPicker: emojiPicker,
      badgeEl:     chatBadge,
      onSend: (text) => {
        if (rtc) rtc.sendChatMessage(text);
        else chat.addMessage({ from: displayName, text, ts: Date.now(), self: true });
      }
    });
    window._chat = chat;

    // Start meeting timer
    startTime = Date.now();
    timerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - startTime) / 1000);
      const m = Math.floor(s / 60).toString().padStart(2, '0');
      const ss = (s % 60).toString().padStart(2, '0');
      meetingTimerEl.textContent = `${m}:${ss}`;
    }, 1000);

    // Init RTC
    rtc = new SyncDraxRTC({
      roomCode:   ROOM_CODE,
      displayName: displayName,

      onPeerJoined(peerId, name) {
        chat.addSystemMessage(`${name} joined the meeting`);
        addPeerToSidebar(peerId, name);
      },

      onPeerLeft(peerId) {
        const tile = peerTileMap.get(peerId);
        if (tile) { tile.remove(); peerTileMap.delete(peerId); }
        updateGridLayout();
        updateParticipantCount();
        chat.addSystemMessage('A participant left the meeting');
        removePeerFromSidebar(peerId);
      },

      onPeerStream(peerId, stream) {
        const tile = peerTileMap.get(peerId);
        if (!tile) {
          createRemoteTile(peerId, stream, '');
        } else {
          const vid = tile.querySelector('video');
          if (vid) { vid.srcObject = stream; vid.play().catch(() => {}); }
        }
        updateGridLayout();
      },

      onMessage(msg) {
        chat.addMessage(msg);
      },

      onParticipantsUpdate(peers) {
        updateParticipantCount(peers.length + 1); // +1 for self
      }
    });

    rtc.connect(localStream).catch(() => {
      chat.addSystemMessage('?? Could not connect to server — using local mode');
    });

    updateGridLayout();
    updateParticipantCount(1);
  }

  /* -------------------- VIDEO TILES -------------------- */
  function createRemoteTile(peerId, stream, name) {
    const tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${peerId}`;

    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsInline = true;
    vid.srcObject = stream;
    vid.play().catch(() => {});

    const noCam = document.createElement('div');
    noCam.className = 'tile-no-cam hidden';
    const av = document.createElement('div');
    av.className = 'avatar-tile';
    av.textContent = initials(name || peerId);
    av.style.background = avatarColor(name || peerId);
    noCam.appendChild(av);

    const overlay = document.createElement('div');
    overlay.className = 'tile-overlay';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tile-name';
    nameSpan.textContent = name || 'Peer';
    const indicators = document.createElement('div');
    indicators.className = 'tile-indicators';
    overlay.appendChild(nameSpan);
    overlay.appendChild(indicators);

    const ring = document.createElement('div');
    ring.className = 'tile-speaking-ring';

    tile.append(vid, noCam, overlay, ring);
    videoGrid.appendChild(tile);
    peerTileMap.set(peerId, tile);
    updateGridLayout();
    return tile;
  }

  function updateGridLayout() {
    const count = peerTileMap.size + 1; // +1 for local
    videoGrid.className = 'video-grid';
    if      (count === 1)              videoGrid.classList.add('count-1');
    else if (count === 2)              videoGrid.classList.add('count-2');
    else if (count <= 4)               videoGrid.classList.add('count-4');
    else if (count <= 6)               videoGrid.classList.add('count-6');
    else if (count <= 9)               videoGrid.classList.add('count-9');
    else if (count <= 12)              videoGrid.classList.add('count-12');
    else                               videoGrid.classList.add('count-big');
  }

  function updateParticipantCount(count) {
    const c = count !== undefined ? count : peerTileMap.size + 1;
    participantCount.textContent = `${c} / 30`;
  }

  /* -------------------- SIDEBAR PARTICIPANTS -------------------- */
  function addPeerToSidebar(peerId, name) {
    const li = document.createElement('li');
    li.className = 'participant-item';
    li.id = `sidebar-peer-${peerId}`;
    const dot = document.createElement('span');
    dot.className = 'online-dot';
    const av = document.createElement('div');
    av.className = 'participant-avatar';
    av.style.background = avatarColor(name);
    av.textContent = initials(name);
    const nameEl = document.createElement('span');
    nameEl.className = 'participant-name';
    nameEl.textContent = name;
    li.append(dot, av, nameEl);
    participantList.appendChild(li);
  }

  function removePeerFromSidebar(peerId) {
    const el = document.getElementById(`sidebar-peer-${peerId}`);
    if (el) el.remove();
  }

  // Add self to sidebar
  (function addSelfToSidebar() {
    const li = document.createElement('li');
    li.className = 'participant-item';
    const dot = document.createElement('span');
    dot.className = 'online-dot';
    const av = document.createElement('div');
    av.className = 'participant-avatar';
    av.style.background = avatarColor(displayName || 'You');
    av.textContent = initials(displayName || 'Y');
    const nameEl = document.createElement('span');
    nameEl.className = 'participant-name';
    nameEl.textContent = (displayName || 'You') + ' (you)';
    li.append(dot, av, nameEl);
    participantList.appendChild(li);
  })();

  /* -------------------- TOOLBAR CONTROLS -------------------- */

  // Mic
  toggleMicBtn.addEventListener('click', () => {
    micEnabled = !micEnabled;
    rtc && rtc.toggleMic(micEnabled);
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    toggleMicBtn.classList.toggle('muted', !micEnabled);
    toggleMicBtn.querySelector('i').className = micEnabled
      ? 'fa-solid fa-microphone'
      : 'fa-solid fa-microphone-slash';
    toggleMicBtn.querySelector('span').textContent = micEnabled ? 'Mute' : 'Unmute';
    localMicIcon.classList.toggle('hidden', micEnabled);
  });

  // Camera
  toggleCamBtn.addEventListener('click', () => {
    camEnabled = !camEnabled;
    rtc && rtc.toggleCamera(camEnabled);
    if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
    toggleCamBtn.classList.toggle('muted', !camEnabled);
    toggleCamBtn.querySelector('i').className = camEnabled
      ? 'fa-solid fa-video'
      : 'fa-solid fa-video-slash';
    toggleCamBtn.querySelector('span').textContent = camEnabled ? 'Camera' : 'Cam Off';
    localNoCam.classList.toggle('hidden', camEnabled);
  });

  // Screen share
  toggleScreenBtn.addEventListener('click', async () => {
    if (!screenSharing) {
      const ok = rtc ? await rtc.startScreenShare() : false;
      if (ok) {
        screenSharing = true;
        toggleScreenBtn.classList.add('active');
        toggleScreenBtn.querySelector('span').textContent = 'Stop';
        showToast('Screen sharing started');
      } else {
        showToast('Screen share cancelled');
      }
    } else {
      rtc && rtc.stopScreenShare();
      screenSharing = false;
      toggleScreenBtn.classList.remove('active');
      toggleScreenBtn.querySelector('span').textContent = 'Share';
      showToast('Screen sharing stopped');
    }
  });

  // Background panel
  toggleBgBtn.addEventListener('click', () => bgPanel.classList.toggle('hidden'));
  closeBgPanel.addEventListener('click', () => bgPanel.classList.add('hidden'));

  bgOptions.forEach(opt => {
    opt.addEventListener('click', async (e) => {
      if (e.target.closest('.dl-btn')) return; // handled by download button
      bgOptions.forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      const bgKey = opt.dataset.bg;
      if (!bgEngineLocal) return;
      const canvasTrack = bgEngineLocal.setBackground(bgKey);
      // Swap WebRTC video track so peers see the processed background too
      if (rtc) {
        if (bgKey === 'none') {
          const camTrack = localStream && localStream.getVideoTracks()[0];
          if (camTrack) await rtc.replaceVideoTrack(camTrack);
        } else if (canvasTrack) {
          await rtc.replaceVideoTrack(canvasTrack);
        }
      }
    });
  });

  // Download background buttons
  document.querySelectorAll('.dl-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opt  = btn.closest('.bg-option');
      const bgKey = opt.dataset.bg;
      const name  = btn.dataset.name || bgKey;
      if (bgEngineLocal) bgEngineLocal.downloadBackground(bgKey, name);
    });
  });

  // Chat
  function openChat() {
    if (!IS_SIGNED_IN) {
      showToast('?? Sign in to use chat');
      return;
    }
    chatOpen = true;
    chatPanel.classList.remove('hidden');
    meetingRoom.classList.add('chat-open');
    toggleChatBtn.classList.add('active');
    openChatToolbar.classList.add('active');
    window._chat && window._chat.setVisible(true);
  }
  function closeChat() {
    chatOpen = false;
    chatPanel.classList.add('hidden');
    meetingRoom.classList.remove('chat-open');
    toggleChatBtn.classList.remove('active');
    openChatToolbar.classList.remove('active');
    window._chat && window._chat.setVisible(false);
  }

  // Lock chat buttons visually for guests
  if (!IS_SIGNED_IN) {
    [toggleChatBtn, openChatToolbar].forEach(btn => {
      btn.classList.add('chat-locked');
      btn.title = 'Sign in to use chat';
    });
  }

  toggleChatBtn.addEventListener('click',   () => chatOpen ? closeChat() : openChat());
  openChatToolbar.addEventListener('click', () => chatOpen ? closeChat() : openChat());
  closeChatBtn.addEventListener('click',    closeChat);

  // Copy links
  copyRoomBtn.addEventListener('click', () => copyToClipboard(ROOM_CODE));
  copyMeetingLink.addEventListener('click', () => copyToClipboard(location.href));

  // Layout toggle
  toggleLayout.addEventListener('click', () => {
    layoutMode = layoutMode === 'grid' ? 'spotlight' : 'grid';
    toggleLayout.querySelector('i').className = layoutMode === 'grid'
      ? 'fa-solid fa-table-cells'
      : 'fa-solid fa-expand';
    updateGridLayout();
  });

  // Leave
  leaveBtn.addEventListener('click', () => leaveModal.classList.remove('hidden'));
  cancelLeave.addEventListener('click', () => leaveModal.classList.add('hidden'));
  confirmLeave.addEventListener('click', () => {
    clearInterval(timerInterval);
    rtc && rtc.disconnect();
    window.location.href = 'index.html';
  });

  // Participants sidebar toggle
  document.getElementById('toggleParticipantsPanel').addEventListener('click', () => {
    document.querySelector('.sidebar').style.display =
      document.querySelector('.sidebar').style.display === 'none' ? '' : 'none';
  });

  /* -------------------- SPEAKING DETECTION (VAD) -------------------- */
  (function setupVAD() {
    if (!localStream) return;
    try {
      const audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      const source = audioCtx.createMediaStreamSource(localStream);
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const localTile = document.getElementById('localTile');

      setInterval(() => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        if (avg > 20 && micEnabled) {
          localTile.classList.add('speaking');
        } else {
          localTile.classList.remove('speaking');
        }
      }, 100);
    } catch (e) {
      console.warn('[VAD] could not set up audio analyser', e);
    }
  })();

  /* -------------------- KEYBOARD SHORTCUTS -------------------- */
  document.addEventListener('keydown', (e) => {
    // Ignore if typing in input/textarea
    if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
    if (e.key === 'm' || e.key === 'M') toggleMicBtn.click();
    if (e.key === 'v' || e.key === 'V') toggleCamBtn.click();
    if ((e.key === 'c' || e.key === 'C') && IS_SIGNED_IN) chatOpen ? closeChat() : openChat();
    if (e.key === 'Escape') {
      leaveModal.classList.add('hidden');
      bgPanel.classList.add('hidden');
    }
  });

})();
