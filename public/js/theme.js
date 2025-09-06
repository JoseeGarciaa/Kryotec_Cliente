// Toggle from header form (backward compatible)
document.addEventListener('submit', async (e) => {
  const form = e.target instanceof HTMLFormElement ? e.target : null;
  if (!form || !form.classList.contains('theme-switch')) return;
  e.preventDefault();
  try {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'kryoDark' ? 'kryoLight' : 'kryoDark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('tema', next === 'kryoDark' ? 'oscuro' : 'claro');
    await fetch('/ui/theme-set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next === 'kryoDark' ? 'dark' : 'light' }),
      credentials: 'same-origin'
    });
  } catch {}
});

// On load, apply saved preference if present
(function(){
  try {
    const saved = localStorage.getItem('tema'); // 'claro' | 'oscuro'
    if (!saved) return;
    const html = document.documentElement;
    const target = saved === 'oscuro' ? 'kryoDark' : 'kryoLight';
    html.setAttribute('data-theme', target);
  } catch {}
})();
