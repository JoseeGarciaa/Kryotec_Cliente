// Inspección: listar cajas en estado Inspección con mismo diseño de tarjetas
(function(){
  'use strict';
  const qs = (s)=> document.querySelector(s);
  const grid = qs('#insp-caja-grid');
  const spin = qs('#insp-spin');
  const state = {
    cajas: [],
    serverOffset: 0,
    cajaSel: null,
    tics: [],
    ticChecks: new Map(),
    activeTic: null,
    inInspeccion: false,
    bulkMode: false,
    bulkQueue: [],
    lastLookupCode: null
  };

  function msElapsed(timer){ if(!timer||!timer.startsAt) return 0; return (Date.now()+state.serverOffset) - new Date(timer.startsAt).getTime(); }
  function timerDisplay(ms){ const s=Math.max(0,Math.floor(ms/1000)); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const sec=s%60; return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }
  function msRemaining(timer){ if(!timer||!timer.startsAt||!timer.durationSec) return null; const end = new Date(timer.startsAt).getTime() + timer.durationSec*1000; return end - (Date.now()+state.serverOffset); }

  function cardHTML(caja){
    const comps = caja.componentes||[];
    const vip = comps.filter(x=>x.tipo==='vip');
    const tics = comps.filter(x=>x.tipo==='tic');
    const cubes = comps.filter(x=>x.tipo==='cube');
    const compBadges = [
      vip.length ? `<span class='badge badge-info badge-xs font-semibold' title='VIPs'>VIP × ${vip.length}</span>` : '',
      tics.length ? `<span class='badge badge-warning badge-xs font-semibold' title='TICs'>TIC × ${tics.length}</span>` : '',
      cubes.length ? `<span class='badge badge-accent badge-xs font-semibold' title='CUBEs'>CUBE × ${cubes.length}</span>` : ''
    ].filter(Boolean).join(' ');
    // Only show countdown timers (with duration). Hide forward/elapsed timers to avoid UI conflicts.
    const hasCountdown = !!(caja.timer && caja.timer.durationSec);
    const timerHtml = hasCountdown
      ? `<span class='badge badge-neutral badge-xs font-mono' data-insp-timer='${caja.id}' id='insp-timer-${caja.id}'>↓ ${timerDisplay(Math.max(0, msRemaining(caja.timer)||0))}</span>`
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
    // Update only countdown timers; ignore forward/elapsed timers entirely
    (state.cajas||[]).forEach(c=>{
      if(!c.timer || !c.timer.durationSec) return;
      const el = document.getElementById('insp-timer-'+c.id);
      if(!el) return;
      const rem = Math.max(0, msRemaining(c.timer)||0);
      el.textContent = '↓ ' + timerDisplay(rem);
    });
  }, 1000);
  // ---- Scan/Lookup caja ----
  const modeIndividualBtn = qs('#insp-mode-individual');
  const modeBulkBtn = qs('#insp-mode-bulk');
  const singleSection = qs('#insp-single-section');
  const bulkSection = qs('#insp-bulk-section');
  const bulkInput = qs('#insp-bulk-input');
  const bulkAddBtn = qs('#insp-bulk-add');
  const bulkNextBtn = qs('#insp-bulk-next');
  const bulkClearBtn = qs('#insp-bulk-clear');
  const bulkMsg = qs('#insp-bulk-msg');
  const bulkList = qs('#insp-bulk-list');

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
  const compList = qs('#insp-comp-list');
  const completeBtn = qs('#insp-complete');
  // Bulk check controls
  const checkAllBtn = qs('#insp-check-all');
  const uncheckAllBtn = qs('#insp-uncheck-all');
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

  function normalizeCode(code){
    const raw = (code||'').toString().toUpperCase();
    return raw.replace(/[^A-Z0-9]/g, '').trim();
  }

  function findBulkEntry(code){
    const target = normalizeCode(code);
    return state.bulkQueue.find(entry=> entry.code === target);
  }

  function updateBulkEntry(code, updates){
    const entry = findBulkEntry(code);
    if(entry){
      Object.assign(entry, updates||{});
      return entry;
    }
    return null;
  }

  function renderBulkQueue(){
    if(!bulkList) return;
    if(!state.bulkQueue.length){
      bulkList.innerHTML = "<div class='text-xs opacity-60'>Sin cajas en cola.</div>";
      return;
    }
    bulkList.innerHTML = state.bulkQueue.map(entry=>{
      const status = entry.status || 'queued';
      const message = entry.message || '';
      let badge = "<span class='badge badge-neutral badge-xs'>Pendiente</span>";
      if(status==='loading'){ badge = "<span class='badge badge-info badge-xs gap-1'><span class='loading loading-xs'></span>Buscando</span>"; }
      else if(status==='active'){ badge = "<span class='badge badge-primary badge-xs'>En inspección</span>"; }
      else if(status==='done'){ badge = "<span class='badge badge-success badge-xs'>Completada</span>"; }
      else if(status==='error'){ badge = "<span class='badge badge-error badge-xs'>Error</span>"; }
      const rowCls = status==='active' ? 'border-primary bg-primary/10 shadow-sm' : status==='done' ? 'border-success bg-success/5' : 'border-base-300/40 bg-base-100';
      const disableIdentify = status==='loading' || status==='active';
      return `<div class='border rounded-md p-2 space-y-1 ${rowCls}' data-bulk-code='${entry.code}'>
        <div class='flex items-center gap-2'>
          <span class='font-mono text-xs flex-1 truncate' title='${entry.code}'>${entry.code}</span>
          ${badge}
          <button class='btn btn-ghost btn-xs' data-action='bulk-open' data-code='${entry.code}' ${disableIdentify?'disabled':''}>Identificar</button>
          <button class='btn btn-ghost btn-xs text-error' data-action='bulk-remove' data-code='${entry.code}' title='Quitar'>✕</button>
        </div>
        ${message ? `<div class='text-[10px] opacity-70'>${message}</div>` : ''}
      </div>`;
    }).join('');
  }

  function setBulkMessage(text){ if(bulkMsg) bulkMsg.textContent = text||''; }

  function addBulkCodesFromList(codes){
    if(!Array.isArray(codes) || !codes.length){ return { added:0, total:0 }; }
    let added = 0;
    codes.forEach(raw=>{
      const code = normalizeCode(raw);
      if(code.length===24 && !state.bulkQueue.some(entry=> entry.code===code)){
        state.bulkQueue.push({ code, status:'queued', message:'' });
        added++;
      }
    });
    renderBulkQueue();
    return { added, total: codes.length };
  }

  function clearBulkQueue(){ state.bulkQueue = []; renderBulkQueue(); setBulkMessage(''); }

  function clearBulkActiveExcept(code){
    const target = normalizeCode(code);
    state.bulkQueue.forEach(entry=>{
      if(entry.code !== target && entry.status === 'active'){
        entry.status = entry.status === 'done' ? 'done' : 'queued';
      }
    });
  }

  function setMode(mode){
    const bulk = mode === 'bulk';
    state.bulkMode = bulk;
    modeIndividualBtn?.classList.toggle('btn-primary', !bulk);
    modeIndividualBtn?.classList.toggle('btn-ghost', bulk);
    modeBulkBtn?.classList.toggle('btn-primary', bulk);
    modeBulkBtn?.classList.toggle('btn-ghost', !bulk);
    singleSection?.classList.toggle('hidden', bulk);
    bulkSection?.classList.toggle('hidden', !bulk);
    setTimeout(()=> (bulk ? bulkInput : scanInput)?.focus(), 120);
  }

  function loadNextBulkCode(){
    const next = state.bulkQueue.find(entry=> entry.status==='queued' || entry.status==='error');
    if(next){ lookupCaja(next.code, { fromBulk:true }); }
    else { setBulkMessage('No hay cajas pendientes en la cola.'); }
  }

  renderBulkQueue();
  setMode('individual');

  modeIndividualBtn?.addEventListener('click', ()=> setMode('individual'));
  modeBulkBtn?.addEventListener('click', ()=> setMode('bulk'));

  function hasActiveBulk(){ return state.bulkQueue.some(entry=> entry.status==='active' || entry.status==='loading'); }

  function processBulkBuffer(raw){
    let value = (raw || '').toUpperCase();
    value = value.replace(/[^A-Z0-9]/g, '');
    let addedTotal = 0;
    let duplicateCount = 0;
    while(value.length >= 24){
      const chunk = value.slice(0,24);
      value = value.slice(24);
      const { added } = addBulkCodesFromList([chunk]);
      if(added>0){ addedTotal += added; }
      else { duplicateCount++; }
    }
    if(addedTotal>0){
      setBulkMessage(`Cajas añadidas: ${addedTotal}`);
      if(!hasActiveBulk()){ loadNextBulkCode(); }
    } else if(duplicateCount>0){
      setBulkMessage('Sin códigos nuevos.');
    }
    return value; // remainder (<24)
  }

  function handleBulkAppend(fromInput){
    const source = typeof fromInput === 'string' ? fromInput : (bulkInput?.value || '');
    const remainder = processBulkBuffer(source);
    if(bulkInput && bulkInput.value !== remainder){ bulkInput.value = remainder; }
    if(!remainder.length && !state.bulkQueue.length){ setBulkMessage(''); }
  }

  bulkAddBtn?.addEventListener('click', ()=> handleBulkAppend());
  bulkInput?.addEventListener('input', ()=>{
    if(!bulkInput) return;
    const remainder = processBulkBuffer(bulkInput.value);
    if(bulkInput.value !== remainder){ bulkInput.value = remainder; }
  });
  bulkInput?.addEventListener('keydown', (e)=>{
    if(e.key==='Enter' && !e.shiftKey){
      e.preventDefault();
      handleBulkAppend();
      if((bulkInput?.value||'').length){
        const missing = 24 - bulkInput.value.length;
        setBulkMessage(`RFID incompleto (faltan ${missing} caracteres).`);
      }
    }
  });
  bulkInput?.addEventListener('paste', (e)=>{
    const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if(text){
      e.preventDefault();
      const remainder = processBulkBuffer(text);
      if(bulkInput) bulkInput.value = remainder;
    }
  });
  bulkClearBtn?.addEventListener('click', ()=>{ clearBulkQueue(); if(bulkInput) bulkInput.value=''; setBulkMessage(''); });
  bulkNextBtn?.addEventListener('click', ()=> loadNextBulkCode());

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
    // Checklist visible cuando la caja está en Inspección. Debe mostrarse aún si hay 0 TICs
    // siempre que existan VIP/CUBE para inspeccionar.
    if(checklistArea){
      const hasVipCube = (state.cajaSel?.componentes||[]).some(it=> (it.tipo==='vip' || it.tipo==='cube'));
      const show = !!state.inInspeccion && (((state.tics||[]).length > 0) || hasVipCube);
      checklistArea.classList.toggle('hidden', !show);
    }
    const active = state.activeTic;
    list.innerHTML = (state.tics||[]).map(t=>{
      const v = state.ticChecks.get(t.rfid) || { limpieza:false, goteo:false, desinfeccion:false };
      const enabled = active === t.rfid;
      const rowCls = enabled ? 'border-primary bg-primary/10 ring-2 ring-primary shadow-md' : 'bg-base-100 border-base-300/40 opacity-70';
      const dis = enabled ? '' : 'disabled';
      const badge = enabled ? "<span class='badge badge-primary badge-xs'>ACTIVA</span>" : '';
      return `<div class='border rounded-md p-2 ${rowCls}' data-tic-row='${t.rfid}'>
        <div class='flex items-center justify-between text-[11px] font-mono opacity-70'>
          <span>TIC ${badge}</span>
          <span class='flex items-center gap-2'>
            <button class='btn btn-xs btn-error' data-action='tic-inhabilitar' data-rfid='${t.rfid}' title='Inhabilitar y registrar novedad'>Inhabilitar</button>
            <span>${t.rfid}</span>
          </span>
        </div>
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

    // Render VIP/CUBE components checklist (always enabled, no activation required)
    if(compList){
      const comps = (state.cajaSel?.componentes||[]).filter(it=> (it.tipo==='vip' || it.tipo==='cube'));
      compList.innerHTML = comps.length ? comps.map(it=>{
        const v = state.ticChecks.get(it.codigo) || { limpieza:false, goteo:false, desinfeccion:false };
        const label = (it.tipo||'').toUpperCase();
        let chipCls = 'badge-ghost'; if(it.tipo==='vip') chipCls='badge-info'; else if(it.tipo==='cube') chipCls='badge-accent';
        return `<div class='border rounded-md p-2 bg-base-100 border-base-300/40' data-comp-row='${it.codigo}'>
          <div class='flex items-center justify-between text-[11px] font-mono opacity-70'>
            <span>${label} <span class='badge ${chipCls} badge-xs ml-1'>${label}</span></span>
            <span class='flex items-center gap-2'>
              <button class='btn btn-xs btn-error' data-action='tic-inhabilitar' data-rfid='${it.codigo}' title='Inhabilitar y registrar novedad'>Inhabilitar</button>
              <span>${it.codigo}</span>
            </span>
          </div>
          <div class='flex gap-3 mt-2 text-xs'>
            <label class='flex items-center gap-1 cursor-pointer'>
              <input type='checkbox' data-chk='limpieza' data-rfid='${it.codigo}' ${v.limpieza?'checked':''}/> Limpieza
            </label>
            <label class='flex items-center gap-1 cursor-pointer'>
              <input type='checkbox' data-chk='goteo' data-rfid='${it.codigo}' ${v.goteo?'checked':''}/> Goteo
            </label>
            <label class='flex items-center gap-1 cursor-pointer'>
              <input type='checkbox' data-chk='desinfeccion' data-rfid='${it.codigo}' ${v.desinfeccion?'checked':''}/> Desinfección
            </label>
          </div>
        </div>`;
      }).join('') : "<div class='text-xs opacity-60'>No hay VIP/CUBE asociados</div>";
    }
    updateCompleteBtn();
  }
  // Novedad modal
  const novDlg = document.getElementById('insp-nov-modal');
  const novRfid = qs('#insp-nov-rfid');
  const novTipo = qs('#insp-nov-tipo');
  const novMotivo = qs('#insp-nov-motivo');
  const novDesc = qs('#insp-nov-desc');
  const novSev = qs('#insp-nov-severidad');
  const novInh = qs('#insp-nov-inhabilita');
  const novMsg = qs('#insp-nov-msg');
  const novConfirm = qs('#insp-nov-confirm');

  // Abrir modal Agregar
  btnAdd?.addEventListener('click', ()=>{ try{ addDlg.showModal(); }catch{ addDlg.classList.remove('hidden'); } addMsg && (addMsg.textContent=''); addConfirm && (addConfirm.disabled=true); addScan && (addScan.value=''); addH && (addH.value=''); addM && (addM.value=''); setTimeout(()=> addScan?.focus(), 200); });

  async function lookupCaja(inputCode, opts = {}){
    const fromBulk = !!opts.fromBulk;
    const code = normalizeCode(inputCode ?? (scanInput?.value||''));
    const targetMsg = fromBulk ? bulkMsg : scanMsg;
    if(code.length!==24){
      if(targetMsg) targetMsg.textContent = 'RFID inválido';
      if(fromBulk){ updateBulkEntry(code, { status:'error', message:'RFID inválido' }); renderBulkQueue(); }
      return;
    }
    state.lastLookupCode = code;
    if(!fromBulk && scanInput) scanInput.value = code;
    if(targetMsg) targetMsg.textContent = 'Buscando...';
    if(fromBulk){
      clearBulkActiveExcept(code);
      updateBulkEntry(code, { status:'loading', message:'' });
      renderBulkQueue();
    }
    let lastError = 'Caja no encontrada';
    try {
      const r = await fetch('/operacion/inspeccion/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfid: code })});
      const j = await r.json();
      if(j.ok){
        state.cajaSel = j.caja; state.tics = j.tics||[]; state.ticChecks = new Map(); state.activeTic = null; state.inInspeccion = true;
        try{
          const r2 = await fetch('/operacion/caja/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code })});
          const j2 = await r2.json();
          if(j2.ok){
            const comps = (j2.caja?.items||[]).map(it=>({ codigo: it.rfid, tipo: (it.rol||inferTipo(it.nombre_modelo||'')) }));
            state.cajaSel = { ...state.cajaSel, componentes: comps };
          } else if(Array.isArray(j.comps)){
            state.cajaSel = { ...state.cajaSel, componentes: (j.comps||[]).map(it=> ({ codigo: it.rfid, tipo: it.rol })) };
          }
        }catch(_e){
          if(Array.isArray(j.comps)){
            state.cajaSel = { ...state.cajaSel, componentes: (j.comps||[]).map(it=> ({ codigo: it.rfid, tipo: it.rol })) };
          }
        }
        renderChecklist();
        if(targetMsg) targetMsg.textContent = fromBulk ? `Caja lista (${code})` : '';
        if(fromBulk){ updateBulkEntry(code, { status:'active', message:'Caja cargada para inspección' }); renderBulkQueue(); }
        return;
      }
      lastError = j.error || lastError;
      try {
        const r2 = await fetch('/operacion/caja/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code })});
        const j2 = await r2.json();
        if(j2.ok){
          const comps = (j2.caja?.items||[]).map(it=>({ codigo: it.rfid, tipo: (it.rol||inferTipo(it.nombre_modelo||'')) }));
          state.cajaSel = { id: j2.caja.id, lote: j2.caja.lote, componentes: comps };
          state.tics = []; state.ticChecks = new Map(); state.activeTic = null; state.inInspeccion = false;
          renderChecklist();
          const msg = 'Caja no está en Inspección. Usa "Agregar a Inspección" para traerla.';
          if(targetMsg) targetMsg.textContent = msg;
          if(fromBulk){ updateBulkEntry(code, { status:'error', message: msg }); renderBulkQueue(); }
          return;
        }
      } catch(_e){}
    } catch(_e){
      lastError = 'Error';
    }
    if(targetMsg) targetMsg.textContent = lastError;
    if(fromBulk){ updateBulkEntry(code, { status:'error', message: lastError }); renderBulkQueue(); }
  }

  // Inferir tipo simple por nombre de modelo (fallback)
  function inferTipo(nombre){ const n=(nombre||'').toLowerCase(); if(n.includes('vip')) return 'vip'; if(n.includes('tic')) return 'tic'; if(n.includes('cube')||n.includes('cubo')) return 'cube'; return 'otro'; }

  function updateCompleteBtn(){
    // Enable completion when: (a) all present TICs (0..6) have all three checks, and (b) VIP/CUBE checks (if present) are all done.
    const tics = state.tics||[];
    const allTicsChecked = tics.every(t=>{
      const v = state.ticChecks.get(t.rfid) || { limpieza:false, goteo:false, desinfeccion:false };
      return v.limpieza && v.goteo && v.desinfeccion;
    });
    const comps = (state.cajaSel?.componentes||[]).filter(it=> (it.tipo==='vip' || it.tipo==='cube'));
    const compsOk = comps.every(it=>{
      const v = state.ticChecks.get(it.codigo) || { limpieza:false, goteo:false, desinfeccion:false };
      return v.limpieza && v.goteo && v.desinfeccion;
    });
    const all = !!state.cajaSel?.id && allTicsChecked && compsOk;
    if(completeBtn) completeBtn.disabled = !all;
  }

  // Bulk actions: mark/unmark all checks for all TICs
  checkAllBtn?.addEventListener('click', ()=>{
    (state.tics||[]).forEach(t=>{ state.ticChecks.set(t.rfid, { limpieza:true, goteo:true, desinfeccion:true }); });
    const comps = (state.cajaSel?.componentes||[]).filter(it=> (it.tipo==='vip' || it.tipo==='cube'));
    comps.forEach(it=>{ state.ticChecks.set(it.codigo, { limpieza:true, goteo:true, desinfeccion:true }); });
    renderChecklist();
  });
  uncheckAllBtn?.addEventListener('click', ()=>{
    (state.tics||[]).forEach(t=>{ state.ticChecks.set(t.rfid, { limpieza:false, goteo:false, desinfeccion:false }); });
    const comps = (state.cajaSel?.componentes||[]).filter(it=> (it.tipo==='vip' || it.tipo==='cube'));
    comps.forEach(it=>{ state.ticChecks.set(it.codigo, { limpieza:false, goteo:false, desinfeccion:false }); });
    renderChecklist();
  });

  document.addEventListener('change', async (e)=>{
    const t = e.target;
    if(!(t instanceof HTMLInputElement)) return;
    const fld = t.getAttribute('data-chk');
    const rfid = t.getAttribute('data-rfid');
    if(!fld || !rfid) return;
    const cur = state.ticChecks.get(rfid) || { limpieza:false, goteo:false, desinfeccion:false };
    cur[fld] = !!t.checked; state.ticChecks.set(rfid, cur); updateCompleteBtn();
  });

  // Open novedad modal
  document.addEventListener('click', (e)=>{
    const t = e.target;
    if(!(t instanceof HTMLElement)) return;
    if(t.matches('[data-action="bulk-open"]')){
      const code = t.getAttribute('data-code')||'';
      if(code){ lookupCaja(code, { fromBulk:true }); }
      return;
    }
    if(t.matches('[data-action="bulk-remove"]')){
      const code = normalizeCode(t.getAttribute('data-code')||'');
      if(code){
        state.bulkQueue = state.bulkQueue.filter(entry=> entry.code !== code);
        if(state.lastLookupCode === code){ state.lastLookupCode = null; }
        renderBulkQueue();
        if(!state.bulkQueue.length) setBulkMessage('');
      }
      return;
    }
    if(t.matches('[data-action="tic-inhabilitar"]')){
      const code = t.getAttribute('data-rfid')||'';
      if(novRfid) novRfid.textContent = code;
      if(novMotivo) novMotivo.value = '';
      if(novDesc) novDesc.value = '';
      if(novSev) novSev.value = '3';
      if(novTipo) novTipo.value = 'otro';
      if(novInh) novInh.checked = true;
      if(novMsg) novMsg.textContent = '';
      try{ novDlg.showModal(); }catch{ novDlg.classList.remove('hidden'); }
    }
  });
  // Submit novedad (aplica para TIC/VIP/CUBE)
  novConfirm?.addEventListener('click', async ()=>{
    const code = (novRfid?.textContent||'').trim();
    const body = {
      rfid: code,
      tipo: (novTipo?.value||'otro'),
      motivo: (novMotivo?.value||'').trim(),
      descripcion: (novDesc?.value||'').trim(),
      severidad: parseInt(novSev?.value||'3',10)||3,
      inhabilita: !!(novInh?.checked)
    };
    if(!body.motivo){ novMsg && (novMsg.textContent='Motivo requerido'); return; }
    novConfirm.disabled = true; novMsg && (novMsg.textContent='Guardando...');
    try{
      const r = await fetch('/operacion/inspeccion/novedad/inhabilitar',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const j = await r.json();
      if(!j.ok){ novMsg && (novMsg.textContent=j.error||'Error'); novConfirm.disabled=false; return; }
      // Remove piece from UI (TIC/VIP/CUBE)
      const beforeTicLen = (state.tics||[]).length;
      state.tics = (state.tics||[]).filter(t=> t.rfid !== code);
      if(beforeTicLen===state.tics.length){
        // not a TIC; try removing from componentes
        if(state.cajaSel && Array.isArray(state.cajaSel.componentes)){
          state.cajaSel.componentes = state.cajaSel.componentes.filter((it)=> (it.codigo!==code));
        }
      }
      state.ticChecks.delete(code);
      renderChecklist();
      // If caja auto-retired or cleared (no items remain in Inspección), clear panel and refresh grid immediately
      if((j.auto_returned || j.cleared) && state.cajaSel){
        try{ novDlg.close(); }catch{ novDlg.classList.add('hidden'); }
        if(panel){ panel.classList.add('hidden'); }
        state.cajaSel = null; state.tics = []; state.ticChecks.clear(); state.activeTic = null;
        await load();
        scanMsg && (scanMsg.textContent = 'Caja retirada de Inspección');
        return; // done
      }
      // close modal
      novMsg && (novMsg.textContent='Registrado');
      try{ novDlg.close(); }catch{ novDlg.classList.add('hidden'); }
    }catch(_e){ novMsg && (novMsg.textContent='Error'); }
    finally{ novConfirm.disabled=false; }
  });

  completeBtn?.addEventListener('click', async ()=>{
    if(!state.cajaSel?.id) return;
    completeBtn.disabled = true;
    try {
      // Gather the TIC RFIDs that have all 3 checks; must match the number of TICs currently presentes (0..6)
      const tics = state.tics||[];
      const confirm = tics.filter(t=>{
        const v = state.ticChecks.get(t.rfid)||{limpieza:false,goteo:false,desinfeccion:false};
        return v.limpieza&&v.goteo&&v.desinfeccion;
      }).map(t=>t.rfid);
      if(confirm.length !== tics.length){
        completeBtn.disabled=false;
        scanMsg && (scanMsg.textContent='Faltan checks en las TICs presentes');
        return;
      }
      const r = await fetch('/operacion/inspeccion/complete',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: state.cajaSel.id, confirm_rfids: confirm })});
      const j = await r.json();
      if(!j.ok){ completeBtn.disabled=false; scanMsg && (scanMsg.textContent=j.error||'Error'); return; }
      // Reset panel and reload list
      if(state.lastLookupCode){
        const entry = updateBulkEntry(state.lastLookupCode, { status:'done', message:'Inspección completada' });
        renderBulkQueue();
        const hasPending = state.bulkQueue.some(it=> it.status==='queued' || it.status==='error');
        state.lastLookupCode = null;
        if(hasPending){ setTimeout(()=> loadNextBulkCode(), 200); }
      }
      panel.classList.add('hidden'); state.cajaSel=null; state.tics=[]; state.ticChecks.clear(); state.activeTic=null;
      scanInput && (scanInput.value='');
      await load();
      scanMsg && (scanMsg.textContent='Inspección finalizada: caja devuelta a Bodega');
    } catch(e){ completeBtn.disabled=false; scanMsg && (scanMsg.textContent='Error'); }
  });

  scanBtn?.addEventListener('click', lookupCaja);
  scanInput?.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); lookupCaja(); }});
  scanClear?.addEventListener('click', ()=>{
    if(scanInput) scanInput.value='';
    scanMsg && (scanMsg.textContent='');
    panel?.classList.add('hidden');
    state.cajaSel=null; state.tics=[]; state.ticChecks.clear(); state.activeTic=null; state.lastLookupCode = null;
    scanInput?.focus();
  });
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
  // No mostrar el panel derecho automáticamente: exigir identificación por RFID.
  // Solo refrescamos la lista de cajas de la izquierda.
  state.cajaSel = null; state.tics = []; state.ticChecks.clear(); state.activeTic = null; state.inInspeccion = false;
  if(panel){ panel.classList.add('hidden'); }
  await load();
  addMsg && (addMsg.textContent='Agregado a Inspección. Identifica la caja con su RFID para continuar.');
      try{ addDlg.close(); }catch{ addDlg.classList.add('hidden'); }
    } catch(e){ addMsg && (addMsg.textContent='Error'); }
  });
})();
