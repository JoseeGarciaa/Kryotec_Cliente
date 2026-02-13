(function(){
  const IDLE_MINUTES = Math.max(1, Number(window.__IDLE_MINUTES__ || 10));
  const IDLE_MS = IDLE_MINUTES * 60 * 1000;
  let idleTimer;
  let lastActivity = Date.now();
  const REFRESH_MS = Math.max(120000, Math.min(IDLE_MS / 2, 5 * 60 * 1000)); // cada 2-5 min y siempre < idle

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
    clearTimeout(idleTimer);
    lastActivity = Date.now();
    idleTimer = setTimeout(triggerLogout, IDLE_MS);
  }

  ['click','mousemove','mousedown','keydown','scroll','touchstart','touchmove'].forEach((evt) => {
    window.addEventListener(evt, resetTimer, { passive: true });
  });

  // Renovar sesión mientras hay actividad reciente (evita expiración de token cuando el usuario está activo)
  setInterval(() => {
    const inactiveFor = Date.now() - lastActivity;
    if (inactiveFor >= IDLE_MS) return; // ya está inactivo, el logout lo hará el timer
    fetch('/auth/refresh', { method: 'POST', credentials: 'include' })
      .catch(() => {})
      .then((res) => {
        if (res && res.status === 401) triggerLogout();
      });
  }, REFRESH_MS);

  resetTimer();
})();
