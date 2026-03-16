// js/ui.js
// Pure UI helpers — no business logic, no Supabase calls.

const UI = (() => {
  let toastTimer = null;

  function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  function setConnStatus(msg, isError = false) {
    const el = document.getElementById('conn-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'conn-status' + (isError ? ' error' : '');
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  function scrollToBottom() {
    const el = document.getElementById('messages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }

  return { showToast, setConnStatus, autoResize, scrollToBottom, escapeHtml };
})();