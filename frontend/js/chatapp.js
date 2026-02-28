/**
 * SyncDrax — Chat App (chatapp.js)
 */
'use strict';

// ── Migrate old localStorage keys (syncora_ → syncdrax_) ────────────────────
(function migrateLegacyKeys() {
  const AUTH_VERSION = '3'; // bump this whenever the JWT secret changes
  if (localStorage.getItem('syncdrax_auth_v') !== AUTH_VERSION) {
    // Wipe all auth — forces fresh sign-in with new secret key
    localStorage.removeItem('syncdrax_token');
    localStorage.removeItem('syncdrax_user');
    localStorage.removeItem('syncora_token');
    localStorage.removeItem('syncora_user');
    localStorage.setItem('syncdrax_auth_v', AUTH_VERSION);
  }
})();

const API = typeof API_BASE !== 'undefined' ? API_BASE : 'http://localhost:8000';
const WSS = typeof WS_BASE  !== 'undefined' ? WS_BASE  : 'ws://localhost:8000';

// ── Auth ──────────────────────────────────────────────────────────────────────
function getUser()  { try { return JSON.parse(localStorage.getItem('syncdrax_user')); } catch { return null; } }
function getToken() { return localStorage.getItem('syncdrax_token') || ''; }

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

// ── State ─────────────────────────────────────────────────────────────────────
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
let allUsers      = [];      // [{id, name}] from /chat/users
let threadParentId   = null;
let threadParentData = null;
let searchTimeout    = null;

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

  buildEmojiPicker();
  buildChannelEmojiPicker();

  await loadChannels();
  await loadUsers();
  connectWS();

  // Auto-open first channel
  if (channels.length) openChannel(channels[0]);

  // Event listeners
  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', e => {
    const dropdownOpen = !slashDropdownEl.classList.contains('hidden');
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (dropdownOpen) {
        // Select active item — fill command into input, keep focus
        const active = slashDropdownEl.querySelector('.slash-cmd-item.active');
        if (active) {
          const cmdName = active.querySelector('.slash-cmd-name').textContent;
          msgInput.value = cmdName + ' ';
          msgInput.dispatchEvent(new Event('input'));  // re-filter dropdown
        }
        return;  // don't send yet
      }
      sendMessage();
    }
    if (e.key === 'Escape') hideSlashDropdown();
    if (e.key === 'ArrowDown') { if (dropdownOpen) { slashSelectDelta(1); e.preventDefault(); } }
    if (e.key === 'ArrowUp')   { if (dropdownOpen) { slashSelectDelta(-1); e.preventDefault(); } }
    sendTyping();
  });
  msgInput.addEventListener('input', () => {
    const v = msgInput.value;
    if (v.startsWith('/')) showSlashDropdown(v);
    else hideSlashDropdown();
  });
  addChannelBtn.addEventListener('click', openAddChannelModal);
  addDmBtn.addEventListener('click', openDmModal);
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
  document.getElementById('searchInput').addEventListener('input', e => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (q.length < 2) {
      document.getElementById('searchResults').innerHTML = '<div class="search-empty">Type to search across all channels and DMs</div>';
      return;
    }
    searchTimeout = setTimeout(() => doSearch(q), 350);
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

  // Auto-resize textarea
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + 'px';
  });

  // New features
  initPushNotifications();
  initPollHandlers();
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
        appendMessage(m, false);
        scrollToBottom();
      } else {
        unread[m.channel_id] = (unread[m.channel_id] || 0) + 1;
        updateUnreadBadge(m.channel_id);
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
      // Reload pinned bar for all users (handles remote pin/unpin; local already handled optimistically)
      if (activeType === 'channel') loadPinnedMessages(activeId);
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
  }
}

// ── Channels ──────────────────────────────────────────────────────────────────
async function loadChannels() {
  const res = await authFetch('/chat/channels');
  if (!res.ok) return;
  channels = await res.json();
  renderChannelList();
}

function renderChannelList() {
  channelListEl.innerHTML = '';
  channels.forEach(ch => {
    const li = document.createElement('li');
    li.className = `ch-item${activeType === 'channel' && activeId === ch.id ? ' active' : ''}`;
    li.dataset.id = ch.id;
    const isOwner = ch.created_by !== 0 && ch.created_by === user.id;
    const delBtn  = isOwner
      ? `<button class="ch-del-btn" onclick="deleteChannel(event,${ch.id})" title="Delete channel">✕</button>`
      : '';
    li.innerHTML = `<span class="ch-name">${esc(ch.name)}</span>${delBtn}`;
    if (unread[ch.id]) {
      li.innerHTML += `<span class="ch-badge">${unread[ch.id]}</span>`;
    }
    li.addEventListener('click', () => openChannel(ch));
    channelListEl.appendChild(li);
  });
}

async function openChannel(ch) {
  activeType  = 'channel';
  activeId    = ch.id;
  activeDmName = '';
  unread[ch.id] = 0;
  chatTitle.textContent  = ch.name;
  chatDesc.textContent   = ch.description || '';
  msgInput.placeholder   = `Message ${ch.name}`;
  messagesWrap.innerHTML = '<div style="color:var(--text-muted);font-size:.8rem;padding:20px 0;">Loading…</div>';
  renderChannelList();
  await Promise.all([loadMessages('channel', ch.id), loadPinnedMessages(ch.id)]);
}

// ── DMs ───────────────────────────────────────────────────────────────────────
async function loadUsers() {
  const res = await authFetch('/chat/users');
  if (!res.ok) return;
  allUsers = await res.json();
  allUsers.forEach(u => { dmUsers[u.id] = { name: u.name, online: false }; });
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
    li.innerHTML = `
      <div class="dm-avatar">${initial}<span class="dm-dot${info.online ? ' online' : ''}"></span></div>
      <span class="ch-name">${esc(info.name)}</span>${badge}`;
    li.addEventListener('click', () => openDm(numId, info.name));
    dmListEl.appendChild(li);
  });
}

async function openDm(uid, name) {
  activeType   = 'dm';
  activeId     = uid;
  activeDmName = name;
  unread[`dm_${uid}`] = 0;
  chatTitle.textContent  = `@ ${name}`;
  chatDesc.textContent   = '';
  msgInput.placeholder   = `Message ${name}`;
  messagesWrap.innerHTML = '<div style="color:var(--text-muted);font-size:.8rem;padding:20px 0;">Loading…</div>';
  renderDmList();
  await loadMessages('dm', uid);
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
    group.innerHTML = `
      <div class="msg-header">
        <span class="msg-name">${esc(m.sender_name)}${botBadge}</span>
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
  if (m.content) inner += `<span class="msg-text">${esc(m.content)}</span>`;
  if (m.file_url) {
    const fullUrl   = API + m.file_url;
    const isImage   = /\.(png|jpg|jpeg|gif|webp)$/i.test(m.file_url);
    if (isImage) {
      inner += `<a href="${fullUrl}" target="_blank"><img class="msg-img" src="${fullUrl}" alt="${esc(m.file_name||'image')}" /></a>`;
    } else {
      inner += `<a class="msg-file" href="${fullUrl}" target="_blank" download="${esc(m.file_name||'file')}"><i class="fa-solid fa-file"></i>${esc(m.file_name||'file')}</a>`;
    }
  }
  // Show pin button only to channel owner (created_by === 0 means seeded/system channel — anyone can pin)
  const activeChannel = activeType === 'channel' ? channels.find(c => c.id === activeId) : null;
  const canPin = activeType === 'dm' || !activeChannel || activeChannel.created_by === 0 || activeChannel.created_by === user.id;

  const isSender = m.sender_id === user.id;
  if (isSender) bubble.dataset.senderSelf = '1';

  inner += `<span class="msg-actions">
    <button class="react-btn" onclick="openReactionPicker(event,${m.id})" title="React">😊</button>
    ${canPin ? `<button class="react-btn pin-msg-btn" onclick="togglePin(${m.id})" title="${m.pinned ? 'Unpin' : 'Pin'}"${m.pinned ? ' style="color:var(--purple-l)"' : ''}>📌</button>` : ''}
    <button class="react-btn" onclick="openThreadById(${m.id})" title="Reply in thread">🧵</button>
    ${isSender ? `<button class="react-btn del-msg-btn" onclick="deleteMessage(${m.id})" title="Delete message">🗑️</button>` : ''}
  </span>`;
  inner += `<div class="reactions-row"></div>`;
  bubble.innerHTML = inner;

  buildReactionRow(bubble.querySelector('.reactions-row'), m.id, m.reactions || {});
  group.appendChild(bubble);
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
  { cmd: '/meet',    icon: '📹', desc: 'Create a meeting room link' },
  { cmd: '/poll',    icon: '📊', desc: '/poll Question | Option1 | Option2' },
  { cmd: '/roll',    icon: '🎲', desc: '/roll [max] — roll a random number' },
  { cmd: '/coin',    icon: '🪙', desc: 'Flip a coin' },
  { cmd: '/remind',  icon: '⏰', desc: '/remind 10m Your reminder text' },
  { cmd: '/giphy',   icon: '🎞️', desc: '/giphy search term — post a GIF' },
  { cmd: '/weather', icon: '🌤️', desc: '/weather city — current weather' },
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

async function _postSyncBot(content) {
  const body = { content, bot_name: 'SyncBot' };
  if (activeType === 'channel') body.channel_id    = activeId;
  else                          body.dm_to_user_id = activeId;
  await authFetch('/chat/syncbot', 'POST', body);
}

async function executeSlashCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();

  if (cmd === '/coin') {
    const result = Math.random() < 0.5 ? '🪙 Heads!' : '🪙 Tails!';
    await _postSyncBot(result);
    return;
  }

  if (cmd === '/roll') {
    const max = parseInt(parts[1]) || 6;
    const n   = Math.floor(Math.random() * max) + 1;
    await _postSyncBot(`🎲 Rolled a **${n}** (1–${max})`);
    return;
  }

  if (cmd === '/meet') {
    const code = Math.random().toString(36).substr(2, 6).toUpperCase();
    const url  = `${window.location.origin}/meeting.html?room=${code}`;
    await _postSyncBot(`📹 Meeting room ready → [Join ${code}](${url})`);
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
      const payload = { content: `🎞️ ${query}`, file_url: url, file_name: `${query}.gif` };
      if (activeType === 'channel') { payload.type = 'channel_message'; payload.channel_id = activeId; }
      else                          { payload.type = 'dm'; payload.to_user_id = activeId; }
      wsSend(payload);
    } catch { showToast('Giphy error'); }
    return;
  }

  if (cmd === '/weather') {
    const city = parts.slice(1).join('+') || 'London';
    try {
      const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
      const text2 = await r.text();
      if (!text2 || r.status !== 200) { showToast('Weather unavailable'); return; }
      await _postSyncBot(`🌤️ ${text2.trim()}`);
    } catch { showToast('Weather fetch failed'); }
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
async function authFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  };
  if (body) opts.body = JSON.stringify(body);
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

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// Expose globally for inline onclick
window.openReactionPicker = openReactionPicker;
window.togglePin          = togglePin;
window.openThreadById     = openThreadById;
window.deleteChannel      = deleteChannel;
window.deleteMessage      = deleteMessage;

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
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  badge.textContent = `📌 ${msgs.length} pinned`;
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
  setTimeout(() => document.getElementById('searchInput').focus(), 50);
}

function closeSearch() {
  document.getElementById('searchOverlay').classList.add('hidden');
}

async function doSearch(q) {
  const res = await authFetch(`/chat/search?q=${encodeURIComponent(q)}`);
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
    new Notification(`SyncDrax — ${senderName}`, {
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
  const totalVotes = p.options.reduce((s, o) => s + o.count, 0);
  const myVote     = p.options.findIndex(o => o.voters && o.voters.includes(user.id));
  card.innerHTML = `
    <h4>${esc(p.question)} <span class="poll-badge">Poll by ${esc(p.creator_name)}</span></h4>
    ${p.options.map((opt, i) => {
      const pct = totalVotes ? Math.round(opt.count / totalVotes * 100) : 0;
      const voted = myVote >= 0;
      return `<div class="poll-option">
        <div class="poll-bar-wrap${voted ? ' voted' : ''}" data-option="${i}" onclick="votePoll(${p.id},${i},this)">
          <div class="poll-bar" style="width:${pct}%"></div>
          <div class="poll-bar-label">
            <span>${esc(opt.label)}</span>
            <span style="color:var(--text-muted)">${pct}%</span>
          </div>
        </div>
      </div>`;
    }).join('')}
    <div class="poll-total">${totalVotes} vote${totalVotes !== 1 ? 's' : ''}</div>`;
}

function updatePollCard(card, p) {
  buildPollCard(card, p);
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
if (!user || !token) {
  document.getElementById('authGate').classList.remove('hidden');
} else {
  document.getElementById('authGate').classList.add('hidden');
  initChat();
}
