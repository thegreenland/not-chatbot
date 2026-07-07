const Admin = (() => {
  let _isLoggedIn = false;
  let _client = null;

  function getClient() {
    if (!_client) {
      _client = window.supabase.createClient(Config.supabaseUrl, Config.supabaseKey);
    }
    return _client;
  }

  async function _syncRealtimeAuth(sb) {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session?.access_token) {
        await sb.realtime.setAuth(session.access_token);
      }
    } catch (err) {
      console.warn('[Admin] realtime auth sync failed:', err);
    }
  }

  function isLoggedIn() {
    return _isLoggedIn;
  }

  async function initSession() {
    try {
      const sb = getClient();
      const { data: { session }, error } = await sb.auth.getSession();

      if (error) {
        console.error('[Admin] getSession error:', error);
        _isLoggedIn = false;
        return false;
      }

      if (session?.access_token) {
        await _syncRealtimeAuth(sb);
      }

      _isLoggedIn = Boolean(session);
      return _isLoggedIn;
    } catch (err) {
      console.error('[Admin] initSession error:', err);
      _isLoggedIn = false;
      return false;
    }
  }

  async function tryLogin(email, password) {
    try {
      const sb = getClient();
      const { data, error } = await sb.auth.signInWithPassword({
        email,
        password,
      });

      if (!error && data?.session) {
        await _syncRealtimeAuth(sb);
        _isLoggedIn = true;
        return true;
      }

      return false;
    } catch (err) {
      console.error('[Admin] tryLogin error:', err);
      return false;
    }
  }

  async function logout() {
    try {
      await getClient().auth.signOut();
    } catch (err) {
      console.error('[Admin] logout error:', err);
    }

    _isLoggedIn = false;
  }

  return { isLoggedIn, initSession, tryLogin, logout, getClient };
})();