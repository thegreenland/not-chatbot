// js/main.js
// Entry point for index.html (visitor chat).
// Persists conversation_id + nickname in localStorage for returning visitors.

const OfficeHours = (() => {
  function _getCetHour(date = new Date()) {
    const hourText = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Paris',
      hour: '2-digit',
      hour12: false,
    }).format(date);

    return Number.parseInt(hourText, 10);
  }

  function isOpen(date = new Date()) {
    const hour = _getCetHour(date);
    return hour >= 9 && hour < 18;
  }

  function getStatusText(date = new Date()) {
    return isOpen(date)
      ? 'Praat met een echt persoon!'
      : '(!) De chat is alleen geopend tijdens onze kantooruren (tussen 09.00 en 18.00), en dus op dit moment gesloten. Tot morgen!';
  }

  return { isOpen, getStatusText };
})();

window.OfficeHours = OfficeHours;

document.addEventListener("DOMContentLoaded", () => {
  const nicknameModal = document.getElementById("nickname-modal");
  const nicknameInput = document.getElementById("nickname-input");
  const nicknameBtn = document.getElementById("nickname-confirm-btn");
  const nicknameNewChatBtn = document.getElementById("nickname-new-chat-btn");
  const nicknameCancelBtn = document.getElementById("nickname-cancel-btn");
  const nicknameTitleEl = document.getElementById("nickname-modal-title");
  const nicknameHelpEl = document.getElementById("nickname-modal-help");
  const msgInput = document.getElementById("msg-input");
  const sendBtn = document.getElementById("send-btn");
  const inputArea = document.querySelector(".input-area");
  const headerStatusEl = document.querySelector(".header-status span");
  const aliasBar = document.getElementById("alias-bar");
  const aliasNameEl = document.getElementById("alias-name");
  const aliasChangeBtn = document.getElementById("alias-change-btn");

  let conversationId = localStorage.getItem("chat_conversation_id");
  let nickname = localStorage.getItem("chat_nickname");
  let isChangingAlias = false;


  function _syncOfficeHoursState() {
    const isOpen = OfficeHours.isOpen();

    if (headerStatusEl) {
      headerStatusEl.textContent = OfficeHours.getStatusText();
    }

    if (inputArea) {
      inputArea.classList.toggle("is-closed", !isOpen);
    }

    msgInput.disabled = !isOpen || !conversationId || !nickname;
    sendBtn.disabled = !isOpen || !conversationId || !nickname;

    if (!isOpen) {
      msgInput.placeholder = "Buiten kantooruren zijn wij niet beschikbaar - tot morgen 09.00!";
      sendBtn.title = "Buiten kantooruren zijn wij niet beschikbaar - tot morgen 09.00!";
    } else {
      msgInput.placeholder = "Typ je bericht..";
      sendBtn.title = "Verstuur";
    }

    return isOpen;
  }

  _syncOfficeHoursState();
  window.setInterval(_syncOfficeHoursState, 60_000);

  if (conversationId && nickname) {
    _bootChat();
  } else {
    _showNicknameModal(false);
  }

  function _showNicknameModal(changing) {
    isChangingAlias = changing;

    if (nicknameTitleEl) {
      nicknameTitleEl.textContent = changing ? "Naam wijzigen" : "Welkom!";
    }

    if (nicknameHelpEl) {
      nicknameHelpEl.textContent = changing
        ? "Kies wat je wilt doen met je nieuwe naam:"
        : "Wat is je (nick)naam?";
    }

    nicknameInput.value = changing ? nickname || "" : "";

    if (nicknameBtn) {
      nicknameBtn.textContent = changing ? "Gebruik in huidige chat" : "Start chatting →";
    }

    if (nicknameNewChatBtn) {
      nicknameNewChatBtn.hidden = !changing;
    }

    if (nicknameCancelBtn) {
      nicknameCancelBtn.hidden = !changing;
    }

    nicknameModal.removeAttribute("hidden");
    setTimeout(() => nicknameInput.focus(), 50);
  }

  function _closeNicknameModal() {
    nicknameModal.setAttribute("hidden", "");
    nicknameInput.value = nickname || "";
  }

  async function _confirmNickname(mode = isChangingAlias ? "current" : "new") {
    const val = nicknameInput.value.trim();
    if (!val) {
      nicknameInput.focus();
      return;
    }

    nickname = val;
    localStorage.setItem("chat_nickname", nickname);

    if (mode === "new") {
      conversationId = crypto.randomUUID();
      localStorage.setItem("chat_conversation_id", conversationId);
      _closeNicknameModal();
      aliasNameEl.textContent = nickname;

      if (isChangingAlias) {
        UI.showToast("Nieuwe conversatie gestart!");
      }

      await _bootChat();
      return;
    }

    _closeNicknameModal();
    aliasNameEl.textContent = nickname;

    if (conversationId) {
      const sb = Chat.getClient();
      await sb.from("conversations").update({ nickname }).eq("id", conversationId);
    }

    UI.showToast("Naam aangepast in huidige conversatie.");
  }

  nicknameBtn.addEventListener("click", () =>
    _confirmNickname(isChangingAlias ? "current" : "new")
  );

  nicknameNewChatBtn?.addEventListener("click", () => _confirmNickname("new"));
  nicknameCancelBtn?.addEventListener("click", () => {
    _closeNicknameModal();
    nicknameInput.value = nickname || "";
  });

  nicknameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      _confirmNickname(isChangingAlias ? "current" : "new");
    }
  });

  aliasChangeBtn.addEventListener("click", () => _showNicknameModal(true));


  // ── Boot chat ─────────────────────────────────────────
  async function _bootChat() {
    aliasNameEl.textContent = nickname;
    aliasBar.removeAttribute("hidden");

    // Upsert the conversation row — safe to call every time.
    // On first visit: creates it. On return: finds existing row, does nothing.
    const sb = Chat.getClient();
    await sb.from("conversations").upsert(
      [
        {
          id: conversationId,
          nickname: nickname,
          last_message_at: new Date().toISOString(),
        },
      ],
      { onConflict: "id", ignoreDuplicates: true },
    );

    Chat.init(conversationId);

    const isOpen = _syncOfficeHoursState();
    if (isOpen) {
      msgInput.focus();
    }
  }

  // ── Send ──────────────────────────────────────────────
  msgInput.addEventListener("input", () => UI.autoResize(msgInput));

  msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      _handleSend();
    }
  });

  sendBtn.addEventListener("click", _handleSend);

  async function _handleSend() {
    if (!OfficeHours.isOpen()) {
      _syncOfficeHoursState();
      UI.showToast("Buiten kantooruren zijn wij niet beschikbaar.");
      return;
    }

    const text = msgInput.value.trim();
    if (!text) return;

    msgInput.value = "";
    UI.autoResize(msgInput);
    sendBtn.disabled = true;

    // Update conversation preview for admin list
    const sb = Chat.getClient();
    sb.from("conversations")
      .update({ last_message_at: new Date().toISOString(), last_message: text })
      .eq("id", conversationId);

    const ok = await Chat.send(text, nickname, false);
    if (!ok) UI.showToast("Failed to send — please try again");

    sendBtn.disabled = false;
    msgInput.focus();
  }
});
