/**
 * SyncDrax — Chat App (chatapp.js)
 */
'use strict';

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
let channels      = [];      // [{id, name, description}]
let activeType    = null;    // 'channel' | 'dm'
let activeId      = null;    // channel id or user id
let activeDmName  = '';
let dmUsers       = {};      // { user_id: {name, online} }
let typingTimers  = {};      // channel/dm → timer
let emojiTarget   = null;    // 'input' or message_id for reaction
let pendingEmoji  = '💬';   // selected channel emoji
let unread        = {};      // { cid: count }
let allUsers      = [];      // [{id, name}] from /chat/users

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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    sendTyping();
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

  // Auto-resize textarea
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + 'px';
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
    li.innerHTML = `<span class="ch-name">${esc(ch.name)}</span>`;
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
  await loadMessages('channel', ch.id);
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
  // Group by sender + within 5 min
  const last = wrap.lastElementChild;
  const lastSenderId = last?.dataset?.senderId;
  const lastTs       = last?.dataset?.ts ? parseInt(last.dataset.ts) : 0;
  const thisTsMs     = new Date(m.ts).getTime();
  const grouped      = lastSenderId === String(m.sender_id) && (thisTsMs - lastTs) < 5 * 60 * 1000;

  if (!grouped) {
    const group = document.createElement('div');
    group.className        = 'msg-group';
    group.dataset.senderId = m.sender_id;
    group.dataset.ts       = thisTsMs;
    group.innerHTML = `
      <div class="msg-header">
        <span class="msg-name">${esc(m.sender_name)}</span>
        <span class="msg-time">${formatTime(m.ts)}</span>
      </div>`;
    wrap.appendChild(group);
  }

  const group = wrap.lastElementChild;
  const bubble  = document.createElement('div');
  bubble.className       = 'msg-bubble';
  bubble.dataset.msgId   = m.id;

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
  inner += `<button class="react-btn" onclick="openReactionPicker(event, ${m.id})">😊+</button>`;
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
  if (!res.ok) { showToast('Could not create channel'); return; }
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

// ── Boot (must be last — all consts/lets must be initialized first) ───────────
if (!user || !token) {
  document.getElementById('authGate').classList.remove('hidden');
} else {
  document.getElementById('authGate').classList.add('hidden');
  initChat();
}
