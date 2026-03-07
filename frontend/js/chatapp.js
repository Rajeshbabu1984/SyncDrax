/**
 * SyncTact — Chat App (chatapp.js)
 */
'use strict';

// ── Migrate old localStorage keys (synctact_ → synctact_) ────────────────────
(function migrateLegacyKeys() {
  const AUTH_VERSION = '3'; // bump this whenever the JWT secret changes
  if (localStorage.getItem('synctact_auth_v') !== AUTH_VERSION) {
    // Wipe all auth — forces fresh sign-in with new secret key
    localStorage.removeItem('synctact_token');
    localStorage.removeItem('synctact_user');
    localStorage.removeItem('synctact_token');
    localStorage.removeItem('synctact_user');
    localStorage.setItem('synctact_auth_v', AUTH_VERSION);
  }
})();

const API = typeof API_BASE !== 'undefined' ? API_BASE : 'http://localhost:8000';
const WSS = typeof WS_BASE  !== 'undefined' ? WS_BASE  : 'ws://localhost:8000';

// ── Auth ──────────────────────────────────────────────────────────────────────
function getUser()  { try { return JSON.parse(localStorage.getItem('synctact_user')); } catch { return null; } }
function getToken() { return localStorage.getItem('synctact_token') || ''; }

const user  = getUser();
const token = getToken();

// ── UI refs ───────────────────────────────────────────────────────────────────
const channelListEl  = document.getElementById('channelList');
const dmListEl       = document.getElementById('dmList');
const messagesWrap   = document.getElementById('messagesWrap');
const typingBar      = document.getElementById('typingBar');
const msgInput       = document.getElementById('msgInput');
const sendBtn        = document.getElementById('sendBtn');
const chatTitle      = document.getElementById('chatTitle');
const chatDesc       = document.getElementById('chatDesc');
const userAvatar     = document.getElementById('userAvatar');
const userNameLabel  = document.getElementById('userNameLabel');
const emojiPickerEl  = document.getElementById('emojiPicker');
const addChannelBtn  = document.getElementById('addChannelBtn');
const addDmBtn       = document.getElementById('addDmBtn');
const fileInput      = document.getElementById('fileInput');
const voltTargetBtn  = document.getElementById('voltTargetBtn');

// ── Volt target helpers (per-channel: 'self' = private, 'channel' = broadcast) ─
function getVoltTarget() {
  if (activeType !== 'channel') return 'self';
  return localStorage.getItem(`volt_ch_target_${activeId}`) || 'self';
}
function _updateVoltTargetBtn() {
  if (!voltTargetBtn) return;
  const t = getVoltTarget();
  voltTargetBtn.textContent = t === 'channel' ? '\uD83D\uDCE2' : '\uD83D\uDD12';
  voltTargetBtn.title = t === 'channel' ? 'Volt: visible to whole channel (click to make private)' : 'Volt: only visible to me (click to broadcast to channel)';
}
let ws            = null;
let channels      = [];      // [{id, name, description, created_by}]
let activeType    = null;    // 'channel' | 'dm'
let activeId      = null;    // channel id or user id
let activeDmName  = '';
let dmUsers       = {};      // { user_id: {name, online} }
let typingTimers  = {};      // channel/dm → timer
let emojiTarget   = null;    // 'input' or message_id for reaction
let pendingEmoji  = '💬';   // selected channel emoji
let unread        = {};      // { cid: count }
let allUsers      = [];      // [{id, name, avatar_url, status}] from /chat/users
let threadParentId   = null;
let threadParentData = null;
let searchTimeout    = null;
let _pinnedPollTimer = null;  // auto-refresh pinned badge every 5s
let categories       = [];    // [{id, name, position}]
let pendingForwardId = null;  // message id to forward
let mentionUsers     = [];    // filtered mention candidates
let mentionActiveIdx = 0;
let myProfile        = null;  // {id, name, avatar_url, status, bio}
let notifPrefs       = {};    // {channel_id: {muted: bool}}
let voiceRecorder    = null;  // MediaRecorder instance
let voiceChunks      = [];
let voiceTimerInterval = null;

const CHANNEL_EMOJIS = [
  '💬','📣','🔥','🎉','🛠️','📢','🌍','🎵','🚀','💡','🎯','🧠',
  '📸','🏆','💼','🍕','🎮','✨','🔒','📊','🌙','⚡','🎨','🤝',
];

const INPUT_EMOJIS = [
  '😀','😂','🥲','😍','🤔','😅','😭','🤩','😎','🥳','🫡','🙏',
  '👍','👎','👏','🔥','❤️','💯','😮','😤','😴','🤣','🥰','😇',
  '🎉','✅','❌','❓','🚀','💡','🌟','⚡','🍕','🎮','🎵','🏆',
  '😏','🤗','🤫','🤭','😬','🙄','😒','😔','😢','😡','🤯','🥺',
  '👋','✌️','🤞','👀','💪','🫶','🤝','🙌','💀','🫠','🤡','💩',
  '🐶','🐱','🦊','🐸','🐼','🦁','🐻','🦄','🌈','⭐','🌸','🍀',
];

// ── Init ──────────────────────────────────────────────────────────────────────
async function initChat() {
  userAvatar.textContent   = user.name.charAt(0).toUpperCase();
  userNameLabel.textContent = user.name;

  // Refresh role & title from server (ensures latest DB values are in-memory)
  authFetch('/auth/me').then(r => r.ok ? r.json() : null).then(me => {
    if (!me) return;
    user.role  = me.role;
    user.title = me.title;
  });

  buildEmojiPicker();
  buildChannelEmojiPicker();

  await loadChannels();
  await loadUsers();
  loadCategories();
  loadMyProfile();
  connectWS();

  // Auto-open first channel
  if (channels.length) openChannel(channels[0]);

  // Event listeners
  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', e => {
    const slashOpen   = !slashDropdownEl.classList.contains('hidden');
    const mentionOpen = !document.getElementById('mentionDropdown').classList.contains('hidden');
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (mentionOpen) { completeMention(mentionUsers[mentionActiveIdx]?.name || ''); return; }
      if (slashOpen) {
        const active = slashDropdownEl.querySelector('.slash-cmd-item.active');
        if (active) {
          const cmdName = active.querySelector('.slash-cmd-name').textContent;
          msgInput.value = cmdName + ' ';
          msgInput.dispatchEvent(new Event('input'));
        }
        return;
      }
      sendMessage();
    }
    if (e.key === 'Escape') { hideSlashDropdown(); hideMentionDropdown(); }
    if (e.key === 'ArrowDown') {
      if (mentionOpen) { mentionActiveIdx = Math.min(mentionActiveIdx + 1, mentionUsers.length - 1); renderMentionDropdown(); e.preventDefault(); }
      else if (slashOpen) { slashSelectDelta(1); e.preventDefault(); }
    }
    if (e.key === 'ArrowUp') {
      if (mentionOpen) { mentionActiveIdx = Math.max(mentionActiveIdx - 1, 0); renderMentionDropdown(); e.preventDefault(); }
      else if (slashOpen) { slashSelectDelta(-1); e.preventDefault(); }
    }
    sendTyping();
  });
  msgInput.addEventListener('input', () => {
    const v = msgInput.value;
    if (v.startsWith('/')) showSlashDropdown(v);
    else hideSlashDropdown();
  });
  addChannelBtn.addEventListener('click', openAddChannelModal);
  addDmBtn.addEventListener('click', openDmModal);
  if (voltTargetBtn) {
    voltTargetBtn.addEventListener('click', () => {
      if (activeType !== 'channel') return;
      const cur  = getVoltTarget();
      const next = cur === 'self' ? 'channel' : 'self';
      localStorage.setItem(`volt_ch_target_${activeId}`, next);
      _updateVoltTargetBtn();
      showToast(next === 'channel'
        ? '\uD83D\uDCE2 Volt replies now visible to whole channel'
        : '\uD83D\uDD12 Volt replies now private \u2014 only visible to you');
    });
  }
  document.getElementById('openBotsBtn').addEventListener('click', openBotsModal);
  document.getElementById('cancelChannelBtn').addEventListener('click', closeAddChannelModal);
  document.getElementById('createChannelBtn').addEventListener('click', createChannel);
  document.getElementById('cancelDmBtn').addEventListener('click', () =>
    document.getElementById('addDmOverlay').classList.add('hidden'));

  fileInput.addEventListener('change', handleFileSelect);
  document.getElementById('emojiInputBtn').addEventListener('click', e => {
    e.stopPropagation();
    emojiTarget = 'input';
    emojiPickerEl.classList.toggle('hidden');
  });
  document.addEventListener('click', () => emojiPickerEl.classList.add('hidden'));

  // Search
  document.getElementById('searchBtn').addEventListener('click', openSearch);
  document.getElementById('closeSearchBtn').addEventListener('click', closeSearch);

  // ⋯ More overflow menu
  const _moreBtn  = document.getElementById('headerMoreBtn');
  const _moreMenu = document.getElementById('headerOverflowMenu');
  if (_moreBtn && _moreMenu) {
    _moreBtn.addEventListener('click', e => { e.stopPropagation(); _moreMenu.classList.toggle('hidden'); });
    document.addEventListener('click', () => _moreMenu.classList.add('hidden'));
    _moreMenu.addEventListener('click', e => e.stopPropagation());
  }
  const _triggerSearch = () => {
    clearTimeout(searchTimeout);
    const q = document.getElementById('searchInput').value.trim();
    if (q.length < 2) {
      document.getElementById('searchResults').innerHTML = '<div class="search-empty">Type to search across all channels and DMs</div>';
      return;
    }
    searchTimeout = setTimeout(() => doSearch(q), 350);
  };
  document.getElementById('searchInput').addEventListener('input', _triggerSearch);
  ['searchFilterUser','searchFilterChannel','searchFilterAfter','searchFilterBefore'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', _triggerSearch);
    document.getElementById(id)?.addEventListener('input',  _triggerSearch);
  });
  document.getElementById('searchFilterClearBtn')?.addEventListener('click', () => {
    ['searchFilterUser','searchFilterAfter','searchFilterBefore'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const sel = document.getElementById('searchFilterChannel'); if (sel) sel.value = '';
    _triggerSearch();
  });
  document.getElementById('searchOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSearch();
  });

  // Thread
  document.getElementById('closeThreadBtn').addEventListener('click', closeThread);
  document.getElementById('threadSendBtn').addEventListener('click', sendThreadReply);
  document.getElementById('threadInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendThreadReply(); }
  });
  document.getElementById('threadInput').addEventListener('input', () => {
    const t = document.getElementById('threadInput');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 80) + 'px';
  });

  // Schedule
  document.getElementById('scheduleBtn').addEventListener('click', openScheduleModal);
  document.getElementById('cancelSchedBtn').addEventListener('click', () =>
    document.getElementById('scheduleOverlay').classList.add('hidden'));
  document.getElementById('createSchedBtn').addEventListener('click', createScheduled);

  // Pinned bar toggle
  document.getElementById('pinnedBadge').addEventListener('click', togglePinnedBar);

  // Auto-resize textarea + @mention detection
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + 'px';
    handleMentionInput();
  });

  // New features
  initPushNotifications();
  initPollHandlers();
  initProfileHandlers();
  initBookmarksHandlers();
  initInviteHandlers();
  initForwardHandlers();
  initCategoryHandlers();
  loadNotifPrefs();
  initMuteHandler();
  initGalleryHandlers();
  initVoiceHandlers();
  initThemeToggle();
  initPresenceSelector();
  initNewFeatureHandlers();
  initKeyboardShortcuts();
  initUnreadJump();
  initMobileSidebar();
  initNotificationSounds();
  initReminderPoll();
  initNewFeatureHandlers2();

  // @mention dropdown keyboard nav
  document.getElementById('mentionDropdown').addEventListener('mousedown', e => {
    const item = e.target.closest('.mention-item');
    if (item) { e.preventDefault(); completeMention(item.dataset.name); }
  });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  ws = new WebSocket(`${WSS}/ws/chat/${user.id}?token=${token}`);

  ws.onopen  = () => console.log('[chat-ws] connected');
  ws.onclose = () => { console.log('[chat-ws] disconnected'); setTimeout(connectWS, 3000); };
  ws.onerror = e => console.error('[chat-ws] error', e);
  ws.onmessage = e => {
    try { handleServerMsg(JSON.parse(e.data)); } catch(err) { console.warn(err); }
  };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Handle server messages ────────────────────────────────────────────────────
function handleServerMsg(msg) {
  switch (msg.type) {

    case 'channel_message': {
      const m = msg.message;
      if (activeType === 'channel' && activeId === m.channel_id) {
        const wrap = document.getElementById('messagesWrap');
        const wasAtBottom = !wrap || wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120;
        appendMessage(m, false);
        if (wasAtBottom) scrollToBottom();
        else notifyUnread();
      } else {
        unread[m.channel_id] = (unread[m.channel_id] || 0) + 1;
        updateUnreadBadge(m.channel_id);
      }
      // Auto-open URL if Volt recurring task / webhook includes one
      if (msg.open_url && m.bot_name) {
        // open_url_for_uid absent → everyone; present → only that user
        const forUid = msg.open_url_for_uid;
        if (forUid === undefined || forUid === null || forUid === user.id) {
          window.open(msg.open_url, '_blank', 'noopener,noreferrer');
        }
      }
      // Desktop notification for Volt automated messages
      if (m.bot_name === 'Volt') {
        maybePushNotif('\u26a1 Volt', m.content || 'Automated message');
      }
      // @mention desktop notification for this user
      if (m.sender_id !== user.id && m.content && user.name) {
        const isMuted = notifPrefs[m.channel_id]?.muted;
        if (!isMuted && m.content.toLowerCase().includes('@' + user.name.toLowerCase())) {
          maybePushNotif(`\uD83D\uDD14 ${m.sender_name} mentioned you`, m.content.slice(0, 100));
        }
      }
      break;
    }

    case 'dm': {
      const m  = msg.message;
      const other = m.sender_id === user.id ? m.dm_to_user_id : m.sender_id;
      if (activeType === 'dm' && activeId === other) {
        appendMessage(m, false);
        scrollToBottom();
      } else if (m.sender_id !== user.id) {
        unread[`dm_${other}`] = (unread[`dm_${other}`] || 0) + 1;
        updateDmBadge(other);
      }
      // Push notification for incoming DMs
      if (m.sender_id !== user.id) {
        maybePushNotif(m.sender_name, m.content || '📎 File');
      }
      break;
    }

    case 'typing': {
      const who     = msg.user_name;
      const chanId  = msg.channel_id;
      const toUid   = msg.to_user_id;
      const key     = chanId ? `ch_${chanId}` : `dm_${msg.user_id}`;
      const relevant = (chanId && activeType === 'channel' && activeId === chanId)
                    || (toUid && activeType === 'dm' && activeId === msg.user_id);
      if (!relevant) break;
      typingBar.textContent = `${who} is typing…`;
      clearTimeout(typingTimers[key]);
      typingTimers[key] = setTimeout(() => { typingBar.textContent = ''; }, 3000);
      break;
    }

    case 'reaction_update': {
      const pill = document.querySelector(`[data-msg-id="${msg.message_id}"] .reactions-row`);
      if (pill) renderReactions(pill.parentElement.querySelector('[data-msg-id]') || pill.parentElement, msg.message_id, msg.reactions);
      // re-render reactions row in place
      const msgEl = document.querySelector(`[data-msg-id="${msg.message_id}"]`);
      if (msgEl) {
        let rr = msgEl.querySelector('.reactions-row');
        if (!rr) { rr = document.createElement('div'); rr.className = 'reactions-row'; msgEl.appendChild(rr); }
        buildReactionRow(rr, msg.message_id, msg.reactions);
      }
      break;
    }

    case 'presence': {
      if (dmUsers[msg.user_id]) {
        dmUsers[msg.user_id].online = msg.online;
        updateDmDot(msg.user_id, msg.online);
      }
      break;
    }

    case 'channel_deleted': {
      channels = channels.filter(c => c.id !== msg.channel_id);
      if (activeType === 'channel' && activeId === msg.channel_id) {
        messagesWrap.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;padding:40px;text-align:center;">This channel was deleted.</div>';
        chatTitle.textContent = '';
        chatDesc.textContent  = '';
        activeId = null;
      }
      renderChannelList();
      showToast('Channel deleted');
      break;
    }

    case 'message_deleted': {
      const el = document.querySelector(`[data-msg-id="${msg.message_id}"]`);
      if (el) {
        const group = el.closest('.msg-group');
        el.remove();
        // Remove group if it has no more bubbles
        if (group && !group.querySelector('.msg-bubble')) group.remove();
      }
      break;
    }

    case 'pin_update': {
      const msgEl = document.querySelector(`[data-msg-id="${msg.message_id}"]`);
      if (msgEl) {
        const btn = msgEl.querySelector('.pin-msg-btn');
        if (btn) { btn.title = msg.pinned ? 'Unpin' : 'Pin'; btn.style.color = msg.pinned ? 'var(--purple-l)' : ''; }
        if (msg.pinned) msgEl.dataset.pinned = '1'; else delete msgEl.dataset.pinned;
      }
      // Always reload pinned bar — covers remote pin/unpin for all users
      if (activeType === 'channel' && activeId) loadPinnedMessages(activeId);
      break;
    }

    case 'thread_reply': {
      const m = msg.message;
      if (threadParentId === m.parent_id) {
        appendThreadMsg(m);
        const tm = document.getElementById('threadMsgs');
        tm.scrollTop = tm.scrollHeight;
      }
      // Increment reply count badge on parent bubble
      const parentEl = document.querySelector(`[data-msg-id="${m.parent_id}"]`);
      if (parentEl) {
        let rb = parentEl.querySelector('.reply-count');
        const cur = parseInt(rb?.dataset.count || '0') + 1;
        if (!rb) { rb = document.createElement('button'); rb.className = 'reply-count react-btn'; rb.onclick = () => openThreadById(m.parent_id); parentEl.appendChild(rb); }
        rb.dataset.count = cur;
        rb.textContent = `🧵 ${cur} repl${cur === 1 ? 'y' : 'ies'}`;
      }
      break;
    }

    case 'dm_read': {
      // Mark last self-sent bubble with a "Seen" indicator
      if (activeType === 'dm') {
        const allBubbles = messagesWrap.querySelectorAll('[data-sender-self="1"]');
        if (allBubbles.length) {
          const last = allBubbles[allBubbles.length - 1];
          if (!last.querySelector('.seen-receipt')) {
            const rc = document.createElement('div');
            rc.className = 'seen-receipt';
            rc.style.cssText = 'font-size:.68rem;color:var(--text-muted);text-align:right;margin-top:2px;';
            rc.textContent = '✓✓ Seen';
            last.appendChild(rc);
          }
        }
      }
      break;
    }

    case 'poll_created': {
      const p = msg.poll;
      const isMyChannel = activeType === 'channel' && activeId === p.channel_id;
      const isMyDm      = activeType === 'dm' && (activeId === p.creator_id || activeId === p.dm_to_user_id);
      if (isMyChannel || isMyDm) {
        appendPollCard(p);
        scrollToBottom();
      }
      break;
    }

    case 'poll_update': {
      const card = document.querySelector(`[data-poll-id="${msg.poll.id}"]`);
      if (card) updatePollCard(card, msg.poll);
      break;
    }

    case 'error': {
      showToast(msg.message || 'Error', 'error');
      break;
    }

    case 'slowmode_update': {
      const ch = channels.find(c => c.id === msg.channel_id);
      if (ch) ch.slowmode_seconds = msg.seconds;
      if (activeType === 'channel' && activeId === msg.channel_id) {
        _updateSlowmodeBar(msg.seconds);
      }
      break;
    }

    case 'moderation': {
      const action = msg.action;
      if (action === 'banned') {
        showToast('You have been banned from SyncTact.', 'error');
        setTimeout(() => { localStorage.removeItem('synctact_token'); localStorage.removeItem('synctact_user'); window.location.href = 'index.html'; }, 2000);
      } else if (action === 'kicked') {
        showToast(`You were removed from this channel by ${msg.by}.`, 'error');
        if (activeType === 'channel' && activeId === msg.channel_id) {
          messagesWrap.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;padding:40px;text-align:center;">You have been removed from this channel.</div>';
          activeId = null;
        }
      } else if (action === 'muted') {
        const untilStr = msg.until ? ` until ${new Date(msg.until).toLocaleTimeString()}` : ' permanently';
        showToast(`You have been muted${untilStr} by ${msg.by}.`, 'error');
      }
      break;
    }

    case 'message_edit': {
      const m = msg.message;
      const bubble = messagesWrap.querySelector(`[data-msg-id="${m.id}"]`);
      if (bubble) {
        // Update text span
        const textEl = bubble.querySelector('.msg-text');
        if (textEl) textEl.innerHTML = renderMentions(esc(m.content));
        // Add/update edited label
        let editedEl = bubble.querySelector('.edited-label');
        if (!editedEl) {
          editedEl = document.createElement('span');
          editedEl.className = 'edited-label';
          const textSpan = bubble.querySelector('.msg-text');
          if (textSpan) textSpan.after(editedEl);
        }
        editedEl.textContent = '(edited)';
        bubble.dataset.msgContent = m.content;
      }
      break;
    }

    case 'user_status': {
      // Update DM list entry
      const uid = msg.user_id;
      if (dmUsers[uid]) {
        if (msg.name)       dmUsers[uid].name       = msg.name;
        if (msg.status !== undefined) dmUsers[uid].status    = msg.status;
        if (msg.avatar_url !== undefined) dmUsers[uid].avatar_url = msg.avatar_url;
        renderDmList();
      }
      break;
    }

    case 'call_started': {
      if (activeType === 'channel' && activeId === msg.channel_id) {
        const bar = document.getElementById('callBar');
        if (bar) {
          document.getElementById('callBarText').textContent = `${msg.started_name} started a call`;
          const joinBtn = document.getElementById('callJoinBtn');
          if (joinBtn) joinBtn.onclick = () => window.open(`/meeting.html?room=${msg.room_code}&name=${encodeURIComponent(user.name)}&back=chat.html`, '_blank');
          bar.classList.add('visible');
        }
        playSound('callIn');
      }
      showToast(`📞 ${msg.started_name} started a call in #${channels.find(c=>c.id===msg.channel_id)?.name||'channel'}`);
      break;
    }

    case 'call_ended': {
      if (activeType === 'channel' && activeId === msg.channel_id) {
        document.getElementById('callBar')?.classList.remove('visible');
      }
      break;
    }

    case 'system_msg': {
      // Inline system notification (e.g. reminder set confirmation)
      const div = document.createElement('div');
      div.style.cssText = 'text-align:center;font-size:.75rem;color:var(--text-muted);padding:6px 0;font-style:italic;';
      div.textContent = msg.message;
      messagesWrap?.appendChild(div);
      break;
    }

    case 'task_created':
    case 'task_updated':
    case 'task_deleted': {
      handleTaskWsEvent(msg);
      break;
    }

    case 'level_up': {
      if (msg.channel_id === activeId || activeType === 'channel') {
        showToast(`🎉 ${msg.user_name} reached Level ${msg.level}!`, 'info', 5000);
        if (messagesWrap) {
          const div = document.createElement('div');
          div.className = 'level-up-notif';
          div.innerHTML = `🎉 <strong>${esc(msg.user_name)}</strong> leveled up to <span class="level-badge">Lvl ${msg.level}</span>!`;
          messagesWrap.appendChild(div);
          messagesWrap.scrollTop = messagesWrap.scrollHeight;
        }
      }
      break;
    }
  }
}

// ── Channels ──────────────────────────────────────────────────────────────────
async function loadChannels() {
  const res = await authFetch('/chat/channels');
  if (!res.ok) return;
  channels = await res.json();
  renderChannelList();
}

// renderChannelList is defined later (with category support)

async function openChannel(ch) {
  saveDraft();
  activeType  = 'channel';
  activeId    = ch.id;
  activeDmName = '';
  unread[ch.id] = 0;
  chatTitle.textContent  = ch.name;
  chatDesc.textContent   = ch.description || '';
  msgInput.placeholder   = `Message ${ch.name}`;
  messagesWrap.innerHTML = '<div style="color:var(--text-muted);font-size:.8rem;padding:20px 0;">Loading…</div>';
  renderChannelList();
  // Show invite button for channel owners or system channels
  const inviteBtn = document.getElementById('inviteBtn');
  if (inviteBtn) inviteBtn.style.display = '';
  // Show gallery and mute buttons
  const galleryBtn = document.getElementById('galleryBtn');
  if (galleryBtn) galleryBtn.style.display = '';
  const muteBtn = document.getElementById('muteChannelBtn');
  if (muteBtn) {
    muteBtn.style.display = '';
    const isMuted = notifPrefs[ch.id]?.muted;
    muteBtn.innerHTML = isMuted ? '<i class="fa-solid fa-bell-slash"></i>' : '<i class="fa-regular fa-bell"></i>';
    muteBtn.title = isMuted ? 'Unmute notifications' : 'Mute notifications for this channel';
  }
  // Always show Volt toggle in channels (server enforces ownership on broadcast)
  if (voltTargetBtn) {
    voltTargetBtn.style.display = '';
    _updateVoltTargetBtn();
  }
  // Show new buttons for channel context
  ['membersBtn', 'webhooksHeaderBtn', 'exportBtn', 'fileBrowserBtn',
   'summarizeBtn', 'analyticsChannelBtn', 'taskBoardBtn', 'meetingSummaryBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  });
  // startCallBtn uses flex for stacked icon+label
  const callBtn = document.getElementById('startCallBtn');
  if (callBtn) callBtn.style.display = 'flex';
  // Show header divider and overflow section divider
  const hDiv = document.getElementById('headerDivider');
  if (hDiv) hDiv.style.display = '';
  const oDiv = document.getElementById('overflowDiv1');
  if (oDiv) oDiv.style.display = '';
  // Readonly / archived channel UI
  const readonlyBar = document.getElementById('readonlyBar');
  const msgInputEl  = document.getElementById('msgInput');
  const sendBtnEl   = document.getElementById('sendBtn');
  if (ch.archived) {
    chatTitle.textContent = '🗃 ' + ch.name + ' [archived]';
    if (readonlyBar) { readonlyBar.textContent = '🗃 This channel has been archived.'; readonlyBar.classList.add('visible'); }
    if (msgInputEl) { msgInputEl.disabled = true; msgInputEl.placeholder = 'Channel archived'; }
    if (sendBtnEl)  sendBtnEl.disabled = true;
  } else if (ch.readonly && user.role === 'member') {
    if (readonlyBar) { readonlyBar.innerHTML = '<i class="fa-solid fa-lock"></i> This channel is read-only — only moderators can post.'; readonlyBar.classList.add('visible'); }
    if (msgInputEl) { msgInputEl.disabled = true; msgInputEl.placeholder = 'Read-only channel'; }
    if (sendBtnEl)  sendBtnEl.disabled = true;
  } else {
    if (readonlyBar)  readonlyBar.classList.remove('visible');
    if (msgInputEl) { msgInputEl.disabled = false; msgInputEl.placeholder = `Message ${ch.name}`; }
    if (sendBtnEl)  sendBtnEl.disabled = false;
  }
  // Reset call bar on channel switch
  document.getElementById('callBar')?.classList.remove('visible');
  // Restore draft
  restoreDraft();
  // Mood board mode
  applyMoodBoardMode(ch.channel_type === 'moodboard');
  await Promise.all([loadMessages('channel', ch.id), loadPinnedMessages(ch.id), loadChannelPolls(ch.id)]);
  _updateSlowmodeBar(ch.slowmode_seconds || 0);
  // 1-second auto-refresh for pinned badge (instant fallback if WS misses an event)
  clearInterval(_pinnedPollTimer);
  _pinnedPollTimer = setInterval(() => {
    if (activeType === 'channel' && activeId === ch.id) loadPinnedMessages(ch.id);
    else clearInterval(_pinnedPollTimer);
  }, 1000);
}

// ── DMs ───────────────────────────────────────────────────────────────────────
async function loadUsers() {
  const res = await authFetch('/chat/users');
  if (!res.ok) return;
  allUsers = await res.json();
  allUsers.forEach(u => {
    dmUsers[u.id] = { name: u.name, online: false, avatar_url: u.avatar_url, status: u.status };
  });
  renderDmList();
}

function renderDmList() {
  dmListEl.innerHTML = '';
  Object.entries(dmUsers).forEach(([uid, info]) => {
    const li = document.createElement('li');
    const numId = parseInt(uid);
    li.className = `ch-item${activeType === 'dm' && activeId === numId ? ' active' : ''}`;
    li.dataset.uid = uid;
    const initial = info.name.charAt(0).toUpperCase();
    const badge   = unread[`dm_${uid}`] ? `<span class="ch-badge">${unread[`dm_${uid}`]}</span>` : '';
    const statusText = info.status ? `<span style="font-size:.65rem;color:var(--text-muted);margin-left:4px;">${esc(info.status)}</span>` : '';
    const avatarInner = info.avatar_url
      ? `<img class="dm-avatar-img" src="${API + info.avatar_url}" alt="" />`
      : initial;
    li.innerHTML = `
      <div class="dm-avatar">${avatarInner}<span class="dm-dot${info.online ? ' online' : ''}"></span></div>
      <span class="ch-name">${esc(info.name)}</span>${statusText}${badge}`;
    li.addEventListener('click', () => openDm(numId, info.name));
    dmListEl.appendChild(li);
  });
}

async function openDm(uid, name) {
  saveDraft();
  activeType   = 'dm';
  activeId     = uid;
  activeDmName = name;
  unread[`dm_${uid}`] = 0;
  chatTitle.textContent  = `@ ${name}`;
  chatDesc.textContent   = '';
  msgInput.placeholder   = `Message ${name}`;
  messagesWrap.innerHTML = '<div style="color:var(--text-muted);font-size:.8rem;padding:20px 0;">Loading…</div>';
  renderDmList();
  // Stop pinned poll and hide pinned bar (DMs don't have pinned)
  clearInterval(_pinnedPollTimer);
  _pinnedPollTimer = null;
  if (voltTargetBtn) voltTargetBtn.style.display = 'none';
  // Hide all channel-context header buttons + dividers when in DM
  ['inviteBtn','membersBtn','galleryBtn','muteChannelBtn','webhooksHeaderBtn',
   'exportBtn','startCallBtn','fileBrowserBtn','headerDivider','overflowDiv1',
   'summarizeBtn','analyticsChannelBtn','taskBoardBtn','meetingSummaryBtn'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  const badge = document.getElementById('pinnedBadge');
  const bar   = document.getElementById('pinnedBar');
  badge.classList.add('hidden');
  bar.classList.add('hidden');
  bar.innerHTML = '';
  await loadMessages('dm', uid);
  restoreDraft();
  // Notify sender that messages were read
  wsSend({ type: 'mark_dm_read', to_user_id: uid });
}

function updateDmDot(uid, online) {
  const dot = dmListEl.querySelector(`li[data-uid="${uid}"] .dm-dot`);
  if (dot) dot.classList.toggle('online', online);
}

function updateDmBadge(uid) {
  renderDmList();
}

function updateUnreadBadge(cid) {
  renderChannelList();
}

// ── Messages ──────────────────────────────────────────────────────────────────
async function loadMessages(type, id) {
  const url = type === 'channel' ? `/chat/channels/${id}/messages` : `/chat/dm/${id}/messages`;
  const res  = await authFetch(url);
  if (!res.ok) { messagesWrap.innerHTML = ''; return; }
  const msgs = await res.json();
  // Guard: discard stale responses if the user has already switched context
  const stillActive = (type === 'channel' && activeType === 'channel' && activeId === id)
                   || (type === 'dm'      && activeType === 'dm'      && activeId === id);
  if (!stillActive) return;
  messagesWrap.innerHTML = '';
  if (!msgs.length) {
    messagesWrap.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;padding:20px 0;text-align:center;">No messages yet. Say hello! 👋</div>';
    return;
  }
  msgs.forEach(m => appendMessage(m, true));
  scrollToBottom();
}

function appendMessage(m, initial) {
  const wrap = messagesWrap;
  // Mood board: render as image card instead of normal message
  if (wrap.classList.contains('moodboard-grid')) {
    const card = renderMoodBoardMessage(m);
    if (card) { wrap.appendChild(card); return; }
    // Non-image messages in moodboard are skipped silently
    return;
  }
  // Group by sender + within 5 min (also keep bot names separate)
  const last = wrap.lastElementChild;
  const lastSenderId = last?.dataset?.senderId;
  const lastBotName  = last?.dataset?.botName || '';
  const lastTs       = last?.dataset?.ts ? parseInt(last.dataset.ts) : 0;
  const thisTsMs     = new Date(m.ts).getTime();
  const thisBotName  = m.bot_name || '';
  const grouped      = lastSenderId === String(m.sender_id) && (thisTsMs - lastTs) < 5 * 60 * 1000 && lastBotName === thisBotName;

  if (!grouped) {
    const group = document.createElement('div');
    group.className        = 'msg-group';
    if (m.bot_name) group.classList.add('bot-group');
    group.dataset.senderId = m.sender_id;
    group.dataset.botName  = thisBotName;
    group.dataset.ts       = thisTsMs;
    const botBadge = m.bot_name ? `<span class="bot-badge">BOT</span>` : '';
    const ephemeralNote = m.ephemeral ? `<span style="font-size:.7rem;color:var(--text-muted);margin-left:6px;font-style:italic;">\uD83D\uDC41\uFE0F Only visible to you</span>` : '';
    // Avatar
    const senderUser = allUsers.find(u => u.id === m.sender_id) || {};
    const senderInitial = (m.sender_name || '?').charAt(0).toUpperCase();
    const avatarHtml = senderUser.avatar_url
      ? `<div class="msg-sender-avatar"><img src="${API + senderUser.avatar_url}" alt="" /></div>`
      : `<div class="msg-sender-avatar" style="background:var(--purple);">${senderInitial}</div>`;
    const titleBadge = (!m.bot_name && senderUser.title) ? `<span class="user-title-badge">${esc(senderUser.title)}</span>` : '';
    const nameClickable = !m.bot_name
      ? `<span class="msg-name" style="cursor:pointer;" onclick="openProfileModal(${m.sender_id})">${esc(m.sender_name)}${botBadge}${ephemeralNote}</span>${titleBadge}`
      : `<span class="msg-name">${esc(m.sender_name)}${botBadge}${ephemeralNote}</span>`;
    group.innerHTML = `
      <div class="msg-header" style="display:flex;align-items:center;gap:8px;">
        ${avatarHtml}
        ${nameClickable}
        <span class="msg-time">${formatTime(m.ts)}</span>
      </div>`;
    wrap.appendChild(group);
  }

  const group = wrap.lastElementChild;
  const bubble  = document.createElement('div');
  bubble.className       = 'msg-bubble';
  bubble.dataset.msgId   = m.id;
  bubble.dataset.msgSender  = m.sender_name;
  bubble.dataset.msgContent = m.content || '';
  bubble.dataset.msgTs      = m.ts;
  bubble.dataset.channelId  = m.channel_id || '';
  bubble.dataset.dmUid      = m.dm_to_user_id || '';
  if (m.pinned)    bubble.dataset.pinned   = '1';
  if (m.parent_id) bubble.dataset.parentId = m.parent_id;

  let inner = '';
  if (m.forwarded_from) inner += `<span class="forwarded-label"><i class="fa-solid fa-share"></i> Forwarded</span>`;
  if (m.content) inner += `<span class="msg-text">${renderMentions(typeof renderMarkdown === 'function' ? renderMarkdown(m.content) : esc(m.content))}</span>`;
  if (m.edited)  inner += `<span class="edited-label">(edited)</span>`;
  if (m.file_url) {
    const fullUrl   = API + m.file_url;
    const isImage   = /\.(png|jpg|jpeg|gif|webp|svg|bmp|avif)$/i.test(m.file_url);
    const isVideo   = /\.(mp4|webm|mov)$/i.test(m.file_url);
    const isAudio   = /\.(mp3|ogg|wav|m4a|webm)$/i.test(m.file_url) && !isVideo;
    const isVoiceMsg = /voice-\d+\.webm$/i.test(m.file_url);
    if (isVoiceMsg || isAudio) {
      inner += `<div class="voice-bubble"><audio src="${fullUrl}" controls preload="metadata"></audio></div>`;
    } else if (isImage) {
      inner += `<a href="${fullUrl}" target="_blank"><img class="msg-img" src="${fullUrl}" alt="${esc(m.file_name||'image')}" /></a>`;
    } else if (isVideo) {
      inner += `<video class="msg-img" src="${fullUrl}" controls preload="metadata" style="max-width:100%;border-radius:8px;"></video>`;
    } else {
      inner += `<a class="msg-file" href="${fullUrl}" target="_blank" download="${esc(m.file_name||'file')}"><i class="fa-solid fa-file"></i>${esc(m.file_name||'file')}</a>`;
    }
  }
  // Show pin button only to channel owner (created_by === 0 means seeded/system channel — anyone can pin)
  const activeChannel = activeType === 'channel' ? channels.find(c => c.id === activeId) : null;
  const canPin = activeType === 'dm' || !activeChannel || activeChannel.created_by === 0 || activeChannel.created_by === user.id;

  const isSender = m.sender_id === user.id;
  const canDelete = isSender || m.bot_name; // anyone can delete bot messages
  if (isSender) bubble.dataset.senderSelf = '1';

  // Ephemeral messages have no DB id — skip interactive actions
  if (m.id !== null && m.id !== undefined) {
    inner += `<span class="msg-actions">
    <button class="react-btn" onclick="openReactionPicker(event,${m.id})" title="React">😊</button>
    ${canPin ? `<button class="react-btn pin-msg-btn" onclick="togglePin(${m.id})" title="${m.pinned ? 'Unpin' : 'Pin'}"${m.pinned ? ' style="color:var(--purple-l)"' : ''}>📌</button>` : ''}
    <button class="react-btn" onclick="openThreadById(${m.id})" title="Reply in thread">🧵</button>
    <button class="react-btn" onclick="bookmarkMessage(${m.id})" title="Bookmark">🔖</button>
    <button class="react-btn" onclick="openForwardModal(${m.id})" title="Forward">↪️</button>
    ${isSender && !m.bot_name ? `<button class="react-btn" onclick="startEditMessage(${m.id})" title="Edit">✏️</button>` : ''}
    ${canDelete ? `<button class="react-btn del-msg-btn" onclick="deleteMessage(${m.id})" title="Delete message">🗑️</button>` : ''}
    ${(activeChannel && activeChannel.created_by === user.id && !isSender && !m.bot_name) ? `<button class="mod-btn" onclick="kickUser(${m.sender_id},${m.channel_id})" title="Kick from channel">🥢</button><button class="mod-btn" onclick="muteUser(${m.sender_id},${m.channel_id})" title="Mute in channel">🔇</button>` : ''}
    ${(!isSender && !m.bot_name) ? `<button class="react-btn ctx-block" onclick="blockUser(${m.sender_id},'${(m.sender_name||'').replace(/'/g,'\\\'')}')" title="Block user"><i class="fa-solid fa-ban"></i></button>` : ''}
  </span>`;
  }
  inner += `<div class="reactions-row"></div>`;
  bubble.innerHTML = inner;

  if (m.id !== null && m.id !== undefined) {
    buildReactionRow(bubble.querySelector('.reactions-row'), m.id, m.reactions || {});
  }
  group.appendChild(bubble);
  // Async link preview for message text
  if (m.content && !m.bot_name) fetchLinkPreviews(bubble, m.content);
}

function buildReactionRow(rowEl, msgId, reactions) {
  rowEl.innerHTML = '';
  Object.entries(reactions).forEach(([emoji, users]) => {
    if (!users.length) return;
    const mine = users.includes(user.id);
    const pill = document.createElement('button');
    pill.className = `reaction-pill${mine ? ' mine' : ''}`;
    pill.innerHTML = `${emoji} <span class="reaction-count">${users.length}</span>`;
    pill.onclick   = () => wsSend({ type: 'react', message_id: msgId, emoji });
    rowEl.appendChild(pill);
  });
}

function openReactionPicker(e, msgId) {
  e.stopPropagation();
  emojiTarget = msgId;
  // Position picker near button
  emojiPickerEl.style.left   = Math.min(e.clientX, window.innerWidth - 320) + 'px';
  emojiPickerEl.style.top    = (e.clientY - 200) + 'px';
  emojiPickerEl.style.bottom = 'auto';
  emojiPickerEl.classList.remove('hidden');
}

// ── Send message ──────────────────────────────────────────────────────────────
async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !activeId) return;

  hideSlashDropdown();

  // Slash command interception
  if (text.startsWith('/')) {
    msgInput.value = '';
    msgInput.style.height = 'auto';
    await executeSlashCommand(text);
    return;
  }

  const payload = { content: text };
  if (activeType === 'channel') {
    payload.type       = 'channel_message';
    payload.channel_id = activeId;
  } else {
    payload.type        = 'dm';
    payload.to_user_id  = activeId;
  }
  wsSend(payload);
  msgInput.value = '';
  msgInput.style.height = 'auto';
}

// ── Slash commands ────────────────────────────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: '/help',      icon: '❓', desc: 'List all available commands' },
  { cmd: '/meet',      icon: '📹', desc: 'Create a meeting room link' },
  { cmd: '/poll',      icon: '📊', desc: '/poll Question | Option1 | Option2' },
  { cmd: '/roll',      icon: '🎲', desc: '/roll [max] — roll a random number' },
  { cmd: '/coin',      icon: '🪙', desc: 'Flip a coin' },
  { cmd: '/remind',    icon: '⏰', desc: '/remind 10m Your reminder text' },
  { cmd: '/task',      icon: '✅', desc: '/task <title> — add a task to the board' },
  { cmd: '/focus',     icon: '🌙', desc: '/focus [minutes] — enable focus mode' },
  { cmd: '/announce',  icon: '📣', desc: '/announce <text> — post an announcement (mod)' },
  { cmd: '/lock',      icon: '🔒', desc: 'Set channel to read-only (mod/admin)' },
  { cmd: '/unlock',    icon: '🔓', desc: 'Remove channel read-only (mod/admin)' },
  { cmd: '/purge',     icon: '🗑️', desc: '/purge [1-100] — delete last N messages (mod)' },
  { cmd: '/pin',       icon: '📌', desc: '/pin last — pin the most recent message' },
  { cmd: '/slowmode',  icon: '🐢', desc: '/slowmode <seconds> — set slowmode (0 to disable)' },
  { cmd: '/warn',      icon: '⚠️', desc: '/warn @user <reason> — issue a warning (mod)' },
  { cmd: '/mute',      icon: '🔇', desc: '/mute @user [minutes] — mute a user (mod)' },
  { cmd: '/kick',      icon: '👢', desc: '/kick @user — remove user from channel (mod)' },
  { cmd: '/ban',       icon: '🔨', desc: '/ban @user — ban user from server (admin)' },
  { cmd: '/userinfo',  icon: '🪪', desc: '/userinfo [@user] — show user profile & stats' },
  { cmd: '/serverinfo',icon: '🖥️', desc: 'Show server stats' },
  { cmd: '/giphy',     icon: '🎞️', desc: '/giphy search term — post a GIF' },
  { cmd: '/weather',   icon: '🌤️', desc: '/weather city — current weather' },
  { cmd: '/8ball',     icon: '🎱', desc: '/8ball question — magic 8-ball answer' },
  { cmd: '/trivia',    icon: '🧠', desc: '/trivia — get a random trivia question' },
  { cmd: '/news',      icon: '📰', desc: '/news topic — latest news summary' },
  { cmd: '/gallery',   icon: '🖼️', desc: '/gallery — open image gallery for this channel' },
];

let slashActiveIdx = 0;
const slashDropdownEl = document.getElementById('slashDropdown');

function showSlashDropdown(val) {
  const typed  = val.toLowerCase();
  const matches = SLASH_COMMANDS.filter(c => c.cmd.startsWith(typed) || typed === '/');
  if (!matches.length) { hideSlashDropdown(); return; }
  slashActiveIdx = 0;
  slashDropdownEl.innerHTML = '';
  matches.forEach((c, i) => {
    const item = document.createElement('div');
    item.className = `slash-cmd-item${i === 0 ? ' active' : ''}`;
    item.innerHTML = `<span class="slash-cmd-icon">${c.icon}</span>
                      <span class="slash-cmd-name">${c.cmd}</span>
                      <span class="slash-cmd-desc">${c.desc}</span>`;
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      msgInput.value = c.cmd + ' ';
      msgInput.focus();
      hideSlashDropdown();
    });
    slashDropdownEl.appendChild(item);
  });
  slashDropdownEl.classList.remove('hidden');
}

function hideSlashDropdown() {
  slashDropdownEl.classList.add('hidden');
  slashActiveIdx = 0;
}

function slashSelectDelta(delta) {
  const items = slashDropdownEl.querySelectorAll('.slash-cmd-item');
  if (!items.length) return;
  items[slashActiveIdx]?.classList.remove('active');
  slashActiveIdx = (slashActiveIdx + delta + items.length) % items.length;
  items[slashActiveIdx]?.classList.add('active');
  items[slashActiveIdx]?.scrollIntoView({ block: 'nearest' });
}

async function _postVolt(content) {
  const target = getVoltTarget();
  const body = { content, bot_name: 'Volt', volt_target: target };
  if (activeType === 'channel') body.channel_id    = activeId;
  else                          body.dm_to_user_id = activeId;

  if (target === 'self' && activeType === 'channel') {
    // Ephemeral: show locally only, no server round-trip needed
    const fakeMsg = {
      id: null, channel_id: activeId, dm_to_user_id: null,
      sender_id: 0, sender_name: 'Volt', content, bot_name: 'Volt',
      file_url: null, file_name: null, reactions: {}, pinned: false,
      parent_id: null, ts: new Date().toISOString(), ephemeral: true,
    };
    appendMessage(fakeMsg, false);
    scrollToBottom();
    return;
  }
  // DM or channel-wide: go through server
  await authFetch('/chat/syncbot', 'POST', body);
}

async function executeSlashCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();

  if (cmd === '/coin') {
    const result = Math.random() < 0.5 ? '🪙 Heads!' : '🪙 Tails!';
    await _postVolt(result);
    return;
  }

  // ── /help ──────────────────────────────────────────────────
  if (cmd === '/help') {
    const lines = SLASH_COMMANDS.map(c => `${c.icon} **${c.cmd}** — ${c.desc}`).join('\n');
    await _postVolt(`📖 **Volt Commands**\n\n${lines}`);
    return;
  }

  // ── /announce ──────────────────────────────────────────────
  if (cmd === '/announce') {
    if (activeType !== 'channel') { showToast('Open a channel first'); return; }
    if (user.role === 'member') { showToast('⛔ Moderators only'); return; }
    const text = parts.slice(1).join(' ').trim();
    if (!text) { showToast('Usage: /announce <text>'); return; }
    await authFetch('/chat/syncbot', {
      method: 'POST',
      body: JSON.stringify({
        content: `📣 **ANNOUNCEMENT** 📣\n\n${text}`,
        bot_name: 'Volt', channel_id: activeId, volt_target: 'channel'
      })
    });
    return;
  }

  // ── /lock ──────────────────────────────────────────────────
  if (cmd === '/lock') {
    if (activeType !== 'channel') { showToast('Open a channel first'); return; }
    if (user.role === 'member') { showToast('⛔ Moderators only'); return; }
    const res = await authFetch(`/channels/${activeId}/settings`, {
      method: 'PATCH', body: JSON.stringify({ readonly: true })
    });
    if (res.ok) showToast('🔒 Channel locked (read-only)');
    else showToast('Failed to lock channel', 'error');
    return;
  }

  // ── /unlock ────────────────────────────────────────────────
  if (cmd === '/unlock') {
    if (activeType !== 'channel') { showToast('Open a channel first'); return; }
    if (user.role === 'member') { showToast('⛔ Moderators only'); return; }
    const res = await authFetch(`/channels/${activeId}/settings`, {
      method: 'PATCH', body: JSON.stringify({ readonly: false })
    });
    if (res.ok) showToast('🔓 Channel unlocked');
    else showToast('Failed to unlock channel', 'error');
    return;
  }

  // ── /purge ─────────────────────────────────────────────────
  if (cmd === '/purge') {
    if (activeType !== 'channel') { showToast('Open a channel first'); return; }
    if (user.role === 'member') { showToast('⛔ Moderators only'); return; }
    const n = parseInt(parts[1]) || 10;
    if (!confirm(`Delete the last ${n} messages in this channel?`)) return;
    const res = await authFetch(`/chat/channels/${activeId}/purge?count=${n}`, { method: 'DELETE' });
    if (res.ok) { const d = await res.json(); showToast(`🗑️ Purged ${d.deleted} messages`); }
    else showToast('Purge failed', 'error');
    return;
  }

  // ── /pin last ─────────────────────────────────────────────
  if (cmd === '/pin') {
    if (activeType !== 'channel') { showToast('Open a channel first'); return; }
    const sub = parts[1]?.toLowerCase();
    if (sub !== 'last') { showToast('Usage: /pin last'); return; }
    const bubbles = document.querySelectorAll('[data-msg-id]');
    if (!bubbles.length) { showToast('No messages to pin'); return; }
    const lastId = bubbles[bubbles.length - 1].dataset.msgId;
    const res = await authFetch(`/chat/messages/${lastId}/pin`, { method: 'POST' });
    if (res.ok) showToast('📌 Message pinned');
    else showToast('Pin failed', 'error');
    return;
  }

  // ── /slowmode ─────────────────────────────────────────────
  if (cmd === '/slowmode') {
    if (activeType !== 'channel') { showToast('Open a channel first'); return; }
    if (user.role === 'member') { showToast('⛔ Moderators only'); return; }
    const secs = parseInt(parts[1]) || 0;
    const res = await authFetch(`/chat/channels/${activeId}/slowmode`, {
      method: 'PATCH', body: JSON.stringify({ seconds: secs })
    });
    if (res.ok) showToast(secs > 0 ? `🐢 Slowmode set to ${secs}s` : '⚡ Slowmode disabled');
    else showToast('Failed', 'error');
    return;
  }

  // ── /warn ─────────────────────────────────────────────────
  if (cmd === '/warn') {
    if (user.role === 'member') { showToast('⛔ Moderators only'); return; }
    const mention = parts[1]; // e.g. @username
    const reason  = parts.slice(2).join(' ').trim();
    if (!mention || !reason) { showToast('Usage: /warn @user <reason>'); return; }
    const targetName = mention.replace(/^@/, '').toLowerCase();
    const target = allUsers.find(u => u.name.toLowerCase() === targetName);
    if (!target) { showToast(`User "${targetName}" not found`); return; }
    const res = await authFetch('/mod/warn', {
      method: 'POST',
      body: JSON.stringify({ user_id: target.id, reason, channel_id: activeType === 'channel' ? activeId : null })
    });
    if (res.ok) showToast(`⚠️ Warning issued to ${target.name}`);
    else showToast('Failed to warn user', 'error');
    return;
  }

  // ── /mute ─────────────────────────────────────────────────
  if (cmd === '/mute') {
    if (user.role === 'member') { showToast('⛔ Moderators only'); return; }
    const mention  = parts[1];
    const mins     = parseInt(parts[2]) || null;
    const targetName = mention?.replace(/^@/, '').toLowerCase();
    const target = allUsers.find(u => u.name.toLowerCase() === targetName);
    if (!target) { showToast('Usage: /mute @user [minutes]'); return; }
    const body = { user_id: target.id };
    if (activeType === 'channel') body.channel_id = activeId;
    if (mins) body.minutes = mins;
    const res = await authFetch('/mod/mute', { method: 'POST', body: JSON.stringify(body) });
    if (res.ok) showToast(`🔇 ${target.name} muted${mins ? ` for ${mins}m` : ''}`);
    else showToast('Mute failed', 'error');
    return;
  }

  // ── /kick ─────────────────────────────────────────────────
  if (cmd === '/kick') {
    if (activeType !== 'channel') { showToast('Open a channel first'); return; }
    if (user.role === 'member') { showToast('⛔ Moderators only'); return; }
    const mention    = parts[1];
    const targetName = mention?.replace(/^@/, '').toLowerCase();
    const target = allUsers.find(u => u.name.toLowerCase() === targetName);
    if (!target) { showToast('Usage: /kick @user'); return; }
    const res = await authFetch(`/mod/kick/${target.id}/${activeId}`, { method: 'POST' });
    if (res.ok) showToast(`👢 ${target.name} kicked from channel`);
    else showToast('Kick failed', 'error');
    return;
  }

  // ── /ban ──────────────────────────────────────────────────
  if (cmd === '/ban') {
    if (user.role !== 'admin') { showToast('⛔ Admins only'); return; }
    const mention    = parts[1];
    const targetName = mention?.replace(/^@/, '').toLowerCase();
    const target = allUsers.find(u => u.name.toLowerCase() === targetName);
    if (!target) { showToast('Usage: /ban @user'); return; }
    if (!confirm(`Permanently ban ${target.name}?`)) return;
    const res = await authFetch(`/mod/ban/${target.id}`, { method: 'POST' });
    if (res.ok) showToast(`🔨 ${target.name} banned`);
    else showToast('Ban failed', 'error');
    return;
  }

  // ── /userinfo ─────────────────────────────────────────────
  if (cmd === '/userinfo') {
    const mention    = parts[1];
    const targetName = mention?.replace(/^@/, '').toLowerCase();
    const target = targetName
      ? allUsers.find(u => u.name.toLowerCase() === targetName)
      : allUsers.find(u => u.id === user.id);
    if (!target) { showToast('User not found'); return; }
    const xpRes = await authFetch(`/users/me/xp`);
    const warnRes = await authFetch(`/mod/warnings/${target.id}`);
    const xpData   = xpRes.ok   ? await xpRes.json()  : { xp: 0, level: 1 };
    const warnings = warnRes.ok ? await warnRes.json() : [];
    await _postVolt(
      `🪪 **${target.name}**\n` +
      `${target.title ? '> ' + target.title + '\n' : ''}` +
      `🏅 Level ${xpData.level} · ${xpData.xp} XP\n` +
      `⚠️ Warnings: ${warnings.length}\n` +
      `📅 Joined: ${target.id ? 'User #' + target.id : 'unknown'}`
    );
    return;
  }

  // ── /serverinfo ───────────────────────────────────────────
  if (cmd === '/serverinfo') {
    const lbRes = await authFetch('/users/xp');
    const lb    = lbRes.ok ? await lbRes.json() : [];
    const topUser = lb[0];
    await _postVolt(
      `🖥️ **SyncTact Server**\n` +
      `📢 Channels: ${channels.length}\n` +
      `👥 Members online: ${Object.values(dmUsers).filter(u => u.online).length}\n` +
      `🏆 Top chatter: ${topUser ? topUser.name + ' (Lvl ' + topUser.level + ')' : 'none yet'}`
    );
    return;
  }

  if (cmd === '/task') {
    if (activeType !== 'channel') { showToast('Open a channel to add a task'); return; }
    const title = parts.slice(1).join(' ').trim();
    if (!title) { showToast('Usage: /task <title>'); return; }
    const res = await authFetch('/board-tasks', { method: 'POST', body: JSON.stringify({ channel_id: activeId, title }) });
    if (res.ok) { showToast('✅ Task added to board'); } else { showToast('Failed to add task', 'error'); }
    return;
  }

  if (cmd === '/focus') {
    const mins = parseInt(parts[1]) || 25;
    startFocusMode(mins);
    return;
  }

  if (cmd === '/roll') {
    const max = parseInt(parts[1]) || 6;
    const n   = Math.floor(Math.random() * max) + 1;
    await _postVolt(`🎲 Rolled a **${n}** (1–${max})`);
    return;
  }

  if (cmd === '/meet') {
    const code = Math.random().toString(36).substr(2, 6).toUpperCase();
    const url  = `${window.location.origin}/meeting.html?room=${code}`;
    await _postVolt(`📹 Meeting room ready → [Join ${code}](${url})`)
    return;
  }

  if (cmd === '/poll') {
    // /poll Question | Option1 | Option2 | ...
    const rest  = text.slice(6).trim();
    const parts2 = rest.split('|').map(s => s.trim()).filter(Boolean);
    if (parts2.length < 3) { showToast('Usage: /poll Question | Option1 | Option2'); return; }
    const question = parts2[0];
    const options  = parts2.slice(1);
    const body = { question, options };
    if (activeType === 'channel') body.channel_id    = activeId;
    else                          body.dm_to_user_id = activeId;
    const res = await authFetch('/chat/polls', 'POST', body);
    if (!res.ok) { const e = await res.json().catch(() => ({})); showToast(e.detail || 'Poll failed'); }
    return;
  }

  if (cmd === '/remind') {
    // /remind 10m Text or /remind 1h Text
    const timeStr = parts[1] || '';
    const match   = timeStr.match(/^(\d+)(m|h|s)$/i);
    if (!match) { showToast('Usage: /remind 10m Your reminder text'); return; }
    const [, num, unit] = match;
    const ms = parseInt(num) * (unit.toLowerCase() === 'h' ? 3600000 : unit.toLowerCase() === 'm' ? 60000 : 1000);
    const sendAt = new Date(Date.now() + ms).toISOString();
    const content = parts.slice(2).join(' ') || 'Reminder!';
    const body = { content, send_at: sendAt };
    if (activeType === 'channel') body.channel_id    = activeId;
    else                          body.dm_to_user_id = activeId;
    const res = await authFetch('/chat/scheduled', 'POST', body);
    if (!res.ok) { showToast('Reminder failed'); return; }
    showToast(`⏰ Reminder set for ${timeStr}`);
    return;
  }

  if (cmd === '/giphy') {
    const query = parts.slice(1).join(' ');
    if (!query) { showToast('Usage: /giphy search term'); return; }
    try {
      const r = await fetch(`https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(query)}&api_key=dc6zaTOxFJmzC&limit=1&rating=g`);
      const d = await r.json();
      const url = d?.data?.[0]?.images?.fixed_height?.url;
      if (!url) { showToast('No GIF found'); return; }
      const target = getVoltTarget();
      if (target === 'self' && activeType === 'channel') {
        // Ephemeral: show locally only, not saved or broadcast
        const fakeMsg = {
          id: null, channel_id: activeId, dm_to_user_id: null,
          sender_id: 0, sender_name: 'Volt', content: `🎞️ ${query}`,
          bot_name: 'Volt', file_url: url, file_name: `${query}.gif`,
          reactions: {}, pinned: false, parent_id: null,
          ts: new Date().toISOString(), ephemeral: true,
        };
        appendMessage(fakeMsg, false); scrollToBottom();
      } else {
        const payload = { content: `🎞️ ${query}`, file_url: url, file_name: `${query}.gif` };
        if (activeType === 'channel') { payload.type = 'channel_message'; payload.channel_id = activeId; }
        else                          { payload.type = 'dm'; payload.to_user_id = activeId; }
        wsSend(payload);
      }
    } catch { showToast('Giphy error'); }
    return;
  }

  if (cmd === '/weather') {
    const city = parts.slice(1).join('+') || 'London';
    try {
      const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
      const text2 = await r.text();
      if (!text2 || r.status !== 200) { showToast('Weather unavailable'); return; }
      await _postVolt(`🌤️ ${text2.trim()}`);
    } catch { showToast('Weather fetch failed'); }
    return;
  }

  if (cmd === '/8ball') {
    const answers = [
      'It is certain.','It is decidedly so.','Without a doubt.','Yes, definitely.',
      'You may rely on it.','As I see it, yes.','Most likely.','Outlook good.',
      'Yes.','Signs point to yes.','Reply hazy, try again.','Ask again later.',
      'Better not tell you now.','Cannot predict now.','Concentrate and ask again.',
      "Don't count on it.",'My reply is no.','My sources say no.',
      'Outlook not so good.','Very doubtful.',
    ];
    const q = parts.slice(1).join(' ') || '…';
    const a = answers[Math.floor(Math.random() * answers.length)];
    await _postVolt(`🎱 *${q}*\n> ${a}`);
    return;
  }

  if (cmd === '/trivia') {
    try {
      const r = await fetch('https://opentdb.com/api.php?amount=1&type=multiple');
      const d = await r.json();
      const q = d?.results?.[0];
      if (!q) { showToast('Trivia unavailable'); return; }
      const all = [...q.incorrect_answers, q.correct_answer].sort(() => Math.random() - 0.5);
      const letters = ['A','B','C','D'];
      const opts = all.map((o,i) => `${letters[i]}. ${o}`).join('\n');
      const clean = (s) => s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'");
      await _postVolt(`🧠 **Trivia** (${clean(q.category)})\n${clean(q.question)}\n\n${opts}\n\n||Answer: ${clean(q.correct_answer)}||`);
    } catch { showToast('Trivia fetch failed'); }
    return;
  }

  if (cmd === '/news') {
    const topic = parts.slice(1).join(' ') || 'technology';
    try {
      const r = await fetch(`https://api.currentsapi.services/v1/search?keywords=${encodeURIComponent(topic)}&language=en&apiKey=demo`);
      const d = await r.json();
      const articles = d?.news?.slice(0, 3);
      if (!articles?.length) {
        await _postVolt(`📰 No news found for "${topic}". Try a different topic.`);
        return;
      }
      const lines = articles.map(a => `• [${a.title}](${a.url})`).join('\n');
      await _postVolt(`📰 **News: ${topic}**\n${lines}`);
    } catch { showToast('News fetch failed'); }
    return;
  }

  if (cmd === '/gallery') {
    openGalleryPanel();
    return;
  }

  // Bare '/' with nothing after — just keep dropdown visible, do nothing
  if (cmd === '/') return;

  showToast(`Unknown command: ${cmd}`);
}

// ── Typing ────────────────────────────────────────────────────────────────────
let typingSent = false;
let typingReset;
function sendTyping() {
  if (typingSent) return;
  typingSent = true;
  const tpl = { type: 'typing' };
  if (activeType === 'channel') tpl.channel_id = activeId;
  else                          tpl.to_user_id  = activeId;
  wsSend(tpl);
  clearTimeout(typingReset);
  typingReset = setTimeout(() => { typingSent = false; }, 2500);
}

// ── File upload ───────────────────────────────────────────────────────────────
async function handleFileSelect() {
  const file = fileInput.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  showToast('Uploading…');
  const res = await fetch(`${API}/chat/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  if (!res.ok) { showToast('Upload failed'); return; }
  const { url, name } = await res.json();
  const payload = { file_url: url, file_name: name, content: '' };
  if (activeType === 'channel') {
    payload.type = 'channel_message'; payload.channel_id = activeId;
  } else {
    payload.type = 'dm'; payload.to_user_id = activeId;
  }
  wsSend(payload);
  fileInput.value = '';
  showToast('File sent!');
}

// ── Emoji picker ──────────────────────────────────────────────────────────────
function buildEmojiPicker() {
  const grid = document.createElement('div');
  grid.className = 'ep-grid';
  INPUT_EMOJIS.forEach(em => {
    const btn    = document.createElement('button');
    btn.className = 'ep-btn';
    btn.textContent = em;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (emojiTarget === 'input') {
        insertAtCursor(msgInput, em);
      } else if (typeof emojiTarget === 'number') {
        wsSend({ type: 'react', message_id: emojiTarget, emoji: em });
      }
      emojiPickerEl.classList.add('hidden');
    });
    grid.appendChild(btn);
  });
  emojiPickerEl.appendChild(grid);
}

function insertAtCursor(input, text) {
  const s = input.selectionStart, e = input.selectionEnd;
  input.value = input.value.slice(0, s) + text + input.value.slice(e);
  input.selectionStart = input.selectionEnd = s + text.length;
  input.focus();
}

// ── Channel emoji picker (modal) ──────────────────────────────────────────────
function buildChannelEmojiPicker() {
  const el = document.getElementById('channelEmojiPicker');
  CHANNEL_EMOJIS.forEach(em => {
    const btn = document.createElement('button');
    btn.className = 'eq-btn';
    btn.textContent = em;
    btn.addEventListener('click', () => {
      pendingEmoji = em;
      el.querySelectorAll('.eq-btn').forEach(b => b.style.background = '');
      btn.style.background = 'var(--bg-active)';
    });
    el.appendChild(btn);
  });
  // Default select first
  if (el.firstChild) el.firstChild.style.background = 'var(--bg-active)';
}

// ── Add channel modal ─────────────────────────────────────────────────────────
function openAddChannelModal() {
  document.getElementById('channelNameInput').value = '';
  document.getElementById('channelDescInput').value = '';
  pendingEmoji = CHANNEL_EMOJIS[0];
  document.getElementById('addChannelOverlay').classList.remove('hidden');
  document.getElementById('channelNameInput').focus();
}
function closeAddChannelModal() {
  document.getElementById('addChannelOverlay').classList.add('hidden');
}
async function createChannel() {
  const rawName = document.getElementById('channelNameInput').value.trim();
  const desc    = document.getElementById('channelDescInput').value.trim();
  if (!rawName) { showToast('Enter a channel name'); return; }
  const fullName = `${pendingEmoji} ${rawName}`;
  const res = await authFetch('/chat/channels', 'POST', { name: fullName, description: desc });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('[createChannel] failed:', res.status, err);
    showToast(err.detail || 'Could not create channel');
    return;
  }
  const ch = await res.json();
  channels.push(ch);
  renderChannelList();
  closeAddChannelModal();
  openChannel(ch);
}

// ── DM modal ──────────────────────────────────────────────────────────────────
async function openDmModal() {
  document.getElementById('addDmOverlay').classList.remove('hidden');
  const list = document.getElementById('userPickList');
  list.innerHTML = '';
  if (!allUsers.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;padding:8px 0;">No other members yet.</div>';
    return;
  }
  allUsers.forEach(u => {
    const info = dmUsers[u.id] || { name: u.name, online: false };
    const div  = document.createElement('div');
    div.className = 'user-pick-item';
    div.innerHTML = `
      <div class="dm-avatar" style="width:32px;height:32px;font-size:.8rem;">${info.name.charAt(0).toUpperCase()}</div>
      <span>${esc(info.name)}</span>`;
    div.addEventListener('click', () => {
      document.getElementById('addDmOverlay').classList.add('hidden');
      // Add to dmUsers if not there
      if (!dmUsers[u.id]) { dmUsers[u.id] = { name: u.name, online: false }; }
      renderDmList();
      openDm(u.id, u.name);
    });
    list.appendChild(div);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function authFetch(path, methodOrOpts = 'GET', body = null) {
  let method = 'GET';
  let rawBody = null;
  if (typeof methodOrOpts === 'string') {
    method = methodOrOpts;
    rawBody = body ? JSON.stringify(body) : null;
  } else if (methodOrOpts && typeof methodOrOpts === 'object') {
    method = methodOrOpts.method || 'GET';
    // Accept pre-stringified body from opts or fall back to body arg
    rawBody = (methodOrOpts.body !== undefined ? methodOrOpts.body : (body ? JSON.stringify(body) : null));
  }
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  };
  if (rawBody) opts.body = rawBody;
  return fetch(API + path, opts);
}

function scrollToBottom() {
  messagesWrap.scrollTop = messagesWrap.scrollHeight;
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  return isToday
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Render @mentions as highlighted spans
function renderMentions(escapedText) {
  return escapedText.replace(/@([\w\d_\- ]{1,32})/g, (match, name) => {
    const isMe = user.name.toLowerCase() === name.toLowerCase();
    return `<span class="mention${isMe ? ' mention-me' : ''}">${match}</span>`;
  });
}

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type === 'error' ? ' error' : '');
  setTimeout(() => { t.classList.remove('show'); }, 3000);
}

// ── @Mention autocomplete ─────────────────────────────────────────────────────
function handleMentionInput() {
  const val = msgInput.value;
  const cursorPos = msgInput.selectionStart;
  // Find the last @ before cursor
  const textBeforeCursor = val.substring(0, cursorPos);
  const atMatch = textBeforeCursor.match(/@([\w\d_\- ]*)$/);
  if (!atMatch) { hideMentionDropdown(); return; }
  const query = atMatch[1].toLowerCase();
  mentionUsers = allUsers.filter(u => u.name.toLowerCase().startsWith(query)).slice(0, 8);
  if (!mentionUsers.length) { hideMentionDropdown(); return; }
  mentionActiveIdx = 0;
  renderMentionDropdown();
}

function renderMentionDropdown() {
  const el = document.getElementById('mentionDropdown');
  if (!mentionUsers.length) { el.classList.add('hidden'); return; }
  el.innerHTML = mentionUsers.map((u, i) => {
    const av = u.avatar_url
      ? `<div class="mention-avatar"><img src="${API + u.avatar_url}" alt="" /></div>`
      : `<div class="mention-avatar">${u.name.charAt(0).toUpperCase()}</div>`;
    const statusText = u.status ? `<span class="mention-status">${esc(u.status)}</span>` : '';
    return `<div class="mention-item${i === mentionActiveIdx ? ' active' : ''}" data-name="${esc(u.name)}">${av}<span class="mention-name">@${esc(u.name)}</span>${statusText}</div>`;
  }).join('');
  el.classList.remove('hidden');
}

function hideMentionDropdown() {
  document.getElementById('mentionDropdown').classList.add('hidden');
  mentionUsers = [];
}

function completeMention(name) {
  if (!name) { hideMentionDropdown(); return; }
  const val = msgInput.value;
  const cursorPos = msgInput.selectionStart;
  const textBeforeCursor = val.substring(0, cursorPos);
  const replaced = textBeforeCursor.replace(/@([\w\d_\- ]*)$/, `@${name} `);
  msgInput.value = replaced + val.substring(cursorPos);
  msgInput.dispatchEvent(new Event('input'));
  hideMentionDropdown();
  msgInput.focus();
}

// ── Channel categories ────────────────────────────────────────────────────────
async function loadCategories() {
  const res = await authFetch('/channels/categories');
  if (!res.ok) return;
  categories = await res.json();
  renderChannelList();
}

function renderChannelList() {
  channelListEl.innerHTML = '';
  // Group channels by category
  const uncategorized = channels.filter(c => !c.category_id);
  const byCat = {};
  channels.filter(c => c.category_id).forEach(c => {
    (byCat[c.category_id] = byCat[c.category_id] || []).push(c);
  });

  // Render categories first
  categories.forEach(cat => {
    const catChannels = byCat[cat.id] || [];
    const headerLi = document.createElement('li');
    headerLi.className = 'category-header';
    headerLi.dataset.catId = cat.id;
    headerLi.innerHTML = `<span class="category-arrow">▾</span>${esc(cat.name)}`;
    headerLi.addEventListener('click', () => {
      const arrow = headerLi.querySelector('.category-arrow');
      const nextUl = headerLi.nextElementSibling;
      if (nextUl && nextUl.classList.contains('category-channels')) {
        nextUl.classList.toggle('collapsed');
        arrow.classList.toggle('collapsed');
      }
    });
    channelListEl.appendChild(headerLi);
    const catUl = document.createElement('ul');
    catUl.className = 'category-channels channel-list';
    catUl.style.listStyle = 'none';
    catChannels.forEach(ch => channelListEl.appendChild(_buildChannelLi(ch)));
    // append to outer list for simplicity
  });

  // Render uncategorized channels
  uncategorized.forEach(ch => channelListEl.appendChild(_buildChannelLi(ch)));
}

function _buildChannelLi(ch) {
  const li = document.createElement('li');
  li.className = `ch-item${activeType === 'channel' && activeId === ch.id ? ' active' : ''}${ch.archived ? ' ch-archived' : ''}`;
  const roIcon  = ch.readonly  ? `<i class="fa-solid fa-lock ch-readonly-ico" title="Read-only" style="font-size:.65rem;color:var(--text-muted);margin-left:4px;opacity:.7;"></i>` : '';
  const arcIcon = ch.archived  ? `<i class="fa-solid fa-box-archive ch-archive-ico" title="Archived" style="font-size:.65rem;color:var(--text-muted);margin-left:4px;opacity:.7;"></i>` : '';
  li.innerHTML = `<span class="ch-prefix">${ch.name.charAt(0) === '#' ? '' : '#'}</span><span class="ch-name">${esc(ch.name)}</span>${roIcon}${arcIcon}`;
  if (ch.created_by === user.id) {
    li.innerHTML += `<button class="ch-del-btn" onclick="deleteChannel(event,${ch.id});" title="Delete">✕</button>`;
  }
  if (unread[ch.id]) {
    li.innerHTML += `<span class="ch-badge">${unread[ch.id]}</span>`;
  }
  li.addEventListener('click', () => openChannel(ch));
  return li;
}

function initCategoryHandlers() {
  // Add manage-categories entry to channels section
  const addCatBtn = document.getElementById('addChannelBtn');
  if (addCatBtn) {
    // Add long-hold or second button — for simplicity expose via slash command / category modal trigger
  }
  document.getElementById('addCategoryBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('newCategoryInput').value.trim();
    if (!name) return;
    const res = await authFetch('/channels/categories', 'POST', { name });
    if (res.ok) {
      document.getElementById('newCategoryInput').value = '';
      categories = [...categories, await res.json()];
      renderCategoryList();
      renderChannelList();
    } else showToast('Failed to create category', 'error');
  });
  document.getElementById('closeCategoryBtn')?.addEventListener('click', () =>
    document.getElementById('categoryOverlay').classList.add('hidden'));
}

function renderCategoryList() {
  const el = document.getElementById('categoryList');
  if (!el) return;
  if (!categories.length) { el.innerHTML = '<em style="color:var(--text-muted);font-size:.82rem">No categories yet.</em>'; return; }
  el.innerHTML = categories.map(c => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--border);">
      <span style="font-size:.88rem;">${esc(c.name)}</span>
      <button class="modal-btn secondary" style="font-size:.75rem;padding:4px 10px;" onclick="deleteCategory(${c.id})">Delete</button>
    </div>`).join('');
}

window.deleteCategory = async function(id) {
  if (!confirm('Delete this category?')) return;
  const res = await authFetch(`/channels/categories/${id}`, 'DELETE');
  if (res.ok) {
    categories = categories.filter(c => c.id !== id);
    renderCategoryList(); renderChannelList();
  } else showToast('Delete failed', 'error');
};

// ── User profiles ─────────────────────────────────────────────────────────────
async function loadMyProfile() {
  const res = await authFetch('/users/me/profile');
  if (!res.ok) return;
  myProfile = await res.json();
  // Update sidebar avatar
  if (myProfile.avatar_url) {
    userAvatar.innerHTML = `<img class="avatar-img" src="${API + myProfile.avatar_url}" alt="" />`;
  }
  if (myProfile.status) {
    const statusEl = document.getElementById('myStatusLabel');
    if (statusEl) statusEl.textContent = '● ' + myProfile.status;
  }
}

function initProfileHandlers() {
  // Click sidebar user area to edit profile
  document.getElementById('sidebarUser')?.addEventListener('click', openMyProfileModal);
  // Profile modal close
  document.getElementById('closeProfileBtn')?.addEventListener('click', () =>
    document.getElementById('profileOverlay').classList.add('hidden'));
  document.getElementById('profileOverlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });
  // DM from profile
  document.getElementById('profileDmBtn')?.addEventListener('click', () => {
    const uid  = parseInt(document.getElementById('profileDmBtn').dataset.uid);
    const name = document.getElementById('profileName').textContent;
    document.getElementById('profileOverlay').classList.add('hidden');
    openDm(uid, name);
  });
  // My profile modal
  document.getElementById('cancelMyProfileBtn')?.addEventListener('click', () =>
    document.getElementById('myProfileOverlay').classList.add('hidden'));
  document.getElementById('myProfileOverlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });
  document.getElementById('saveMyProfileBtn')?.addEventListener('click', saveMyProfile);
  document.getElementById('avatarFileInput')?.addEventListener('change', uploadMyAvatar);
}

async function openProfileModal(userId) {
  const overlay = document.getElementById('profileOverlay');
  overlay.classList.remove('hidden');
  document.getElementById('profileAvatar').textContent = '…';
  document.getElementById('profileName').textContent   = '';
  document.getElementById('profileStatus').textContent  = '';
  document.getElementById('profileBio').textContent     = '';
  document.getElementById('profileJoined').textContent  = '';
  try {
    const res  = await authFetch(`/users/${userId}/profile`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const avEl = document.getElementById('profileAvatar');
    if (data.avatar_url) {
      avEl.innerHTML = `<img src="${API + data.avatar_url}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
    } else {
      avEl.textContent = data.name.charAt(0).toUpperCase();
    }
    document.getElementById('profileName').textContent   = data.name;
    document.getElementById('profileStatus').textContent  = data.status || '';
    document.getElementById('profileBio').textContent     = data.bio || '';
    document.getElementById('profileJoined').textContent  = 'Joined ' + new Date(data.joined).toLocaleDateString();
    document.getElementById('profileDmBtn').dataset.uid = userId;
  } catch { document.getElementById('profileName').textContent = 'Could not load profile'; }
}

function openMyProfileModal() {
  if (!myProfile) return;
  const overlay = document.getElementById('myProfileOverlay');
  overlay.classList.remove('hidden');
  document.getElementById('profileNameInput').value   = myProfile.name    || '';
  document.getElementById('profileStatusInput').value = myProfile.status  || '';
  document.getElementById('profileBioInput').value    = myProfile.bio     || '';
  const avEl = document.getElementById('myProfileAvatar');
  if (myProfile.avatar_url) {
    avEl.innerHTML = `<img src="${API + myProfile.avatar_url}" alt="" style="width:100%;height:100%;object-fit:cover;" />`;
  } else {
    avEl.textContent = myProfile.name.charAt(0).toUpperCase();
  }
}

async function saveMyProfile() {
  const name   = document.getElementById('profileNameInput').value.trim();
  const status = document.getElementById('profileStatusInput').value.trim();
  const bio    = document.getElementById('profileBioInput').value.trim();
  const res = await authFetch('/users/me/profile', 'PATCH', { name: name || undefined, status, bio });
  if (res.ok) {
    myProfile = await res.json();
    userNameLabel.textContent = myProfile.name;
    const statusEl = document.getElementById('myStatusLabel');
    if (statusEl) statusEl.textContent = myProfile.status ? '● ' + myProfile.status : '● Active';
    // Update stored user name
    const stored = JSON.parse(localStorage.getItem('synctact_user') || '{}');
    stored.name = myProfile.name;
    localStorage.setItem('synctact_user', JSON.stringify(stored));
    document.getElementById('myProfileOverlay').classList.add('hidden');
    showToast('Profile updated ✓');
  } else showToast('Update failed', 'error');
}

async function uploadMyAvatar() {
  const file = document.getElementById('avatarFileInput').files?.[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API}/users/me/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  if (res.ok) {
    const data = await res.json();
    myProfile.avatar_url = data.avatar_url;
    userAvatar.innerHTML = `<img class="avatar-img" src="${API + data.avatar_url}?t=${Date.now()}" alt="" />`;
    const avEl = document.getElementById('myProfileAvatar');
    avEl.innerHTML = `<img src="${API + data.avatar_url}?t=${Date.now()}" alt="" style="width:100%;height:100%;object-fit:cover;" />`;
    showToast('Avatar updated ✓');
  } else showToast('Upload failed', 'error');
}

// ── Bookmarks ─────────────────────────────────────────────────────────────────
function initBookmarksHandlers() {
  document.getElementById('openBookmarksBtn')?.addEventListener('click', toggleBookmarksPanel);
  document.getElementById('closeBookmarksBtn')?.addEventListener('click', () =>
    document.getElementById('bookmarksPanel').classList.remove('open'));
}

function toggleBookmarksPanel() {
  const panel = document.getElementById('bookmarksPanel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) loadBookmarks();
}

async function bookmarkMessage(msgId) {
  const res = await authFetch(`/bookmarks/${msgId}`, 'POST');
  if (res.ok) showToast('Bookmarked 🔖');
  else showToast('Already bookmarked', 'error');
}

async function loadBookmarks() {
  const el = document.getElementById('bookmarksList');
  el.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;padding:10px;">Loading…</div>';
  const res = await authFetch('/bookmarks');
  if (!res.ok) { el.innerHTML = '<div style="color:#f87171;font-size:.82rem;padding:10px;">Failed to load.</div>'; return; }
  const bms = await res.json();
  if (!bms.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;padding:10px;">No bookmarks yet.</div>'; return; }
  el.innerHTML = bms.map(m => `
    <div class="bookmark-item">
      <div class="bki-name">${esc(m.sender_name)} · <span style="font-size:.72rem;">${new Date(m.ts).toLocaleDateString()}</span>
        <button class="bki-del" onclick="removeBookmark(${m.id}, this.closest('.bookmark-item'))" title="Remove">\u00d7</button>
      </div>
      <div class="bki-text">${renderMentions(esc(m.content || '')) || '<em style="color:var(--text-muted)">File attachment</em>'}</div>
    </div>`).join('');
}

window.removeBookmark = async function(msgId, el) {
  await authFetch(`/bookmarks/${msgId}`, 'DELETE');
  el?.remove();
};

// ── Invite links ──────────────────────────────────────────────────────────────
function initInviteHandlers() {
  document.getElementById('inviteBtn')?.addEventListener('click', () => {
    if (activeType !== 'channel') return;
    const ch = channels.find(c => c.id === activeId);
    document.getElementById('inviteChannelName').textContent = ch?.name || '';
    document.getElementById('inviteOverlay').classList.remove('hidden');
    document.getElementById('inviteCopyWrap').classList.add('hidden');
    document.getElementById('inviteExpiry').value   = '';
    document.getElementById('inviteMaxUses').value  = '';
  });
  document.getElementById('cancelInviteBtn')?.addEventListener('click', () =>
    document.getElementById('inviteOverlay').classList.add('hidden'));
  document.getElementById('inviteOverlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });
  document.getElementById('generateInviteBtn')?.addEventListener('click', generateInvite);
  document.getElementById('copyInviteBtn')?.addEventListener('click', () => {
    const input = document.getElementById('inviteLinkInput');
    navigator.clipboard.writeText(input.value).then(() => showToast('Copied! 📋'));
  });
}

async function generateInvite() {
  const expiry  = document.getElementById('inviteExpiry').value;
  const maxUses = parseInt(document.getElementById('inviteMaxUses').value) || null;
  const body    = { channel_id: activeId };
  if (expiry)   body.expires_hours = parseInt(expiry);
  if (maxUses)  body.max_uses = maxUses;
  const res = await authFetch('/invite', 'POST', body);
  if (!res.ok) { showToast('Failed to generate invite', 'error'); return; }
  const data = await res.json();
  const inviteUrl = `${window.location.origin}/chat.html?invite=${data.code}`;
  document.getElementById('inviteLinkInput').value = inviteUrl;
  document.getElementById('inviteCopyWrap').classList.remove('hidden');
}

// ── Forward message ───────────────────────────────────────────────────────────
function initForwardHandlers() {
  document.getElementById('cancelForwardBtn')?.addEventListener('click', () => {
    document.getElementById('forwardOverlay').classList.add('hidden');
    pendingForwardId = null;
  });
  document.getElementById('forwardOverlay')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) { e.currentTarget.classList.add('hidden'); pendingForwardId = null; }
  });
  document.getElementById('confirmForwardBtn')?.addEventListener('click', async () => {
    if (!pendingForwardId) return;
    const cid = parseInt(document.getElementById('forwardChannelSelect').value);
    if (!cid) { showToast('Select a channel', 'error'); return; }
    const res = await authFetch(`/chat/messages/${pendingForwardId}/forward`, 'POST', { channel_id: cid });
    if (res.ok) { showToast('Message forwarded ↪️'); document.getElementById('forwardOverlay').classList.add('hidden'); pendingForwardId = null; }
    else showToast('Forward failed', 'error');
  });
}

function openForwardModal(msgId) {
  pendingForwardId = msgId;
  const sel = document.getElementById('forwardChannelSelect');
  sel.innerHTML = channels.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  document.getElementById('forwardOverlay').classList.remove('hidden');
}

// ── Message editing ───────────────────────────────────────────────────────────
function startEditMessage(msgId) {
  const bubble = messagesWrap.querySelector(`[data-msg-id="${msgId}"]`);
  if (!bubble) return;
  const currentText = bubble.dataset.msgContent || '';
  const textEl = bubble.querySelector('.msg-text');
  if (!textEl) return;

  // Inline edit
  const editArea = document.createElement('textarea');
  editArea.className = 'modal-input';
  editArea.style.cssText = 'width:100%;min-height:60px;resize:none;margin-top:4px;';
  editArea.value = currentText;
  textEl.replaceWith(editArea);
  editArea.focus();

  // Remove existing action bar, replace with save/cancel
  const actionsEl = bubble.querySelector('.msg-actions');
  const saveRow = document.createElement('div');
  saveRow.style.cssText = 'display:flex;gap:8px;margin-top:6px;';
  saveRow.innerHTML = `
    <button class="modal-btn primary"   style="padding:5px 14px;font-size:.78rem;" id="saveEdit_${msgId}">Save</button>
    <button class="modal-btn secondary" style="padding:5px 14px;font-size:.78rem;" id="cancelEdit_${msgId}">Cancel</button>`;
  bubble.appendChild(saveRow);
  if (actionsEl) actionsEl.style.display = 'none';

  const cancel = () => {
    editArea.replaceWith(textEl);
    saveRow.remove();
    if (actionsEl) actionsEl.style.display = '';
  };

  document.getElementById(`saveEdit_${msgId}`).addEventListener('click', async () => {
    const newText = editArea.value.trim();
    if (!newText) return;
    const res = await authFetch(`/chat/messages/${msgId}`, 'PATCH', { content: newText });
    if (res.ok) {
      cancel();
      // WS broadcast will update the bubble for everyone else; update locally too
      textEl.innerHTML = renderMentions(esc(newText));
      bubble.dataset.msgContent = newText;
      let editedEl = bubble.querySelector('.edited-label');
      if (!editedEl) { editedEl = document.createElement('span'); editedEl.className = 'edited-label'; textEl.after(editedEl); }
      editedEl.textContent = '(edited)';
    } else showToast('Edit failed', 'error');
  });
  document.getElementById(`cancelEdit_${msgId}`).addEventListener('click', cancel);
  editArea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById(`saveEdit_${msgId}`)?.click(); }
    if (e.key === 'Escape') cancel();
  });
}

function scrollToBottom() {
  messagesWrap.scrollTop = messagesWrap.scrollHeight;
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  return isToday
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type === 'error' ? ' error' : '');
  setTimeout(() => { t.classList.remove('show'); }, 3000);
}

// ── Slowmode bar ──────────────────────────────────────────────────────────────
let _slowmodeTimer = null;
function _updateSlowmodeBar(seconds) {
  const bar = document.getElementById('slowmodeBar');
  const cd  = document.getElementById('slowmodeCountdown');
  if (!bar) return;
  clearInterval(_slowmodeTimer);
  if (!seconds) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  if (cd) cd.textContent = `${seconds} second${seconds !== 1 ? 's' : ''} between messages`;
}

// ── Moderation actions ───────────────────────────────────────────────────────
async function muteUser(userId, channelId) {
  const mins = prompt('Mute duration in minutes (leave blank for permanent):');
  if (mins === null) return; // cancelled
  const body = { user_id: userId, channel_id: channelId };
  if (mins && !isNaN(parseInt(mins))) body.minutes = parseInt(mins);
  const res = await authFetch('/mod/mute', 'POST', body);
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    showToast(data.detail || 'User muted');
  } else {
    const e = await res.json().catch(() => ({}));
    showToast(e.detail || 'Mute failed', 'error');
  }
}

async function kickUser(userId, channelId) {
  if (!confirm('Kick this user from the channel?')) return;
  const res = await authFetch(`/mod/kick/${userId}/${channelId}`, 'POST');
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    showToast(data.detail || 'User kicked');
  } else {
    const e = await res.json().catch(() => ({}));
    showToast(e.detail || 'Kick failed', 'error');
  }
}

// Expose globally for inline onclick
window.openReactionPicker  = openReactionPicker;
window.togglePin           = togglePin;
window.openThreadById      = openThreadById;
window.deleteChannel       = deleteChannel;
window.deleteMessage       = deleteMessage;
window.muteUser            = muteUser;
window.kickUser            = kickUser;
window.openProfileModal    = openProfileModal;
window.bookmarkMessage     = bookmarkMessage;
window.openForwardModal    = openForwardModal;
window.startEditMessage    = startEditMessage;
window.openGalleryPanel    = openGalleryPanel;

// ── Link previews ──────────────────────────────────────────────────────────────
const _previewCache = {};  // url → data (simple cache)
const URL_REGEX = /https?:\/\/[^\s"'<>()]+/gi;

async function fetchLinkPreviews(bubble, content) {
  const urls = content.match(URL_REGEX);
  if (!urls || !urls.length) return;
  const url = urls[0];  // preview only the first URL per message
  if (_previewCache[url] === null) return;  // known failure, skip
  try {
    const data = _previewCache[url] || await (async () => {
      const r = await authFetch(`/link-preview?url=${encodeURIComponent(url)}`);
      if (!r.ok) return null;
      const d = await r.json();
      _previewCache[url] = d;
      return d;
    })();
    if (!data || !data.title) return;
    const imgHtml = data.image ? `<img src="${esc(data.image)}" alt="" onerror="this.style.display='none'" />` : '';
    const siteHtml = data.site ? `<span class="lp-site">${esc(data.site)}</span>` : '';
    const descHtml = data.description ? `<p class="lp-desc">${esc(data.description)}</p>` : '';
    const preview = document.createElement('div');
    preview.className = 'link-preview';
    preview.innerHTML = `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${imgHtml}<div class="lp-text">${siteHtml}<span class="lp-title">${esc(data.title)}</span>${descHtml}</div></a>`;
    bubble.appendChild(preview);
  } catch { _previewCache[url] = null; }
}

// ── Notification preferences (per-channel mute) ────────────────────────────────
async function loadNotifPrefs() {
  try {
    const r = await authFetch('/notifications/prefs');
    if (r.ok) notifPrefs = await r.json();
  } catch { /* ignore */ }
}

async function toggleChannelMute(channelId) {
  const isMuted = notifPrefs[channelId]?.muted;
  const newVal  = !isMuted;
  const r = await authFetch(`/notifications/prefs/${channelId}?muted=${newVal}`, 'PUT');
  if (!r.ok) { showToast('Could not update notification preference'); return; }
  notifPrefs[channelId] = { muted: newVal };
  const btn = document.getElementById('muteChannelBtn');
  if (btn) {
    btn.innerHTML = newVal ? '<i class="fa-solid fa-bell-slash"></i>' : '<i class="fa-regular fa-bell"></i>';
    btn.title = newVal ? 'Unmute notifications' : 'Mute notifications for this channel';
  }
  showToast(newVal ? 'Channel muted' : 'Channel unmuted');
}

function initMuteHandler() {
  document.getElementById('muteChannelBtn')?.addEventListener('click', () => {
    if (activeType === 'channel') toggleChannelMute(activeId);
  });
}

// ── Image Gallery ─────────────────────────────────────────────────────────────
const VIDEO_EXTS   = /\.(mp4|webm|mov)$/i;
const IMAGE_EXTS_R = /\.(png|jpg|jpeg|gif|webp|svg|bmp|avif)$/i;

function initGalleryHandlers() {
  document.getElementById('galleryBtn')?.addEventListener('click', openGalleryPanel);
  document.getElementById('closeGalleryBtn')?.addEventListener('click', () => {
    document.getElementById('galleryPanel')?.classList.add('hidden');
  });
}

async function openGalleryPanel() {
  if (activeType !== 'channel') { showToast('Open a channel first'); return; }
  const panel = document.getElementById('galleryPanel');
  if (!panel) return;
  panel.classList.remove('hidden');
  const body = document.getElementById('galleryPanelBody');
  body.innerHTML = '<div class="gallery-empty">Loading…</div>';
  const r = await authFetch(`/chat/channels/${activeId}/gallery`);
  if (!r.ok) { body.innerHTML = '<div class="gallery-empty">Could not load gallery</div>'; return; }
  const items = await r.json();
  if (!items.length) { body.innerHTML = '<div class="gallery-empty">No media in this channel yet.</div>'; return; }
  body.innerHTML = '';
  items.forEach(item => {
    const fullUrl = API + item.file_url;
    const el = document.createElement('div');
    el.className = 'gallery-item';
    el.title = `${item.sender} • ${item.file_name}`;
    if (VIDEO_EXTS.test(item.file_url)) {
      el.innerHTML = `<video src="${fullUrl}" muted preload="metadata"></video>`;
    } else {
      el.innerHTML = `<img src="${fullUrl}" alt="${esc(item.file_name || '')}" loading="lazy" />`;
    }
    el.addEventListener('click', () => window.open(fullUrl, '_blank'));
    body.appendChild(el);
  });
}

// ── Voice messages ────────────────────────────────────────────────────────────
function initVoiceHandlers() {
  const startBtn  = document.getElementById('voiceStartBtn');
  const stopBtn   = document.getElementById('voiceStopBtn');
  const sendBtn   = document.getElementById('voiceSendBtn');
  const cancelBtn = document.getElementById('voiceCancelBtn');
  const status    = document.getElementById('voiceStatus');
  const timer     = document.getElementById('voiceTimer');
  const preview   = document.getElementById('voicePreview');
  const overlay   = document.getElementById('voiceOverlay');
  const micBtn    = document.getElementById('voiceRecordBtn');

  if (micBtn) micBtn.addEventListener('click', () => {
    if (!activeId) { showToast('Open a channel or DM first'); return; }
    overlay?.classList.remove('hidden');
    // Reset state
    startBtn.disabled  = false;
    stopBtn.disabled   = true;
    sendBtn.style.display = 'none';
    preview.style.display = 'none';
    status.textContent = 'Press Start to record';
    timer.textContent  = '0:00';
    voiceChunks = [];
  });

  if (startBtn) startBtn.addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceChunks = [];
      voiceRecorder = new MediaRecorder(stream);
      voiceRecorder.ondataavailable = e => { if (e.data.size) voiceChunks.push(e.data); };
      voiceRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(voiceChunks, { type: 'audio/webm' });
        preview.src = URL.createObjectURL(blob);
        preview.style.display = '';
        sendBtn.style.display = '';
        status.textContent = 'Preview below. Press Send to share.';
      };
      voiceRecorder.start();
      startBtn.disabled = true;
      stopBtn.disabled  = false;
      status.textContent = '🔴 Recording…';
      let secs = 0;
      clearInterval(voiceTimerInterval);
      voiceTimerInterval = setInterval(() => {
        secs++;
        timer.textContent = `${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}`;
        if (secs >= 120) stopBtn.click(); // 2-min max
      }, 1000);
    } catch { showToast('Microphone access denied'); }
  });

  if (stopBtn) stopBtn.addEventListener('click', () => {
    voiceRecorder?.stop();
    stopBtn.disabled = true;
    clearInterval(voiceTimerInterval);
  });

  if (sendBtn) sendBtn.addEventListener('click', async () => {
    const blob = new Blob(voiceChunks, { type: 'audio/webm' });
    const fd   = new FormData();
    fd.append('file', blob, `voice-${Date.now()}.webm`);
    showToast('Sending voice message…');
    const res = await fetch(`${API}/chat/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    if (!res.ok) { showToast('Upload failed'); return; }
    const { url, name } = await res.json();
    const payload = { file_url: url, file_name: name, content: '🎤 Voice message' };
    if (activeType === 'channel') { payload.type = 'channel_message'; payload.channel_id = activeId; }
    else                          { payload.type = 'dm'; payload.to_user_id = activeId; }
    wsSend(payload);
    overlay?.classList.add('hidden');
    showToast('Voice message sent!');
  });

  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    voiceRecorder?.stop();
    clearInterval(voiceTimerInterval);
    overlay?.classList.add('hidden');
  });
}

// ── Delete message ─────────────────────────────────────────────────────────
async function deleteMessage(msgId) {
  if (!confirm('Delete this message?')) return;
  const res = await authFetch(`/chat/messages/${msgId}`, 'DELETE');
  if (res.status === 403) { showToast('You can only delete your own messages'); return; }
  if (!res.ok) { showToast('Could not delete message'); return; }
}

// ── Delete channel ────────────────────────────────────────────────────────────
async function deleteChannel(e, channelId) {
  e.stopPropagation(); // don't open the channel when clicking delete
  if (!confirm('Delete this channel and all its messages? This cannot be undone.')) return;
  const res = await authFetch(`/chat/channels/${channelId}`, 'DELETE');
  if (res.status === 403) { showToast('Only the channel owner can delete this'); return; }
  if (!res.ok) { showToast('Could not delete channel'); return; }
}

// ── Pin messages ────────────────────────────────────────────────────────────────
async function togglePin(msgId) {
  const res = await authFetch(`/chat/messages/${msgId}/pin`, 'POST');
  if (res.status === 403) { showToast('Only the channel owner can pin messages'); return; }
  if (!res.ok) { showToast('Could not pin message'); return; }
  // Always refresh the pinned bar/badge immediately, don't wait for WS event
  if (activeType === 'channel') await loadPinnedMessages(activeId);
}

async function loadPinnedMessages(channelId) {
  const res = await authFetch(`/chat/channels/${channelId}/pinned`);
  if (!res.ok) return;
  const msgs = await res.json();
  const badge = document.getElementById('pinnedBadge');
  const bar   = document.getElementById('pinnedBar');
  if (!msgs.length) {
    badge.classList.add('hidden');
    badge.textContent = '';
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  badge.textContent = `\uD83D\uDCCC ${msgs.length} pinned`;
  badge.classList.remove('hidden');
  // Keep bar visibility state but update content
  renderPinnedBar(msgs);
}

function renderPinnedBar(msgs) {
  const bar = document.getElementById('pinnedBar');
  bar.innerHTML = msgs.map(m => `
    <div class="pin-item" data-pin-id="${m.id}">
      <span class="pin-who">${esc(m.sender_name)}</span>
      <span class="pin-text pin-jump" onclick="scrollToPinnedMsg(${m.id})" title="Jump to message">${esc(m.content || (m.file_name ? '📎 ' + m.file_name : ''))}</span>
      <button class="unpin-btn" onclick="unpinFromBar(${m.id}, this)" title="Unpin">📌 Unpin</button>
    </div>`).join('');
}

function scrollToPinnedMsg(msgId) {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-highlight');
    setTimeout(() => el.classList.remove('msg-highlight'), 1500);
  }
}

async function unpinFromBar(msgId, btn) {
  // Optimistic: remove pin item immediately so UI feels instant
  const pinItem = btn.closest('[data-pin-id]');
  if (pinItem) pinItem.remove();
  const bar   = document.getElementById('pinnedBar');
  const badge = document.getElementById('pinnedBadge');
  const remaining = bar.querySelectorAll('[data-pin-id]').length;
  if (remaining === 0) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    badge.classList.add('hidden');
  } else {
    badge.textContent = `📌 ${remaining} pinned`;
  }
  // Also update the pin button on the message bubble
  const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (msgEl) {
    const pinBtn = msgEl.querySelector('.pin-msg-btn');
    if (pinBtn) { pinBtn.title = 'Pin'; pinBtn.style.color = ''; }
    delete msgEl.dataset.pinned;
  }
  // Fire API in background
  const res = await authFetch(`/chat/messages/${msgId}/pin`, 'POST');
  if (!res.ok) {
    showToast('Could not unpin message');
    // Refresh to restore correct state
    if (activeType === 'channel') loadPinnedMessages(activeId);
  }
}

function togglePinnedBar() {
  document.getElementById('pinnedBar').classList.toggle('hidden');
}

// ── Search ─────────────────────────────────────────────────────────────────
function openSearch() {
  document.getElementById('searchOverlay').classList.remove('hidden');
  document.getElementById('searchInput').value = '';
  document.getElementById('searchResults').innerHTML = '<div class="search-empty">Type to search across all channels and DMs</div>';
  // Populate channel dropdown
  const sel = document.getElementById('searchFilterChannel');
  if (sel) {
    sel.innerHTML = '<option value="">All channels</option>';
    channels.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = '#' + ch.name;
      sel.appendChild(opt);
    });
  }
  setTimeout(() => document.getElementById('searchInput').focus(), 50);
}

function closeSearch() {
  document.getElementById('searchOverlay').classList.add('hidden');
}

async function doSearch(q) {
  const fromUser   = (document.getElementById('searchFilterUser')?.value   || '').trim();
  const channelId  = document.getElementById('searchFilterChannel')?.value  || '';
  const afterDate  = document.getElementById('searchFilterAfter')?.value    || '';
  const beforeDate = document.getElementById('searchFilterBefore')?.value   || '';

  let url = `/chat/search?q=${encodeURIComponent(q)}`;
  if (fromUser)   url += `&from_user=${encodeURIComponent(fromUser)}`;
  if (channelId)  url += `&channel_id=${channelId}`;
  if (afterDate)  url += `&after=${encodeURIComponent(afterDate)}`;
  if (beforeDate) url += `&before=${encodeURIComponent(beforeDate)}`;

  const res = await authFetch(url);
  const resultsEl = document.getElementById('searchResults');
  if (!res.ok) { resultsEl.innerHTML = '<div class="search-empty">Search failed</div>'; return; }
  const msgs = await res.json();
  if (!msgs.length) { resultsEl.innerHTML = '<div class="search-empty">No results for "' + esc(q) + '"</div>'; return; }
  const highlighted = str => esc(str).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`);
  resultsEl.innerHTML = msgs.map(m => {
    const where = m.channel_id
      ? (channels.find(c => c.id === m.channel_id)?.name || `#${m.channel_id}`)
      : `@ DM`;
    return `<div class="search-result-item" onclick="jumpToMsg(${m.channel_id},${m.dm_to_user_id},${m.sender_id})">
      <div class="sri-meta">${esc(m.sender_name)} in <b>${esc(where)}</b> · ${formatTime(m.ts)}</div>
      <div class="sri-text">${highlighted(m.content || (m.file_name ? '📎 ' + m.file_name : ''))}</div>
    </div>`;
  }).join('');
}

function jumpToMsg(channelId, dmUid, senderId) {
  closeSearch();
  if (channelId) {
    const ch = channels.find(c => c.id === channelId);
    if (ch) openChannel(ch);
  } else if (dmUid) {
    const info = dmUsers[dmUid] || dmUsers[senderId];
    const uid  = dmUsers[dmUid] ? dmUid : senderId !== user.id ? senderId : null;
    if (uid && dmUsers[uid]) openDm(uid, dmUsers[uid].name);
  }
}
window.jumpToMsg = jumpToMsg;

// ── Threads ─────────────────────────────────────────────────────────────
function openThreadById(msgId) {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!el) return;
  const m = {
    id:            msgId,
    sender_name:   el.dataset.msgSender,
    content:       el.dataset.msgContent,
    ts:            el.dataset.msgTs,
    channel_id:    el.dataset.channelId ? parseInt(el.dataset.channelId) : null,
    dm_to_user_id: el.dataset.dmUid    ? parseInt(el.dataset.dmUid)     : null,
  };
  openThread(m);
}

async function openThread(m) {
  threadParentId   = m.id;
  threadParentData = m;
  // Show panel
  document.getElementById('threadPanel').classList.remove('hidden');
  // Render parent message preview
  const p = document.getElementById('threadParentMsg');
  p.innerHTML = `<span class="tp-name">${esc(m.sender_name)}</span>: ${esc(m.content || (m.file_name ? '📎 ' + m.file_name : ''))}<br><span style="font-size:.7rem;">${formatTime(m.ts)}</span>`;
  // Load replies
  const tmsgs = document.getElementById('threadMsgs');
  tmsgs.innerHTML = '<div style="color:var(--text-muted);font-size:.8rem;padding:10px 0;">Loading…</div>';
  const res = await authFetch(`/chat/messages/${m.id}/thread`);
  tmsgs.innerHTML = '';
  if (!res.ok) return;
  const replies = await res.json();
  if (!replies.length) {
    tmsgs.innerHTML = '<div style="color:var(--text-muted);font-size:.8rem;padding:8px 0;">No replies yet.</div>';
    return;
  }
  replies.forEach(r => appendThreadMsg(r));
  tmsgs.scrollTop = tmsgs.scrollHeight;
}

function appendThreadMsg(m) {
  const tmsgs = document.getElementById('threadMsgs');
  const div = document.createElement('div');
  div.className = 'msg-group';
  div.style.marginBottom = '12px';
  div.innerHTML = `
    <div class="msg-header">
      <span class="msg-name">${esc(m.sender_name)}</span>
      <span class="msg-time">${formatTime(m.ts)}</span>
    </div>
    <div class="msg-bubble" style="font-size:.85rem;">${esc(m.content)}</div>`;
  tmsgs.appendChild(div);
}

function closeThread() {
  document.getElementById('threadPanel').classList.add('hidden');
  threadParentId   = null;
  threadParentData = null;
  document.getElementById('threadMsgs').innerHTML = '';
  document.getElementById('threadInput').value = '';
}

function sendThreadReply() {
  const input = document.getElementById('threadInput');
  const text  = input.value.trim();
  if (!text || !threadParentId) return;
  wsSend({
    type:          'thread_reply',
    parent_id:     threadParentId,
    content:       text,
    channel_id:    threadParentData?.channel_id    || null,
    dm_to_user_id: threadParentData?.dm_to_user_id || null,
  });
  input.value = '';
  input.style.height = 'auto';
}

// ── Scheduled messages ──────────────────────────────────────────────
async function openScheduleModal() {
  if (!activeId) { showToast('Open a channel or DM first'); return; }
  document.getElementById('scheduleOverlay').classList.remove('hidden');
  document.getElementById('schedMsgInput').value = msgInput.value.trim();
  // Default: 1 hour from now
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setSeconds(0, 0);
  document.getElementById('schedTimeInput').value = d.toISOString().slice(0, 16);
  await loadScheduled();
}

async function loadScheduled() {
  const res = await authFetch('/chat/scheduled');
  if (!res.ok) return;
  const items = await res.json();
  renderScheduled(items);
}

function renderScheduled(items) {
  const el = document.getElementById('schedList');
  if (!items.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:.8rem;padding:8px 0;">No scheduled messages yet.</div>'; return; }
  el.innerHTML = items.map(it => {
    const where = it.channel_id
      ? (channels.find(c => c.id === it.channel_id)?.name || `#${it.channel_id}`)
      : 'DM';
    return `<div class="sched-item">
      <span class="si-text">${esc(it.content)} <span style="color:var(--text-muted);font-size:.7rem;">→ ${esc(where)}</span></span>
      <span class="si-time">${formatTime(it.send_at)}</span>
      <button class="sched-del" onclick="deleteScheduled(${it.id})">✕</button>
    </div>`;
  }).join('');
}
window.deleteScheduled = deleteScheduled;

async function createScheduled() {
  const content = document.getElementById('schedMsgInput').value.trim();
  const sendAt  = document.getElementById('schedTimeInput').value;
  if (!content) { showToast('Enter a message'); return; }
  if (!sendAt)  { showToast('Pick a send time'); return; }
  const body = { content, send_at: new Date(sendAt).toISOString() };
  if (activeType === 'channel') body.channel_id    = activeId;
  else                          body.dm_to_user_id = activeId;
  const res = await authFetch('/chat/scheduled', 'POST', body);
  if (!res.ok) { const e = await res.json(); showToast(e.detail || 'Could not schedule'); return; }
  showToast('Message scheduled! ⏰');
  document.getElementById('schedMsgInput').value = '';
  await loadScheduled();
}

async function deleteScheduled(id) {
  await authFetch(`/chat/scheduled/${id}`, 'DELETE');
  await loadScheduled();
}

// ── Push Notifications ───────────────────────────────────────────────────────
function initPushNotifications() {
  if (!('Notification' in window)) return;
  const notifBtn = document.getElementById('notifBtn');
  if (!notifBtn) return;
  const updateBtn = () => {
    notifBtn.title = Notification.permission === 'granted' ? 'Notifications ON' : 'Enable notifications';
    notifBtn.style.color = Notification.permission === 'granted' ? 'var(--purple-l)' : '';
  };
  updateBtn();
  notifBtn.addEventListener('click', async () => {
    if (Notification.permission === 'granted') { showToast('Notifications already on \u2705'); return; }
    const res = await Notification.requestPermission();
    updateBtn();
    showToast(res === 'granted' ? 'Notifications enabled! \ud83d\udd14' : 'Permission denied');
  });
}

function maybePushNotif(senderName, body) {
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  try {
    new Notification(`SyncTact — ${senderName}`, {
      body: body.slice(0, 120),
      icon: 'data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><text y=\'.9em\' font-size=\'90\'>\u26a1</text></svg>'
    });
  } catch (e) { /* ignore */ }
}

// ── Polls ────────────────────────────────────────────────────────────────────
function initPollHandlers() {
  const pollOverlay  = document.getElementById('pollOverlay');
  const cancelBtn    = document.getElementById('cancelPollBtn');
  const submitBtn    = document.getElementById('submitPollBtn');
  const createPollBtn = document.getElementById('createPollBtn');
  if (!pollOverlay) return;
  createPollBtn.addEventListener('click', () => {
    if (!activeId) { showToast('Open a channel or DM first'); return; }
    pollOverlay.classList.remove('hidden');
    document.getElementById('pollQuestion').value = '';
    ['pollOpt0','pollOpt1','pollOpt2','pollOpt3'].forEach(id => { document.getElementById(id).value = ''; });
  });
  cancelBtn.addEventListener('click', () => pollOverlay.classList.add('hidden'));
  submitBtn.addEventListener('click', createPoll);
}

async function createPoll() {
  const question = document.getElementById('pollQuestion').value.trim();
  const opts     = ['pollOpt0','pollOpt1','pollOpt2','pollOpt3']
    .map(id => document.getElementById(id).value.trim())
    .filter(Boolean);
  if (!question) { showToast('Enter a question'); return; }
  if (opts.length < 2) { showToast('Add at least 2 options'); return; }
  const body = { question, options: opts };
  if (activeType === 'channel') body.channel_id    = activeId;
  else                          body.dm_to_user_id = activeId;
  const res = await authFetch('/chat/polls', 'POST', body);
  if (!res.ok) { const e = await res.json().catch(() => ({})); showToast(e.detail || 'Could not create poll'); return; }
  document.getElementById('pollOverlay').classList.add('hidden');
  showToast('Poll created! \ud83d\udcca');
}

function appendPollCard(p) {
  const card = document.createElement('div');
  card.className = 'poll-card';
  card.dataset.pollId = p.id;
  buildPollCard(card, p);
  messagesWrap.appendChild(card);
}

function buildPollCard(card, p) {
  const counts     = p.counts  || p.options.map(() => 0);
  const voters     = p.voters  || p.options.map(() => []);
  const totalVotes = counts.reduce((s, c) => s + c, 0);
  const myVote     = voters.findIndex(v => v && v.includes(user.id));
  const voted      = myVote >= 0;
  card.innerHTML = `
    <h4>${esc(p.question)} <span class="poll-badge">Poll by ${esc(p.creator_name)}</span></h4>
    ${p.options.map((opt, i) => {
      const pct  = totalVotes ? Math.round(counts[i] / totalVotes * 100) : 0;
      const mine = myVote === i;
      return `<div class="poll-option">
        <button class="poll-bar-wrap${voted ? ' voted' : ''}${mine ? ' my-vote' : ''}" data-option="${i}" onclick="votePoll(${p.id},${i},this)" ${voted ? 'disabled' : ''}>
          <div class="poll-bar" style="width:${pct}%"></div>
          <div class="poll-bar-label">
            <span>${esc(opt)}${mine ? ' ✓' : ''}</span>
            <span style="color:var(--text-muted)">${voted ? pct + '%' : ''}</span>
          </div>
        </button>
      </div>`;
    }).join('')}
    <div class="poll-total">${totalVotes} vote${totalVotes !== 1 ? 's' : ''}</div>`;
}

function updatePollCard(card, p) {
  buildPollCard(card, p);
}

async function loadChannelPolls(channelId) {
  const res = await authFetch(`/chat/channels/${channelId}/polls`);
  if (!res.ok) return;
  // Guard against stale responses from a previous channel
  if (activeType !== 'channel' || activeId !== channelId) return;
  const polls = await res.json();
  polls.forEach(p => {
    if (!document.querySelector(`[data-poll-id="${p.id}"]`)) appendPollCard(p);
  });
}

window.votePoll = async function(pollId, optionIndex, el) {
  if (el.closest('.poll-bar-wrap').classList.contains('voted')) { showToast('You already voted'); return; }
  const res = await authFetch(`/chat/polls/${pollId}/vote`, 'POST', { option_index: optionIndex });
  if (!res.ok) { const e = await res.json().catch(() => ({})); showToast(e.detail || 'Could not vote'); return; }
  const updated = await authFetch(`/chat/polls/${pollId}`);
  if (updated.ok) {
    const p = await updated.json();
    const card = document.querySelector(`[data-poll-id="${pollId}"]`);
    if (card) updatePollCard(card, p);
  }
};

// ── Boot (must be last — all consts/lets must be initialized first) ───────────

// ── Bots modal ───────────────────────────────────────────────────────────────────────────────
const BOT_AVATARS = ['🤖','🦾','🛸','🔧','🚀','🐧','🦊','⭐','⚡','🎯','🔥','💡'];
let botsData          = [];
let selectedBotAvatar = BOT_AVATARS[0];

function openBotsModal() {
  document.getElementById('botsOverlay').classList.remove('hidden');
  buildAvatarPickerModal();
  fetchBots();
  fetchTasks();
  _populateTaskChannelSelect();
}

window.closeBotsModal = function() {
  document.getElementById('botsOverlay').classList.add('hidden');
};

function buildAvatarPickerModal() {
  const el = document.getElementById('avatarPickModal');
  if (el.children.length) return;
  BOT_AVATARS.forEach(em => {
    const btn = document.createElement('button');
    btn.className = `av-btn${em === selectedBotAvatar ? ' sel' : ''}`;
    btn.textContent = em;
    btn.onclick = () => {
      selectedBotAvatar = em;
      el.querySelectorAll('.av-btn').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
    };
    el.appendChild(btn);
  });
}

async function fetchBots() {
  const el = document.getElementById('botListModal');
  el.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;">Loading…</div>';
  const res = await authFetch('/bots');
  if (!res.ok) { el.innerHTML = '<div style="color:#e55;font-size:.82rem;">Failed to load.</div>'; return; }
  botsData = await res.json();
  renderBotsModal();
}

function renderBotsModal() {
  const el = document.getElementById('botListModal');
  if (!botsData.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;padding:4px 0;">No bots yet — create one below.</div>';
    return;
  }
  el.innerHTML = '';
  botsData.forEach(b => {
    const webhookUrl = `${API}/bots/webhook/${b.webhook_token}`;
    const item = document.createElement('div');
    item.className = 'bot-item';
    item.innerHTML = `
      <div class="bot-avatar-em">${esc(b.avatar)}</div>
      <div class="bot-info">
        <div class="bot-name-lbl">${esc(b.name)}</div>
        <div class="bot-token-row">
          <span class="bot-token" title="${webhookUrl}">${webhookUrl}</span>
          <button class="copy-webhook-btn" onclick="copyBotWebhook('${webhookUrl}',this)">Copy</button>
        </div>
      </div>
      <button class="del-bot-btn" onclick="deleteBotModal(${b.id})">Remove</button>`;
    el.appendChild(item);
  });
}

window.createBotModal = async function() {
  const name = document.getElementById('botNameInputModal').value.trim();
  if (!name) { showToast('Enter a bot name'); return; }
  const res = await authFetch('/bots', 'POST', { name, avatar: selectedBotAvatar });
  if (!res.ok) { const e = await res.json().catch(() => ({})); showToast(e.detail || 'Create failed'); return; }
  const bot = await res.json();
  botsData.push(bot);
  renderBotsModal();
  document.getElementById('botNameInputModal').value = '';
  showToast(`✅ Bot “${bot.name}” created!`);
};

window.deleteBotModal = async function(id) {
  if (!confirm('Delete this bot? Its webhook URL will stop working.')) return;
  const res = await authFetch(`/bots/${id}`, 'DELETE');
  if (!res.ok) { showToast('Delete failed'); return; }
  botsData = botsData.filter(b => b.id !== id);
  renderBotsModal();
  showToast('Bot deleted');
};

window.copyBotWebhook = function(url, btn) {
  navigator.clipboard.writeText(url).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy', 2000);
  }).catch(() => showToast('Copy failed'));
};

// -----------------------------------------------------------------
// Recurring Tasks
// -----------------------------------------------------------------
let tasksData = [];

function _populateTaskChannelSelect() {
  const sel = document.getElementById('taskChannelSelect');
  if (!sel) return;
  sel.innerHTML = '';
  channels.forEach(ch => {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = ch.name;
    sel.appendChild(opt);
  });
}

async function fetchTasks() {
  const el = document.getElementById('taskListModal');
  el.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;">Loading…</div>';
  const res = await authFetch('/tasks');
  if (!res.ok) { el.innerHTML = '<div style="color:#e55;font-size:.82rem;">Failed to load tasks.</div>'; return; }
  tasksData = await res.json();
  renderTasks();
}

function renderTasks() {
  const el = document.getElementById('taskListModal');
  if (!tasksData.length) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;padding:4px 0;">No recurring tasks yet — add one below.</div>';
    return;
  }
  el.innerHTML = '';
  tasksData.forEach(t => {
    const chName = channels.find(c => c.id === t.channel_id)?.name || `#${t.channel_id}`;
    const interval = t.interval_minutes >= 1440
      ? `every ${t.interval_minutes / 1440}d`
      : t.interval_minutes >= 60
        ? `every ${t.interval_minutes / 60}h`
        : `every ${t.interval_minutes}m`;
    const lastRun = t.last_run ? new Date(t.last_run).toLocaleString() : 'never';
    const item = document.createElement('div');
    item.className = 'bot-item';
    item.style.cssText = 'align-items:flex-start;gap:10px;';
    item.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-size:.85rem;color:var(--text-primary);word-break:break-word;margin-bottom:3px;">${esc(t.message)}</div>
        <div style="font-size:.75rem;color:var(--text-muted);">${esc(chName)} &middot; ${interval} &middot; last: ${lastRun}</div>
        ${t.open_url ? `<div style="font-size:.72rem;color:#7ab4f5;margin-top:2px;">&#128279; ${esc(t.open_url)} <span style="color:var(--text-muted);">(for: ${t.url_target === 'channel' ? 'everyone in channel' : 'just me'})</span></div>` : ''}
        ${t.shell_cmd ? `<div style="font-size:.72rem;color:#f5c97a;margin-top:2px;">&#9881; ${esc(t.shell_cmd)}</div>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="modal-btn ${t.active ? 'primary' : 'secondary'}" style="padding:5px 10px;font-size:.78rem;"
          onclick="toggleTask(${t.id},this)">${t.active ? 'On' : 'Off'}</button>
        <button class="del-bot-btn" onclick="deleteTask(${t.id})">Remove</button>
      </div>`;
    el.appendChild(item);
  });
}

window.createTask = async function() {
  const msg      = document.getElementById('taskMsgInput').value.trim();
  const chanId   = parseInt(document.getElementById('taskChannelSelect').value);
  const interval = parseInt(document.getElementById('taskIntervalInput').value) || 1;
  const unit     = parseInt(document.getElementById('taskIntervalUnit').value);
  const openUrl  = document.getElementById('taskUrlInput')?.value.trim() || null;
  const shellCmd = document.getElementById('taskShellInput')?.value.trim() || null;
  const urlTarget = document.getElementById('taskUrlTarget')?.value || 'self';
  if (!msg) { showToast('Enter a message'); return; }
  if (!chanId) { showToast('Select a channel'); return; }
  const res = await authFetch('/tasks', 'POST', {
    message: msg,
    channel_id: chanId,
    interval_minutes: interval * unit,
    ...(openUrl  ? { open_url:  openUrl  } : {}),
    ...(shellCmd ? { shell_cmd: shellCmd } : {}),
    url_target: urlTarget,
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); showToast(e.detail || 'Failed to create task'); return; }
  const task = await res.json();
  tasksData.push(task);
  renderTasks();
  document.getElementById('taskMsgInput').value = '';
  document.getElementById('taskIntervalInput').value = '60';
  document.getElementById('taskIntervalUnit').value = '60';
  if (document.getElementById('taskUrlInput'))   document.getElementById('taskUrlInput').value = '';
  if (document.getElementById('taskShellInput')) document.getElementById('taskShellInput').value = '';
  showToast('✅ Recurring task created!');
};

window.deleteTask = async function(id) {
  if (!confirm('Delete this recurring task?')) return;
  const res = await authFetch(`/tasks/${id}`, 'DELETE');
  if (!res.ok) { showToast('Delete failed'); return; }
  tasksData = tasksData.filter(t => t.id !== id);
  renderTasks();
  showToast('Task deleted');
};

window.toggleTask = async function(id, btn) {
  const res = await authFetch(`/tasks/${id}/toggle`, 'PATCH');
  if (!res.ok) { showToast('Toggle failed'); return; }
  const updated = await res.json();
  tasksData = tasksData.map(t => t.id === id ? updated : t);
  renderTasks();
};

// ══════════════════════════════════════════════════════════════════════════════
// NEW FEATURES  (theme toggle, presence, settings, webhooks, audit log,
//                analytics, export, members, 2FA, sessions, markdown,
//                keyboard shortcuts, drafts, unread jump)
// ══════════════════════════════════════════════════════════════════════════════

// ── Markdown renderer (lightweight) ─────────────────────────────────────────
function renderMarkdown(rawText) {
  if (!rawText) return '';
  let s = esc(rawText);
  // Code blocks  ```lang\n…```  (with syntax highlighting via highlight.js)
  s = s.replace(/```([a-z]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    let highlighted = '';
    try {
      highlighted = lang && window.hljs && window.hljs.getLanguage(lang)
        ? window.hljs.highlight(code.trim(), { language: lang }).value
        : window.hljs ? window.hljs.highlightAuto(code.trim()).value : code.trim();
    } catch(e) { highlighted = code.trim(); }
    return `<pre class="hljs"><code>${highlighted}</code></pre>`;
  });
  // Inline code  `…`
  s = s.replace(/`([^`]+)`/g, '<code style="background:var(--bg-input);padding:1px 5px;border-radius:4px;font-family:monospace;font-size:.85em;">$1</code>');
  // Bold   **…**
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic *…* or _…_
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/_(.+?)_/g, '<em>$1</em>');
  // Strikethrough ~~…~~
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Block quote
  s = s.replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:3px solid var(--purple);padding-left:8px;color:var(--text-muted);margin:2px 0;">$1</blockquote>');
  // Link [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--purple-l);">$1</a>');
  // Bare URL
  s = s.replace(/(^|[\s])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener" style="color:var(--purple-l);">$2</a>');
  // Newlines
  s = s.replace(/\n/g, '<br>');
  return s;
}

// ── Theme toggle ─────────────────────────────────────────────────────────────
function initThemeToggle() {
  const btn = document.getElementById('themeToggleBtn');
  const cb  = document.getElementById('lightThemeCheckbox');
  const apply = (light) => {
    document.body.classList.toggle('light-theme', light);
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.innerHTML = light ? '<i class="fa-regular fa-sun"></i>' : '<i class="fa-regular fa-moon"></i>';
    const cb  = document.getElementById('lightThemeCheckbox');
    if (cb)  cb.checked = light;
    localStorage.setItem('synctact_theme', light ? 'light' : 'dark');
  };
  // Restore saved theme
  apply(localStorage.getItem('synctact_theme') === 'light');
  btn?.addEventListener('click', () => apply(!document.body.classList.contains('light-theme')));
  cb?.addEventListener('change', () => apply(cb.checked));
}
window.applyTheme = (light) => {
  document.body.classList.toggle('light-theme', light);
  const btn = document.getElementById('themeToggleBtn');
  const cb  = document.getElementById('lightThemeCheckbox');
  if (btn) btn.textContent = light ? '🌞' : '🌙';
  if (cb)  cb.checked = light;
  localStorage.setItem('synctact_theme', light ? 'light' : 'dark');
};

// ── Presence selector ────────────────────────────────────────────────────────
function initPresenceSelector() {
  const sel = document.getElementById('presenceSelect');
  if (!sel) return;
  // Restore current presence from stored user data
  const storedPres = myProfile?.presence || 'online';
  sel.value = storedPres;
  sel.addEventListener('change', async () => {
    const pres = sel.value;
    const res  = await authFetch('/users/me/presence', 'PATCH', { presence: pres });
    if (!res.ok) { showToast('Could not update presence'); return; }
    showToast({ online:'🟢 Online', away:'🟡 Away', dnd:'🔴 Do Not Disturb', offline:'⚫ Offline' }[pres] || '');
  });
}

// ── Draft messages ────────────────────────────────────────────────────────────
function saveDraft() {
  if (!activeType || !activeId) return;
  const key = `synctact_draft_${activeType}_${activeId}`;
  const val = msgInput.value;
  if (val) localStorage.setItem(key, val);
  else localStorage.removeItem(key);
}

function restoreDraft() {
  if (!activeType || !activeId) return;
  const key = `synctact_draft_${activeType}_${activeId}`;
  const val = localStorage.getItem(key) || '';
  msgInput.value = val;
  msgInput.style.height = 'auto';
  if (val) {
    msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + 'px';
  }
}

// Patch openChannel to save/restore drafts and show new buttons
const _origOpenChannel = window.openChannel;

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
function initKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    // Ctrl+K  — search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault(); openSearch();
    }
    // Escape — close modals/panels
    if (e.key === 'Escape') {
      ['settingsOverlay','webhooksOverlay','auditLogOverlay','analyticsOverlay',
       'exportOverlay','membersOverlay','searchOverlay'].forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.classList.contains('hidden')) el.classList.add('hidden');
      });
    }
    // Ctrl+/ — show keyboard shortcuts hint
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      showToast('⌨️ Shortcuts: Ctrl+K = Search  |  Esc = Close panels');
    }
  });
}

// ── Unread jump button ────────────────────────────────────────────────────────
let _unreadCount = 0;
function initUnreadJump() {
  const btn  = document.getElementById('unreadJumpBtn');
  const wrap = document.getElementById('messagesWrap');
  if (!btn || !wrap) return;
  wrap.addEventListener('scroll', () => {
    const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
    if (atBottom) { _unreadCount = 0; btn.style.display = 'none'; }
  });
  btn.addEventListener('click', () => {
    scrollToBottom();
    _unreadCount = 0;
    btn.style.display = 'none';
  });
}

function notifyUnread() {
  const wrap = document.getElementById('messagesWrap');
  const btn  = document.getElementById('unreadJumpBtn');
  if (!wrap || !btn) return;
  const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
  if (!atBottom) {
    _unreadCount++;
    btn.textContent = `↓ ${_unreadCount} new message${_unreadCount !== 1 ? 's' : ''}`;
    btn.style.display = 'block';
  }
}

// ── New feature handlers (header buttons + modals) ───────────────────────────
function initNewFeatureHandlers() {
  // Settings
  const settingsBtn = document.getElementById('settingsBtn');
  settingsBtn?.addEventListener('click', openSettingsModal);
  document.getElementById('closeSettingsBtn')?.addEventListener('click', () =>
    document.getElementById('settingsOverlay').classList.add('hidden'));
  // Settings tabs
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.settings-pane').forEach(p => p.classList.add('hidden'));
      tab.classList.add('active');
      const pane = document.getElementById('settings-' + tab.dataset.tab);
      if (pane) pane.classList.remove('hidden');
      if (tab.dataset.tab === '2fa')      load2FAStatus();
      if (tab.dataset.tab === 'sessions') loadSessionsList();
      if (tab.dataset.tab === 'server')   loadServerSettings();
    });
  });
  // 2FA buttons
  document.getElementById('twoFASetupBtn')?.addEventListener('click', setup2FA);
  document.getElementById('twoFAConfirmBtn')?.addEventListener('click', confirm2FA);
  document.getElementById('twoFADisableBtn')?.addEventListener('click', disable2FA);
  // Sessions
  document.getElementById('saveServerSettingsBtn')?.addEventListener('click', saveServerSettings);

  // Webhooks
  document.getElementById('webhooksHeaderBtn')?.addEventListener('click', () => {
    if (activeType !== 'channel') { showToast('Open a channel first'); return; }
    openWebhooksModal();
  });
  document.getElementById('closeWebhooksBtn')?.addEventListener('click', () =>
    document.getElementById('webhooksOverlay').classList.add('hidden'));
  document.getElementById('createWebhookBtn')?.addEventListener('click', createWebhook);

  // Audit log
  document.getElementById('auditLogBtn')?.addEventListener('click', openAuditLog);
  document.getElementById('closeAuditLogBtn')?.addEventListener('click', () =>
    document.getElementById('auditLogOverlay').classList.add('hidden'));

  // Analytics (attached to analytics modal channels + days filters)
  document.getElementById('closeAnalyticsBtn')?.addEventListener('click', () =>
    document.getElementById('analyticsOverlay').classList.add('hidden'));
  document.getElementById('refreshAnalyticsBtn')?.addEventListener('click', refreshAnalytics);

  // Export
  document.getElementById('exportBtn')?.addEventListener('click', () => {
    if (activeType !== 'channel') { showToast('Open a channel first'); return; }
    const ch = channels.find(c => c.id === activeId);
    document.getElementById('exportChannelName').textContent = ch ? '#' + ch.name : '#channel';
    document.getElementById('exportOverlay').classList.remove('hidden');
  });
  document.getElementById('cancelExportBtn')?.addEventListener('click', () =>
    document.getElementById('exportOverlay').classList.add('hidden'));
  document.getElementById('confirmExportBtn')?.addEventListener('click', doExport);

  // ── New feature buttons ────────────────────────────────────
  // Focus mode
  document.getElementById('focusModeBtn')?.addEventListener('click', () => {
    document.getElementById('headerOverflowMenu').classList.add('hidden');
    if (_focusActive) exitFocusMode();
    else startFocusMode(25);
  });
  document.getElementById('exitFocusBtn')?.addEventListener('click', exitFocusMode);

  // AI Summarize
  document.getElementById('summarizeBtn')?.addEventListener('click', () => {
    document.getElementById('headerOverflowMenu').classList.add('hidden');
    openSummarizeModal();
  });
  document.getElementById('closeSummarizeBtn')?.addEventListener('click', () =>
    document.getElementById('summarizeOverlay').classList.add('hidden'));

  // Channel analytics (per-channel deep dive)
  document.getElementById('analyticsChannelBtn')?.addEventListener('click', () => {
    document.getElementById('headerOverflowMenu').classList.add('hidden');
    openAnalyticsModal();
  });

  // Task board
  document.getElementById('taskBoardBtn')?.addEventListener('click', () => {
    document.getElementById('headerOverflowMenu').classList.add('hidden');
    openTaskBoard();
  });
  document.getElementById('closeTaskBoardBtn')?.addEventListener('click', () =>
    document.getElementById('taskBoardOverlay').classList.add('hidden'));

  // Meeting notes
  document.getElementById('meetingSummaryBtn')?.addEventListener('click', () => {
    document.getElementById('headerOverflowMenu').classList.add('hidden');
    openMeetingNotes();
  });
  document.getElementById('closeMeetingNotesBtn')?.addEventListener('click', () =>
    document.getElementById('meetingNotesOverlay').classList.add('hidden'));

  // Members
  document.getElementById('membersBtn')?.addEventListener('click', () => {
    if (activeType !== 'channel') return;
    openMembersModal();
  });
  document.getElementById('closeMembersBtn')?.addEventListener('click', () =>
    document.getElementById('membersOverlay').classList.add('hidden'));

  // Analytics sidebar entry (add to sidebar on load)
  _addAnalyticsToSidebar();
}

function _addAnalyticsToSidebar() {
  const bookmarksSection = document.querySelector('.sidebar-section:last-of-type');
  if (!bookmarksSection) return;
  // Add analytics section after bookmarks
  const analyticsSection = document.createElement('div');
  analyticsSection.className = 'sidebar-section';
  analyticsSection.style.marginTop = '12px';
  analyticsSection.innerHTML = `
    <div class="section-header">
      <span>Analytics</span>
      <button class="btn-add" title="Open analytics">📊</button>
    </div>`;
  analyticsSection.querySelector('button').addEventListener('click', openAnalyticsModal);
  bookmarksSection.after(analyticsSection);
}

// ── Settings modal ────────────────────────────────────────────────────────────
function openSettingsModal() {
  document.getElementById('settingsOverlay').classList.remove('hidden');
  // Load 2FA status on open
  load2FAStatus();
}

async function load2FAStatus() {
  const res = await authFetch('/auth/me');
  if (!res.ok) return;
  const me = await res.json();
  const statusEl  = document.getElementById('twoFAStatus');
  const setupBtn  = document.getElementById('twoFASetupBtn');
  const disableBtn = document.getElementById('twoFADisableBtn');
  const qrArea    = document.getElementById('twoFAQRArea');
  if (statusEl) statusEl.textContent = me.totp_enabled ? '✅ 2FA is enabled on your account.' : '⚠️ 2FA is not enabled.';
  if (setupBtn)   setupBtn.classList.toggle('hidden', me.totp_enabled);
  if (disableBtn) disableBtn.classList.toggle('hidden', !me.totp_enabled);
  if (qrArea)     qrArea.classList.add('hidden');
}

async function setup2FA() {
  const res = await authFetch('/auth/2fa/setup', 'POST', {});
  if (!res.ok) { showToast('Could not start 2FA setup'); return; }
  const data = await res.json();
  const qrEl = document.getElementById('twoFAQR');
  const qrArea = document.getElementById('twoFAQRArea');
  if (qrEl)  qrEl.src = data.qr_data_url;
  if (qrArea) qrArea.classList.remove('hidden');
  document.getElementById('twoFASetupBtn').classList.add('hidden');
}

async function confirm2FA() {
  const code = document.getElementById('twoFAConfirmCode')?.value?.trim();
  if (!code) { showToast('Enter the 6-digit code'); return; }
  const res = await authFetch('/auth/2fa/confirm', 'POST', { code });
  if (!res.ok) { const e = await res.json().catch(() => ({})); showToast(e.detail || 'Invalid code'); return; }
  showToast('✅ 2FA enabled!');
  load2FAStatus();
}

async function disable2FA() {
  if (!confirm('Disable two-factor authentication?')) return;
  const res = await authFetch('/auth/2fa', 'DELETE');
  if (!res.ok) { showToast('Could not disable 2FA'); return; }
  showToast('2FA disabled');
  load2FAStatus();
}

async function loadSessionsList() {
  const res = await authFetch('/auth/sessions');
  const el = document.getElementById('sessionsList');
  if (!el) return;
  if (!res.ok) { el.innerHTML = '<div style="color:var(--text-muted);">Failed to load sessions</div>'; return; }
  const sessions = await res.json();
  if (!sessions.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;">No active sessions found.</div>'; return; }
  el.innerHTML = sessions.map(s => `
    <div class="session-item">
      <div class="si-device">${esc(s.device || 'Unknown device')}</div>
      <div class="si-ip">${esc(s.ip_addr || '')}</div>
      <button class="session-revoke" onclick="revokeSession(${s.id}, this)">Revoke</button>
    </div>`).join('');
}

window.revokeSession = async function(id, btn) {
  const res = await authFetch(`/auth/sessions/${id}`, 'DELETE');
  if (!res.ok) { showToast('Failed to revoke session'); return; }
  btn.closest('.session-item')?.remove();
  showToast('Session revoked');
};

async function loadServerSettings() {
  const res = await authFetch('/settings');
  if (!res.ok) return;
  const data = await res.json();
  const nameEl = document.getElementById('settingServerName');
  const wlcEl  = document.getElementById('settingWelcomeMsg');
  if (nameEl) nameEl.value = data.server_name || '';
  if (wlcEl)  wlcEl.value  = data.welcome_message || '';
}

async function saveServerSettings() {
  const body = {};
  const name = document.getElementById('settingServerName')?.value?.trim();
  const wlc  = document.getElementById('settingWelcomeMsg')?.value?.trim();
  if (name) body.server_name = name;
  if (wlc)  body.welcome_message = wlc;
  const res = await authFetch('/settings', 'PATCH', body);
  if (!res.ok) { const e = await res.json().catch(() => ({})); showToast(e.detail || 'Could not save settings'); return; }
  showToast('✅ Settings saved!');
}

// ── Webhooks ──────────────────────────────────────────────────────────────────
async function openWebhooksModal() {
  document.getElementById('webhooksOverlay').classList.remove('hidden');
  await loadWebhooks();
}

async function loadWebhooks() {
  if (activeType !== 'channel') return;
  const res = await authFetch(`/webhooks?channel_id=${activeId}`);
  const el  = document.getElementById('webhooksList');
  if (!el) return;
  if (!res.ok) { el.innerHTML = '<div style="color:var(--text-muted);">Failed to load webhooks</div>'; return; }
  const whs = await res.json();
  if (!whs.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;">No webhooks yet.</div>'; return; }
  const base = `${API}/webhook/`;
  el.innerHTML = whs.map(w => `
    <div class="wh-item" data-wh-id="${w.id}">
      <span class="wh-name">${esc(w.name)}</span>
      <span class="wh-token" title="${esc(w.token)}">${esc(w.token.slice(0,12))}…</span>
      <button class="copy-wh-btn" onclick="navigator.clipboard.writeText('${base}${esc(w.token)}');showToast('Copied!')">Copy URL</button>
      <button class="del-wh-btn" onclick="deleteWebhook(${w.id})">Delete</button>
    </div>`).join('');
}

async function createWebhook() {
  const name = document.getElementById('webhookNameInput')?.value?.trim();
  if (!name) { showToast('Enter a webhook name'); return; }
  const res = await authFetch('/webhooks', 'POST', { channel_id: activeId, name });
  if (!res.ok) { const e = await res.json().catch(() => ({})); showToast(e.detail || 'Failed'); return; }
  document.getElementById('webhookNameInput').value = '';
  showToast('Webhook created!');
  await loadWebhooks();
}

window.deleteWebhook = async function(id) {
  if (!confirm('Delete this webhook?')) return;
  const res = await authFetch(`/webhooks/${id}`, 'DELETE');
  if (!res.ok) { showToast('Failed to delete'); return; }
  showToast('Webhook deleted');
  await loadWebhooks();
};

// ── Audit Log ─────────────────────────────────────────────────────────────────
async function openAuditLog() {
  document.getElementById('auditLogOverlay').classList.remove('hidden');
  const el = document.getElementById('auditLogList');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;">Loading…</div>';
  const cid = activeType === 'channel' ? activeId : null;
  const url = cid ? `/audit-log?limit=100&channel_id=${cid}` : '/audit-log?limit=100';
  const res = await authFetch(url);
  if (!res.ok) { el.innerHTML = '<div style="color:var(--text-muted);">Failed to load</div>'; return; }
  const rows = await res.json();
  if (!rows.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;text-align:center;padding:20px;">No audit events logged yet.</div>'; return; }
  const icons = { kick:'🥢', mute:'🔇', ban:'🔨', delete:'🗑️', pin:'📌', unpin:'📌', channel_delete:'❌', channel_create:'✅' };
  el.innerHTML = rows.map(r => `
    <div class="audit-item">
      <span class="audit-icon">${icons[r.action] || '📋'}</span>
      <div class="audit-detail"><b>${esc(r.action)}</b>${r.detail ? ' — ' + esc(r.detail) : ''}</div>
      <span class="audit-time">${formatTime(r.created_at)}</span>
    </div>`).join('');
}

// ── Analytics ─────────────────────────────────────────────────────────────────
async function openAnalyticsModal() {
  const overlay = document.getElementById('analyticsOverlay');
  overlay.classList.remove('hidden');
  // Populate channel filter
  const sel = document.getElementById('analyticsChannelFilter');
  if (sel) {
    sel.innerHTML = '<option value="">All channels</option>' +
      channels.map(c => `<option value="${c.id}"${c.id === activeId && activeType === 'channel' ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  }
  await refreshAnalytics();
}

async function refreshAnalytics() {
  const channelId = document.getElementById('analyticsChannelFilter')?.value || '';
  const days      = document.getElementById('analyticsDaysFilter')?.value || '7';
  const actUrl  = `/analytics/activity?days=${days}${channelId ? '&channel_id=' + channelId : ''}`;
  const lbUrl   = `/analytics/leaderboard?limit=10${channelId ? '&channel_id=' + channelId : ''}`;
  const [actRes, lbRes] = await Promise.all([authFetch(actUrl), authFetch(lbUrl)]);
  if (actRes.ok) {
    const data  = await actRes.json();
    const maxCnt = Math.max(1, ...data.map(d => d.count));
    const chartEl  = document.getElementById('activityChart');
    const labelEl  = document.getElementById('activityLabels');
    if (chartEl) {
      chartEl.innerHTML = data.map(d => {
        const pct = Math.round(d.count / maxCnt * 100);
        return `<div class="chart-bar" style="height:${Math.max(4, pct)}%;" title="${d.date}: ${d.count}"></div>`;
      }).join('');
    }
    if (labelEl) {
      labelEl.innerHTML = data.map(d => `<span>${d.date.slice(5)}</span>`).join('');
    }
  }
  if (lbRes.ok) {
    const lb = await lbRes.json();
    const maxCnt = Math.max(1, ...lb.map(e => e.count));
    const el = document.getElementById('leaderboardList');
    if (el) {
      el.innerHTML = lb.map((e, i) => `
        <div class="analytics-bar-row">
          <span class="analytics-bar-name">${i + 1}. ${esc(e.name)}</span>
          <div class="analytics-bar-track"><div class="analytics-bar-fill" style="width:${Math.round(e.count / maxCnt * 100)}%"></div></div>
          <span class="analytics-bar-count">${e.count}</span>
        </div>`).join('');
    }
  }
}

// ── Export ────────────────────────────────────────────────────────────────────
async function doExport() {
  if (activeType !== 'channel') return;
  const format = document.getElementById('exportFormat')?.value || 'json';
  const res = await authFetch(`/chat/channels/${activeId}/export?format=${format}`);
  if (!res.ok) { showToast('Export failed'); return; }
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href     = url;
  link.download = `channel_${activeId}.${format}`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  document.getElementById('exportOverlay').classList.add('hidden');
  showToast('📥 Export downloaded!');
}

// ── Channel Members ──────────────────────────────────────────────────────────
async function openMembersModal() {
  const overlay = document.getElementById('membersOverlay');
  overlay.classList.remove('hidden');
  const ch = channels.find(c => c.id === activeId);
  document.getElementById('membersModalTitle').textContent = '👥 ' + (ch ? '#' + ch.name + ' Members' : 'Members');
  const el = document.getElementById('membersList');
  el.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;padding:12px;">Loading…</div>';
  const res = await authFetch(`/channels/${activeId}/members`);
  if (!res.ok) { el.innerHTML = '<div style="color:var(--text-muted);">Failed to load members</div>'; return; }
  const members = await res.json();
  if (!members.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;text-align:center;padding:20px;">No members yet.</div>'; return; }
  const presenceIcon = { online:'🟢', away:'🟡', dnd:'🔴', offline:'⚫' };
  el.innerHTML = members.map(m => {
    const ini = (m.name || '?').charAt(0).toUpperCase();
    const avHtml = m.avatar ? `<div class="msg-sender-avatar" style="width:32px;height:32px;font-size:.75rem;margin-right:0;"><img src="${API + m.avatar}" alt="" /></div>`
                             : `<div class="msg-sender-avatar" style="width:32px;height:32px;font-size:.75rem;margin-right:0;">${ini}</div>`;
    const roleBadge = m.role !== 'member' ? `<span class="role-badge ${m.role}">${m.role}</span>` : '';
    return `<div class="user-pick-item">
      ${avHtml}
      <div style="flex:1;min-width:0;">
        <div style="font-size:.85rem;font-weight:600;">${esc(m.name)}${roleBadge}</div>
        <div style="font-size:.72rem;color:var(--text-muted);">${presenceIcon[m.presence] || '⚫'} ${m.presence}</div>
      </div>
    </div>`;
  }).join('');
}

// ── Augment openChannel for new buttons + draft handling ─────────────────────
// (openChannel already patched inline above to show new buttons + restore draft)

// ═══════════════════════════════════════════════════════════
// FEATURE: Focus Mode
// ═══════════════════════════════════════════════════════════
let _focusActive = false;
let _focusTimer  = null;
let _focusSecs   = 0;

function startFocusMode(minutes = 25) {
  if (_focusActive) { exitFocusMode(); return; }
  _focusActive = true;
  _focusSecs = minutes * 60;
  document.getElementById('focusbanner').style.display = 'block';
  _tickFocusTimer();
  _focusTimer = setInterval(_tickFocusTimer, 1000);
  authFetch('/users/me/presence', { method: 'PATCH', body: JSON.stringify({ presence: 'dnd' }) });
  showToast('🌙 Focus mode on — presence set to Do Not Disturb');
}
function _tickFocusTimer() {
  if (_focusSecs <= 0) { exitFocusMode(); return; }
  _focusSecs--;
  const m = String(Math.floor(_focusSecs / 60)).padStart(2,'0');
  const s = String(_focusSecs % 60).padStart(2,'0');
  const el = document.getElementById('focusbannerTimer');
  if (el) el.textContent = `(${m}:${s} left)`;
}
function exitFocusMode() {
  _focusActive = false;
  clearInterval(_focusTimer); _focusTimer = null;
  document.getElementById('focusbanner').style.display = 'none';
  authFetch('/users/me/presence', { method: 'PATCH', body: JSON.stringify({ presence: 'online' }) });
  showToast('Focus mode ended');
}

// ═══════════════════════════════════════════════════════════
// FEATURE: AI Channel Summarizer
// ═══════════════════════════════════════════════════════════
async function openSummarizeModal() {
  if (activeType !== 'channel') { showToast('Open a channel first'); return; }
  const overlay = document.getElementById('summarizeOverlay');
  const result  = document.getElementById('summarizeResult');
  overlay.classList.remove('hidden');
  result.textContent = 'Summarizing with Gemini AI…';
  try {
    const res = await authFetch(`/chat/channels/${activeId}/summarize`);
    const data = await res.json();
    if (!res.ok) { result.textContent = data.detail || 'Error from AI service.'; return; }
    result.textContent = data.summary;
  } catch(e) {
    result.textContent = 'Failed to reach AI service.';
  }
}

// ═══════════════════════════════════════════════════════════
// FEATURE: Task / Kanban Board
// ═══════════════════════════════════════════════════════════
let _boardTasks = [];
let _dragTaskId = null;

async function openTaskBoard() {
  if (activeType !== 'channel') { showToast('Open a channel first'); return; }
  document.getElementById('taskBoardOverlay').classList.remove('hidden');
  await reloadTaskBoard();
}

async function reloadTaskBoard() {
  const res = await authFetch(`/board-tasks?channel_id=${activeId}`);
  if (!res.ok) { showToast('Failed to load tasks'); return; }
  _boardTasks = await res.json();
  renderKanban();
}

function renderKanban() {
  const cols = ['todo', 'doing', 'done'];
  const labels = { todo: 'To Do', doing: 'In Progress', done: 'Done' };
  const wrap = document.getElementById('kanbanWrap');
  wrap.innerHTML = '';
  cols.forEach(status => {
    const tasks = _boardTasks.filter(t => t.status === status);
    const col = document.createElement('div');
    col.className = 'kanban-col';
    col.dataset.status = status;
    col.innerHTML = `
      <div class="kanban-col-header">
        <span>${labels[status]} (${tasks.length})</span>
        <button class="kanban-add-btn" title="Add task" data-status="${status}">＋</button>
      </div>
      ${tasks.map(t => `
        <div class="kanban-card" draggable="true" data-id="${t.id}">
          <div class="kc-title">${esc(t.title)}</div>
          <div class="kc-meta">
            <span>👤 ${esc(t.assignee_name || t.creator_name)}</span>
          </div>
          <button class="kc-del" data-id="${t.id}" title="Delete">✕</button>
        </div>`).join('')}
      <div class="kanban-new-row" id="kanban-new-${status}" style="display:none;">
        <input class="kanban-new-input" placeholder="Task title…" />
        <button class="kanban-new-save" data-status="${status}">Add</button>
      </div>`;
    // drag events
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async e => {
      e.preventDefault(); col.classList.remove('drag-over');
      if (_dragTaskId == null) return;
      await authFetch(`/board-tasks/${_dragTaskId}`, {
        method: 'PATCH', body: JSON.stringify({ status }) });
      await reloadTaskBoard();
    });
    wrap.appendChild(col);
  });
  // Wire up cards after render
  wrap.querySelectorAll('.kanban-card').forEach(card => {
    card.addEventListener('dragstart', () => { _dragTaskId = Number(card.dataset.id); card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  wrap.querySelectorAll('.kc-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      await authFetch(`/board-tasks/${id}`, { method: 'DELETE' });
      await reloadTaskBoard();
    });
  });
  wrap.querySelectorAll('.kanban-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = document.getElementById(`kanban-new-${btn.dataset.status}`);
      if (row) { row.style.display = 'flex'; row.querySelector('input').focus(); }
    });
  });
  wrap.querySelectorAll('.kanban-new-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const status = btn.dataset.status;
      const row  = document.getElementById(`kanban-new-${status}`);
      const inp  = row?.querySelector('input');
      const title = inp?.value.trim();
      if (!title) return;
      await authFetch('/board-tasks', {
        method: 'POST',
        body: JSON.stringify({ channel_id: activeId, title, status })
      });
      await reloadTaskBoard();
    });
  });
}

// Handle real-time task events from WebSocket
function handleTaskWsEvent(msg) {
  if (msg.type === 'task_created' || msg.type === 'task_updated') {
    const idx = _boardTasks.findIndex(t => t.id === msg.task.id);
    if (idx >= 0) _boardTasks[idx] = msg.task; else _boardTasks.push(msg.task);
    if (!document.getElementById('taskBoardOverlay').classList.contains('hidden')) renderKanban();
  } else if (msg.type === 'task_deleted') {
    _boardTasks = _boardTasks.filter(t => t.id !== msg.task_id);
    if (!document.getElementById('taskBoardOverlay').classList.contains('hidden')) renderKanban();
  }
}

// ═══════════════════════════════════════════════════════════
// FEATURE: Mood Board rendering
// ═══════════════════════════════════════════════════════════
function applyMoodBoardMode(isMoodboard) {
  const wrap = document.getElementById('messagesWrap');
  const inputArea = document.querySelector('.input-area');
  if (!wrap) return;
  if (isMoodboard) {
    wrap.classList.add('moodboard-grid');
    // Show hint in input placeholder
    if (msgInput) msgInput.placeholder = 'Paste an image URL to pin to mood board…';
  } else {
    wrap.classList.remove('moodboard-grid');
    if (msgInput) msgInput.placeholder = 'Message…';
  }
}

function renderMoodBoardMessage(msg) {
  // Returns an img card if content looks like an image URL
  const imgExtRe = /\.(jpg|jpeg|png|gif|webp|avif|svg)(\?.*)?$/i;
  const urlRe = /^https?:\/\//i;
  const src = (msg.file_url && imgExtRe.test(msg.file_url))
    ? msg.file_url
    : (urlRe.test(msg.content) && (imgExtRe.test(msg.content) || msg.content.includes('images.')))
      ? msg.content : null;
  if (!src) return null;
  const card = document.createElement('div');
  card.className = 'mood-img-card';
  card.innerHTML = `<img src="${src}" alt="" loading="lazy" />`;
  card.addEventListener('click', () => window.open(src, '_blank'));
  return card;
}

// ═══════════════════════════════════════════════════════════
// FEATURE: Meeting Notes Auto-Summary
// ═══════════════════════════════════════════════════════════
async function openMeetingNotes() {
  if (activeType !== 'channel') { showToast('Open a channel first'); return; }
  const overlay = document.getElementById('meetingNotesOverlay');
  const result  = document.getElementById('meetingNotesResult');
  overlay.classList.remove('hidden');
  result.textContent = 'Generating meeting notes from the last 2 hours…';
  try {
    const res = await authFetch(`/chat/channels/${activeId}/meeting-summary`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { result.textContent = data.detail || 'Error from AI service.'; return; }
    result.textContent = data.notes;
  } catch(e) {
    result.textContent = 'Failed to reach AI service.';
  }
}

// ── Mobile sidebar ────────────────────────────────────────────────────────────
function initMobileSidebar() {
  const btn     = document.getElementById('hamburgerBtn');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (!btn || !sidebar) return;
  const open  = () => { sidebar.classList.add('mobile-open');  overlay.classList.add('visible');    btn.innerHTML = '<i class="fa-solid fa-xmark"></i>'; };
  const close = () => { sidebar.classList.remove('mobile-open'); overlay.classList.remove('visible'); btn.innerHTML = '<i class="fa-solid fa-bars"></i>'; };
  btn.addEventListener('click', () => sidebar.classList.contains('mobile-open') ? close() : open());
  overlay.addEventListener('click', close);
}

// ── Notification sounds ────────────────────────────────────────────────────────
let _soundsEnabled = localStorage.getItem('synctact_sounds') !== 'off';
function playSound(type) {
  if (!_soundsEnabled) return;
  const ids = { message: 'sndMessage', mention: 'sndMention', callIn: 'sndCallIn', notif: 'sndNotif' };
  const el = document.getElementById(ids[type] || 'sndNotif');
  if (!el) return;
  el.currentTime = 0;
  el.play().catch(() => {});
}
function initNotificationSounds() {
  // Hook into channel_message to play sound
  const origHandle = window.handleServerMsg;
  if (!origHandle) return;
  // No re-wrap needed — playSound is called inside the switch cases
}

// ── Reminder polling ──────────────────────────────────────────────────────────
function initReminderPoll() {
  async function checkReminders() {
    try {
      const res = await authFetch('/remind/pending');
      if (!res.ok) return;
      const due = await res.json();
      due.forEach(r => {
        showToast(`⏰ Reminder: ${r.content}`, 'info', 8000);
        playSound('notif');
      });
    } catch(e) {}
  }
  setInterval(checkReminders, 60_000);
  setTimeout(checkReminders, 5_000); // check soon after login
}

// ── GIF Picker ────────────────────────────────────────────────────────────────
// Uses Tenor v2 — replace TENOR_KEY with your own key or set "" for trending only
const TENOR_KEY = '';
function openGifPicker() {
  document.getElementById('gifOverlay').classList.remove('hidden');
  document.getElementById('gifSearch').value = '';
  fetchGifs('trending');
}
async function fetchGifs(query) {
  const grid = document.getElementById('gifGrid');
  grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-muted);font-size:.8rem;">Loading…</div>';
  try {
    const endpoint = query === 'trending'
      ? `https://tenor.googleapis.com/v2/featured?key=${TENOR_KEY||'LIVDSRZULELA'}&limit=18&media_filter=gif`
      : `https://tenor.googleapis.com/v2/search?key=${TENOR_KEY||'LIVDSRZULELA'}&q=${encodeURIComponent(query)}&limit=18&media_filter=gif`;
    const r = await fetch(endpoint);
    const d = await r.json();
    grid.innerHTML = '';
    (d.results || []).forEach(item => {
      const url = item.media_formats?.gif?.url || item.url;
      const img = document.createElement('img');
      img.src = item.media_formats?.tinygif?.url || url;
      img.className = 'gif-thumb';
      img.title = item.content_description || '';
      img.addEventListener('click', () => {
        document.getElementById('gifOverlay').classList.add('hidden');
        wsSend({ type: 'channel_message', channel_id: activeId, content: '', file_url: url, file_name: 'gif' });
      });
      grid.appendChild(img);
    });
    if (!grid.children.length) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-muted);">No results</div>';
  } catch(e) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-muted);">Failed to load GIFs</div>';
  }
}

// ── File Browser ──────────────────────────────────────────────────────────────
function toggleFileBrowser() {
  const panel = document.getElementById('fileBrowserPanel');
  if (!panel) return;
  const isOpen = !panel.classList.contains('hidden');
  if (isOpen) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  loadFileBrowser();
}
async function loadFileBrowser() {
  const list = document.getElementById('fbList');
  if (!list) return;
  if (activeType !== 'channel' || !activeId) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:.8rem;padding:12px;text-align:center;">Open a channel first</div>';
    return;
  }
  list.innerHTML = '<div style="color:var(--text-muted);font-size:.8rem;padding:12px;">Loading…</div>';
  const res = await authFetch(`/files/${activeId}`);
  if (!res.ok) { list.innerHTML = '<div style="color:var(--text-muted);font-size:.8rem;padding:12px;">Failed to load</div>'; return; }
  const files = await res.json();
  if (!files.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:.8rem;padding:12px;text-align:center;">No files shared yet</div>'; return; }
  const extIcon = n => {
    if (!n) return 'fa-file';
    const ext = n.split('.').pop().toLowerCase();
    if (['jpg','jpeg','png','gif','webp','svg'].includes(ext)) return 'fa-file-image';
    if (['mp4','webm','mov'].includes(ext)) return 'fa-file-video';
    if (['mp3','wav','ogg'].includes(ext)) return 'fa-file-audio';
    if (['pdf'].includes(ext)) return 'fa-file-pdf';
    if (['zip','rar','gz'].includes(ext)) return 'fa-file-zipper';
    if (['doc','docx'].includes(ext)) return 'fa-file-word';
    if (['xls','xlsx'].includes(ext)) return 'fa-file-excel';
    return 'fa-file';
  };
  list.innerHTML = files.map(f => `
    <a class="fb-item" href="${API+f.file_url}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;">
      <i class="fa-solid ${extIcon(f.file_name)} fb-icon"></i>
      <span class="fb-name" title="${esc(f.file_name||'')}"> ${esc(f.file_name||'file')}</span>
      <span class="fb-date">${new Date(f.ts).toLocaleDateString()}</span>
    </a>`).join('');
}

// ── Events / Calendar ─────────────────────────────────────────────────────────
async function openEventsModal() {
  const overlay = document.getElementById('eventsOverlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  await loadEvents();
}
async function loadEvents() {
  const list = document.getElementById('eventsList');
  if (!list) return;
  const params = activeType === 'channel' ? `?channel_id=${activeId}` : '';
  const res = await authFetch(`/events${params}`);
  if (!res.ok) { list.innerHTML = '<div style="color:var(--text-muted);">Failed to load</div>'; return; }
  const events = await res.json();
  if (!events.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;text-align:center;padding:14px;">No events yet.</div>'; return; }
  const yesUsers  = e => e.rsvps.filter(r=>r.status==='yes').map(r=>r.name).join(', ') || '—';
  const maybeUsers= e => e.rsvps.filter(r=>r.status==='maybe').map(r=>r.name).join(', ') || '—';
  list.innerHTML = events.map(e => `
    <div class="event-card">
      <div class="event-title">${esc(e.title)}</div>
      ${e.description ? `<div style="font-size:.78rem;color:var(--text-muted);margin-bottom:4px;">${esc(e.description)}</div>` : ''}
      <div class="event-time"><i class="fa-regular fa-clock"></i> ${new Date(e.starts_at).toLocaleString()}${e.ends_at ? ' → ' + new Date(e.ends_at).toLocaleTimeString() : ''}</div>
      <div class="event-rsvps">
        <button class="rsvp-btn yes" onclick="rsvpEvent(${e.id},'yes')"><i class="fa-solid fa-check"></i> Yes (${e.rsvps.filter(r=>r.status==='yes').length})</button>
        <button class="rsvp-btn maybe" onclick="rsvpEvent(${e.id},'maybe')"><i class="fa-solid fa-circle-question"></i> Maybe (${e.rsvps.filter(r=>r.status==='maybe').length})</button>
        <button class="rsvp-btn no" onclick="rsvpEvent(${e.id},'no')"><i class="fa-solid fa-xmark"></i> No (${e.rsvps.filter(r=>r.status==='no').length})</button>
        ${e.creator_id===user.id ? `<button class="rsvp-btn" onclick="deleteEvent(${e.id})" style="margin-left:auto;color:var(--text-muted);border-color:var(--border);" title="Delete"><i class="fa-solid fa-trash"></i></button>` : ''}
      </div>
    </div>`).join('');
}
async function rsvpEvent(id, status) {
  await authFetch(`/events/${id}/rsvp?status=${status}`, { method: 'POST' });
  await loadEvents();
}
async function deleteEvent(id) {
  if (!confirm('Delete this event?')) return;
  await authFetch(`/events/${id}`, { method: 'DELETE' });
  await loadEvents();
}
async function createCalendarEvent() {
  const title = document.getElementById('eventTitle').value.trim();
  const desc  = document.getElementById('eventDesc').value.trim();
  const start = document.getElementById('eventStart').value;
  const end   = document.getElementById('eventEnd').value;
  if (!title || !start) { showToast('Title and start time required', 'error'); return; }
  const body = { title, description: desc || null, starts_at: new Date(start).toISOString(), channel_id: activeType === 'channel' ? activeId : null };
  if (end) body.ends_at = new Date(end).toISOString();
  const res = await authFetch('/events', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!res.ok) { showToast('Failed to create event', 'error'); return; }
  document.getElementById('eventTitle').value = '';
  document.getElementById('eventDesc').value  = '';
  document.getElementById('eventStart').value = '';
  document.getElementById('eventEnd').value   = '';
  showToast('Event created!');
  await loadEvents();
}

// ── Message Templates ─────────────────────────────────────────────────────────
async function openTemplatesModal() {
  document.getElementById('templatesOverlay')?.classList.remove('hidden');
  await loadTemplates();
}
async function loadTemplates() {
  const list = document.getElementById('templatesList');
  if (!list) return;
  const res = await authFetch('/templates');
  if (!res.ok) { list.innerHTML = '<div style="color:var(--text-muted);">Failed to load</div>'; return; }
  const tmpl = await res.json();
  if (!tmpl.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;text-align:center;padding:12px;">No templates yet.</div>'; return; }
  list.innerHTML = tmpl.map(t => `
    <div class="template-item">
      <span class="t-title">${esc(t.title)}</span>
      <span class="t-content">${esc(t.content)}</span>
      <button class="use-template-btn" onclick="useTemplate(${JSON.stringify(t.content).replace(/"/g,'&quot;')})">Use</button>
      <button class="del-template-btn" onclick="deleteTemplate(${t.id})" title="Delete"><i class="fa-solid fa-trash"></i></button>
    </div>`).join('');
}
function useTemplate(content) {
  const inp = document.getElementById('msgInput');
  if (inp) { inp.value = content; inp.focus(); }
  document.getElementById('templatesOverlay')?.classList.add('hidden');
}
async function saveTemplate() {
  const title   = document.getElementById('templateTitle').value.trim();
  const content = document.getElementById('templateContent').value.trim();
  if (!title || !content) { showToast('Title and content required', 'error'); return; }
  const res = await authFetch('/templates', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ title, content }) });
  if (!res.ok) { showToast('Failed to save', 'error'); return; }
  document.getElementById('templateTitle').value   = '';
  document.getElementById('templateContent').value = '';
  showToast('Template saved!');
  await loadTemplates();
}
async function deleteTemplate(id) {
  await authFetch(`/templates/${id}`, { method: 'DELETE' });
  await loadTemplates();
}

// ── User Blocking ─────────────────────────────────────────────────────────────
async function openBlocksModal() {
  document.getElementById('blocksOverlay')?.classList.remove('hidden');
  const list = document.getElementById('blocksList');
  if (!list) return;
  list.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;padding:12px;">Loading…</div>';
  const res = await authFetch('/blocks');
  if (!res.ok) { list.innerHTML = '<div style="color:var(--text-muted);">Failed to load</div>'; return; }
  const blocks = await res.json();
  if (!blocks.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;text-align:center;padding:14px;">No blocked users.</div>'; return; }
  list.innerHTML = blocks.map(b => `
    <div class="session-item">
      <span class="si-device">${esc(b.name)}</span>
      <button class="session-revoke" onclick="unblockUser(${b.blocked_id},this)">Unblock</button>
    </div>`).join('');
}
async function blockUser(uid, name) {
  const res = await authFetch(`/blocks/${uid}`, { method: 'POST' });
  if (res.ok) showToast(`${name} blocked`);
}
async function unblockUser(uid, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const res = await authFetch(`/blocks/${uid}`, { method: 'DELETE' });
  if (res.ok) { showToast('Unblocked'); await openBlocksModal(); }
}

// ── Badges ────────────────────────────────────────────────────────────────────
async function loadAndShowBadges(userId, containerEl) {
  if (!containerEl) return;
  const res = await authFetch(`/badges/${userId}`);
  if (!res.ok) return;
  const data = await res.json();
  containerEl.innerHTML = data.badges.map(b =>
    `<span class="badge-pill" style="background:${b.color}22;color:${b.color};border:1px solid ${b.color}55;">
      <i class="${b.icon}"></i> ${esc(b.label)}
    </span>`).join('');
}

// ── Video / Voice Call ────────────────────────────────────────────────────────
async function startCall() {
  if (activeType !== 'channel') { showToast('Open a channel to start a call', 'error'); return; }
  const res = await authFetch(`/channels/${activeId}/call`, { method: 'POST' });
  if (!res.ok) { showToast('Failed to start call', 'error'); return; }
  const { room_code } = await res.json();
  window.open(`/meeting.html?room=${room_code}&name=${encodeURIComponent(user.name)}&back=chat.html`, '_blank');
}
async function endCall() {
  if (activeType !== 'channel') return;
  await authFetch(`/channels/${activeId}/call`, { method: 'DELETE' });
  document.getElementById('callBar')?.classList.remove('visible');
}

// ── Channel archive / readonly (mod controls) ──────────────────────────────
async function toggleChannelArchive() {
  const ch = channels.find(c => c.id === activeId);
  if (!ch) return;
  const newVal = !ch.archived;
  const res = await authFetch(`/channels/${activeId}/settings`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ archived: newVal }),
  });
  if (res.ok) { ch.archived = newVal; showToast(newVal ? 'Channel archived' : 'Channel unarchived'); openChannel(ch); renderChannelList(); }
}
async function toggleChannelReadonly() {
  const ch = channels.find(c => c.id === activeId);
  if (!ch) return;
  const newVal = !ch.readonly;
  const res = await authFetch(`/channels/${activeId}/settings`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ readonly: newVal }),
  });
  if (res.ok) { ch.readonly = newVal; showToast(newVal ? 'Channel set to read-only' : 'Channel open for posting'); openChannel(ch); }
}

// ── Server Discovery ────────────────────────────────────────────────────────
async function loadDiscovery(containerEl) {
  if (!containerEl) return;
  containerEl.innerHTML = '<div style="color:var(--text-muted);font-size:.82rem;padding:12px;text-align:center;">Loading channels…</div>';
  const res = await fetch(`${API}/discovery`);
  if (!res.ok) { containerEl.innerHTML = '<div style="color:var(--text-muted);">Failed to load</div>'; return; }
  const list = await res.json();
  containerEl.innerHTML = list.map(ch => `
    <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;cursor:pointer;" onclick="window.location.href='chat.html'">
      <div style="font-weight:700;font-size:.9rem;"># ${esc(ch.name)}</div>
      ${ch.description ? `<div style="font-size:.78rem;color:var(--text-muted);margin-top:2px;">${esc(ch.description)}</div>` : ''}
      <div style="font-size:.7rem;color:var(--text-muted);margin-top:6px;">${ch.message_count} messages</div>
    </div>`).join('');
}

// ── Wire all new feature buttons ───────────────────────────────────────────
function initNewFeatureHandlers2() {
  // Call buttons
  document.getElementById('startCallBtn')?.addEventListener('click', startCall);
  document.getElementById('callJoinBtn')?.addEventListener('click', () => {
    const room = `ch${activeId}`;
    window.open(`/meeting.html?room=${room}&name=${encodeURIComponent(user.name)}`, '_blank');
  });
  document.getElementById('callEndBtn')?.addEventListener('click', endCall);

  // File browser
  document.getElementById('fileBrowserBtn')?.addEventListener('click', toggleFileBrowser);
  document.getElementById('closeFBBtn')?.addEventListener  ('click', () => document.getElementById('fileBrowserPanel')?.classList.add('hidden'));

  // Templates
  document.getElementById('templatesBtn')?.addEventListener('click', openTemplatesModal);
  document.getElementById('closeTemplatesBtn')?.addEventListener('click', () => document.getElementById('templatesOverlay')?.classList.add('hidden'));
  document.getElementById('saveTemplateBtn')?.addEventListener('click', saveTemplate);

  // Events
  document.getElementById('eventsBtn')?.addEventListener('click', openEventsModal);
  document.getElementById('closeEventsBtn')?.addEventListener('click', () => document.getElementById('eventsOverlay')?.classList.add('hidden'));
  document.getElementById('createEventBtn')?.addEventListener('click', createCalendarEvent);

  // GIF picker
  document.getElementById('gifOverlay')?.addEventListener('click', e => { if (e.target === document.getElementById('gifOverlay')) document.getElementById('gifOverlay').classList.add('hidden'); });
  document.getElementById('closeGifBtn')?.addEventListener('click', () => document.getElementById('gifOverlay')?.classList.add('hidden'));
  document.getElementById('gifSearchBtn')?.addEventListener('click', () => fetchGifs(document.getElementById('gifSearch').value.trim() || 'trending'));
  document.getElementById('gifSearch')?.addEventListener('keydown', e => { if (e.key === 'Enter') fetchGifs(e.target.value.trim() || 'trending'); });
  // Add GIF button to input area
  const inputActions = document.querySelector('.input-actions');
  if (inputActions && !document.getElementById('gifBtn')) {
    const gifBtn = document.createElement('button');
    gifBtn.id = 'gifBtn'; gifBtn.className = 'ia-btn'; gifBtn.title = 'GIF';
    gifBtn.innerHTML = '<i class="fa-solid fa-film"></i>';
    gifBtn.addEventListener('click', openGifPicker);
    inputActions.insertBefore(gifBtn, inputActions.firstChild);
  }

  // Blocked users
  document.getElementById('closeBlocksBtn')?.addEventListener('click', () => document.getElementById('blocksOverlay')?.classList.add('hidden'));

  // Add to settings sidebar entry
  const sidebarScroll = document.querySelector('.sidebar-scroll');
  if (sidebarScroll && !document.getElementById('discoverySidebarItem')) {
    const section = document.createElement('div');
    section.className = 'sidebar-section';
    section.style.marginTop = '12px';
    section.innerHTML = `<div class="section-header"><span>Tools</span></div>
      <ul class="channel-list">
        <li><button id="discoverySidebarItem" onclick="openEventsModal()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:0.82rem;padding:3px 14px;display:block;width:100%;text-align:left;"><i class="fa-regular fa-calendar" style="margin-right:6px;"></i>Events</button></li>
        <li><button onclick="openTemplatesModal()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:0.82rem;padding:3px 14px;display:block;width:100%;text-align:left;"><i class="fa-solid fa-rectangle-list" style="margin-right:6px;"></i>Templates</button></li>
        <li><button onclick="openBlocksModal()" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:0.82rem;padding:3px 14px;display:block;width:100%;text-align:left;"><i class="fa-solid fa-ban" style="margin-right:6px;"></i>Blocked Users</button></li>
      </ul>`;
    sidebarScroll.appendChild(section);
  }

  // Sound toggle in appearance settings tab
  const soundToggleWrap = document.getElementById('soundToggleWrap');
  if (soundToggleWrap) {
    soundToggleWrap.innerHTML = `
      <div class="sound-toggle">
        <label class="toggle-switch">
          <input type="checkbox" id="soundToggle" ${_soundsEnabled ? 'checked' : ''} />
          <span class="slider"></span>
        </label>
        <span style="font-size:.82rem;">Notification sounds</span>
      </div>`;
    document.getElementById('soundToggle')?.addEventListener('change', e => {
      _soundsEnabled = e.target.checked;
      localStorage.setItem('synctact_sounds', _soundsEnabled ? 'on' : 'off');
    });
  }

  // Notification sounds on channel_message (play sound via wrapper)
  document.addEventListener('synctact_new_msg', () => playSound('message'));
  document.addEventListener('synctact_mention', () => playSound('mention'));
}

if (!user || !token) {
  document.getElementById('authGate').classList.remove('hidden');
} else {
  document.getElementById('authGate').classList.add('hidden');
  initChat();
}