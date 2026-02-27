/* =======================================================
   SyncDrax ï¿½ In-Call Chat Controller
   ======================================================= */

const CHAT_EMOJIS = ['ðŸ‘','â¤ï¸','ðŸ˜‚','ðŸŽ‰','ðŸ˜®','ðŸ‘','ðŸ”¥','ðŸ’¯'];

class ChatController {
  constructor({ messagesEl, inputEl, sendBtn, emojiBtn, emojiPicker, badgeEl, onSend }) {
    this.messagesEl  = messagesEl;
    this.inputEl     = inputEl;
    this.sendBtn     = sendBtn;
    this.emojiBtn    = emojiBtn;
    this.emojiPicker = emojiPicker;
    this.badgeEl     = badgeEl;
    this.onSend      = onSend || (() => {});
    this.unread      = 0;
    this.visible     = false;
    this._replyTo    = null;
    this._msgIdCounter = 0;

    this._replyBar     = document.getElementById('chatReplyBar');
    this._replyName    = document.getElementById('chatReplyName');
    this._replyPreview = document.getElementById('chatReplyPreview');
    this._replyCancel  = document.getElementById('chatReplyCancelBtn');

    if (this._replyCancel) {
      this._replyCancel.addEventListener('click', () => this._clearReply());
    }

    this._bind();
  }

  _bind() {
    this.sendBtn.addEventListener('click', () => this._send());

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
      if (e.key === 'Escape') this._clearReply();
    });

    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 100) + 'px';
    });

    this.emojiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.emojiPicker.classList.toggle('hidden');
    });

    this.emojiPicker.addEventListener('click', (e) => {
      const char = e.target.textContent.trim();
      if (char) {
        const { selectionStart, selectionEnd } = this.inputEl;
        this.inputEl.value =
          this.inputEl.value.substring(0, selectionStart) + char +
          this.inputEl.value.substring(selectionEnd);
        this.inputEl.focus();
        this.emojiPicker.classList.add('hidden');
      }
    });

    document.addEventListener('click', (e) => {
      this.emojiPicker.classList.add('hidden');
      document.querySelectorAll('.chat-emoji-msg-picker').forEach(p => {
        if (!p.contains(e.target)) p.remove();
      });
    });
  }

  _send() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    const replyTo = this._replyTo ? { ...this._replyTo } : null;
    this.onSend(text, replyTo);
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    this._clearReply();
  }

  _clearReply() {
    this._replyTo = null;
    if (this._replyBar) this._replyBar.classList.add('hidden');
  }

  _setReply(from, text) {
    this._replyTo = { from, text };
    if (this._replyName)    this._replyName.textContent    = from;
    if (this._replyPreview) this._replyPreview.textContent = text;
    if (this._replyBar)     this._replyBar.classList.remove('hidden');
    this.inputEl.focus();
  }

  addMessage(msg) {
    const { from, text, ts, self, replyTo } = msg;
    const time  = this._formatTime(ts || Date.now());
    const msgId = 'cmsg-' + (++this._msgIdCounter);

    const lastEl     = this.messagesEl.lastElementChild;
    const lastAuthor = lastEl?.dataset?.author;
    const sameAuthor = !replyTo
      && lastAuthor === from
      && lastEl && !lastEl.classList.contains('chat-system-msg');

    if (sameAuthor) {
      this._appendBubble(lastEl, msgId, text, self, from, replyTo);
    } else {
      const el = document.createElement('div');
      el.className      = `chat-msg${self ? ' own' : ''}`;
      el.dataset.author = from;

      const header  = document.createElement('div');
      header.className = 'chat-msg-header';

      const nameEl = document.createElement('span');
      nameEl.className   = 'chat-msg-name';
      nameEl.textContent = self ? 'You' : from;
      if (!self) nameEl.style.color = this._colorFor(from);

      const timeEl = document.createElement('span');
      timeEl.className   = 'chat-msg-time';
      timeEl.textContent = time;

      header.appendChild(nameEl);
      header.appendChild(timeEl);
      el.appendChild(header);
      this._appendBubble(el, msgId, text, self, from, replyTo);
      this.messagesEl.appendChild(el);
    }

    this._scrollToBottom();
    if (!this.visible) { this.unread++; this._updateBadge(); }
  }

  _appendBubble(groupEl, msgId, text, self, from, replyTo) {
    const wrap = document.createElement('div');
    wrap.className     = 'chat-bubble-wrap';
    wrap.dataset.msgId = msgId;
    wrap.style.position = 'relative';

    if (replyTo) {
      const q = document.createElement('div');
      q.className = 'chat-reply-quote';
      q.innerHTML = `<strong>${this._esc(replyTo.from)}</strong>${this._esc(replyTo.text)}`;
      wrap.appendChild(q);
    }

    const textEl = document.createElement('div');
    textEl.className   = 'chat-msg-text';
    textEl.textContent = text;
    wrap.appendChild(textEl);

    const reactRow = document.createElement('div');
    reactRow.className = 'chat-msg-reactions';
    wrap.appendChild(reactRow);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'chat-msg-actions';

    const reactBtn = document.createElement('button');
    reactBtn.className = 'chat-msg-action-btn';
    reactBtn.title     = 'React';
    reactBtn.innerHTML = 'ðŸ˜Š';
    reactBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleEmojiPicker(wrap, reactRow);
    });

    const replyBtn = document.createElement('button');
    replyBtn.className = 'chat-msg-action-btn';
    replyBtn.title     = 'Reply';
    replyBtn.innerHTML = '<i class="fa-solid fa-reply"></i>';
    replyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._setReply(from, text);
    });

    actions.appendChild(reactBtn);
    actions.appendChild(replyBtn);

    if (self) {
      const delBtn = document.createElement('button');
      delBtn.className = 'chat-msg-action-btn del';
      delBtn.title     = 'Delete';
      delBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        wrap.style.opacity    = '0';
        wrap.style.transition = 'opacity 0.2s';
        setTimeout(() => {
          wrap.remove();
          if (groupEl.querySelectorAll('.chat-bubble-wrap').length === 0) groupEl.remove();
        }, 200);
      });
      actions.appendChild(delBtn);
    }

    wrap.appendChild(actions);
    groupEl.appendChild(wrap);
  }

  _toggleEmojiPicker(wrapEl, reactRow) {
    document.querySelectorAll('.chat-emoji-msg-picker').forEach(p => p.remove());
    const picker = document.createElement('div');
    picker.className = 'chat-emoji-msg-picker';
    CHAT_EMOJIS.forEach(emoji => {
      const btn = document.createElement('button');
      btn.textContent = emoji;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._addReaction(reactRow, emoji);
        picker.remove();
      });
      picker.appendChild(btn);
    });
    wrapEl.appendChild(picker);
  }

  _addReaction(reactRow, emoji) {
    const existing = [...reactRow.querySelectorAll('.chat-reaction-pill')]
      .find(p => p.dataset.emoji === emoji);
    if (existing) {
      const cEl = existing.querySelector('.rp-count');
      cEl.textContent = parseInt(cEl.textContent) + 1;
      existing.classList.add('mine');
    } else {
      const pill = document.createElement('span');
      pill.className     = 'chat-reaction-pill mine';
      pill.dataset.emoji = emoji;
      pill.innerHTML     = `${emoji} <span class="rp-count">1</span>`;
      pill.addEventListener('click', () => {
        const cEl = pill.querySelector('.rp-count');
        const n   = parseInt(cEl.textContent) - 1;
        if (n <= 0) pill.remove();
        else { cEl.textContent = n; pill.classList.remove('mine'); }
      });
      reactRow.appendChild(pill);
    }
  }

  addSystemMessage(text) {
    const el = document.createElement('div');
    el.className   = 'chat-system-msg';
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this._scrollToBottom();
  }

  setVisible(v) {
    this.visible = v;
    if (v) {
      this.unread = 0;
      this._updateBadge();
      this._scrollToBottom();
      setTimeout(() => this.inputEl.focus(), 150);
    }
  }

  _updateBadge() {
    if (this.unread > 0) {
      this.badgeEl.textContent = this.unread > 9 ? '9+' : this.unread;
      this.badgeEl.classList.remove('hidden');
    } else {
      this.badgeEl.classList.add('hidden');
    }
  }

  _scrollToBottom() {
    requestAnimationFrame(() => { this.messagesEl.scrollTop = this.messagesEl.scrollHeight; });
  }

  _formatTime(ts) {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  }

  _colorFor(name) {
    const colors = ['#7c3aed','#059669','#dc2626','#d97706','#0284c7','#db2777','#16a34a','#9333ea'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return colors[Math.abs(h) % colors.length];
  }

  _esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
}

window.ChatController = ChatController;

