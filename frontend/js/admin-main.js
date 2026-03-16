// js/admin-main.js
// Entry point for admin.html.
// Two-panel layout: conversation list (left) + active chat (right).

document.addEventListener('DOMContentLoaded', () => {
  const loginModal  = document.getElementById('admin-login-modal');
  const passInput   = document.getElementById('admin-pass-input');
  const loginBtn    = document.getElementById('admin-login-btn');
  const logoutBtn   = document.getElementById('logout-btn');
  const msgInput    = document.getElementById('msg-input');
  const sendBtn     = document.getElementById('send-btn');
  const convList    = document.getElementById('conv-list');
  const chatPanel   = document.getElementById('chat-panel');
  const emptyState  = document.getElementById('empty-state');
  const activeName  = document.getElementById('active-conv-name');
  const activeTime  = document.getElementById('active-conv-time');

  let sbClient     = null;
  let activeConvId = null;
  let conversations = {};  // id → { id, nickname, last_message_at, last_message, unread }

  // ── Session persistence ───────────────────────────────
  const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

  function _isSessionValid() {
    const ts = sessionStorage.getItem('admin_auth_ts');
    return ts && (Date.now() - parseInt(ts, 10)) < SESSION_DURATION_MS;
  }

  function _saveSession() {
    sessionStorage.setItem('admin_auth_ts', Date.now().toString());
  }

  function _clearSession() {
    sessionStorage.removeItem('admin_auth_ts');
  }

  // ── Login ─────────────────────────────────────────────
  if (_isSessionValid()) {
    loginModal.setAttribute('hidden', '');
    _bootAdmin();
  } else {
    loginModal.removeAttribute('hidden');
    setTimeout(() => passInput.focus(), 100);
  }

  function tryLogin() {
    if (passInput.value === Config.adminPassword) {
      _saveSession();
      loginModal.setAttribute('hidden', '');
      _bootAdmin();
    } else {
      UI.showToast('Wrong password');
      passInput.value = '';
      passInput.focus();
    }
  }

  loginBtn.addEventListener('click', tryLogin);
  passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      _clearSession();
      window.location.reload();
    });
  }

  // ── Boot ──────────────────────────────────────────────
  async function _bootAdmin() {
    sbClient = Chat.getClient();
    await _loadConversations();
    _subscribeGlobalRealtime();
  }

  // ── Load all conversations ─────────────────────────────
  async function _loadConversations() {
    const { data, error } = await sbClient
      .from('conversations')
      .select('*')
      .order('last_message_at', { ascending: false });

    if (error) {
      console.error('[Admin] loadConversations error:', error);
      UI.showToast('Could not load conversations');
      return;
    }

    (data || []).forEach((conv) => {
      conversations[conv.id] = { ...conv, unread: 0 };
    });

    _renderConvList();
  }

  // ── Global real-time: sidebar list updates ─────────────
  // Watches ALL new messages and conversations so the sidebar
  // stays live. The active chat's messages are handled separately
  // by chat.js with a per-conversation filter.
  function _subscribeGlobalRealtime() {
    sbClient
      .channel('admin:global')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        async (payload) => {
          const msg = payload.new;
          const cid = msg.conversation_id;

          // Fetch conversation if we haven't seen it yet
          if (!conversations[cid]) {
            const { data } = await sbClient
              .from('conversations')
              .select('*')
              .eq('id', cid)
              .single();
            if (data) conversations[cid] = { ...data, unread: 0 };
          }

          if (conversations[cid]) {
            conversations[cid].last_message_at = msg.created_at;
            conversations[cid].last_message = msg.content;

            // Only badge unread for user messages in non-active conversations
            if (msg.sender === 'user' && cid !== activeConvId) {
              conversations[cid].unread = (conversations[cid].unread || 0) + 1;
            }
          }

          _renderConvList();
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'conversations' },
        (payload) => {
          const conv = payload.new;
          if (!conversations[conv.id]) {
            conversations[conv.id] = { ...conv, unread: 0 };
            _renderConvList();
          }
        }
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR') UI.setConnStatus('⚠ Real-time disconnected', true);
        if (status === 'SUBSCRIBED') UI.setConnStatus('');
      });
  }

  // ── Render conversation list ───────────────────────────
  function _renderConvList() {
    const sorted = Object.values(conversations).sort((a, b) =>
      new Date(b.last_message_at || b.created_at) - new Date(a.last_message_at || a.created_at)
    );

    convList.innerHTML = '';

    if (sorted.length === 0) {
      convList.innerHTML = '<div class="conv-empty">No conversations yet</div>';
      return;
    }

    sorted.forEach((conv) => {
      const hasUnread = conv.unread > 0;
      const isActive  = conv.id === activeConvId;

      const item = document.createElement('div');
      item.className = [
        'conv-item',
        isActive  ? 'active'     : '',
        hasUnread ? 'has-unread' : '',
      ].filter(Boolean).join(' ');

      item.dataset.id = conv.id;

      const time = _formatTime(new Date(conv.last_message_at || conv.created_at));

      const previewText = conv.last_message || '';
      const preview = previewText
        ? UI.escapeHtml(previewText.length > 42 ? previewText.substring(0, 42) + '…' : previewText)
        : `<span class="conv-preview-empty">No messages yet</span>`;

      const unreadBadge = hasUnread
        ? `<span class="unread-badge">${conv.unread}</span>`
        : '';

      item.innerHTML = `
        <div class="conv-avatar">${UI.escapeHtml((conv.nickname || '?')[0].toUpperCase())}</div>
        <div class="conv-info">
          <div class="conv-header-row">
            <span class="conv-name">${UI.escapeHtml(conv.nickname || 'Visitor')}</span>
            <span class="conv-time">${time}</span>
          </div>
          <div class="conv-preview">${preview}${unreadBadge}</div>
        </div>
      `;

      item.addEventListener('click', () => _openConversation(conv.id));
      convList.appendChild(item);
    });
  }

  // ── Open a conversation ────────────────────────────────
  function _openConversation(convId) {
    activeConvId = convId;

    if (conversations[convId]) {
      conversations[convId].unread = 0;
    }

    const conv = conversations[convId];
    activeName.textContent = conv ? (conv.nickname || 'Visitor') : 'Visitor';
    activeTime.textContent = conv
      ? 'Started ' + _formatTime(new Date(conv.created_at))
      : '';

    emptyState.style.display = 'none';
    chatPanel.style.display = 'flex';

    msgInput.disabled = false;
    sendBtn.disabled  = false;

    // chat.js handles history load + per-conversation real-time subscription
    Chat.init(convId);

    _renderConvList();
    msgInput.focus();
  }

  // ── Send ──────────────────────────────────────────────
  msgInput.addEventListener('input', () => UI.autoResize(msgInput));

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      _handleSend();
    }
  });

  sendBtn.addEventListener('click', _handleSend);

  async function _handleSend() {
    const text = msgInput.value.trim();
    if (!text || !activeConvId) return;

    msgInput.value = '';
    UI.autoResize(msgInput);
    sendBtn.disabled = true;

    const ok = await Chat.send(text, 'Host', true);
    if (!ok) UI.showToast('Failed to send — please try again');

    sendBtn.disabled = false;
    msgInput.focus();
  }

  // ── Time formatter ─────────────────────────────────────
  function _formatTime(date) {
    const now      = new Date();
    const diffDays = Math.floor((now - date) / 86400000);

    if (diffDays === 0) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7)  return date.toLocaleDateString('en-US', { weekday: 'short' });
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
});