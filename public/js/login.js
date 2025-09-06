(function(){
  const html = document.documentElement;
  const btnTheme = document.getElementById('toggle-theme-btn');
  const iconSun = document.getElementById('icon-sun');
  const iconMoon = document.getElementById('icon-moon');
  const form = document.getElementById('login-form');
  const submitBtn = document.getElementById('submit-btn');
  const submitText = document.getElementById('submit-text');
  const submitSpinner = document.getElementById('submit-spinner');
  const pwd = document.getElementById('password');
  const togglePwd = document.getElementById('toggle-password');
  const eye = document.getElementById('icon-eye');
  const eyeOff = document.getElementById('icon-eye-off');

  function setThemeIcons(){
    const isDark = html.classList.contains('dark') || (html.getAttribute('data-theme') || '').toLowerCase().includes('dark');
    if (iconSun) iconSun.classList.toggle('hidden', isDark);
    if (iconMoon) iconMoon.classList.toggle('hidden', !isDark);
  }

  try {
    const saved = localStorage.getItem('tema');
    if (saved === 'oscuro') {
      html.setAttribute('data-theme', 'kryoDark');
      html.classList.add('dark');
    } else if (saved === 'claro') {
      html.setAttribute('data-theme', 'kryoLight');
      html.classList.remove('dark');
    }
  } catch {}
  setThemeIcons();

  if (btnTheme) {
    btnTheme.addEventListener('click', async () => {
      const current = html.getAttribute('data-theme');
      const toDark = !(current && current.toLowerCase().includes('dark'));
      const next = toDark ? 'kryoDark' : 'kryoLight';
      html.setAttribute('data-theme', next);
      if (toDark) html.classList.add('dark'); else html.classList.remove('dark');
      localStorage.setItem('tema', toDark ? 'oscuro' : 'claro');
      setThemeIcons();
      try {
        await fetch('/ui/theme-set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: toDark ? 'dark' : 'light' }), credentials: 'same-origin' });
      } catch {}
    });
  }

  if (togglePwd) {
    togglePwd.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (!pwd) return;
      const showText = pwd.getAttribute('type') === 'password';
      pwd.type = showText ? 'text' : 'password';
      pwd.setAttribute('type', showText ? 'text' : 'password');
      if (eye) eye.classList.toggle('hidden', showText);
      if (eyeOff) eyeOff.classList.toggle('hidden', !showText);
      pwd.focus();
    });
  }

  if (form && submitBtn && submitText && submitSpinner) {
    form.addEventListener('submit', () => {
      submitBtn.setAttribute('disabled', 'true');
      submitSpinner.classList.remove('hidden');
      submitText.textContent = 'Iniciando sesión...';
    });
  }
})();
