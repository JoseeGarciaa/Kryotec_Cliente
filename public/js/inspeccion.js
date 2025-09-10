// Inspección: listar cajas en estado Inspección con mismo diseño de tarjetas
(function(){
  'use strict';
  const qs = (s)=> document.querySelector(s);
  const grid = qs('#insp-caja-grid');
  const spin = qs('#insp-spin');
  const state = { cajas: [], serverOffset: 0, cajaSel: null, tics: [], ticChecks: new Map(), activeTic: null };

  function msElapsed(timer){ if(!timer||!timer.startsAt) return 0; return (Date.now()+state.serverOffset) - new Date(timer.startsAt).getTime(); }
  function timerDisplay(ms){ const s=Math.max(0,Math.floor(ms/1000)); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const sec=s%60; return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }
  function msRemaining(timer){ if(!timer||!timer.startsAt||!timer.durationSec) return null; const end = new Date(timer.startsAt).getTime() + timer.durationSec*1000; return end - (Date.now()+state.serverOffset); }

  function cardHTML(caja){
    const comps = caja.componentes||[];
    const vip = comps.filter(x=>x.tipo==='vip');
    const tics = comps.filter(x=>x.tipo==='tic');
    const cubes = comps.filter(x=>x.tipo==='cube');
    const compBadges = [
      ...vip.map(()=>`<span class='badge badge-info badge-xs font-semibold'>VIP</span>`),
      ...tics.map(()=>`<span class='badge badge-warning badge-xs font-semibold'>TIC</span>`),
      ...cubes.map(()=>`<span class='badge badge-accent badge-xs font-semibold'>CUBE</span>`)
    ].join(' ');
    const timerHtml = caja.timer && caja.timer.startsAt
      ? `<span class='badge badge-neutral badge-xs font-mono' data-insp-timer='${caja.id}' id='insp-timer-${caja.id}'>${timerDisplay(msElapsed(caja.timer))}</span>`
      : `<span class='badge badge-outline badge-xs opacity-70'>Sin cronómetro</span>`;
    return `<div class='caja-card rounded-lg border border-base-300/40 bg-base-200/10 p-3 flex flex-col gap-2'>
      <div class='flex items-center justify-between text-[10px] tracking-wide uppercase opacity-60'><span>Caja</span><span class='font-mono'>${caja.codigoCaja||''}</span></div>
      <div class='font-semibold text-xs leading-tight break-all pr-2' title='${caja.codigoCaja||''}'>${caja.codigoCaja||''}</div>
      <div class='flex flex-wrap gap-1 text-[9px] flex-1'>${compBadges || "<span class='badge badge-ghost badge-xs'>Sin items</span>"}</div>
      <div class='flex items-center justify-between text-[10px] opacity-70'>
        <span class='badge badge-outline badge-xs'>Inspección</span>
        ${timerHtml}
      </div>
    </div>`;
  }

  function render(){
    if(!grid) return;
    const cajas = state.cajas||[];
    if(!cajas.length){ grid.innerHTML = `<div class='col-span-full py-10 text-center text-xs opacity-60'>Sin cajas en Inspección</div>`; return; }
    grid.innerHTML = cajas.map(cardHTML).join('');
  }

  async function load(){
    try { spin?.classList.remove('hidden');
      const r = await fetch('/operacion/inspeccion/data');
      const j = await r.json();
      state.cajas = j.ok ? (j.cajas||[]) : [];
      if(j.ok && j.serverNow){ state.serverOffset = new Date(j.serverNow).getTime() - Date.now(); }
      render();
    } catch(e){ console.error('[Inspección] load error', e); }
    finally { spin?.classList.add('hidden'); }
  }

  load();
  setInterval(load, 15000);
  // tick timers
  setInterval(()=>{
    (state.cajas||[]).forEach(c=>{
      if(!c.timer||!c.timer.startsAt) return;
      const el = document.getElementById('insp-timer-'+c.id);
      if(!el) return;
      if(c.timer && c.timer.durationSec){
        const rem = Math.max(0, msRemaining(c.timer)||0);
        el.textContent = '↓ ' + timerDisplay(rem);
      } else {
        el.textContent = timerDisplay(msElapsed(c.timer));
      }
    });
  }, 1000);
  // ---- Scan/Lookup caja ----
  const scanInput = qs('#insp-scan');
  const scanBtn = qs('#insp-scan-btn');
  const scanClear = qs('#insp-scan-clear');
  const scanMsg = qs('#insp-scan-msg');
  const panel = qs('#insp-caja-panel');
  const panelLote = qs('#insp-caja-lote');
  const panelCount = qs('#insp-caja-tic-count');
  const panelComps = qs('#insp-caja-comps');
  const checklistArea = qs('#insp-checklist-area');
  const list = qs('#insp-tic-list');
  const completeBtn = qs('#insp-complete');
  // TIC scan elements
  const ticScan = qs('#insp-tic-scan');
  const ticScanBtn = qs('#insp-tic-scan-btn');
  const ticScanClear = qs('#insp-tic-scan-clear');
  const ticMsg = qs('#insp-tic-msg');
  // Add modal controls (Agregar a Inspección)
  const btnAdd = qs('#insp-btn-add');
  const addDlg = document.getElementById('insp-modal-add');
  const addScan = qs('#insp-add-scan');
  const addH = qs('#insp-add-hours');
  const addM = qs('#insp-add-mins');
  const addMsg = qs('#insp-add-msg');
  const addConfirm = qs('#insp-add-confirm');
  const addClear = qs('#insp-add-clear');
  const addItems = qs('#insp-add-items');

  function renderChecklist(){
    if(!panel||!list) return;
    panel.classList.remove('hidden');
    panelLote && (panelLote.textContent = state.cajaSel?.lote || '—');
    panelCount && (panelCount.textContent = String(state.tics.length||0));
    // Render componentes si vienen
    if(panelComps){
      const comps = state.cajaSel?.componentes || [];
      panelComps.innerHTML = comps.length
        ? comps.map(it=>{
            let cls='badge-ghost'; const t=(it.tipo||'').toLowerCase();
            if(t==='vip') cls='badge-info'; else if(t==='tic') cls='badge-warning'; else if(t==='cube') cls='badge-accent';
            const code = it.codigo || it.rfid || '';
            return `<span class='badge ${cls} badge-xs' title='${code}'>${(t||'').toUpperCase()}</span>`;
          }).join(' ')
        : "<span class='badge badge-ghost badge-xs'>Sin items</span>";
    }
    // Checklist visible solo si la caja está en Inspección (cuando tics fueron cargadas desde inspección endpoints)
    if(checklistArea){ checklistArea.classList.toggle('hidden', !(state.tics||[]).length); }
    const active = state.activeTic;
    list.innerHTML = (state.tics||[]).map(t=>{
      const v = state.ticChecks.get(t.rfid) || { limpieza:false, goteo:false, desinfeccion:false };
      const enabled = active === t.rfid;
      const rowCls = enabled ? 'border-primary bg-primary/10 ring-2 ring-primary shadow-md' : 'bg-base-100 border-base-300/40 opacity-70';
      const dis = enabled ? '' : 'disabled';
      const badge = enabled ? "<span class='badge badge-primary badge-xs'>ACTIVA</span>" : '';
      return `<div class='border rounded-md p-2 ${rowCls}' data-tic-row='${t.rfid}'>
        <div class='flex items-center justify-between text-[11px] font-mono opacity-70'><span>TIC ${badge}</span><span>${t.rfid}</span></div>
        <div class='flex gap-3 mt-2 text-xs'>
          <label class='flex items-center gap-1 cursor-pointer'>
            <input type='checkbox' data-chk='limpieza' data-rfid='${t.rfid}' ${v.limpieza?'checked':''} ${dis}/> Limpieza
          </label>
          <label class='flex items-center gap-1 cursor-pointer'>
            <input type='checkbox' data-chk='goteo' data-rfid='${t.rfid}' ${v.goteo?'checked':''} ${dis}/> Goteo
          </label>
          <label class='flex items-center gap-1 cursor-pointer'>
            <input type='checkbox' data-chk='desinfeccion' data-rfid='${t.rfid}' ${v.desinfeccion?'checked':''} ${dis}/> Desinfección
          </label>
        </div>
      </div>`;
    }).join('');
    updateCompleteBtn();
  }

  // Abrir modal Agregar
  btnAdd?.addEventListener('click', ()=>{ try{ addDlg.showModal(); }catch{ addDlg.classList.remove('hidden'); } addMsg && (addMsg.textContent=''); addConfirm && (addConfirm.disabled=true); addScan && (addScan.value=''); addH && (addH.value=''); addM && (addM.value=''); setTimeout(()=> addScan?.focus(), 200); });

  async function lookupCaja(){
    const code = (scanInput?.value||'').trim();
    if(code.length!==24){ scanMsg && (scanMsg.textContent='RFID inválido'); return; }
    try {
      scanMsg && (scanMsg.textContent='Buscando...');
      const r = await fetch('/operacion/inspeccion/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfid: code })});
      const j = await r.json();
      if(j.ok){
        // Caja en Inspección: tenemos TICs; complementar con lista completa de componentes
        state.cajaSel = j.caja; state.tics = j.tics||[]; state.ticChecks = new Map(); state.activeTic = null;
        try{
          const r2 = await fetch('/operacion/caja/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code })});
          const j2 = await r2.json();
          if(j2.ok){
            const comps = (j2.caja?.items||[]).map(it=>({ codigo: it.rfid, tipo: (it.rol||inferTipo(it.nombre_modelo||'')) }))
            state.cajaSel = { ...state.cajaSel, componentes: comps };
          }
        }catch(_e){}
        renderChecklist();
        scanMsg && (scanMsg.textContent='');
        return;
      }
      // Si no está en Inspección, mostrar igualmente la composición completa de la caja (vip/tic/cube)
      // usando el lookup general de operación que devuelve items de la caja
      try {
        const r2 = await fetch('/operacion/caja/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code })});
        const j2 = await r2.json();
        if(j2.ok){
          const comps = (j2.caja?.items||[]).map(it=>({ codigo: it.rfid, tipo: (it.rol||inferTipo(it.nombre_modelo||'')) }))
          state.cajaSel = { id: j2.caja.id, lote: j2.caja.lote, componentes: comps };
          state.tics = []; state.ticChecks = new Map(); state.activeTic = null;
          renderChecklist();
          scanMsg && (scanMsg.textContent='Caja no está en Inspección. Usa "Agregar a Inspección" para traerla.');
          return;
        }
      } catch(_e){}
      // Fallback mensaje si no encontramos caja
      scanMsg && (scanMsg.textContent=j.error||'Caja no encontrada');
    } catch(e){ scanMsg && (scanMsg.textContent='Error'); }
  }

  // Inferir tipo simple por nombre de modelo (fallback)
  function inferTipo(nombre){ const n=(nombre||'').toLowerCase(); if(n.includes('vip')) return 'vip'; if(n.includes('tic')) return 'tic'; if(n.includes('cube')||n.includes('cubo')) return 'cube'; return 'otro'; }

  function updateCompleteBtn(){
  // Checklist habilitado solo cuando ya hay caja seleccionada (ya jalada a Inspección)
  const all = !!state.cajaSel?.id && (state.tics||[]).length===6 && (state.tics||[]).every(t=>{
      const v = state.ticChecks.get(t.rfid) || { limpieza:false, goteo:false, desinfeccion:false };
      return v.limpieza && v.goteo && v.desinfeccion;
    });
    if(completeBtn) completeBtn.disabled = !all;
  }

  document.addEventListener('change', async (e)=>{
    const t = e.target;
    if(!(t instanceof HTMLInputElement)) return;
    const fld = t.getAttribute('data-chk');
    const rfid = t.getAttribute('data-rfid');
    if(!fld || !rfid) return;
    const cur = state.ticChecks.get(rfid) || { limpieza:false, goteo:false, desinfeccion:false };
    cur[fld] = !!t.checked; state.ticChecks.set(rfid, cur); updateCompleteBtn();
  });

  completeBtn?.addEventListener('click', async ()=>{
    if(!state.cajaSel?.id) return;
    completeBtn.disabled = true;
    try {
      // Gather the 6 TIC RFIDs that have all 3 checks
      const confirm = (state.tics||[])
        .filter(t=>{ const v = state.ticChecks.get(t.rfid)||{limpieza:false,goteo:false,desinfeccion:false}; return v.limpieza&&v.goteo&&v.desinfeccion; })
        .map(t=>t.rfid);
      if(confirm.length!==6){ completeBtn.disabled=false; scanMsg && (scanMsg.textContent='Faltan checks'); return; }
      const r = await fetch('/operacion/inspeccion/complete',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: state.cajaSel.id, confirm_rfids: confirm })});
      const j = await r.json();
      if(!j.ok){ completeBtn.disabled=false; scanMsg && (scanMsg.textContent=j.error||'Error'); return; }
      // Reset panel and reload list
  panel.classList.add('hidden'); state.cajaSel=null; state.tics=[]; state.ticChecks.clear(); state.activeTic=null;
      scanInput && (scanInput.value='');
  await load();
  scanMsg && (scanMsg.textContent='Caja completa devuelta a Bodega y reiniciada');
    } catch(e){ completeBtn.disabled=false; scanMsg && (scanMsg.textContent='Error'); }
  });

  scanBtn?.addEventListener('click', lookupCaja);
  scanInput?.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); lookupCaja(); }});
  scanClear?.addEventListener('click', ()=>{ if(scanInput) scanInput.value=''; scanMsg && (scanMsg.textContent=''); panel?.classList.add('hidden'); state.cajaSel=null; state.tics=[]; state.ticChecks.clear(); state.activeTic=null; scanInput?.focus(); });
  scanInput && setTimeout(()=> scanInput.focus(), 400);

  // ---- TIC scan/activation ----
  function activateTic(rfid){
    if(!rfid) return;
    const exists = (state.tics||[]).some(t=>t.rfid===rfid);
    if(!exists){ ticMsg && (ticMsg.textContent='TIC no pertenece a la caja'); return; }
    state.activeTic = rfid; ticMsg && (ticMsg.textContent=''); renderChecklist();
  const row = document.querySelector(`[data-tic-row='${rfid}']`);
  row?.scrollIntoView({ behavior:'smooth', block:'center' });
  if(row){ row.classList.add('animate-pulse'); setTimeout(()=> row.classList.remove('animate-pulse'), 600); }
  }
  async function handleTicScan(){
    const code = (ticScan?.value||'').trim();
    if(code.length!==24){ ticMsg && (ticMsg.textContent='RFID TIC inválido'); return; }
    activateTic(code);
  }
  ticScanBtn?.addEventListener('click', handleTicScan);
  ticScan?.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); handleTicScan(); }});
  ticScanClear?.addEventListener('click', ()=>{ if(ticScan) ticScan.value=''; state.activeTic=null; renderChecklist(); ticMsg && (ticMsg.textContent=''); ticScan?.focus(); });

  // Validación de inputs del modal
  function updateAddConfirm(){
    const code = (addScan?.value||'').trim();
    const h = parseInt(addH?.value||'0',10)||0; const m = parseInt(addM?.value||'0',10)||0; const sec = h*3600 + m*60;
    addConfirm && (addConfirm.disabled = !(code.length===24 && sec>0));
  }
  async function renderAddItems(code){
    if(!addItems) return;
    addItems.innerHTML = '';
    if(code.length!==24){ return; }
    try{
      // Only preview if caja is exactly Pendiente a Inspección
      const r = await fetch('/operacion/inspeccion/pending/preview',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfid: code })});
      const j = await r.json();
      if(!j.ok){ addItems.innerHTML = ""; addMsg && (addMsg.textContent = j.error||'Caja no está Pendiente a Inspección'); return; }
      const items = (j.items||[]);
      addItems.innerHTML = items.map(it=>{
        const rol = (it.rol||'').toUpperCase();
        let cls='badge-ghost'; const rl=rol.toLowerCase();
        if(rl==='vip') cls='badge-info'; else if(rl==='tic') cls='badge-warning'; else if(rl==='cube') cls='badge-accent';
        return `<span class='badge ${cls} badge-sm font-mono'>${rol} • ${it.rfid}</span>`;
      }).join(' ');
    }catch(_e){ /* ignore */ }
  }
  addScan?.addEventListener('input', ()=>{ if(addScan.value.length>24) addScan.value = addScan.value.slice(0,24); updateAddConfirm(); renderAddItems((addScan?.value||'').trim()); });
  addH?.addEventListener('input', updateAddConfirm);
  addM?.addEventListener('input', updateAddConfirm);
  addClear?.addEventListener('click', ()=>{ addScan && (addScan.value=''); addH && (addH.value=''); addM && (addM.value=''); addMsg && (addMsg.textContent=''); if(addItems) addItems.innerHTML=''; updateAddConfirm(); addScan?.focus(); });
  addScan?.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); addConfirm?.click(); }});

  // Confirmar Agregar (pull con cronómetro obligatorio)
  addConfirm?.addEventListener('click', async ()=>{
    const code = (addScan?.value||'').trim();
    const h = parseInt(addH?.value||'0',10)||0; const m = parseInt(addM?.value||'0',10)||0; const sec = h*3600 + m*60;
    if(code.length!==24){ addMsg && (addMsg.textContent='RFID inválido'); return; }
    if(sec<=0){ addMsg && (addMsg.textContent='Asigna horas/minutos'); return; }
    // Validate eligibility again before pulling
    try{
      const r0 = await fetch('/operacion/inspeccion/pending/preview',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfid: code })});
      const j0 = await r0.json();
      if(!j0.ok){ addMsg && (addMsg.textContent = j0.error||'Caja no está Pendiente a Inspección'); return; }
    }catch(_e){ addMsg && (addMsg.textContent='Error validando'); return; }
    addMsg && (addMsg.textContent='Agregando...');
    try {
      const r = await fetch('/operacion/inspeccion/pull',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfid: code, durationSec: sec })});
      const j = await r.json();
      if(!j.ok){ addMsg && (addMsg.textContent=j.error||'Error'); return; }
      state.cajaSel = j.caja; state.tics = j.tics||[]; state.ticChecks = new Map(); state.activeTic = null;
      renderChecklist();
      await load();
      addMsg && (addMsg.textContent='Agregado');
      try{ addDlg.close(); }catch{ addDlg.classList.add('hidden'); }
    } catch(e){ addMsg && (addMsg.textContent='Error'); }
  });
})();
