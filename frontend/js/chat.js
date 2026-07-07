// js/chat.js
// Handles Supabase interactions for a SINGLE conversation.
//
// IMPORTANT re: real-time filters:
//   Supabase's postgres_changes `filter` param requires REPLICA IDENTITY FULL
//   on the table, which is off by default. Instead we subscribe to ALL inserts
//   on the messages table and filter by conversation_id in JS. This is reliable
//   regardless of Supabase replication settings.

const Chat = (() => {
  let sbClient = null;
  let activeConversationId = null;
  let lastDateLabel = '';
  const renderedIds = new Set();
  let realtimeChannel = null;
  let pollTimer = null;
  let lastKnownCreatedAt = '';

  // ── Init ───────────────────────────────────────────────
  async function init(conversationId) {
    activeConversationId = conversationId;
    renderedIds.clear();
    lastDateLabel = '';
    lastKnownCreatedAt = '';

    _stopPolling();

    try {
      if (!sbClient) {
        sbClient = window.supabase.createClient(Config.supabaseUrl, Config.supabaseKey);
      }

      await _syncRealtimeAuth();
      await _loadHistory();
      _subscribeRealtime();
      _startPolling();
      UI.setConnStatus('');
    } catch (err) {
      UI.setConnStatus('⚠ Connection failed — check config.js', true);
      console.error('[Chat] init error:', err);
    }
  }

  async function _syncRealtimeAuth() {
    try {
      const { data: { session } } = await window.supabase.auth.getSession();
      if (session?.access_token) {
        await sbClient.realtime.setAuth(session.access_token);
      }
    } catch (err) {
      console.warn('[Chat] auth sync failed:', err);
    }
  }

  function getClient() {
    if (!sbClient) {
      sbClient = window.supabase.createClient(Config.supabaseUrl, Config.supabaseKey);
    }
    return sbClient;
  }

  function _stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function _startPolling() {
  _stopPolling();
  pollTimer = window.setInterval(() => {
    _pollForNewMessages();
  }, 2500);
}

async function _pollForNewMessages() {
  if (!sbClient || !activeConversationId) return;

  const { data, error } = await sbClient
    .from('messages')
    .select('*')
    .eq('conversation_id', activeConversationId)
    .gt('created_at', lastKnownCreatedAt || '1970-01-01T00:00:00.000Z')
    .order('created_at', { ascending: true });

  if (error) {
    console.warn('[Chat] poll error:', error);
    return;
  }

  (data || []).forEach((msg) => {
    if (renderedIds.has(msg.id)) return;
    _renderMessage(msg);
  });

  if ((data || []).length) {
    UI.scrollToBottom();
  }
}

  // ── Load history ───────────────────────────────────────
  async function _loadHistory() {
    const container = document.getElementById('messages');
    const welcome = container.querySelector('.welcome-card');
    container.innerHTML = '';
    if (welcome) container.appendChild(welcome);

    const { data, error } = await sbClient
      .from('messages')
      .select('*')
      .eq('conversation_id', activeConversationId)
      .order('created_at', { ascending: true })
      .limit(200);

    if (error) {
      UI.setConnStatus('⚠ Could not load messages', true);
      console.error('[Chat] loadHistory error:', error);
      return;
    }

    const messages = data || [];
    messages.forEach(_renderMessage);

    if (messages.length) {
      lastKnownCreatedAt = messages[messages.length - 1].created_at;
    } else {
      lastKnownCreatedAt = new Date().toISOString();
    }

    UI.scrollToBottom();

    (data || []).forEach(_renderMessage);
    UI.scrollToBottom();
  }

  // ── Real-time subscription ─────────────────────────────
  // No filter here — we receive all message inserts and discard
  // those that don't belong to the active conversation.
  // This avoids the REPLICA IDENTITY FULL requirement.
  function _subscribeRealtime() {
    if (realtimeChannel) {
      sbClient.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }

    realtimeChannel = sbClient
      .channel('chat:messages:' + activeConversationId)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const msg = payload.new;
          // Discard messages from other conversations
          if (msg.conversation_id !== activeConversationId) return;
          // Discard if already rendered (optimistic render dedup)
          if (renderedIds.has(msg.id)) return;
          _renderMessage(msg);
          UI.scrollToBottom();
        }
      )
      .subscribe((status) => {
        console.log('[Chat] realtime status:', status);
        if (status === 'SUBSCRIBED')    UI.setConnStatus('');
        if (status === 'CHANNEL_ERROR') UI.setConnStatus('⚠ Real-time disconnected', true);
        if (status === 'TIMED_OUT')     UI.setConnStatus('⚠ Real-time timed out', true);
      });
  }

  // ── Send ───────────────────────────────────────────────
  async function send(content, senderName, isAdminSender) {
    if (!sbClient || !activeConversationId) return false;
    if (!isAdminSender && (!window.OfficeHours || !window.OfficeHours.isOpen())) return false;

    // Optimistic render — appears instantly for the sender
    const tempId = 'temp-' + Date.now();
    const pendingMessage = _renderMessage({
      id: tempId,
      content,
      sender: isAdminSender ? 'admin' : 'user',
      sender_name: senderName,
      conversation_id: activeConversationId,
      created_at: new Date().toISOString(),
      pending: true,
    });
    UI.scrollToBottom();

    // Persist to Supabase
    const { data, error } = await sbClient
      .from('messages')
      .insert([{
        content,
        sender: isAdminSender ? 'admin' : 'user',
        sender_name: senderName,
        conversation_id: activeConversationId,
      }])
      .select()
      .single();

    if (error) {
      console.error('[Chat] send error:', error);
      if (pendingMessage) {
        pendingMessage.classList.remove('pending');
        pendingMessage.classList.add('failed');
        const statusEl = pendingMessage.querySelector('.msg-status');
        if (statusEl) statusEl.textContent = 'Failed to send';
      }
      UI.scrollToBottom();
      return false;
    }

    if (pendingMessage) {
      pendingMessage.classList.remove('pending');
      pendingMessage.removeAttribute('data-temp-id');
      pendingMessage.querySelector('.msg-status')?.remove();
    }

    // Register the real DB id so the realtime event skips it
    if (data) renderedIds.add(data.id);

    if (data) {
      try {
        await sbClient
          .from('conversations')
          .upsert(
            [
              {
                id: activeConversationId,
                last_message: content,
                last_message_at: new Date().toISOString(),
              },
            ],
            { onConflict: 'id' }
          );
      } catch (err) {
        console.warn('[Chat] conversation preview update failed:', err);
      }

      renderedIds.add(data.id);
    }

    return true;
  }

  // ── Render a message ───────────────────────────────────
  function _renderMessage(msg) {
    if (renderedIds.has(msg.id)) return;
    renderedIds.add(msg.id);

    const container = document.getElementById('messages');
    const isAdminMsg = msg.sender === 'admin';
    const date = new Date(msg.created_at);

    const createdAtIso = date.toISOString();

    if (!lastKnownCreatedAt || createdAtIso > lastKnownCreatedAt) {
      lastKnownCreatedAt = createdAtIso;
    }

    const dateLabel = date.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
    });

    if (dateLabel !== lastDateLabel) {
      lastDateLabel = dateLabel;
      const sep = document.createElement('div');
      sep.className = 'date-sep';
      sep.textContent = dateLabel;
      container.appendChild(sep);
    }

    const timeStr    = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const avatarText = isAdminMsg ? '✦' : (msg.sender_name || 'V')[0].toUpperCase();
    const senderLabel = isAdminMsg ? 'The Green Land' : (msg.sender_name || 'Bezoeker');

    const row = document.createElement('div');
    row.className = `msg-row ${isAdminMsg ? 'admin' : 'user'}`;
    if (String(msg.id).startsWith('temp-')) {
      row.dataset.tempId = msg.id;
    }
    if (msg.pending) {
      row.classList.add('pending');
    }
    row.innerHTML = `
      <div class="msg-avatar">${UI.escapeHtml(avatarText)}</div>
      <div class="bubble-wrap">
        <div class="msg-sender">${UI.escapeHtml(senderLabel)}</div>
        <div class="bubble">${UI.escapeHtml(msg.content)}</div>
        <div class="msg-meta">
          <div class="msg-time">${timeStr}</div>
          ${msg.pending ? '<div class="msg-status">Sending…</div>' : ''}
        </div>
      </div>
    `;
    container.appendChild(row);
    return row;
  }

  return { init, send, getClient };
})();