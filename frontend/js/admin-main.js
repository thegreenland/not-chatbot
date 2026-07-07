// js/admin-main.js
// Entry point for admin.html.
// Two-panel layout: conversation list (left) + active chat (right).


document.addEventListener('DOMContentLoaded', () => {
  const loginModal  = document.getElementById('admin-login-modal');
  const emailInput  = document.getElementById('admin-email-input');
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

  let sbClient = null;
  let activeConvId = null;
  let conversations = {};
  let previewPollTimer = null;
  let lastSeenByConversation = {};

  function _loadLastSeenState() {
    try {
      const raw = localStorage.getItem('admin-last-seen');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          lastSeenByConversation = parsed;
        }
      }
    } catch (err) {
      console.warn('[Admin] last-seen state load failed', err);
      lastSeenByConversation = {};
    }
  }

  function _saveLastSeenState() {
    try {
      localStorage.setItem('admin-last-seen', JSON.stringify(lastSeenByConversation));
    } catch (err) {
      console.warn('[Admin] last-seen state save failed', err);
    }
  }

  function _getLastSeenAt(cid) {
    return lastSeenByConversation[cid]
      || conversations[cid]?.lastSeenAt
      || conversations[cid]?.last_message_at
      || conversations[cid]?.created_at
      || '1970-01-01T00:00:00.000Z';
  }

  function _setConversationSeen(cid, timestamp) {
    const seenAt = timestamp
      || conversations[cid]?.last_message_at
      || conversations[cid]?.created_at
      || new Date().toISOString();

    lastSeenByConversation[cid] = seenAt;

    if (conversations[cid]) {
      conversations[cid].lastSeenAt = seenAt;
    }

    _saveLastSeenState();
  }

  async function _restoreAuth() {
    const ok = await Admin.initSession();
    if (ok) {
      loginModal.setAttribute('hidden', '');
      _bootAdmin();
    } else {
      loginModal.removeAttribute('hidden');
      setTimeout(() => emailInput.focus(), 100);
    }
  }

  async function tryLogin() {
    const email = emailInput.value.trim();
    const password = passInput.value;

    const ok = await Admin.tryLogin(email, password);
    if (ok) {
      sbClient = Admin.getClient();
      loginModal.setAttribute('hidden', '');
      _bootAdmin();
    } else {
      UI.showToast('Username of wachtwoord onjuist');
      passInput.value = '';
      passInput.focus();
    }
  }

  loginBtn.addEventListener('click', tryLogin);
  passInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryLogin();
  });

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await Admin.logout();
      window.location.reload();
    });
  }

  _restoreAuth();

  // ── Boot ──────────────────────────────────────────────
  async function _bootAdmin() {
    sbClient = Admin.getClient();
    _loadLastSeenState();
    await _loadConversations();
    await _refreshConversationPreviews();
    _subscribeGlobalRealtime();
    _startConversationPreviewPolling();
  }

  function _stopConversationPreviewPolling() {
    if (previewPollTimer) {
      clearInterval(previewPollTimer);
      previewPollTimer = null;
    }
  }

  function _startConversationPreviewPolling() {
    _stopConversationPreviewPolling();
    previewPollTimer = window.setInterval(() => {
      _refreshConversationPreviews();
    }, 2500);
  }

  async function _refreshConversationPreviews() {
    const ids = Object.keys(conversations);
    if (!ids.length || !sbClient) return;

    const { data, error } = await sbClient
      .from('messages')
      .select('*')
      .in('conversation_id', ids)
      .order('created_at', { ascending: false });

    if (error) {
      console.warn('[Admin] preview refresh error:', error);
      return;
    }

    const latestByConversation = new Map();
    (data || []).forEach((msg) => {
      if (!latestByConversation.has(msg.conversation_id)) {
        latestByConversation.set(msg.conversation_id, msg);
      }
    });

    let changed = false;

    latestByConversation.forEach((msg, cid) => {
      const conv = conversations[cid];
      if (!conv) return;

      const isIncomingVisitorMessage =
        msg.sender !== 'admin' &&
        msg.sender !== 'host' &&
        msg.sender !== 'system';

      const lastSeenAt = _getLastSeenAt(cid);
      const isNewerThanSeen = msg.created_at && lastSeenAt && msg.created_at > lastSeenAt;

      if (conv.last_message !== msg.content || conv.last_message_at !== msg.created_at) {
        conversations[cid] = {
          ...conv,
          last_message: msg.content,
          last_message_at: msg.created_at,
        };
        changed = true;
      }

      if (isIncomingVisitorMessage && cid !== activeConvId && isNewerThanSeen) {
        conversations[cid] = {
          ...conversations[cid],
          unread: 1,
        };
        changed = true;
      }
    });

    if (changed) {
      _renderConvList();
    }
  }

  async function _hydrateConversationPreview(conv) {
    if (conv.last_message && conv.last_message_at) return conv;

    const { data, error } = await sbClient
      .from('messages')
      .select('content, created_at')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!error && data) {
      return {
        ...conv,
        last_message: data.content,
        last_message_at: data.created_at,
      };
    }

    return conv;
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

    const convs = data || [];
    const hydrated = [];

    for (const conv of convs) {
      hydrated.push(await _hydrateConversationPreview(conv));
    }

    hydrated.forEach((conv) => {
      const persistedSeenAt = lastSeenByConversation[conv.id];
      const seenAt = persistedSeenAt || conv.last_message_at || conv.created_at;

      conversations[conv.id] = {
        ...conv,
        unread: 0,
        lastSeenAt: seenAt,
      };
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

          const isIncomingVisitorMessage =
            msg.sender !== 'admin' &&
            msg.sender !== 'host' &&
            msg.sender !== 'system';

          if (!conversations[cid]) {
            const { data } = await sbClient
              .from('conversations')
              .select('*')
              .eq('id', cid)
              .single();

            if (data) {
              conversations[cid] = {
                ...data,
                unread: isIncomingVisitorMessage && cid !== activeConvId ? 1 : 0,
                lastSeenAt: data.last_message_at || data.created_at,
              };
            }
          }

          if (conversations[cid]) {
            conversations[cid].last_message_at = msg.created_at;
            conversations[cid].last_message = msg.content;

            if (isIncomingVisitorMessage && cid !== activeConvId) {
              conversations[cid].unread = (conversations[cid].unread || 0) + 1;
            }
          }

          _renderConvList();
        }
      )

      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversations' },
        (payload) => {
          const conv = payload.new;
          const prev = conversations[conv.id] || {};

          conversations[conv.id] = {
            ...prev,
            ...conv,
            unread: prev.unread || 0,
            lastSeenAt: prev.lastSeenAt || conv.last_message_at || conv.created_at,
          };

          _renderConvList();
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'conversations' },
        (payload) => {
          const conv = payload.new;
          const prev = conversations[conv.id] || {};

          conversations[conv.id] = {
            ...prev,
            ...conv,
            unread: prev.unread || 0,
            lastSeenAt: prev.lastSeenAt || conv.last_message_at || conv.created_at,
          };

          _renderConvList();
        }
      )

      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR') UI.setConnStatus('⚠ Real-time verbinding verbroken', true);
        if (status === 'SUBSCRIBED') UI.setConnStatus('');
      });
  }

  // ── Render conversation list ───────────────────────────
  function _renderConvList() {

    const sorted = Object.values(conversations).sort((a, b) => {
      const aTime = new Date(a.last_message_at || a.created_at || 0).getTime();
      const bTime = new Date(b.last_message_at || b.created_at || 0).getTime();
      if (bTime !== aTime) return bTime - aTime;
      return (a.unread || 0) - (b.unread || 0);
    });

    convList.innerHTML = '';

    if (sorted.length === 0) {
      convList.innerHTML = '<div class="conv-empty">Geen conversaties beschikbaar</div>';
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
        : `<span class="conv-preview-empty">Geen berichten beschikbaar</span>`;

      const unreadBadge = hasUnread
        ? `<span class="unread-badge">${conv.unread}</span>`
        : '';

      item.innerHTML = `
        <div class="conv-avatar">${UI.escapeHtml((conv.nickname || '?')[0].toUpperCase())}</div>
        <div class="conv-info">
          <div class="conv-header-row">
            <span class="conv-name">${UI.escapeHtml(conv.nickname || 'Bezoeker')}</span>
            <span class="conv-time">${time}</span>
          </div>
          <div class="conv-preview">${preview}${unreadBadge}</div>
        </div>
        <button class="conv-delete-btn" title="Delete" aria-label="Delete conversation">×</button>
      `;

      const deleteBtn = item.querySelector('.conv-delete-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          _deleteConversation(conv.id);
        });
      }

      item.addEventListener('click', () => _openConversation(conv.id));
      convList.appendChild(item);
    });
  }

  // ── Open a conversation ────────────────────────────────
  function _openConversation(convId) {
    activeConvId = convId;

    if (conversations[convId]) {
      conversations[convId].unread = 0;
      _setConversationSeen(
        convId,
        conversations[convId].last_message_at || conversations[convId].created_at
      );
    }

    const conv = conversations[convId];
    activeName.textContent = conv ? (conv.nickname || 'Bezoeker') : 'Bezoeker';
    activeTime.textContent = conv
      ? 'Gestart op ' + _formatTime(new Date(conv.created_at))
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

  async function _deleteConversation(convId) {
    const conv = conversations[convId];
    if (!conv) return;

    const confirmDelete = confirm(
      `Delete conversation with "${conv.nickname || 'Bezoeker'}"?\n\nThis will also delete all messages in this conversation.`
    );

    if (!confirmDelete) return;

    try {
      // Delete all messages in the conversation
      const { error: msgError } = await sbClient
        .from('messages')
        .delete()
        .eq('conversation_id', convId);

      if (msgError) throw msgError;

      // Delete the conversation
      const { error: convError } = await sbClient
        .from('conversations')
        .delete()
        .eq('id', convId);

      if (convError) throw convError;

      // Remove from local state
      delete conversations[convId];
      delete lastSeenByConversation[convId];
      _saveLastSeenState();

      // If the deleted conv was active, close it
      if (activeConvId === convId) {
        activeConvId = null;
        emptyState.style.display = 'flex';
        chatPanel.style.display = 'none';
      }

      _renderConvList();
      UI.showToast('Conversation deleted');
    } catch (err) {
      console.error('[Admin] delete conversation error:', err);
      UI.showToast('Failed to delete conversation');
    }
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
    if (!ok) UI.showToast('Versturen mislukt — probeer het opnieuw');

    sendBtn.disabled = false;
    msgInput.focus();
  }

  // ── Time formatter ─────────────────────────────────────
  function _formatTime(date) {
    const now      = new Date();
    const diffDays = Math.floor((now - date) / 86400000);

    if (diffDays === 0) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (diffDays === 1) return 'Gisteren';
    if (diffDays < 7)  return date.toLocaleDateString('en-US', { weekday: 'short' });
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
});