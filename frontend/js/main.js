// js/main.js
// Entry point for index.html (visitor chat).
// Persists conversation_id + nickname in localStorage for returning visitors.

document.addEventListener('DOMContentLoaded', () => {
  const nicknameModal  = document.getElementById('nickname-modal');
  const nicknameInput  = document.getElementById('nickname-input');
  const nicknameBtn    = document.getElementById('nickname-confirm-btn');
  const nicknameTitleEl = document.getElementById('nickname-modal-title');
  const msgInput       = document.getElementById('msg-input');
  const sendBtn        = document.getElementById('send-btn');
  const aliasBar       = document.getElementById('alias-bar');
  const aliasNameEl    = document.getElementById('alias-name');
  const aliasChangeBtn = document.getElementById('alias-change-btn');

  // ── Restore or create identity ────────────────────────
  // conversationId is PERMANENT once created — never regenerated.
  // nickname can be changed freely without affecting the conversation.
  let conversationId = localStorage.getItem('chat_conversation_id');
  let nickname       = localStorage.getItem('chat_nickname');
  let isChangingAlias = false;

  if (conversationId && nickname) {
    _bootChat();
  } else {
    _showNicknameModal(false);
  }

  // ── Nickname modal ────────────────────────────────────
  function _showNicknameModal(changing) {
    isChangingAlias = changing;
    if (nicknameTitleEl) {
      nicknameTitleEl.textContent = changing ? 'Naam wijzigen' : 'Welkom!';
    }
    nicknameInput.value = changing ? (nickname || '') : '';
    nicknameModal.removeAttribute('hidden');
    setTimeout(() => nicknameInput.focus(), 50);
  }

  function _confirmNickname() {
    const val = nicknameInput.value.trim();
    if (!val) { nicknameInput.focus(); return; }

    nickname = val;
    localStorage.setItem('chat_nickname', nickname);

    if (isChangingAlias) {
      // Just update the nickname — keep the same conversationId
      nicknameModal.setAttribute('hidden', '');
      aliasNameEl.textContent = nickname;

      // Update nickname in Supabase too so admin sees the new name
      const sb = Chat.getClient();
      sb.from('conversations')
        .update({ nickname })
        .eq('id', conversationId);

      UI.showToast('Naam gewijzigd!');
    } else {
      // First visit — generate a new conversationId
      conversationId = crypto.randomUUID();
      localStorage.setItem('chat_conversation_id', conversationId);
      nicknameModal.setAttribute('hidden', '');
      _bootChat();
    }
  }

  nicknameBtn.addEventListener('click', _confirmNickname);
  nicknameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _confirmNickname();
  });

  // ── Change alias button ───────────────────────────────
  aliasChangeBtn.addEventListener('click', () => _showNicknameModal(true));

  // ── Boot chat ─────────────────────────────────────────
  async function _bootChat() {
    aliasNameEl.textContent = nickname;
    aliasBar.removeAttribute('hidden');

    // Upsert the conversation row — safe to call every time.
    // On first visit: creates it. On return: finds existing row, does nothing.
    const sb = Chat.getClient();
    await sb.from('conversations').upsert([{
      id: conversationId,
      nickname: nickname,
      last_message_at: new Date().toISOString(),
    }], { onConflict: 'id', ignoreDuplicates: true });

    Chat.init(conversationId);

    msgInput.disabled = false;
    sendBtn.disabled = false;
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
    if (!text) return;

    msgInput.value = '';
    UI.autoResize(msgInput);
    sendBtn.disabled = true;

    // Update conversation preview for admin list
    const sb = Chat.getClient();
    sb.from('conversations')
      .update({ last_message_at: new Date().toISOString(), last_message: text })
      .eq('id', conversationId);

    const ok = await Chat.send(text, nickname, false);
    if (!ok) UI.showToast('Failed to send — please try again');

    sendBtn.disabled = false;
    msgInput.focus();
  }
});