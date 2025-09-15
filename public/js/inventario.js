(function(){
  const input = document.getElementById('inv-search-input');
  const count = document.getElementById('inv-search-count');
  const tbody = document.getElementById('inv-tbody');
  const modeBadge = document.getElementById('inv-mode-badge');
  const status = document.getElementById('inv-status');
  const tagsBox = document.getElementById('inv-rfid-tags');
  let rfids = [];
  let remainder = '';
  let debounceTimer = 0, fetchTimer = 0;

  function updateCount(){ if(!input||!count) return; count.textContent = (input.value.length||0)+"/24 caracteres"; }
  updateCount();
  function parseBuffer(buf){ const s = String(buf||'').toUpperCase().replace(/[^A-Z0-9]/g,''); const found=[]; let i=0; while(i+24<=s.length){ found.push(s.slice(i,i+24)); i+=24; } return { found, rest: s.slice(i) }; }
  function addCodes(codes){ let added=false; for(const c of codes){ if(!rfids.includes(c)){ rfids.push(c); added=true; } } if(added){ renderTags(); scheduleFetch(); } }
  function renderTags(){ if(!tagsBox) return; if(!rfids.length){ tagsBox.innerHTML=''; return; } tagsBox.innerHTML = rfids.map(r=>`<span class="badge badge-primary gap-1" data-rfid-tag="${r}">${r}<button type="button" class="ml-1" data-action="remove-rfid" data-rfid="${r}">✕</button></span>`).join(''); }
  async function fetchData(){ if(!tbody) return; const multi=rfids.length>1; const single=rfids.length===1; if(modeBadge) modeBadge.textContent = multi? 'Multi': (single? 'Caja':'Buscar'); let url='/inventario/data?limit=500'; if(multi) url+='&rfids='+encodeURIComponent(rfids.join(',')); else if(single) url+='&q='+encodeURIComponent(rfids[0]); else { const q=(input?.value||'').trim(); if(q){ url+='&q='+encodeURIComponent(q); } else { tbody.innerHTML='<tr><td colspan="9" class="text-center py-6 opacity-60">Escanea o escribe para iniciar</td></tr>'; if(status) status.textContent=''; return; } } tbody.innerHTML='<tr><td colspan="9" class="text-center py-4"><span class="loading loading-spinner loading-xs"></span></td></tr>'; try{ const r=await fetch(url,{headers:{'Accept':'application/json'}}); const j=await r.json(); if(!j.ok){ tbody.innerHTML='<tr><td colspan="9" class="text-center text-error">Error</td></tr>'; return; } const rows=j.items||[]; if(!rows.length){ tbody.innerHTML='<tr><td colspan="9" class="text-center py-4 opacity-60">Sin resultados</td></tr>'; if(status) status.textContent='Sin resultados'; return; } tbody.innerHTML=rows.map(i=>{ const fecha=i.fecha_ingreso? new Date(i.fecha_ingreso).toLocaleString(): '-'; const sub=i.sub_estado? `<div class=\"badge badge-outline whitespace-nowrap\">${i.sub_estado}</div>`:'<span class="opacity-60">—</span>'; return `<tr><td>${i.nombre_unidad||''}</td><td>${i.modelo_id||''}</td><td><code class=\"font-mono text-xs\">${i.rfid||''}</code></td><td class=\"whitespace-nowrap\">${i.lote||''}</td><td class=\"whitespace-nowrap\"><div class=\"badge badge-primary badge-outline whitespace-nowrap\">${i.estado||''}</div></td><td class=\"whitespace-nowrap\">${sub}</td><td>${i.categoria||''}</td><td>${fecha}</td><td class=\"whitespace-nowrap\"><button type=\"button\" class=\"btn btn-ghost btn-xs\" data-action=\"inv-edit\" data-id=\"${i.id}\" data-modelo_id=\"${i.modelo_id}\" data-rfid=\"${i.rfid}\" data-nombre=\"${(i.nombre_unidad||'').replace(/\"/g,'&quot;')}\" data-lote=\"${(i.lote||'').replace(/\"/g,'&quot;')}\" data-estado=\"${(i.estado||'').replace(/\"/g,'&quot;')}\" data-sub=\"${(i.sub_estado||'').replace(/\"/g,'&quot;')}\">✎</button></td></tr>`; }).join(''); if(status) status.textContent=`${rows.length} resultado${rows.length!==1?'s':''} (${j.mode})`; }catch(e){ console.error(e); tbody.innerHTML='<tr><td colspan="9" class="text-center text-error">Error</td></tr>'; } }
  function scheduleFetch(){ if(fetchTimer) clearTimeout(fetchTimer); fetchTimer=setTimeout(()=>{ fetchTimer=0; fetchData(); },140); }
  function handleInput(){ if(!input) return; const {found, rest}=parseBuffer(remainder+input.value); if(found.length){ addCodes(found); input.value=''; remainder=rest; updateCount(); } }
  if(input){ input.addEventListener('input', ()=>{ if(debounceTimer) clearTimeout(debounceTimer); debounceTimer=setTimeout(()=>{ handleInput(); },80); updateCount(); }); input.addEventListener('paste', e=>{ const t=e.clipboardData?.getData('text')||''; if(t){ e.preventDefault(); const {found,rest}=parseBuffer(remainder+t); addCodes(found); remainder=rest; scheduleFetch(); } }); input.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); handleInput(); } }); }
  document.addEventListener('click', e=>{ const t=e.target; if(!(t instanceof HTMLElement)) return; if(t.matches('[data-action="remove-rfid"]')){ const r=t.getAttribute('data-rfid'); if(r){ rfids=rfids.filter(x=>x!==r); renderTags(); scheduleFetch(); } } if(t.id==='inv-clear-multiscan'){ e.preventDefault(); rfids=[]; remainder=''; renderTags(); scheduleFetch(); } });

  // Modal edición (reutilizamos bloque original)
  const modal = document.getElementById('inv-edit-modal');
  const formEdit = document.getElementById('inv-edit-form');
  const fModeloId = document.getElementById('inv-edit-modelo_id');
  const fRfid = document.getElementById('inv-edit-rfid');
  const fNombre = document.getElementById('inv-edit-nombre');
  const fLote = document.getElementById('inv-edit-lote');
  const fEstado = document.getElementById('inv-edit-estado');
  const fSub = document.getElementById('inv-edit-sub');
  if(modal){ modal.addEventListener('close', ()=>{ if(formEdit) formEdit.reset(); }); }
  document.addEventListener('click', (e)=>{
    const t = e.target; if(!(t instanceof HTMLElement)) return;
    if(t.matches('[data-action="inv-edit"]')){
      e.preventDefault();
      const id = t.getAttribute('data-id');
      const modelo_id = t.getAttribute('data-modelo_id')||'';
      const rfid = t.getAttribute('data-rfid')||'';
      const nombre = t.getAttribute('data-nombre')||'';
      const lote = t.getAttribute('data-lote')||'';
      const estado = t.getAttribute('data-estado')||'';
      const sub = t.getAttribute('data-sub')||'';
      if(formEdit){ formEdit.action = `/inventario/${id}/update`; }
      if(fModeloId) fModeloId.value = modelo_id;
      if(fRfid) fRfid.value = rfid;
      if(fNombre) fNombre.value = nombre;
      if(fLote) fLote.value = lote;
      if(fEstado) fEstado.value = estado;
      if(fSub) fSub.value = sub;
      try{ modal.showModal(); }catch{ modal.classList.remove('hidden'); }
      if(fNombre) setTimeout(()=>fNombre.focus(), 100);
    }
    if(t.id==='inv-edit-cancel'){ modal?.close?.(); }
  });
  document.addEventListener('submit', (e)=>{ const t=e.target; if(t instanceof HTMLFormElement && t.classList.contains('inv-delete-form')){ if(!window.confirm('¿Eliminar este item?')){ e.preventDefault(); } } });
})();
