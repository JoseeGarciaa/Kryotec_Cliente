// Devolución UI placeholder logic
(function(){
  'use strict';
  const qs = s=>document.querySelector(s);
  const qsa = s=>Array.from(document.querySelectorAll(s));
  const spin = qs('#dev-spin');
  const pendCount = qs('#dev-pend-count');
  const pendList = qs('#dev-pend-list');
  const empty = qs('#dev-empty');
  const totalBadge = qs('#dev-total');
  const cntCubes = qs('#dev-count-cubes');
  const cntVips = qs('#dev-count-vips');
  const cntTics = qs('#dev-count-tics');
  const lastUpdate = qs('#dev-last-update');
  const btnAdd = qs('#dev-btn-add');
  const modal = document.getElementById('dev-modal');
  const input = qs('#dev-input');
  const validateBtn = qs('#dev-validate');
  const confirmBtn = qs('#dev-confirm');
  const clearBtn = qs('#dev-clear');
  const selWrap = qs('#dev-selected');
  const validateMsg = qs('#dev-validate-msg');
  let data = { pendientes: [], stats:{ cubes:0,vips:0,tics:0,total:0 } };
  let selected = new Set();

  function openModal(){ try{ modal.showModal(); }catch{ modal.classList.remove('hidden'); } }
  function closeModal(){ try{ modal.close(); }catch{ modal.classList.add('hidden'); } }

  function renderPendientes(){
    if(!pendList) return;
    if(!data.pendientes.length){ pendList.classList.add('hidden'); empty?.classList.remove('hidden'); }
    else {
      empty?.classList.add('hidden');
      pendList.classList.remove('hidden');
      // Lazy add grid + responsive classes once
      if(!pendList.dataset.init){
        pendList.classList.add('grid','gap-4','sm:grid-cols-2','md:grid-cols-3','lg:grid-cols-4');
        pendList.dataset.init='1';
      }
      pendList.innerHTML = data.pendientes.map(p=>`<div class="border rounded-md p-3 bg-base-200/40 text-xs flex flex-col gap-2" data-rfid="${p.rfid}" data-role="${p.rol}">
        <div class="font-mono text-[11px] break-all">${p.rfid}</div>
        <div class="flex items-center justify-between">
          <span class="badge badge-outline badge-xs">${p.rol.toUpperCase()}</span>
          <button type="button" class="btn btn-ghost btn-[6px] btn-xs" data-add-rfid="${p.rfid}" title="Seleccionar">+</button>
        </div>
      </div>`).join('');
    }
    if(pendCount) pendCount.textContent = `(${data.pendientes.length} items listos para devolver)`;
  }
  function renderStats(){
    if(totalBadge) totalBadge.textContent = String(data.stats.total||0);
    if(cntCubes) cntCubes.textContent = String(data.stats.cubes||0);
    if(cntVips) cntVips.textContent = String(data.stats.vips||0);
    if(cntTics) cntTics.textContent = String(data.stats.tics||0);
    if(lastUpdate) lastUpdate.textContent = new Date().toLocaleTimeString();
  }
  function renderSelected(){
    if(!selWrap) return;
    selWrap.innerHTML = Array.from(selected).map(r=>`<div class="badge badge-primary badge-sm flex justify-between w-full" data-sel-rfid="${r}"><span class="truncate max-w-[140px]">${r}</span><button type="button" class="ml-2 opacity-70 hover:opacity-100" title="Quitar">×</button></div>`).join('');
    confirmBtn.disabled = !selected.size;
  }

  async function load(){
  try { spin?.classList.remove('hidden');
      const r = await fetch('/operacion/devolucion/data').catch(()=>null);
      if(r && r.ok){ const j = await r.json(); if(j.ok){ data = j; }}
      // Fallback dummy if no endpoint yet
      if(!data || !Array.isArray(data.pendientes)) data = { pendientes: [], stats:{ cubes:0,vips:0,tics:0,total:0 } };
      renderPendientes(); renderStats();
    } finally { spin?.classList.add('hidden'); }
  }

  document.addEventListener('click', e=>{
    const t = e.target; if(!(t instanceof HTMLElement)) return;
    const addBtn = t.closest('[data-add-rfid]');
    if(addBtn){ const rfid = addBtn.getAttribute('data-add-rfid'); if(rfid){ selected.add(rfid); renderSelected(); } }
    const sel = t.closest('[data-sel-rfid]');
    if(sel){ const r = sel.getAttribute('data-sel-rfid'); if(r){ selected.delete(r); renderSelected(); } }
  });

  async function doValidate(){
    const raw = (input?.value||'').trim();
  const parts = raw.split(/\s+/).filter(Boolean);
    if(!parts.length){ validateMsg.textContent='Ingresa RFIDs'; selected.clear(); renderSelected(); return; }
    const unique = Array.from(new Set(parts));
    validateMsg.textContent='Validando...';
    try {
      const r = await fetch('/operacion/devolucion/validate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids: unique })});
      const j = await r.json();
  selected = new Set((j.valid||[]).map(v=> v.rfid));
      renderSelected();
      if(validateMsg){
        const inv = (j.invalid||[]);
  if(!j.valid?.length) validateMsg.textContent = inv.length? 'Sin RFIDs válidos (deben estar en Operación / Transito)':'Sin coincidencias';
        else {
          const resumenInv = inv.slice(0,4).map(x=> x.rfid.split('').slice(-6).join('')).join(', ');
          validateMsg.textContent = inv.length? `${j.valid.length} válidos · ${inv.length} ignorados`+(inv.length? ` (${resumenInv}${inv.length>4?'…':''})`:'') : `${j.valid.length} válidos`;
        }
      }
    } catch { validateMsg.textContent='Error validando'; }
  }
  validateBtn?.addEventListener('click', doValidate);
  input?.addEventListener('keydown', e=>{ if(e.key==='Enter' && (e.ctrlKey||e.metaKey)){ e.preventDefault(); doValidate(); } });
  clearBtn?.addEventListener('click', ()=>{ selected.clear(); renderSelected(); if(input) input.value=''; validateMsg.textContent=''; input?.focus(); });
  confirmBtn?.addEventListener('click', async ()=>{
    if(!selected.size) return; confirmBtn.disabled=true;
    try {
      const rfids = Array.from(selected);
      await fetch('/operacion/devolucion/confirm',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids })});
      selected.clear(); renderSelected(); if(input) input.value=''; await load();
      closeModal();
    } catch{ /* ignore */ } finally { confirmBtn.disabled=false; }
  });
  btnAdd?.addEventListener('click', ()=>{ openModal(); });
  modal?.addEventListener('close', ()=>{ selected.clear(); renderSelected(); if(input) input.value=''; validateMsg.textContent=''; });

  load();
})();
