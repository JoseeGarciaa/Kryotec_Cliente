(function(){
  const IDLE_MINUTES = Math.max(1, Number(window.__IDLE_MINUTES__ || 10));
  const IDLE_MS = IDLE_MINUTES * 60 * 1000;
  let idleTimer;

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
    idleTimer = setTimeout(triggerLogout, IDLE_MS);
  }

  ['click','mousemove','mousedown','keydown','scroll','touchstart','touchmove'].forEach((evt) => {
    window.addEventListener(evt, resetTimer, { passive: true });
  });

  resetTimer();
})();
