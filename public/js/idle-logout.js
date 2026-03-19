(function(){
  const IDLE_MINUTES = Math.max(1, Number(window.__IDLE_MINUTES__ || 10));
  const IDLE_MS = IDLE_MINUTES * 60 * 1000;
  const STORAGE_KEY = 'kryo:last-activity';
  let lastActivity = Date.now();
  const REFRESH_MS = Math.min(60000, Math.max(15000, Math.round(IDLE_MS / 6))); // cada 15-60s
  let refreshInFlight = false;

  function getSharedActivity(){
    try {
      const v = Number(localStorage.getItem(STORAGE_KEY));
      return Number.isFinite(v) ? v : 0;
    } catch { return 0; }
  }

  function setSharedActivity(ts){
    try { localStorage.setItem(STORAGE_KEY, String(ts)); } catch {}
  }

  function syncActivity(ts){
    if (!Number.isFinite(ts)) return;
    lastActivity = Math.max(lastActivity, ts);
    setSharedActivity(lastActivity);
  }

  function triggerLogout(){
    const form = document.getElementById('logout-form');
    if (form) {
      try { form.submit(); return; } catch(e) {}
    }
    fetch('/auth/logout', { method: 'POST', credentials: 'include' }).finally(() => {
      window.location.href = '/auth/login';
    });
  }

  function resetTimer(){
    lastActivity = Date.now();
    setSharedActivity(lastActivity);
  }

  function refreshSession(){
    return fetch('/auth/refresh', { method: 'POST', credentials: 'include' })
      .then((res) => ({ ok: Boolean(res && res.ok), status: Number(res?.status || 0) }))
      .catch(() => ({ ok: false, status: 0 }));
  }

  function checkSession(){
    if (document.hidden) return;
    if (refreshInFlight) return;

    const globalLast = Math.max(lastActivity, getSharedActivity());
    lastActivity = globalLast;

    const inactiveFor = Date.now() - globalLast;
    // El servidor decide expiración real. El cliente solo consulta y evita refresh durante inactividad larga.
    if (inactiveFor < IDLE_MS) {
      refreshInFlight = true;
      refreshSession().then((res) => {
        if (res.status === 401) triggerLogout();
      }).finally(() => {
        refreshInFlight = false;
      });
      return;
    }

    refreshInFlight = true;
    refreshSession().then((res) => {
      if (res.status === 401) triggerLogout();
    }).finally(() => {
      refreshInFlight = false;
    });
  }

  ['click','mousemove','mousedown','keydown','scroll','touchstart','touchmove','pointerdown','pointermove'].forEach((evt) => {
    window.addEventListener(evt, resetTimer, { passive: true });
  });
  window.addEventListener('focus', resetTimer);
  window.addEventListener('pageshow', resetTimer);

  // Sincronizar actividad entre pestañas/ventanas
  window.addEventListener('storage', (ev) => {
    if (ev.key === STORAGE_KEY && ev.newValue) {
      const ts = Number(ev.newValue);
      if (Number.isFinite(ts)) syncActivity(ts);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    checkSession();
  });

  setInterval(checkSession, REFRESH_MS);

  // Inicializar estado compartido si estaba vacío
  // Siempre reiniciar al cargar para evitar timestamps viejos de otra sesión
  lastActivity = Date.now();
  setSharedActivity(lastActivity);
  syncActivity(lastActivity);
  checkSession();
})();
