// Devolución UI placeholder logic
(function(){
  'use strict';
  const qs = s=>document.querySelector(s);
  const qsa = s=>Array.from(document.querySelectorAll(s));
  const spin = qs('#dev-spin');
  const pendCount = qs('#dev-pend-count');
  const pendList = qs('#dev-pend-list');
  const empty = qs('#dev-empty');
  const table = qs('#dev-pend-table');
  const tableBody = qs('#dev-pend-table-body');
  const searchInput = qs('#dev-search');
  const btnCards = qs('#dev-view-cards');
  const btnList = qs('#dev-view-list');
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
  // Retorno scanning elements
  const retInput = qs('#ret-input');
  const retValidate = qs('#ret-validate');
  const retConfirm = qs('#ret-confirm');
  const retMsg = qs('#ret-msg');
  const retSelectedWrap = qs('#ret-selected');
  let retSelected = new Set();
  let data = { pendientes: [], stats:{ cubes:0,vips:0,tics:0,total:0 }, serverNow: null };
  let selected = new Set();
  let viewMode = localStorage.getItem('devViewMode') || 'cards';
  let serverOffsetMs = 0; // serverNow - Date.now()

  function updateViewToggle(){
    if(!pendList) return;
    const showCards = viewMode==='cards';
    pendList.classList.toggle('hidden', !showCards);
    table?.classList.toggle('hidden', showCards);
    btnCards?.classList.toggle('btn-active', showCards);
    btnList?.classList.toggle('btn-active', !showCards);
  }

  function openModal(){ try{ modal.showModal(); }catch{ modal.classList.remove('hidden'); } }
  function closeModal(){ try{ modal.close(); }catch{ modal.classList.add('hidden'); } }

  function renderPendientes(){
    if(!pendList) return;
    const term = (searchInput?.value||'').trim().toLowerCase();
  const items = term? data.pendientes.filter(p=> p.rfid.toLowerCase().includes(term) || (p.rol||'').toLowerCase().includes(term) || (p.caja||'').toLowerCase().includes(term)) : data.pendientes;
    if(!items.length){
      empty?.classList.remove('hidden');
    } else {
      empty?.classList.add('hidden');
    }
    // Render tarjetas
    if(items.length){
        if(!pendList.dataset.init){ pendList.classList.add('grid','gap-4','sm:grid-cols-2','md:grid-cols-3','lg:grid-cols-4'); pendList.dataset.init='1'; }
        pendList.innerHTML = items.map(p=>`<div class=\"border rounded-md p-3 bg-base-200/40 text-xs flex flex-col gap-2\" data-rfid=\"${p.rfid}\" data-role=\"${p.rol}\">
    <div class="font-mono text-[11px] break-all">${p.rfid}</div>
    <div class="text-[11px] font-semibold">${p.nombre||''}</div>
  <div class="text-[10px] opacity-70">${p.caja||''}</div>
  <div class="text-[10px] opacity-60">${p.sub_estado || p.estado || ''}</div>
          <div class=\"flex items-center justify-between\">
            <span class=\"badge badge-outline badge-xs\">${(p.rol||'').toUpperCase()}</span>
            <button type=\"button\" class=\"btn btn-ghost btn-[6px] btn-xs\" data-add-rfid=\"${p.rfid}\" title=\"Seleccionar\">+</button>
          </div>
        </div>`).join('');
    } else {
      pendList.innerHTML='';
    }
    // Render tabla
    if(tableBody){
        tableBody.innerHTML = items.map(p=>{
          // Esperamos que backend pueda enviar p.nombre, p.caja, p.timer { endsAt, startsAt, completedAt }
          const nombre = p.nombre||'';
    const caja = p.caja||p.lote||'';
  const t = p.timer||{};
  const estadoTxt = p.sub_estado || p.estado || '';
    const now = Date.now() + serverOffsetMs;
          let chronoTxt='-'; let badgeCls='badge-neutral';
          if(t && t.startsAt && (t.endsAt||t.completedAt)){
            if(t.completedAt){ chronoTxt='Completado'; badgeCls='badge-success'; }
            else if(t.endsAt){
              const end = new Date(t.endsAt).getTime();
              if(now>=end){ chronoTxt='Finalizado'; badgeCls='badge-warning'; }
              else { const rem=end-now; const sec=Math.floor(rem/1000); const m=Math.floor(sec/60); const s=sec%60; chronoTxt=`${m}m ${s.toString().padStart(2,'0')}s`; badgeCls = sec<=60? 'badge-error' : (sec<=300?'badge-warning':'badge-info'); }
            }
          }
          return `<tr class="hover" data-rfid="${p.rfid}" data-timer-row>
            <td class="font-mono text-[11px]">${p.rfid}</td>
            <td class="hidden md:table-cell text-xs">${nombre}</td>
            <td class="hidden md:table-cell text-xs">${caja}</td>
            <td class="hidden lg:table-cell text-[11px]">${estadoTxt}</td>
            <td class="w-32"><span class="badge ${badgeCls} badge-xs font-mono" data-dev-chrono data-rfid="${p.rfid}">${chronoTxt}</span></td>
          </tr>`;}).join('');
    }
    if(pendCount) pendCount.textContent = `(${items.length} de ${data.pendientes.length} items listos para devolver)`;
    updateViewToggle();
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
  function renderRetSelected(){
    if(!retSelectedWrap) return;
    retSelectedWrap.innerHTML = Array.from(retSelected).map(r=>`<div class="badge badge-success badge-sm" data-ret-rfid="${r}">${r}<button type="button" class="ml-1" data-ret-remove="${r}">×</button></div>`).join('');
    if(retConfirm) retConfirm.disabled = !retSelected.size;
  }

  async function load(){
  try { spin?.classList.remove('hidden');
      const r = await fetch('/operacion/devolucion/data').catch(()=>null);
  if(r && r.ok){ const j = await r.json(); if(j.ok){ data = j; if(j.serverNow){ serverOffsetMs = new Date(j.serverNow).getTime() - Date.now(); } }}
      // Fallback dummy if no endpoint yet
      if(!data || !Array.isArray(data.pendientes)) data = { pendientes: [], stats:{ cubes:0,vips:0,tics:0,total:0 } };
      renderPendientes(); renderStats();
      startLocalTick();
    } finally { spin?.classList.add('hidden'); }
  }

  // Actualiza cada segundo los cronómetros de tabla y tarjetas
  let tickInt = null;
  function startLocalTick(){
    if(tickInt) return;
    tickInt = setInterval(()=>{
      const now = Date.now();
      data.pendientes.forEach(p=>{
  const t = p.timer; if(!t) return; // solo lectura
        const el = document.querySelector(`[data-dev-chrono][data-rfid="${p.rfid}"]`);
        if(!el) return;
        let txt='-'; let cls='badge-neutral';
        if(t.completedAt){ txt='Completado'; cls='badge-success'; }
        else if(t.endsAt && t.startsAt){
          const end = new Date(t.endsAt).getTime();
          if(now>=end){ txt='Finalizado'; cls='badge-warning'; }
          else { const rem=end-now; const sec=Math.floor(rem/1000); const m=Math.floor(sec/60); const s=sec%60; txt=`${m}m ${s.toString().padStart(2,'0')}s`; cls=sec<=60?'badge-error':(sec<=300?'badge-warning':'badge-info'); }
        }
        el.textContent = txt; el.className = `badge ${cls} badge-xs font-mono`;
      });
    },1000);
  }

  document.addEventListener('click', e=>{
    const t = e.target; if(!(t instanceof HTMLElement)) return;
  const addBtn = t.closest('[data-add-rfid]');
  if(addBtn){ const rfid = addBtn.getAttribute('data-add-rfid'); if(rfid){ selected.add(rfid); renderSelected(); } }
    const sel = t.closest('[data-sel-rfid]');
    if(sel){ const r = sel.getAttribute('data-sel-rfid'); if(r){ selected.delete(r); renderSelected(); } }
  const retRem = t.getAttribute('data-ret-remove'); if(retRem){ retSelected.delete(retRem); renderRetSelected(); }
  });

  async function doValidate(){
    const raw = (input?.value||'').trim();
  const parts = raw.split(/\s+/).filter(x=> x && x.length===24); // solo RFIDs de 24 caracteres
  if(!parts.length){ validateMsg.textContent='Ingresa RFIDs (24 caracteres)'; selected.clear(); renderSelected(); return; }
  const unique = Array.from(new Set(parts));
    validateMsg.textContent='Validando...';
    try {
      const r = await fetch('/operacion/devolucion/validate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids: unique })});
      const j = await r.json();
  selected = new Set((j.valid||[]).map(v=> v.rfid));
      renderSelected();
      if(validateMsg){
        const inv = (j.invalid||[]);
    if(!j.valid?.length) validateMsg.textContent = inv.length? 'Sin RFIDs válidos (deben estar en Operación: Transito/Retorno/Completado)':'Sin coincidencias';
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
  // Retorno validate & confirm
  async function retDoValidate(){
    const raw = (retInput?.value||'').trim();
    if(!raw){ retMsg && (retMsg.textContent='Ingresa RFIDs'); retSelected.clear(); renderRetSelected(); return; }
    const parts = Array.from(new Set(raw.split(/\s+/).filter(x=> x.length===24)));
    if(!parts.length){ retMsg && (retMsg.textContent='Sin RFIDs válidos'); retSelected.clear(); renderRetSelected(); return; }
    retMsg && (retMsg.textContent='Validando...');
    try {
      const r = await fetch('/operacion/devolucion/ret/validate',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids: parts })});
      const j = await r.json();
      retSelected = new Set((j.valid||[]).map(v=> v.rfid));
      renderRetSelected();
      const inv = (j.invalid||[]);
      if(retMsg) retMsg.textContent = `${retSelected.size} válidos` + (inv.length? ` · ${inv.length} ignorados`:'');
    } catch { if(retMsg) retMsg.textContent='Error validando'; }
  }
  retValidate?.addEventListener('click', retDoValidate);
  retConfirm?.addEventListener('click', async ()=>{
    if(!retSelected.size) return; retConfirm.disabled=true; if(retMsg) retMsg.textContent='Confirmando...';
    try {
      await fetch('/operacion/devolucion/ret/confirm',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids: Array.from(retSelected) })});
      retSelected.clear(); renderRetSelected(); if(retInput) retInput.value=''; await load(); if(retMsg) retMsg.textContent='Movidos a Bodega';
    } catch { if(retMsg) retMsg.textContent='Error confirmando'; }
    finally { retConfirm.disabled=false; }
  });
  btnAdd?.addEventListener('click', ()=>{ openModal(); });
  btnCards?.addEventListener('click', ()=>{ viewMode='cards'; localStorage.setItem('devViewMode','cards'); updateViewToggle(); });
  btnList?.addEventListener('click', ()=>{ viewMode='list'; localStorage.setItem('devViewMode','list'); updateViewToggle(); });
  searchInput?.addEventListener('input', ()=>{ renderPendientes(); });
  modal?.addEventListener('close', ()=>{ selected.clear(); renderSelected(); if(input) input.value=''; validateMsg.textContent=''; });

  updateViewToggle();
  load();
})();
