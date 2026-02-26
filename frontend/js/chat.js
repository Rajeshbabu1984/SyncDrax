/* =======================================================
   SyncDrax — In-Call Chat Controller
   ======================================================= */

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

    this._bind();
  }

  _bind() {
    // Send on button click
    this.sendBtn.addEventListener('click', () => this._send());

    // Send on Enter (Shift+Enter = newline)
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });

    // Auto-resize textarea
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 100) + 'px';
    });

    // Emoji picker toggle
    this.emojiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.emojiPicker.classList.toggle('hidden');
    });

    // Emoji click
    this.emojiPicker.addEventListener('click', (e) => {
      const char = e.target.textContent.trim();
      if (char) {
        const { selectionStart, selectionEnd } = this.inputEl;
        this.inputEl.value =
          this.inputEl.value.substring(0, selectionStart) +
          char +
          this.inputEl.value.substring(selectionEnd);
        this.inputEl.focus();
        this.emojiPicker.classList.add('hidden');
      }
    });

    // Close emoji picker on outside click
    document.addEventListener('click', () => this.emojiPicker.classList.add('hidden'));
  }

  _send() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.onSend(text);
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
  }

  /**
   * Render an incoming or outgoing message
   * @param {{from: string, text: string, ts: number, self: boolean}} msg
   */
  addMessage(msg) {
    const { from, text, ts, self } = msg;
    const time = this._formatTime(ts || Date.now());

    // Group consecutive messages from same sender
    const lastMsg = this.messagesEl.lastElementChild;
    const lastAuthor = lastMsg && lastMsg.dataset.author;
    const sameAuthor = lastAuthor === from && !lastMsg.classList.contains('chat-system-msg');

    if (sameAuthor) {
      // Append text to last bubble group
      const textEl = document.createElement('div');
      textEl.className = 'chat-msg-text';
      textEl.textContent = text;
      lastMsg.appendChild(textEl);
    } else {
      const el = document.createElement('div');
      el.className = `chat-msg${self ? ' own' : ''}`;
      el.dataset.author = from;

      const header = document.createElement('div');
      header.className = 'chat-msg-header';

      const nameEl = document.createElement('span');
      nameEl.className = 'chat-msg-name';
      nameEl.textContent = self ? 'You' : from;
      nameEl.style.color = self ? '' : this._colorFor(from);

      const timeEl = document.createElement('span');
      timeEl.className = 'chat-msg-time';
      timeEl.textContent = time;

      header.appendChild(nameEl);
      header.appendChild(timeEl);

      const textEl = document.createElement('div');
      textEl.className = 'chat-msg-text';
      textEl.textContent = text;

      el.appendChild(header);
      el.appendChild(textEl);
      this.messagesEl.appendChild(el);
    }

    this._scrollToBottom();

    // Badge
    if (!this.visible) {
      this.unread++;
      this._updateBadge();
    }
  }

  addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'chat-system-msg';
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
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  _formatTime(ts) {
    const d = new Date(ts);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  _colorFor(name) {
    const colors = ['#7c3aed','#059669','#dc2626','#d97706','#0284c7','#db2777','#16a34a','#9333ea'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }
}

window.ChatController = ChatController;
