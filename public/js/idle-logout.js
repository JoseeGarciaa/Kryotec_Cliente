(function(){
  const IDLE_MINUTES = Math.max(1, Number(window.__IDLE_MINUTES__ || 10));
  const IDLE_MS = IDLE_MINUTES * 60 * 1000;
  const BACKGROUND_GRACE_MS = Math.max(30000, Math.min(60000, Math.round(IDLE_MS * 0.1)));
  const STORAGE_KEY = 'kryo:last-activity';
  let idleTimer;
  let lastActivity = Date.now();
  let hiddenAt = 0;
  let graceRefreshInFlight = false;
  const REFRESH_MS = Math.max(120000, Math.min(IDLE_MS / 2, 5 * 60 * 1000)); // cada 2-5 min y siempre < idle
  const CHECK_MS = Math.min(60000, Math.max(5000, Math.round(IDLE_MS / 4))); // chequeo periódico para usar reloj real

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
    scheduleFromLastActivity(lastActivity);
  }

  function scheduleFromLastActivity(baseTs){
    clearTimeout(idleTimer);
    const remaining = (baseTs + IDLE_MS) - Date.now();
    idleTimer = setTimeout(triggerLogout, Math.max(1000, remaining));
  }

  function triggerLogout(){
    // Verificar actividad en otras pestañas antes de cerrar sesión
    const shared = getSharedActivity();
    const now = Date.now();
    if (shared && now - shared < IDLE_MS) {
      syncActivity(shared);
      return;
    }

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
    scheduleFromLastActivity(lastActivity);
  }

  function refreshSession(){
    return fetch('/auth/refresh', { method: 'POST', credentials: 'include' })
      .then((res) => Boolean(res && res.ok))
      .catch(() => false);
  }

  function checkIdle(opts){
    const allowGrace = Boolean(opts && opts.allowGrace);
    const globalLast = Math.max(lastActivity, getSharedActivity());
    lastActivity = globalLast;
    const now = Date.now();
    const inactiveFor = now - globalLast;
    if (inactiveFor >= IDLE_MS) {
      const overdue = inactiveFor - IDLE_MS;
      if (allowGrace && overdue <= BACKGROUND_GRACE_MS) {
        if (graceRefreshInFlight) return;
        graceRefreshInFlight = true;
        refreshSession()
          .finally(() => {
            graceRefreshInFlight = false;
            syncActivity(Date.now());
          });
        return;
      }
      triggerLogout();
      return;
    }
    scheduleFromLastActivity(globalLast);
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
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    const wasBackgrounded = hiddenAt > 0;
    hiddenAt = 0;
    checkIdle({ allowGrace: wasBackgrounded });
  });

  // Renovar sesión mientras hay actividad reciente (evita expiración de token cuando el usuario está activo)
  setInterval(() => {
    if (document.hidden) return; // evita refresh en segundo plano para no perder cookie si devuelve 401
    const globalLast = Math.max(lastActivity, getSharedActivity());
    const inactiveFor = Date.now() - globalLast;
    if (inactiveFor >= IDLE_MS) return; // ya está inactivo, el logout lo hará el timer
    refreshSession();
  }, REFRESH_MS);

  // Chequeo periódico basado en reloj real (mitiga throttling de timers en segundo plano)
  setInterval(() => checkIdle(), CHECK_MS);

  // Inicializar estado compartido si estaba vacío
  // Siempre reiniciar al cargar para evitar timestamps viejos de otra sesión
  lastActivity = Date.now();
  setSharedActivity(lastActivity);
  syncActivity(lastActivity);
  checkIdle();
})();
