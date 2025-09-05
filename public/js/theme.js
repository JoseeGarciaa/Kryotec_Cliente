document.addEventListener('submit', async (e) => {
  const form = e.target instanceof HTMLFormElement ? e.target : null;
  if (!form || !form.classList.contains('theme-switch')) return;
  e.preventDefault();
  try {
    // Optimistically toggle theme on the client
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'kryoDark' ? 'kryoLight' : 'kryoDark';
    html.setAttribute('data-theme', next);

    // Persist on server via fetch without navigation
    const formData = new FormData(form);
    const res = await fetch('/ui/theme-toggle', {
      method: 'POST',
      body: formData,
      credentials: 'same-origin'
    });
    // The server redirects; ignore body to avoid reload
  } catch {
    // best-effort; ignore errors
  }
});
