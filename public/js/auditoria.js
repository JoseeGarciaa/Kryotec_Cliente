'use strict';
(function(){
  const dlg = document.getElementById('aud-edit-modal');
  const form = document.getElementById('aud-edit-form');
  const sel = document.getElementById('aud-edit-auditada');
  const com = document.getElementById('aud-edit-comentarios');
  let globalSubmitting = false;

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
    if(target.hasAttribute('data-single-submit')){
      if(globalSubmitting || target.hasAttribute('data-submitting')){
        e.preventDefault();
        return;
      }
      globalSubmitting = true;
      target.setAttribute('data-submitting', 'true');
      const submitters = document.querySelectorAll('form[data-single-submit] button[type="submit"], form[data-single-submit] input[type="submit"]');
      submitters.forEach((btn)=>{
        if(btn instanceof HTMLButtonElement || btn instanceof HTMLInputElement){ btn.disabled = true; }
      });
      const panel = target.closest('[data-selected-panel]');
      if(panel){
        panel.classList.add('relative');
        if(!panel.querySelector('[data-progress]')){
          const wrap = document.createElement('div');
          wrap.setAttribute('data-progress', '');
          wrap.className = 'absolute inset-0 bg-base-200/60 backdrop-blur-sm flex items-center justify-center z-10';
          wrap.innerHTML = '<span class="badge badge-lg badge-outline">Guardando...</span>';
          panel.appendChild(wrap);
        }
      }
    }
    if(target.matches('[data-action="aud-delete"]')){
      const ok = window.confirm('¿Eliminar registro de auditoría?');
      if(!ok){ e.preventDefault(); }
    }
  });
})();
