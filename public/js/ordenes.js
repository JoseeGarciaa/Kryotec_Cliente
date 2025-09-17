(function(){
  document.addEventListener('DOMContentLoaded', function(){
    const btn = document.getElementById('btn-add-order');
    const modal = document.getElementById('modal-add-order');
    const modalEdit = document.getElementById('modal-edit-order');
    const modalDelete = document.getElementById('modal-delete-order');
    if(btn && modal && typeof modal.showModal === 'function'){
      btn.addEventListener('click', function(){
        modal.showModal();
      });
    }
    // Close buttons inside modal that have data-close attribute
    document.querySelectorAll('#modal-add-order [data-close]')
      .forEach(el => el.addEventListener('click', () => modal?.close()))
    // If backdrop exists, ensure click closes via native <form method="dialog">
    const backdrop = document.querySelector('#modal-add-order .modal-backdrop');
    if(backdrop){
      backdrop.addEventListener('click', () => modal?.close());
    }

    // Edit actions
    document.querySelectorAll('[data-edit]')
      .forEach(el => el.addEventListener('click', () => {
        if(!(modalEdit && typeof modalEdit.showModal === 'function')) return;
        const form = document.getElementById('form-edit-order');
        if(!(form instanceof HTMLFormElement)) return;
        form.querySelector('input[name="id"]').value = el.getAttribute('data-id')||'';
        form.querySelector('input[name="numero_orden"]').value = el.getAttribute('data-numero')||'';
        form.querySelector('input[name="codigo_producto"]').value = el.getAttribute('data-codigo')||'';
        form.querySelector('input[name="cantidad"]').value = el.getAttribute('data-cantidad')||'';
        form.querySelector('input[name="ciudad_destino"]').value = el.getAttribute('data-ciudad')||'';
        form.querySelector('input[name="ubicacion_destino"]').value = el.getAttribute('data-ubicacion')||'';
        form.querySelector('input[name="cliente"]').value = el.getAttribute('data-cliente')||'';
        form.querySelector('input[name="fecha_generacion"]').value = el.getAttribute('data-fecha')||'';
        modalEdit.showModal();
      }));
    // Delete actions
    document.querySelectorAll('[data-delete]')
      .forEach(el => el.addEventListener('click', () => {
        if(!(modalDelete && typeof modalDelete.showModal === 'function')) return;
        const form = document.getElementById('form-delete-order');
        if(!(form instanceof HTMLFormElement)) return;
        form.querySelector('input[name="id"]').value = el.getAttribute('data-id')||'';
        const lbl = document.getElementById('del-order-label');
        if(lbl) lbl.textContent = el.getAttribute('data-numero')||'';
        modalDelete.showModal();
      }));
    // Close buttons inside other modals
    document.querySelectorAll('#modal-edit-order [data-close], #modal-delete-order [data-close]')
      .forEach(el => el.addEventListener('click', () => {
        modalEdit?.close(); modalDelete?.close();
      }));
  });
})();
