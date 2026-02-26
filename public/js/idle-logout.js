(function(){
  const IDLE_MINUTES = Math.max(1, Number(window.__IDLE_MINUTES__ || 10));
  const IDLE_MS = IDLE_MINUTES * 60 * 1000;
  const STORAGE_KEY = 'kryo:last-activity';
  let idleTimer;
  let lastActivity = Date.now();
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
    scheduleFrom(lastActivity);
  }

  function scheduleFrom(ts){
    clearTimeout(idleTimer);
    const remaining = IDLE_MS - Math.max(0, Date.now() - ts);
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
    scheduleFrom(lastActivity);
  }

  function checkIdle(){
    const globalLast = Math.max(lastActivity, getSharedActivity());
    lastActivity = globalLast;
    const inactiveFor = Date.now() - globalLast;
    if (inactiveFor >= IDLE_MS) {
      triggerLogout();
      return;
    }
    scheduleFrom(globalLast);
  }

  ['click','mousemove','mousedown','keydown','scroll','touchstart','touchmove'].forEach((evt) => {
    window.addEventListener(evt, resetTimer, { passive: true });
  });

  // Sincronizar actividad entre pestañas/ventanas
  window.addEventListener('storage', (ev) => {
    if (ev.key === STORAGE_KEY && ev.newValue) {
      const ts = Number(ev.newValue);
      if (Number.isFinite(ts)) syncActivity(ts);
    }
  });

  // Renovar sesión mientras hay actividad reciente (evita expiración de token cuando el usuario está activo)
  setInterval(() => {
    const globalLast = Math.max(lastActivity, getSharedActivity());
    const inactiveFor = Date.now() - globalLast;
    if (inactiveFor >= IDLE_MS) return; // ya está inactivo, el logout lo hará el timer
    fetch('/auth/refresh', { method: 'POST', credentials: 'include' })
      .catch(() => {})
      .then((res) => {
        if (res && res.status === 401) triggerLogout();
      });
  }, REFRESH_MS);

  // Chequeo periódico basado en reloj real (mitiga throttling de timers en segundo plano)
  setInterval(checkIdle, CHECK_MS);

  // Inicializar estado compartido si estaba vacío
  if (!getSharedActivity()) setSharedActivity(lastActivity);
  syncActivity(getSharedActivity());
  checkIdle();
})();
