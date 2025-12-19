// JS para manejar CRUD de Administración evitando inline scripts (CSP)
(function(){
  function qs(sel, ctx){return (ctx||document).querySelector(sel);} 
  function qsa(sel, ctx){return Array.from((ctx||document).querySelectorAll(sel));}

  const btnNew = qs('#btn-new-user');
  const dlgNew = qs('#dlg-new-user');
  const btnNewSede = qs('#btn-new-sede');
  const dlgNewSede = qs('#dlg-new-sede');
  const dlgEditSede = qs('#dlg-edit-sede');
  const formEditSede = qs('#form-edit-sede');
  const dlgEdit = qs('#dlg-edit-user');
  const formEdit = qs('#form-edit');
  const ttlMin = formEdit && formEdit.dataset && formEdit.dataset.ttlMin ? Number(formEdit.dataset.ttlMin) : 0;
  const ttlMax = formEdit && formEdit.dataset && formEdit.dataset.ttlMax ? Number(formEdit.dataset.ttlMax) : 0;
  function applyRoleExclusivity(select){
    if(!(select instanceof HTMLSelectElement)) return;
    const values = Array.from(select.selectedOptions).map((opt)=> opt.value);
    const hasSuper = values.includes('super_admin');
    const hasAdmin = values.includes('admin');
    const exclusive = hasSuper ? 'super_admin' : (hasAdmin ? 'admin' : null);
    const options = Array.from(select.options);
    options.forEach((opt)=>{
      opt.disabled = false;
      if(exclusive){
        opt.selected = opt.value === exclusive;
      }
    });
    if(!exclusive){
      const hasSelection = options.some((opt)=> opt.selected);
      if(!hasSelection){
        const defaultOpt = options.find((opt)=> opt.value === 'acondicionador');
        if(defaultOpt){ defaultOpt.selected = true; }
      }
    }
  }

  function bindRoleSelect(select){
    if(!(select instanceof HTMLSelectElement)) return;
    if(select.dataset.rolesBound === 'true') return;
    select.dataset.rolesBound = 'true';
    // Toggle roles on click so users do not need modifier keys
    const handleMouseDown = (event) => {
      if(event.button !== 0) return;
      const option = event.target;
      if(!(option instanceof HTMLOptionElement)) return;
      event.preventDefault();
      if(select.disabled || option.disabled) return;
      const options = Array.from(select.options);
      const wasSelected = option.selected;
      const isExclusive = option.value === 'admin' || option.value === 'super_admin';
      if(isExclusive){
        options.forEach((opt)=>{
          if(opt === option){
            opt.selected = !wasSelected;
          } else {
            opt.selected = false;
          }
        });
      } else {
        options.forEach((opt)=>{
          if(opt.value === 'admin' || opt.value === 'super_admin'){
            opt.selected = false;
          }
        });
        option.selected = !wasSelected;
      }
      applyRoleExclusivity(select);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    select.addEventListener('mousedown', handleMouseDown);
    select.addEventListener('change', ()=> applyRoleExclusivity(select));
    applyRoleExclusivity(select);
  }

  const newRolesSelect = qs('#new-user-roles');
  bindRoleSelect(newRolesSelect);

  if(btnNew && dlgNew){
    btnNew.addEventListener('click', ()=> dlgNew.showModal());
  }

  if(btnNewSede && dlgNewSede){
    btnNewSede.addEventListener('click', ()=> dlgNewSede.showModal());
  }

  qsa('.btn-edit-sede').forEach(btn => {
    btn.addEventListener('click', () => {
      if(!dlgEditSede || !formEditSede) return;
      const id = btn.dataset.id;
      if(!id) return;
      formEditSede.action = `/administracion/sedes/${id}`;
      if(formEditSede.nombre) formEditSede.nombre.value = btn.dataset.nombre || '';
      if(formEditSede.codigo) formEditSede.codigo.value = btn.dataset.codigo || '';
      if(formEditSede.activa){
        const activeValue = btn.dataset.activo === 'false' ? 'false' : 'true';
        formEditSede.activa.value = activeValue;
      }
      dlgEditSede.showModal();
    });
  });

  qsa('.btn-del-sede').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if(!id) return;
      const nombre = btn.dataset.nombre ? btn.dataset.nombre : 'esta sede';
      if(!window.confirm(`¿Eliminar ${nombre}? Esta acción no se puede deshacer.`)) return;
      const form = document.createElement('form');
      form.method = 'post';
      form.action = `/administracion/sedes/${id}/eliminar`;
      document.body.appendChild(form);
      form.submit();
      setTimeout(() => {
        if(form.parentNode) form.parentNode.removeChild(form);
      }, 1000);
    });
  });

  // Toggle activo
  qsa('.btn-toggle-activo').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const next = btn.dataset.next;
      const nombre = btn.dataset.nombre || '';
      const label = nombre ? `al usuario ${nombre}` : 'al usuario';
      const currentActive = String(next) === 'false';
      const confirmMessage = currentActive
        ? `¿Inactivar ${label}?`
        : `¿Reactivar ${label}?`;
      if (!window.confirm(confirmMessage)) return;
      try {
        const res = await fetch(`/administracion/${id}/estado`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activo: next }),
        });
        if (res.ok) {
          location.reload();
        } else {
          const data = await res.json().catch(() => ({}));
          window.alert(data.error || 'No se pudo actualizar el usuario');
        }
      } catch (e) {
        console.error(e);
        window.alert('No se pudo actualizar el usuario');
      }
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
      const rolesSelect = formEdit.querySelector('select[name="roles"]');
      const parseRoles = () => {
        if (!ds.roles) return [];
        try {
          const parsed = JSON.parse(ds.roles);
          if (Array.isArray(parsed)) return parsed.map((r) => String(r).toLowerCase());
        } catch {}
        return String(ds.roles || '')
          .split(',')
          .map((r) => r.trim().toLowerCase())
          .filter(Boolean);
      };
      let roles = parseRoles();
      if (!roles.length) {
        let rol = (ds.rol || '').toString();
        if (['Admin','Administrador','admin'].includes(rol)) rol = 'admin';
        if (['SuperAdmin','superadmin','Super Admin','super admin','super_admin','Super-Admin','super-admin'].includes(rol)) rol = 'super_admin';
        roles = rol ? [rol.toLowerCase()] : [];
      }
      if (rolesSelect instanceof HTMLSelectElement) {
        const sanitized = roles.includes('super_admin')
          ? ['super_admin']
          : (roles.includes('admin') ? ['admin'] : (roles.length ? roles : ['acondicionador']));
        Array.from(rolesSelect.options).forEach((opt) => {
          opt.selected = sanitized.includes(opt.value);
        });
        applyRoleExclusivity(rolesSelect);
      }
      if(formEdit.sede_id){
        formEdit.sede_id.value = ds.sede || '';
        if(!ds.sede){
          formEdit.sede_id.value = '';
        }
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

  const editRolesSelect = qs('#edit-user-roles');
  bindRoleSelect(editRolesSelect);
})();
