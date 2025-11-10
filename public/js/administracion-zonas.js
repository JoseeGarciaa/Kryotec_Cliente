(function(){
  const sedeSelect = document.getElementById('zonas-sede-select');
  if (sedeSelect && sedeSelect.form) {
    sedeSelect.addEventListener('change', () => {
      sedeSelect.form.submit();
    });
  }

  document.querySelectorAll('[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      const message = form.getAttribute('data-confirm') || 'Confirmas esta accion?';
      if (!window.confirm(message)) {
        event.preventDefault();
      }
    });
  });
})();
