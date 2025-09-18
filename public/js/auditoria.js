'use strict';
(function(){
  const dlg = document.getElementById('aud-edit-modal');
  const form = document.getElementById('aud-edit-form');
  const sel = document.getElementById('aud-edit-auditada');
  const com = document.getElementById('aud-edit-comentarios');

  document.addEventListener('click', function(e){
    const t = e.target;
    if(!(t instanceof HTMLElement)) return;
    if(t.matches('[data-action="aud-edit"]')){
      const id = t.getAttribute('data-id');
      const auditada = t.getAttribute('data-auditada') === 'true' ? 'true' : 'false';
      const comentarios = t.getAttribute('data-comentarios') || '';
      if(form && id){ form.setAttribute('action', '/auditoria/' + id + '/update'); }
      if(sel){ sel.value = auditada; }
      if(com){ com.value = comentarios; }
      try{ dlg.showModal(); }catch{ dlg.classList.remove('hidden'); }
    }
    if(t.matches('[data-close]')){
      try{ dlg.close(); }catch{ dlg.classList.add('hidden'); }
    }
  });

  document.addEventListener('submit', function(e){
    const target = e.target;
    if(!(target instanceof HTMLFormElement)) return;
    if(target.matches('[data-action="aud-delete"]')){
      const ok = window.confirm('¿Eliminar registro de auditoría?');
      if(!ok){ e.preventDefault(); }
    }
  });
})();
