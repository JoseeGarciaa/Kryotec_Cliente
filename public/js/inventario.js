(function(){
  const modal = document.getElementById('inv-edit-modal');
  const form = document.getElementById('inv-edit-form');
  const fModeloId = document.getElementById('inv-edit-modelo_id');
  const fRfid = document.getElementById('inv-edit-rfid');
  const fNombre = document.getElementById('inv-edit-nombre');
  const fLote = document.getElementById('inv-edit-lote');
  const fEstado = document.getElementById('inv-edit-estado');
  const fSub = document.getElementById('inv-edit-sub');
  // Always reset modal on close
  if(modal) {
    modal.addEventListener('close', ()=>{
      if(form) form.reset();
    });
  }
  document.addEventListener('click', (e)=>{
    const t = e.target;
    if(!(t instanceof HTMLElement)) return;
    if(t.matches('[data-action="inv-edit"]')){
      e.preventDefault();
      const id = t.getAttribute('data-id');
  const modelo_id = t.getAttribute('data-modelo_id')||'';
  const rfid = t.getAttribute('data-rfid')||'';
  const nombre = t.getAttribute('data-nombre')||'';
  const lote = t.getAttribute('data-lote')||'';
  const estado = t.getAttribute('data-estado')||'';
  const sub = t.getAttribute('data-sub')||'';
  if(form){ form.action = `/inventario/${id}/update`; }
  if(fModeloId) fModeloId.value = modelo_id;
  if(fRfid) fRfid.value = rfid;
  if(fNombre) fNombre.value = nombre;
  if(fLote) fLote.value = lote;
  if(fEstado) fEstado.value = estado;
  if(fSub) fSub.value = sub;
      try{ modal.showModal(); }catch{ modal.classList.remove('hidden'); }
      if(fNombre) setTimeout(()=>fNombre.focus(), 100);
    }
    if(t.id === 'inv-edit-cancel'){
      modal.close();
    }
  });
  // Confirmación de borrado sin inline JS
  document.addEventListener('submit', function(e) {
    const t = e.target;
    if (t instanceof HTMLFormElement && t.classList.contains('inv-delete-form')) {
      if (!window.confirm('¿Eliminar este item?')) {
        e.preventDefault();
      }
    }
  });
})();
