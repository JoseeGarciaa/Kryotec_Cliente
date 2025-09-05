document.addEventListener('click', (e) => {
  if (e.target && e.target.closest('form.theme-switch')) {
    // no-op; handled server-side
  }
});
