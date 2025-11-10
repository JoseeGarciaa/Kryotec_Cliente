// JS para manejar CRUD de Administración evitando inline scripts (CSP)
(function(){
  function qs(sel, ctx){return (ctx||document).querySelector(sel);} 
  function qsa(sel, ctx){return Array.from((ctx||document).querySelectorAll(sel));}

  const btnNew = qs('#btn-new-user');
  const dlgNew = qs('#dlg-new-user');
  const btnNewSede = qs('#btn-new-sede');
  const dlgNewSede = qs('#dlg-new-sede');
  const dlgEdit = qs('#dlg-edit-user');
  const formEdit = qs('#form-edit');
  const ttlMin = formEdit && formEdit.dataset && formEdit.dataset.ttlMin ? Number(formEdit.dataset.ttlMin) : 0;
  const ttlMax = formEdit && formEdit.dataset && formEdit.dataset.ttlMax ? Number(formEdit.dataset.ttlMax) : 0;

  if(btnNew && dlgNew){
    btnNew.addEventListener('click', ()=> dlgNew.showModal());
  }

  if(btnNewSede && dlgNewSede){
    btnNewSede.addEventListener('click', ()=> dlgNewSede.showModal());
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
  let rol = ds.rol || '';
  if(['Admin','Administrador','admin'].includes(rol)) rol = 'admin';
  formEdit.rol.value = rol || 'Acondicionador';
      if(formEdit.sede_id){
        formEdit.sede_id.value = ds.sede || '';
      }
      if (formEdit.sesion_ttl_minutos) {
        const ttl = ds.ttl ? Number(ds.ttl) : '';
        formEdit.sesion_ttl_minutos.value = ttl && Number.isFinite(ttl) ? ttl : '';
        if (ttlMin) formEdit.sesion_ttl_minutos.min = ttlMin;
        if (ttlMax) formEdit.sesion_ttl_minutos.max = ttlMax;
      }
      formEdit.activo.value = ds.activo === 'false' ? 'false' : 'true';
      dlgEdit.showModal();
    });
  });

  // Inhabilitar en lugar de eliminar (soft-delete lógico)
  qsa('.btn-del-user').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if(!confirm('¿Inhabilitar este usuario?')) return;
      try {
        const res = await fetch(`/administracion/${id}/estado`, { 
          method:'POST', 
          headers:{'Content-Type':'application/json'}, 
          body: JSON.stringify({ activo: false }) 
        });
        if(res.ok) location.reload();
        else {
          const data = await res.json().catch(()=>({}));
          alert(data.error || 'No se pudo inhabilitar');
        }
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
