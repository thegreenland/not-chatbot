// js/admin.js
// Manages admin authentication state.
// UI wiring is handled per-page (index.html has none, admin.html has its own).

const Admin = (() => {
  let _isLoggedIn = false;

  function isLoggedIn() {
    return _isLoggedIn;
  }

  function tryLogin(password) {
    if (password === Config.adminPassword) {
      _isLoggedIn = true;
      return true;
    }
    return false;
  }

  function logout() {
    _isLoggedIn = false;
  }

  return { isLoggedIn, tryLogin, logout };
})();