// Inspección: listar piezas en estado Inspección con diseño de tarjetas
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

  function buildDefaultSedePrompt(payload){
    if(payload && typeof payload.confirm === 'string' && payload.confirm.trim()) return payload.confirm;
    if(payload && typeof payload.error === 'string' && payload.error.trim()) return payload.error;
    return 'Las piezas seleccionadas pertenecen a otra sede. ¿Deseas trasladarlas a esta sede?';
  }

  const postJSONWithSedeTransfer = (()=>{
    if(typeof window !== 'undefined' && typeof window.postJSONWithSedeTransfer === 'function'){
      return window.postJSONWithSedeTransfer;
    }

    const helper = async function postJSONWithSedeTransfer(url, body, options){
      const opts = options || {};
      const headers = Object.assign({ 'Content-Type':'application/json' }, opts.headers || {});
      const confirmFn = typeof opts.confirmFn === 'function' ? opts.confirmFn : (message) => (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(message) : true);
      const promptBuilder = typeof opts.promptMessage === 'function' ? opts.promptMessage : buildDefaultSedePrompt;

      const send = async (allowTransfer) => {
        const payload = allowTransfer ? Object.assign({}, body, { allowSedeTransfer: true }) : Object.assign({}, body);
        try {
          const res = await fetch(url, { method:'POST', headers, body: JSON.stringify(payload) });
          let data = null;
          try { data = await res.json(); } catch { data = null; }
          return { httpOk: res.ok, status: res.status, data };
        } catch(err){
          return {
            httpOk: false,
            status: 0,
            data: { ok:false, error: err?.message || 'Error de red' },
            networkError: err
          };
        }
      };

      let attempt = await send(false);
      if(!attempt.httpOk && attempt.data && attempt.data.code === 'SEDE_MISMATCH'){
        const prompt = promptBuilder(attempt.data);
        const proceed = confirmFn ? await confirmFn(prompt, attempt.data) : false;
        if(!proceed){
          return Object.assign({ cancelled: true }, attempt);
        }
        attempt = await send(true);
      }
      return Object.assign({ cancelled: false }, attempt);
    };

    if(typeof window !== 'undefined'){
      window.postJSONWithSedeTransfer = helper;
    }
    return helper;
  })();

  function msElapsed(timer){ if(!timer||!timer.startsAt) return 0; return (Date.now()+state.serverOffset) - new Date(timer.startsAt).getTime(); }
  function timerDisplay(ms){ const s=Math.max(0,Math.floor(ms/1000)); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const sec=s%60; return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }
  function msRemaining(timer){ if(!timer||!timer.startsAt||!timer.durationSec) return null; const end = new Date(timer.startsAt).getTime() + timer.durationSec*1000; return end - (Date.now()+state.serverOffset); }
  function escapeHtml(value){
    return (value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }


  function flattenInspectionPieces(){
    const piezas = [];
    (state.cajas||[]).forEach((caja)=>{
      const comps = Array.isArray(caja.componentes) ? caja.componentes : [];
      comps.forEach((comp)=>{
        if(!comp || !comp.codigo) return;
        piezas.push({
          ...comp,
          cajaId: caja.id,
          cajaNombre: caja.nombreCaja,
          codigoCaja: caja.codigoCaja,
          timer: caja.timer
        });
      });
    });
    return piezas;
  }

  function pieceCardHTML(piece){
    const role = (piece.tipo||'').toUpperCase() || 'PIEZA';
    const badgeClass = role==='VIP' ? 'badge-info' : role==='TIC' ? 'badge-warning' : role==='CUBE' ? 'badge-accent' : 'badge-ghost';
    const cajaLabel = escapeHtml(piece.cajaNombre || piece.codigoCaja || 'Conjunto sin nombre');
    const rawCode = String(piece.codigo || '');
    const safeRfid = escapeHtml(rawCode || '—');
    const meta = piece.litraje || piece.nombreUnidad ? `<div class='text-[10px] opacity-70'>${escapeHtml(piece.litraje || piece.nombreUnidad || '')}</div>` : '';
    const cajaKey = typeof piece.cajaId === 'number' && Number.isFinite(piece.cajaId) ? String(piece.cajaId) : '';
    const hasCountdown = !!(piece.timer && piece.timer.durationSec);
    const timerAttr = cajaKey ? ` data-insp-timer-caja='${cajaKey}'` : '';
    const timerId = escapeHtml(`insp-timer-${rawCode}`);
    const timerHtml = hasCountdown
      ? `<span class='badge badge-neutral badge-xs font-mono'${timerAttr} id='${timerId}'>↓ ${timerDisplay(Math.max(0, msRemaining(piece.timer)||0))}</span>`
      : `<span class='badge badge-outline badge-xs opacity-70'>Sin cronómetro</span>`;
    return `<div class='caja-card rounded-lg border border-base-300/40 bg-base-200/10 p-3 flex flex-col gap-2'>
      <div class='flex items-center justify-between text-[10px] uppercase opacity-60 tracking-wide'>
        <span class='truncate pr-2' title='${cajaLabel}'>${cajaLabel}</span>
        ${timerHtml}
      </div>
      <div class='flex items-center gap-2 font-mono text-xs'>
        <span class='badge ${badgeClass} badge-xs'>${role}</span>
        <span class='truncate flex-1' title='${safeRfid}'>${safeRfid}</span>
      </div>
      ${meta}
    </div>`;
  }

  function render(){
    if(!grid) return;
    const piezas = flattenInspectionPieces();
    if(!piezas.length){ grid.innerHTML = `<div class='col-span-full py-10 text-center text-xs opacity-60'>Sin piezas en Inspección</div>`; return; }
    grid.innerHTML = piezas.map(pieceCardHTML).join('');
  }

  async function load(){
    try {
      spin?.classList.remove('hidden');
      const r = await fetch('/operacion/inspeccion/data', { headers: { 'Accept': 'application/json' }});
      const contentType = r.headers.get('content-type') || '';
      const bodyText = await r.text();
      if(!r.ok){
        throw new Error(`HTTP ${r.status}: ${bodyText.slice(0, 200)}`);
      }
      let j;
      if(contentType.includes('application/json')){
        try {
          j = JSON.parse(bodyText);
        } catch(parseErr){
          throw new Error(`Invalid JSON: ${(parseErr&&parseErr.message)||parseErr}`);
        }
      } else {
        const lower = bodyText.trim().toLowerCase();
        if(lower.startsWith('<!doctype') || lower.includes('<html')){
          console.warn('[Inspección] Unexpected HTML response, likely session expired. Redirecting to login.');
          window.location.href = '/auth/login';
          return;
        }
        throw new Error(`Unexpected response content-type: ${contentType||'unknown'}`);
      }
      state.cajas = j.ok ? (j.cajas||[]) : [];
      if(j.ok && j.serverNow){ state.serverOffset = new Date(j.serverNow).getTime() - Date.now(); }
      render();
    } catch(e){
      console.error('[Inspección] load error', e);
      state.cajas = [];
      if(grid){ grid.innerHTML = `<div class='col-span-full py-10 text-center text-xs text-error'>Error al cargar datos de Inspección. Reintenta en unos segundos.</div>`; }
    }
    finally { spin?.classList.add('hidden'); }
  }

  load();
  setInterval(load, 15000);
  // tick timers
  setInterval(()=>{
    (state.cajas||[]).forEach(c=>{
      if(!c.timer || !c.timer.durationSec) return;
      const cajaKey = typeof c.id === 'number' && Number.isFinite(c.id) ? String(c.id) : '';
      if(!cajaKey) return;
      const rem = Math.max(0, msRemaining(c.timer)||0);
      document.querySelectorAll(`[data-insp-timer-caja='${cajaKey}']`).forEach((el)=>{
        el.textContent = '↓ ' + timerDisplay(rem);
      });
    });
  }, 1000);
  // ---- Scan/Lookup caja ----
  const modeIndividualBtn = qs('#insp-mode-individual');
  const modeBulkBtn = qs('#insp-mode-bulk');
  const singleSection = qs('#insp-single-section');
  const bulkSection = qs('#insp-bulk-section');
  const bulkInput = qs('#insp-bulk-input');
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
  const addCountTic = qs('#insp-add-count-tic');
  const addCountVip = qs('#insp-add-count-vip');
  const addCountCube = qs('#insp-add-count-cube');
  const addCountBoxes = qs('#insp-add-count-boxes');
  const addZona = qs('#insp-add-zona');
  const addSeccion = qs('#insp-add-seccion');
  const addLocationHint = qs('#insp-add-location-hint');

  const addState = {
    items: new Map()
  };

  let addSelectedZonaId = '';
  let addSelectedSeccionId = '';
  const addLocationController = (typeof window !== 'undefined' && window.LocationSelector && typeof window.LocationSelector.create === 'function')
    ? window.LocationSelector.create({
        zonaSelect: addZona,
        seccionSelect: addSeccion,
        hintElement: addLocationHint
      })
    : null;

  function ensureAddLocation(){
    if(!addLocationController) return Promise.resolve();
    return addLocationController.ensure({ zonaId: addSelectedZonaId, seccionId: addSelectedSeccionId })
      .then(()=>{
        const current = addLocationController.getValue();
        addSelectedZonaId = current.zonaId || '';
        addSelectedSeccionId = current.seccionId || '';
      });
  }

  function captureAddLocation(){
    if(addLocationController){
      const value = addLocationController.getValue();
      addSelectedZonaId = value.zonaId || '';
      addSelectedSeccionId = value.seccionId || '';
    } else {
      addSelectedZonaId = addZona ? String(addZona.value || '') : '';
      addSelectedSeccionId = addSeccion ? String(addSeccion.value || '') : '';
    }
    return { zona_id: addSelectedZonaId, seccion_id: addSelectedSeccionId };
  }

  function resetAddLocation(){
    addSelectedZonaId = '';
    addSelectedSeccionId = '';
    if(addLocationController){
      addLocationController.reset();
    } else {
      if(addZona) addZona.value='';
      if(addSeccion){
        addSeccion.innerHTML = '<option value="">Sin sección</option>';
        addSeccion.disabled = true;
      }
      if(addLocationHint) addLocationHint.textContent='';
    }
  }

  function normalizeCode(code){
    if(code == null) return '';
    return code.toString().replace(/\s+/g, '').toUpperCase();
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
      bulkList.innerHTML = "<div class='text-xs opacity-60'>Sin piezas en cola.</div>";
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
      const rowCls = status==='active' ? 'border-primary bg-primary/10 shadow-sm' : status==='done' ? 'border-success bg-success/10 text-success-content' : 'border-base-300/40 bg-base-100';
      const showIdentify = status!=='done';
      return `<div class='border rounded-md p-2 space-y-1 ${rowCls}' data-bulk-code='${entry.code}'>
        <div class='flex items-center gap-2'>
          <span class='font-mono text-xs flex-1 truncate' title='${entry.code}'>${entry.code}</span>
          ${badge}
          ${showIdentify ? `<button class='btn btn-ghost btn-xs' data-action='bulk-open' data-code='${entry.code}'>Identificar</button>` : ''}
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
    else { setBulkMessage('No hay piezas pendientes en la cola.'); }
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
      setBulkMessage(`Piezas añadidas: ${addedTotal}`);
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
      panelLote && (panelLote.textContent = state.cajaSel?.nombreCaja || state.cajaSel?.lote || '—');
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
  btnAdd?.addEventListener('click', ()=>{
    try{ addDlg.showModal(); }catch{ addDlg.classList.remove('hidden'); }
    addMsg && (addMsg.textContent='');
    addConfirm && (addConfirm.disabled=true);
    addState.items.clear();
    if(addScan) addScan.value='';
    if(addH) addH.value='';
    if(addM) addM.value='';
    renderAddItems();
    resetAddLocation();
    ensureAddLocation().finally(()=> setTimeout(()=> addScan?.focus(), 200));
  });

  async function lookupCaja(inputCode, opts = {}){
    if(inputCode instanceof Event){
      inputCode.preventDefault?.();
      inputCode = undefined;
    }
    const fromBulk = !!opts.fromBulk;
    const individualMode = !state.bulkMode;
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
    let lastError = 'Pieza no encontrada';
    try {
      const r = await fetch('/operacion/inspeccion/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfid: code, individual: individualMode })});
      const j = await r.json();
      if(j.ok){
        const upperCode = code.toUpperCase();
        const baseCaja = j.caja ? { ...j.caja } : {};
        state.cajaSel = baseCaja;
        state.tics = Array.isArray(j.tics) ? [...j.tics] : [];
        if(individualMode){
          state.tics = state.tics.filter((t)=> ((t?.rfid)||'').toUpperCase() === upperCode);
        }
        state.ticChecks = new Map();
        state.activeTic = null;
        state.inInspeccion = true;
        const rawComps = Array.isArray(j.comps) ? j.comps : [];
        const compsList = individualMode
          ? rawComps.filter((it)=> ((it?.rfid)||'').toUpperCase() === upperCode)
          : rawComps;
        const compMap = new Map();
        state.tics.forEach((t)=>{
          if(t?.rfid){ compMap.set(t.rfid, { codigo: t.rfid, tipo: 'tic' }); }
        });
        compsList.forEach((it)=>{
          if(!it?.rfid) return;
          const role = ((it.rol || inferTipo(it.nombre_modelo || '')) || '').toLowerCase();
          compMap.set(it.rfid, { codigo: it.rfid, tipo: role || 'otro' });
        });
        state.cajaSel = { ...state.cajaSel, componentes: Array.from(compMap.values()) };
        renderChecklist();
        if(targetMsg) targetMsg.textContent = fromBulk ? `Pieza lista (${code})` : '';
        if(fromBulk){ updateBulkEntry(code, { status:'active', message:'Pieza cargada para Inspección' }); renderBulkQueue(); }
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
          const msg = 'La pieza no está en Inspección. Usa "Agregar piezas a Inspección" para traerla.';
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
    if(t.matches('[data-action="add-remove-item"]')){
      const code = normalizeCode(t.getAttribute('data-rfid')||'');
      if(code && addState.items.has(code)){
        addState.items.delete(code);
        renderAddItems();
        addMsg && (addMsg.textContent='Pieza eliminada de la lista');
      }
      return;
    }
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
        scanMsg && (scanMsg.textContent = 'Pieza retirada de Inspección');
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
      const attempt = await postJSONWithSedeTransfer('/operacion/inspeccion/complete', { caja_id: state.cajaSel.id, confirm_rfids: confirm }, {
        promptMessage: (payload) => {
          const label = state.cajaSel?.lote || state.cajaSel?.codigoCaja || `#${state.cajaSel?.id}`;
          return payload?.confirm || payload?.error || `El conjunto ${label} pertenece a otra sede. ¿Deseas trasladarlo a tu sede actual?`;
        }
      });
      if(attempt.cancelled){
        completeBtn.disabled=false;
        scanMsg && (scanMsg.textContent='Operación cancelada.');
        return;
      }
      const payload = attempt.data || {};
      if(!attempt.httpOk || payload.ok === false){
        const message = payload.error || payload.message || `Error (${attempt.status || 0})`;
        scanMsg && (scanMsg.textContent = message);
        completeBtn.disabled=false;
        return;
      }
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
      scanMsg && (scanMsg.textContent='Inspección finalizada: pieza devuelta a Bodega');
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
    if(!exists){ ticMsg && (ticMsg.textContent='TIC no pertenece al conjunto activo'); return; }
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
  function summarizeRole(role){
    let total = 0;
    const groups = new Map();
    addState.items.forEach((item)=>{
      if((item.rol||'').toLowerCase() !== role) return;
      total++;
      const label = item.litraje || 'Sin litraje';
      groups.set(label, (groups.get(label)||0)+1);
    });
    return { total, groups };
  }

  function renderRoleCard(role, container){
    if(!container) return;
    const summary = summarizeRole(role);
    if(!summary.total){
      container.innerHTML = "<div class='text-2xl font-semibold'>0</div><div class='text-[11px] opacity-60'>Sin piezas</div>";
      return;
    }
    const lines = Array.from(summary.groups.entries())
      .sort((a,b)=> a[0].localeCompare(b[0], 'es', { numeric:true }))
      .map(([label,count])=> `<div>${escapeHtml(label)} × ${count}</div>`)
      .join('');
    container.innerHTML = `<div class='text-2xl font-semibold'>${summary.total}</div>`+
      `<div class='text-[11px] opacity-80 leading-tight space-y-0.5'>${lines}</div>`;
  }

  function buildCajaKey(item){
    if(item.caja_id != null) return `id:${item.caja_id}`;
    if(item.lote) return `lote:${item.lote}`;
    return `rfid:${item.rfid}`;
  }

  function computeCajaProgress(){
    const groups = new Map();
    addState.items.forEach((item)=>{
      const key = buildCajaKey(item);
      if(!groups.has(key)){
        groups.set(key, {
          tic:0,
          vip:0,
          cube:0,
          total:0,
          label: item.lote || item.rfid || key,
          litraje: item.litraje || 'Sin litraje'
        });
      }
      const group = groups.get(key);
      group.total++;
      const role = (item.rol||'').toLowerCase();
      if(role === 'tic') group.tic++;
      else if(role === 'vip') group.vip++;
      else if(role === 'cube') group.cube++;
    });
    let completas = 0;
    let incompletas = 0;
    const completasLitros = [];
    const incompletasLitros = [];
    groups.forEach((group)=>{
      const full = group.tic >= 6 && group.vip >= 1 && group.cube >= 1;
      if(full) {
        completas++;
        completasLitros.push(group.litraje);
      } else {
        incompletas++;
        incompletasLitros.push(group.litraje);
      }
    });
    const total = groups.size;
    return {
      total,
      completas,
      incompletas: Math.max(incompletas, 0),
      completasLitros,
      incompletasLitros
    };
  }

  function renderAddCounts(){
    renderRoleCard('tic', addCountTic);
    renderRoleCard('vip', addCountVip);
    renderRoleCard('cube', addCountCube);
    const { total, completas, incompletas, completasLitros, incompletasLitros } = computeCajaProgress();
    if(addCountBoxes){
      addCountBoxes.innerHTML = `<div class='text-2xl font-semibold'>${total}</div>`+
        `<div class='text-[11px] opacity-80 leading-tight space-y-0.5'>`+
        `Completas: ${completas} ${completasLitros.length ? '('+completasLitros.join(', ')+')' : ''}<br>`+
        `Incompletas: ${incompletas} ${incompletasLitros.length ? '('+incompletasLitros.join(', ')+')' : ''}`+
        `</div>`;
    }
    return { total, completas, incompletas };
  }

  function computeAddTimerSeconds(){
    const hours = parseInt(addH?.value||'0',10)||0;
    const minutes = parseInt(addM?.value||'0',10)||0;
    return (hours*3600) + (minutes*60);
  }

  function updateAddConfirm(){
    const { total } = renderAddCounts();
    const seconds = computeAddTimerSeconds();
    if(addConfirm) addConfirm.disabled = total <= 0 || seconds <= 0;
  }

  function renderAddItems(){
    if(!addItems) return;
    const entries = Array.from(addState.items.values()).sort((a,b)=> (a.addedAt||0) - (b.addedAt||0));
    if(!entries.length){
      addItems.innerHTML = "<div class='text-xs opacity-60'>Sin piezas escaneadas.</div>";
    } else {
      addItems.innerHTML = entries.map((entry)=>{
        const rol = (entry.rol||'').toUpperCase();
        const badgeClass = rol==='VIP' ? 'badge-info' : rol==='TIC' ? 'badge-warning' : rol==='CUBE' ? 'badge-accent' : 'badge-ghost';
        const metaParts = [];
        if(entry.lote) metaParts.push(`Lote ${escapeHtml(entry.lote)}`);
        if(entry.litraje) metaParts.push(escapeHtml(entry.litraje));
        const meta = metaParts.length ? `<span class='opacity-60 text-[10px]'>${metaParts.join(' · ')}</span>` : '';
        const safeRfid = escapeHtml(entry.rfid);
        return `<div class='flex items-center justify-between gap-2 border border-base-300/60 rounded-md px-2 py-1 bg-base-100' data-add-rfid='${entry.rfid}'>
          <div class='flex flex-col text-[11px] font-mono leading-tight'>
            <span class='flex items-center gap-2 font-semibold'><span class='badge ${badgeClass} badge-xs'>${rol||'PIEZA'}</span><span>${safeRfid}</span></span>
            ${meta}
          </div>
          <button class='btn btn-ghost btn-xs text-error' data-action='add-remove-item' data-rfid='${entry.rfid}'>✕</button>
        </div>`;
      }).join('');
    }
    updateAddConfirm();
  }

  const addScanQueue = [];
  let processingAddQueue = false;

  function enqueueAddScan(value, opts = {}){
    const code = normalizeCode(value);
    if(code.length !== 24){
      if(!opts.silent && code.length){ addMsg && (addMsg.textContent='RFID inválido'); }
      return;
    }
    if(addState.items.has(code)){
      if(!opts.silent){ addMsg && (addMsg.textContent='RFID ya agregado'); }
      return;
    }
    addScanQueue.push(code);
    if(!processingAddQueue){ processAddScanQueue(); }
  }

  async function processAddScanQueue(){
    processingAddQueue = true;
    while(addScanQueue.length){
      const code = addScanQueue.shift();
      await processSingleAddScan(code);
    }
    processingAddQueue = false;
  }

  async function processSingleAddScan(code){
    addMsg && (addMsg.textContent = `Validando ${code}...`);
    try {
      const r = await fetch('/operacion/inspeccion/pending/item-info',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfid: code })});
      const j = await r.json();
      if(!j.ok){ addMsg && (addMsg.textContent = j.error||'No disponible'); return; }
      const item = j.item || {};
      const normalizedRol = (item.rol||'').toLowerCase();
      addState.items.set(code, {
        rfid: code,
        rol: normalizedRol,
        caja_id: item.caja_id ?? null,
        lote: item.lote || null,
        litraje: item.litraje || null,
        addedAt: Date.now()
      });
      const msgRole = normalizedRol ? normalizedRol.toUpperCase() : 'PIEZA';
      addMsg && (addMsg.textContent = `${msgRole} agregada (${code})`);
      renderAddItems();
    } catch(_e){
      addMsg && (addMsg.textContent='Error validando');
    }
  }

  function processAddInputValue(value){
    let buffer = normalizeCode(value);
    while(buffer.length >= 24){
      const chunk = buffer.slice(0,24);
      buffer = buffer.slice(24);
      enqueueAddScan(chunk, { silent:true });
    }
    return buffer;
  }

  addScan?.addEventListener('input', ()=>{
    if(!addScan) return;
    const remainder = processAddInputValue(addScan.value);
    addScan.value = remainder;
  });
  addH?.addEventListener('input', updateAddConfirm);
  addM?.addEventListener('input', updateAddConfirm);
  addClear?.addEventListener('click', ()=>{
    if(addScan) addScan.value='';
    if(addH) addH.value='';
    if(addM) addM.value='';
    addMsg && (addMsg.textContent='');
    addScanQueue.length = 0;
    processingAddQueue = false;
    addState.items.clear();
    renderAddItems();
    resetAddLocation();
    ensureAddLocation();
    addScan?.focus();
  });
  addScan?.addEventListener('paste', (e)=>{
    if(!e.clipboardData || !addScan) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    const remainder = processAddInputValue(text);
    addScan.value = remainder;
  });

  addScan?.addEventListener('keydown', (e)=>{
    if(e.key==='Enter'){
      e.preventDefault();
      if(!addScan) return;
      const code = normalizeCode(addScan.value);
      if(code.length === 24){
        addScan.value = '';
        enqueueAddScan(code);
      } else if(code.length){
        addMsg && (addMsg.textContent='RFID incompleto');
      }
    }
  });

  // Confirmar Agregar (pull con cronómetro obligatorio)
  addConfirm?.addEventListener('click', async ()=>{
    const rfids = Array.from(addState.items.keys());
    if(!rfids.length){ addMsg && (addMsg.textContent='Escanea al menos una pieza'); return; }
    const { total } = renderAddCounts();
    if(total <= 0){ addMsg && (addMsg.textContent='Identifica al menos un conjunto para continuar'); return; }
    const sec = computeAddTimerSeconds();
    if(sec <= 0){
      addMsg && (addMsg.textContent='Configura un cronómetro mayor a 0.');
      updateAddConfirm();
      return;
    }
    addMsg && (addMsg.textContent='Agregando...');
    try {
      const locationPayload = captureAddLocation();
      const attempt = await postJSONWithSedeTransfer('/operacion/inspeccion/pull', {
        rfids,
        durationSec: sec,
        zona_id: locationPayload.zona_id,
        seccion_id: locationPayload.seccion_id
      }, {
        promptMessage: (payload) => payload?.confirm || payload?.error || 'Las piezas seleccionadas pertenecen a otra sede. ¿Deseas trasladarlas a tu sede actual?'
      });
      if(attempt.cancelled){
        addMsg && (addMsg.textContent='Operación cancelada.');
        return;
      }
      const payload = attempt.data || {};
      if(!attempt.httpOk || payload.ok === false){
        const message = payload.error || payload.message || `Error (${attempt.status || 0})`;
        addMsg && (addMsg.textContent=message);
        return;
      }
      state.cajaSel = null; state.tics = []; state.ticChecks.clear(); state.activeTic = null; state.inInspeccion = false;
      if(panel){ panel.classList.add('hidden'); }
      await load();
      addState.items.clear();
      renderAddItems();
      const cajasProcesadas = typeof payload.cajasProcesadas === 'number' ? payload.cajasProcesadas : total;
      addMsg && (addMsg.textContent=`Se enviaron ${cajasProcesadas} conjunto${cajasProcesadas===1?'':'s'} a Inspección.`);
      setTimeout(()=> addScan?.focus(), 200);
    } catch(e){ addMsg && (addMsg.textContent='Error'); }
  });
})();
