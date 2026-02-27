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

  // New feature DOM refs
  const raiseHandBtn      = document.getElementById('raiseHandBtn');
  const reactionsBtn      = document.getElementById('reactionsBtn');
  const reactionsPanel    = document.getElementById('reactionsPanel');
  const noiseSuppBtn      = document.getElementById('noiseSuppBtn');
  const recordBtn         = document.getElementById('recordBtn');
  const whiteboardBtn     = document.getElementById('whiteboardBtn');
  const localHandBadge    = document.getElementById('localHandBadge');
  const summaryOverlay    = document.getElementById('summaryOverlay');
  const sumStayBtn        = document.getElementById('sumStayBtn');
  const sumLeaveBtn       = document.getElementById('sumLeaveBtn');
  const sumDuration       = document.getElementById('sumDuration');
  const sumParticipants   = document.getElementById('sumParticipants');
  const sumMessages       = document.getElementById('sumMessages');
  const sumNames          = document.getElementById('sumNames');
  const recordIndicator   = document.getElementById('recordIndicator');
  const recTimerEl        = document.getElementById('recTimer');
  const wbOverlay         = document.getElementById('whiteboardOverlay');
  const wbCanvas          = document.getElementById('whiteboardCanvas');
  const wbCloseBtn        = document.getElementById('wbCloseBtn');
  const wbPenBtn          = document.getElementById('wbPenBtn');
  const wbEraserBtn       = document.getElementById('wbEraserBtn');
  const wbColorPick       = document.getElementById('wbColor');
  const wbSizeRange       = document.getElementById('wbSize');
  const wbClearBtn        = document.getElementById('wbClearBtn');
  const editProfilePicBtn = document.getElementById('editProfilePicBtn');
  const profilePicInput   = document.getElementById('profilePicInput');

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

  // New feature state
  let handRaised          = false;
  let noiseActive         = false;
  let _noiseAudioCtx      = null;
  let _noiseDest          = null;
  let _originalAudioTrack = null;
  let isRecording         = false;
  let _mediaRecorder      = null;
  let _recordedChunks     = [];
  let _recSeconds         = 0;
  let _recInterval        = null;
  let allParticipantNames = new Set();
  let meetingChatCount    = 0;
  let wbTool              = 'pen';
  let _wbDrawing          = false;
  let _wbLastX            = 0;
  let _wbLastY            = 0;
  let _wbCtx              = null;

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

  // Apply saved profile picture to lobby avatar
  (function applyProfilePic() {
    const savedPic = localStorage.getItem('syncdrax_avatar');
    if (!savedPic) return;
    [lobbyAvatar, localAvatar].forEach(el => {
      if (!el) return;
      el.style.backgroundImage = `url('${savedPic}')`;
      el.style.backgroundSize  = 'cover';
      el.style.backgroundPosition = 'center';
      el.style.fontSize = '0';
      el.classList.add('has-pic');
    });
  })();

  // Profile pic upload handler
  editProfilePicBtn.addEventListener('click', () => profilePicInput.click());
  profilePicInput.addEventListener('change', () => {
    const file = profilePicInput.files[0];
    if (!file) return;
    profilePicInput.value = '';
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      localStorage.setItem('syncdrax_avatar', dataUrl);
      [lobbyAvatar, localAvatar].forEach(el => {
        el.style.backgroundImage = `url('${dataUrl}')`;
        el.style.backgroundSize  = 'cover';
        el.style.backgroundPosition = 'center';
        el.style.fontSize = '0';
        el.classList.add('has-pic');
      });
      showToast('Profile photo updated!');
    };
    reader.readAsDataURL(file);
  });

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
    // Sync toolbar buttons to lobby toggle state
    toggleMicBtn.classList.toggle('muted', !micEnabled);
    toggleMicBtn.querySelector('i').className = micEnabled
      ? 'fa-solid fa-microphone'
      : 'fa-solid fa-microphone-slash';
    toggleMicBtn.querySelector('span').textContent = micEnabled ? 'Mute' : 'Unmute';
    localMicIcon.classList.toggle('hidden', micEnabled);

    toggleCamBtn.classList.toggle('muted', !camEnabled);
    toggleCamBtn.querySelector('i').className = camEnabled
      ? 'fa-solid fa-video'
      : 'fa-solid fa-video-slash';
    toggleCamBtn.querySelector('span').textContent = camEnabled ? 'Camera' : 'Cam Off';

    // Populate sidebar info
    sidebarRoomCode.textContent    = ROOM_CODE;
    sidebarRoomCodeCopy.textContent = ROOM_CODE;
    topbarTitle.textContent        = `SyncDrax — ${ROOM_CODE}`;
    localNameEl.textContent        = displayName;
    localAvatar.textContent        = initials(displayName);
    localAvatar.style.background   = avatarColor(displayName);
    lobbyAvatar.textContent        = initials(displayName);
    addSelfToSidebar();
    // Sidebar starts visible — mark the participants button as active
    document.getElementById('toggleParticipantsPanel').classList.add('active');

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
      onSend: (text, replyTo) => {
        meetingChatCount++;
        if (rtc) rtc.sendChatMessage(text);
        chat.addMessage({ from: displayName, text, ts: Date.now(), self: true, replyTo: replyTo || null });
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
      },

      onData(msg) {
        if (msg.type === 'raise_hand') {
          const tile = peerTileMap.get(msg.from_id);
          if (tile) {
            let badge = tile.querySelector('.raised-hand-badge');
            if (!badge) {
              badge = document.createElement('div');
              badge.className = 'raised-hand-badge';
              badge.textContent = '✋';
              tile.appendChild(badge);
            }
            if (msg.raised) badge.classList.remove('hidden');
            else badge.classList.add('hidden');
          }
        }
        if (msg.type === 'reaction') fireReaction(msg.emoji);
        if (msg.type === 'whiteboard') handleWbOp(msg);
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
    allParticipantNames.add(name);
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

  // Add self to sidebar (called from enterMeeting after displayName is set)
  function addSelfToSidebar() {
    allParticipantNames.add(displayName);
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
  }

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
    if (localStream) {
      localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
      if (camEnabled && !localVideo.srcObject) {
        localVideo.srcObject = localStream;
        localVideo.play().catch(() => {});
      }
    }
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
  const bgOptionsContainer = document.getElementById('bgOptions');
  toggleBgBtn.addEventListener('click', () => bgPanel.classList.toggle('hidden'));
  closeBgPanel.addEventListener('click', () => bgPanel.classList.add('hidden'));

  bgOptionsContainer.addEventListener('click', async (e) => {
    if (e.target.closest('.dl-btn')) return;
    const opt = e.target.closest('.bg-option');
    if (!opt) return;
    const bgKey = opt.dataset.bg;
    // Custom tile: apply the saved background, don't open file picker
    if (bgKey === 'custom') {
      const saved = localStorage.getItem('syncdrax_custom_bg');
      if (!saved) { document.getElementById('customBgInput').click(); return; }
      document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      if (!bgEngineLocal) return;
      const canvasTrack = bgEngineLocal.setCustomBackground(saved);
      if (rtc && canvasTrack) await rtc.replaceVideoTrack(canvasTrack);
      return;
    }
    document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
    opt.classList.add('active');
    if (!bgEngineLocal) return;
    const canvasTrack = bgEngineLocal.setBackground(bgKey);
    if (rtc) {
      if (bgKey === 'none') {
        const camTrack = localStream && localStream.getVideoTracks()[0];
        if (camTrack) await rtc.replaceVideoTrack(camTrack);
      } else if (canvasTrack) {
        await rtc.replaceVideoTrack(canvasTrack);
      }
    }
  });

  // Custom background upload
  const customBgInput   = document.getElementById('customBgInput');
  const uploadBgOption  = document.getElementById('uploadBgOption');

  // Restore previously uploaded custom background from localStorage
  (function restoreCustomBg() {
    const saved = localStorage.getItem('syncdrax_custom_bg');
    if (!saved) return;
    const opt = document.createElement('div');
    opt.className = 'bg-option';
    opt.dataset.bg = 'custom';
    opt.innerHTML = `<div class="bg-thumb" style="background-image:url('${saved}');background-size:cover;background-position:center;"></div><span>My Upload</span>`;
    document.getElementById('bgOptions').appendChild(opt);
  })();

  uploadBgOption.addEventListener('click', () => customBgInput.click());

  customBgInput.addEventListener('change', async () => {
    const file = customBgInput.files[0];
    if (!file) return;
    customBgInput.value = ''; // allow re-picking same file
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target.result;
      // Save to localStorage so it persists across meetings
      try { localStorage.setItem('syncdrax_custom_bg', dataUrl); } catch(e) {}
      // Add or update the custom tile
      let customTile = document.querySelector('[data-bg="custom"]');
      if (!customTile) {
        customTile = document.createElement('div');
        customTile.className = 'bg-option';
        customTile.dataset.bg = 'custom';
        customTile.innerHTML = `<div class="bg-thumb"></div><span>My Upload</span>`;
        document.getElementById('bgOptions').appendChild(customTile);
      }
      customTile.querySelector('.bg-thumb').style.cssText = `background-image:url('${dataUrl}');background-size:cover;background-position:center;`;
      document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
      customTile.classList.add('active');
      if (!bgEngineLocal) return;
      const canvasTrack = bgEngineLocal.setCustomBackground(dataUrl);
      if (rtc && canvasTrack) await rtc.replaceVideoTrack(canvasTrack);
      showToast('Custom background applied');
    };
    reader.readAsDataURL(file);
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
    leaveModal.classList.add('hidden');
    showMeetingSummary();
  });

  function showMeetingSummary() {
    const totalSec = Math.floor((Date.now() - (startTime || Date.now())) / 1000);
    const mm = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const ss = (totalSec % 60).toString().padStart(2, '0');
    if (sumDuration)      sumDuration.textContent     = `${mm}:${ss}`;
    if (sumParticipants)  sumParticipants.textContent  = allParticipantNames.size || 1;
    if (sumMessages)      sumMessages.textContent      = meetingChatCount;
    if (sumNames)         sumNames.textContent         = [...allParticipantNames].join(', ') || displayName;
    summaryOverlay.classList.remove('hidden');
    clearInterval(timerInterval);
    rtc && rtc.disconnect();
  }

  sumStayBtn.addEventListener('click', () => {
    summaryOverlay.classList.add('hidden');
    // Re-start the timer so it's not frozen
    timerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - startTime) / 1000);
      const m = Math.floor(s / 60).toString().padStart(2, '0');
      const ss = (s % 60).toString().padStart(2, '0');
      meetingTimerEl.textContent = `${m}:${ss}`;
    }, 1000);
  });
  sumLeaveBtn.addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  // Participants sidebar toggle
  const toggleParticipantsBtn = document.getElementById('toggleParticipantsPanel');
  toggleParticipantsBtn.addEventListener('click', () => {
    const isCollapsed = meetingRoom.classList.toggle('sidebar-collapsed');
    toggleParticipantsBtn.classList.toggle('active', !isCollapsed);
    if (!isCollapsed) {
      // Restore to default width if it was dragged to 0 or is missing
      const curW = parseInt(getComputedStyle(meetingRoom).getPropertyValue('--sidebar-w')) || 0;
      if (curW < 120) meetingRoom.style.setProperty('--sidebar-w', '240px');
    }
  });

  /* -------------------- SIDEBAR RESIZE -------------------- */
  (function initSidebarResize() {
    const handle = document.getElementById('sidebarResizeHandle');
    if (!handle) return;
    const room = meetingRoom;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = parseInt(getComputedStyle(room).getPropertyValue('--sidebar-w')) || 240;
      handle.classList.add('dragging');
      document.body.style.cursor     = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(e) {
        const newW = Math.max(0, startW + (e.clientX - startX));
        room.style.setProperty('--sidebar-w', newW + 'px');
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.body.style.cursor     = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  })();

  /* -------------------- CHAT PANEL RESIZE -------------------- */
  (function initChatResize() {
    const handle    = document.getElementById('chatResizeHandle');
    const chatPanel = document.getElementById('chatPanel');
    if (!handle || !chatPanel) return;
    const room = meetingRoom;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = parseInt(getComputedStyle(room).getPropertyValue('--chat-w')) || 320;
      handle.classList.add('dragging');
      document.body.style.cursor     = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(e) {
        const newW = Math.max(0, startW - (e.clientX - startX));
        room.style.setProperty('--chat-w', newW + 'px');
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.body.style.cursor     = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  })();

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
      reactionsPanel.classList.add('hidden');
      if (wbOverlay && !wbOverlay.classList.contains('hidden')) wbOverlay.classList.add('hidden');
    }
  });

  /* ==================== RAISE HAND ==================== */
  raiseHandBtn.addEventListener('click', () => {
    handRaised = !handRaised;
    raiseHandBtn.classList.toggle('active', handRaised);
    raiseHandBtn.querySelector('span').textContent = handRaised ? 'Lower' : 'Hand';
    localHandBadge.classList.toggle('hidden', !handRaised);
    if (rtc) rtc.sendData('raise_hand', { raised: handRaised });
  });

  /* ==================== REACTIONS ==================== */
  reactionsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    reactionsPanel.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!reactionsPanel.contains(e.target) && e.target !== reactionsBtn) {
      reactionsPanel.classList.add('hidden');
    }
  });
  document.querySelectorAll('.react-emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.emoji;
      reactionsPanel.classList.add('hidden');
      fireReaction(emoji);
      if (rtc) rtc.sendData('reaction', { emoji });
    });
  });

  function fireReaction(emoji) {
    const el = document.createElement('div');
    el.className = 'reaction-float';
    el.textContent = emoji;
    const grid = videoGrid.getBoundingClientRect();
    el.style.left = (grid.left + Math.random() * grid.width * 0.8 + grid.width * 0.1) + 'px';
    el.style.bottom = (window.innerHeight - grid.bottom + 20) + 'px';
    document.body.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  /* ==================== NOISE SUPPRESSION ==================== */
  noiseSuppBtn.addEventListener('click', async () => {
    noiseActive = !noiseActive;
    noiseSuppBtn.classList.toggle('active', noiseActive);
    noiseSuppBtn.querySelector('span').textContent = noiseActive ? 'Noise: On' : 'Noise';
    if (!localStream) return;

    if (noiseActive) {
      try {
        _originalAudioTrack = localStream.getAudioTracks()[0];
        _noiseAudioCtx = new AudioContext();
        const src = _noiseAudioCtx.createMediaStreamSource(localStream);
        const hpf = _noiseAudioCtx.createBiquadFilter();
        hpf.type = 'highpass'; hpf.frequency.value = 80;
        const comp = _noiseAudioCtx.createDynamicsCompressor();
        comp.threshold.value = -45; comp.knee.value = 30;
        comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.25;
        _noiseDest = _noiseAudioCtx.createMediaStreamDestination();
        src.connect(hpf); hpf.connect(comp); comp.connect(_noiseDest);
        const newTrack = _noiseDest.stream.getAudioTracks()[0];
        if (rtc) rtc.replaceAudioTrack(newTrack);
        showToast('Noise suppression ON');
      } catch (err) {
        console.warn('[Noise]', err);
        showToast('Noise suppression unavailable');
        noiseActive = false;
        noiseSuppBtn.classList.remove('active');
        noiseSuppBtn.querySelector('span').textContent = 'Noise';
      }
    } else {
      if (_noiseAudioCtx) { _noiseAudioCtx.close(); _noiseAudioCtx = null; }
      if (_originalAudioTrack && rtc) rtc.replaceAudioTrack(_originalAudioTrack);
      showToast('Noise suppression OFF');
    }
  });

  /* ==================== RECORDING ==================== */
  recordBtn.addEventListener('click', () => {
    if (!isRecording) startRecording(); else stopRecording();
  });

  function startRecording() {
    try {
      const tracks = [];
      // Prefer canvas track if bg active, else video track
      const videoTrack = (localCanvas && localCanvas.captureStream)
        ? localCanvas.captureStream(30).getVideoTracks()[0]
        : (localStream && localStream.getVideoTracks()[0]);
      if (videoTrack) tracks.push(videoTrack);
      const audioTrack = localStream && localStream.getAudioTracks()[0];
      if (audioTrack) tracks.push(audioTrack);
      if (!tracks.length) { showToast('No media to record'); return; }

      const recStream = new MediaStream(tracks);
      _recordedChunks = [];
      _mediaRecorder = new MediaRecorder(recStream, { mimeType: 'video/webm;codecs=vp9' });
      _mediaRecorder.ondataavailable = (e) => { if (e.data.size) _recordedChunks.push(e.data); };
      _mediaRecorder.onstop = () => {
        const blob = new Blob(_recordedChunks, { type: 'video/webm' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `SyncDrax-recording-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.webm`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Recording saved!');
      };
      _mediaRecorder.start(100);
      isRecording = true;
      recordBtn.classList.add('recording');
      recordBtn.querySelector('span').textContent = 'Stop Rec';
      recordIndicator.classList.remove('hidden');
      _recSeconds = 0;
      _recInterval = setInterval(() => {
        _recSeconds++;
        const m = Math.floor(_recSeconds / 60).toString().padStart(2, '0');
        const s = (_recSeconds % 60).toString().padStart(2, '0');
        if (recTimerEl) recTimerEl.textContent = `${m}:${s}`;
      }, 1000);
    } catch (err) {
      console.warn('[Rec]', err);
      showToast('Recording not supported in this browser');
    }
  }

  function stopRecording() {
    if (_mediaRecorder && _mediaRecorder.state !== 'inactive') _mediaRecorder.stop();
    isRecording = false;
    recordBtn.classList.remove('recording');
    recordBtn.querySelector('span').textContent = 'Record';
    recordIndicator.classList.add('hidden');
    clearInterval(_recInterval);
  }

  /* ==================== WHITEBOARD ==================== */
  whiteboardBtn.addEventListener('click', () => {
    wbOverlay.classList.remove('hidden');
    initWhiteboard();
  });
  wbCloseBtn.addEventListener('click', () => {
    wbOverlay.classList.add('hidden');
  });

  function initWhiteboard() {
    if (_wbCtx) return; // already init
    _wbCtx = wbCanvas.getContext('2d');
    resizeWb();
    window.addEventListener('resize', resizeWb);
    wbCanvas.addEventListener('mousedown',  wbPointerDown);
    wbCanvas.addEventListener('mousemove',  wbPointerMove);
    wbCanvas.addEventListener('mouseup',    wbPointerUp);
    wbCanvas.addEventListener('mouseleave', wbPointerUp);
    wbCanvas.addEventListener('touchstart', wbTouchDown, { passive: false });
    wbCanvas.addEventListener('touchmove',  wbTouchMove, { passive: false });
    wbCanvas.addEventListener('touchend',   wbPointerUp);
  }

  function resizeWb() {
    const rect = wbCanvas.parentElement.getBoundingClientRect();
    const imgData = _wbCtx ? _wbCtx.getImageData(0, 0, wbCanvas.width, wbCanvas.height) : null;
    wbCanvas.width  = rect.width;
    wbCanvas.height = rect.height - 52;
    _wbCtx.fillStyle = '#1a1a1e';
    _wbCtx.fillRect(0, 0, wbCanvas.width, wbCanvas.height);
    if (imgData) _wbCtx.putImageData(imgData, 0, 0);
  }

  function wbPointerDown(e) { _wbDrawing = true; _wbLastX = e.offsetX; _wbLastY = e.offsetY; }
  function wbPointerMove(e) {
    if (!_wbDrawing) return;
    wbDrawLine(_wbLastX, _wbLastY, e.offsetX, e.offsetY, wbColorPick.value, parseInt(wbSizeRange.value), wbTool);
    if (rtc) rtc.sendData('whiteboard', { op: 'draw', x0: _wbLastX, y0: _wbLastY, x1: e.offsetX, y1: e.offsetY, color: wbColorPick.value, size: parseInt(wbSizeRange.value), tool: wbTool });
    _wbLastX = e.offsetX; _wbLastY = e.offsetY;
  }
  function wbPointerUp() { _wbDrawing = false; }
  function wbTouchDown(e) { e.preventDefault(); const t = e.touches[0]; const r = wbCanvas.getBoundingClientRect(); wbPointerDown({ offsetX: t.clientX - r.left, offsetY: t.clientY - r.top }); }
  function wbTouchMove(e) { e.preventDefault(); const t = e.touches[0]; const r = wbCanvas.getBoundingClientRect(); wbPointerMove({ offsetX: t.clientX - r.left, offsetY: t.clientY - r.top }); }

  function wbDrawLine(x0, y0, x1, y1, color, size, tool) {
    if (!_wbCtx) return;
    _wbCtx.beginPath();
    _wbCtx.moveTo(x0, y0);
    _wbCtx.lineTo(x1, y1);
    _wbCtx.strokeStyle = tool === 'eraser' ? '#1a1a1e' : (color || '#ffffff');
    _wbCtx.lineWidth   = tool === 'eraser' ? size * 4 : size;
    _wbCtx.lineCap     = 'round';
    _wbCtx.lineJoin    = 'round';
    _wbCtx.stroke();
  }

  function handleWbOp(msg) {
    if (!_wbCtx) return;
    if (msg.op === 'draw') wbDrawLine(msg.x0, msg.y0, msg.x1, msg.y1, msg.color, msg.size, msg.tool);
    if (msg.op === 'clear') { _wbCtx.fillStyle = '#1a1a1e'; _wbCtx.fillRect(0, 0, wbCanvas.width, wbCanvas.height); }
  }

  wbPenBtn.addEventListener('click', () => {
    wbTool = 'pen';
    wbPenBtn.classList.add('active');
    wbEraserBtn.classList.remove('active');
    wbCanvas.style.cursor = 'crosshair';
  });
  wbEraserBtn.addEventListener('click', () => {
    wbTool = 'eraser';
    wbEraserBtn.classList.add('active');
    wbPenBtn.classList.remove('active');
    wbCanvas.style.cursor = 'cell';
  });
  wbClearBtn.addEventListener('click', () => {
    if (!_wbCtx) return;
    _wbCtx.fillStyle = '#1a1a1e';
    _wbCtx.fillRect(0, 0, wbCanvas.width, wbCanvas.height);
    if (rtc) rtc.sendData('whiteboard', { op: 'clear' });
  });

})();
