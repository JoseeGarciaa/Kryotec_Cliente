// JS para manejar CRUD de Administración evitando inline scripts (CSP)
(function(){
  function qs(sel, ctx){return (ctx||document).querySelector(sel);} 
  function qsa(sel, ctx){return Array.from((ctx||document).querySelectorAll(sel));}

  const btnNew = qs('#btn-new-user');
  const dlgNew = qs('#dlg-new-user');
  const dlgEdit = qs('#dlg-edit-user');
  const formEdit = qs('#form-edit');

  if(btnNew && dlgNew){
    btnNew.addEventListener('click', ()=> dlgNew.showModal());
  }

  // Toggle activo
  qsa('.btn-toggle-activo').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id; const next = btn.dataset.next;
      try {
        const res = await fetch(`/administracion/${id}/estado`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ activo: next }) });
        if(res.ok) location.reload();
      } catch(e){ console.error(e); }
    });
  });

  // Editar
  qsa('.btn-edit-user').forEach(btn => {
    btn.addEventListener('click', () => {
      const ds = btn.dataset;
      formEdit.action = `/administracion/${ds.id}/editar`;
      formEdit.nombre.value = ds.nombre || '';
      formEdit.correo.value = ds.correo || '';
      formEdit.telefono.value = ds.telefono || '';
      formEdit.rol.value = ds.rol || 'User';
      formEdit.activo.value = ds.activo === 'false' ? 'false' : 'true';
      dlgEdit.showModal();
    });
  });

  // Eliminar
  qsa('.btn-del-user').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if(!confirm('¿Eliminar usuario?')) return;
      try {
        const res = await fetch(`/administracion/${id}`, { method:'DELETE' });
        if(res.ok) location.reload();
      } catch(e){ console.error(e); }
    });
  });

  // Cerrar modales
  qsa('.btn-close-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      const dlg = target && qs('#'+target);
      if(dlg && typeof dlg.close === 'function') dlg.close();
    });
  });
})();
