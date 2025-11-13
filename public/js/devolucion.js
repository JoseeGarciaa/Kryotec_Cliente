// Devolución: mostrar cajas en Operación con mismos cronómetros que Operación y botón para devolver a Bodega
(function(){
  'use strict';
  const qs = (s)=> document.querySelector(s);
  const grid = qs('#dev-caja-grid');
  const spin = qs('#dev-spin');
  // Scan UI elements
  const scanInput = qs('#dev-scan');
  const scanBtn = qs('#dev-scan-btn');
  const scanClear = qs('#dev-scan-clear');
  const scanMsg = qs('#dev-scan-msg');
  const scanResult = qs('#dev-scan-result');
  const scanCardBox = qs('#dev-scan-card');
  const scanExtra = qs('#dev-scan-extra');
  const modal = document.getElementById('dev-modal');
  const modalBody = qs('#dev-modal-body');
  const modalTitle = qs('#dev-modal-title');
  const modalReturn = qs('#dev-modal-return');
  const modalClose = qs('#dev-modal-close');
  // Decide dialog
  const decideDlg = qs('#dev-decide');
  const decideMsg = qs('#dev-decide-msg');
  const decideActions = qs('#dev-decide-actions');
  const decideClose = qs('#dev-decide-close');
  // Confirm dialog
  const confirmDlg = qs('#dev-confirm');
  const confirmYes = qs('#dev-confirm-yes');
  const confirmNo = qs('#dev-confirm-no');
  const confirmMsg = qs('#dev-confirm-msg');
  let confirmCajaId = null; let confirmFromModal = false;
  let modalCajaId = null;
  // PI timer modal (Pendiente a Inspección)
  const piDlg = qs('#dev-pi-timer');
  const piHours = qs('#dev-pi-hours');
  const piMins = qs('#dev-pi-mins');
  const piAccept = qs('#dev-pi-accept');
  const piCancel = qs('#dev-pi-cancel');
  let piCajaId = null;
  let data = { cajas: [], serverNow: null, ordenes: {} };
  let serverOffset = 0; // serverNow - Date.now()
  let tick = null; let poll = null;

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

  function msRemaining(timer){ if(!timer||!timer.endsAt) return 0; return new Date(timer.endsAt).getTime() - (Date.now()+serverOffset); }
  function timerDisplay(rem){ if(rem<=0) return 'Finalizado'; const s=Math.max(0,Math.floor(rem/1000)); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const sec=s%60; return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }
  function progressPct(timer){ if(!timer||!timer.startsAt||!timer.endsAt) return 0; const start=new Date(timer.startsAt).getTime(); const end=new Date(timer.endsAt).getTime(); const now=Date.now()+serverOffset; if(now<=start) return 0; if(now>=end) return 100; return ((now-start)/(end-start))*100; }
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
    const rem = caja.timer? msRemaining(caja.timer):0;
    const pct = progressPct(caja.timer);
    const timerTxt = caja.timer? (caja.timer.completedAt? 'Listo' : timerDisplay(rem)) : '';
    let timerBadge='';
    if(caja.timer && caja.timer.startsAt && caja.timer.endsAt && !caja.timer.completedAt){
      timerBadge = `<span class='badge badge-neutral badge-xs flex items-center gap-1' data-dev-caja-timer data-caja='${caja.id}'>
        <span id='dev-timer-${caja.id}' class='font-mono whitespace-nowrap tabular-nums'>${timerTxt}</span>
      </span>`;
    } else if(caja.timer && caja.timer.completedAt){
      timerBadge = `<span class='badge badge-success badge-xs'>Listo</span>`;
    } else {
      timerBadge = `<span class='badge badge-outline badge-xs opacity-60'>Sin cronómetro</span>`;
    }
    const progress = Math.min(100, Math.max(0, pct));
    const code = caja.codigoCaja||'';
    const displayName = caja.nombreCaja || code || '';
    const titleText = displayName && code && displayName !== code ? `${displayName} · ${code}` : displayName || code;
    // Formato de orden: si se conoce expected (>0) mostrar a/b, si no solo a
    const ordenStrBase = (caja.orderNumero ? caja.orderNumero : (caja.orderId ? ('#'+caja.orderId) : '-'));
    let ordenStr = ordenStrBase;
    const haveCount = (caja.orderCajaCount!=null && caja.orderCajaCount>=0);
    const haveExpected = (caja.orderCajaExpected!=null && caja.orderCajaExpected>0);
    if(caja.orderId && haveCount){
      if(haveExpected){
        ordenStr = `${ordenStrBase} (${caja.orderCajaCount}/${caja.orderCajaExpected})`;
      } else {
        ordenStr = `${ordenStrBase} (${caja.orderCajaCount})`;
      }
    }
      return `<div class='caja-card rounded-lg border border-base-300/40 bg-base-200/10 p-3 flex flex-col gap-2 hover-border-primary/60 transition cursor-pointer' data-caja-id='${caja.id}' title='${titleText}'>
        <div class='text-[10px] uppercase opacity-60 tracking-wide'>Caja</div>
        <div class='font-semibold text-xs leading-tight break-all pr-2'>${displayName}</div>
      <div class='text-[10px] opacity-70'>Orden: <span class='font-mono'>${ordenStr}</span></div>
      <div class='flex flex-wrap gap-1 text-[9px] flex-1'>${compBadges || "<span class='badge badge-ghost badge-xs'>Sin items</span>"}</div>
      <div class='h-1.5 w-full bg-base-300/30 rounded-full overflow-hidden'>
        <div class='h-full bg-gradient-to-r from-primary via-primary to-primary/70' style='width:${progress.toFixed(1)}%' data-dev-caja-bar='${caja.id}'></div>
      </div>
      <div class='flex items-center justify-between text-[10px] font-mono opacity-70'>
        <span class='inline-flex items-center gap-1'>${timerBadge}</span>
        <button class='btn btn-ghost btn-[6px] btn-xs text-primary' data-process-caja='${caja.id}' title='Procesar devolución'>➜</button>
      </div>
    </div>`;
  }
  function render(){
    if(!grid) return; const cajas = data.cajas||[];
    if(!cajas.length){ grid.innerHTML = `<div class='col-span-full py-10 text-center text-xs opacity-60'>Sin cajas elegibles (Operación · Tránsito)</div>`; return; }
    grid.innerHTML = cajas.map(c=> cardHTML(c)).join('');
    // Render resumen por orden
    const resumenBox = document.getElementById('dev-orden-resumen');
    if(resumenBox){
      const ordenes = data.ordenes||{};
      const entries = Object.values(ordenes);
      if(!entries.length){ resumenBox.innerHTML = `<span class='opacity-50'>Sin órdenes asociadas</span>`; }
      else {
        resumenBox.innerHTML = entries.map(o=>{
          const a = o.cajas;
          const haveExpected = (o.expected!=null && o.expected>0);
          const b = haveExpected? o.expected : null;
          const match = (haveExpected && a>=o.expected);
          const countStr = haveExpected? `${a}/${b}` : `${a}`;
          return `<span class='px-2 py-1 rounded border ${match?'border-success/60 text-success':'border-base-300/50'} bg-base-300/10 font-mono'>${o.numero_orden||('#'+o.order_id)}: ${countStr}</span>`;
        }).join('');
      }
    }
  }
  async function load(){
    try { spin?.classList.remove('hidden');
      const r = await fetch('/operacion/devolucion/data');
      const j = await r.json();
  if(j.ok){ data = j; if(j.serverNow){ serverOffset = new Date(j.serverNow).getTime() - Date.now(); } syncScannedFromData(j); }
      else { data = { cajas:[], serverNow:null }; syncScannedFromData({ cajas: [] }); }
      render(); renderScannedList(); ensureTick();
    } catch(e){ console.error('[Devolución] load error', e); }
    finally { spin?.classList.add('hidden'); }
  }
  function ensureTick(){ if(tick) return; tick = setInterval(()=>{
    (data.cajas||[]).forEach(c=>{
      if(!c.timer) return; const el=document.getElementById('dev-timer-'+c.id); if(!el) return; const rem=msRemaining(c.timer); el.textContent = c.timer.completedAt? 'Listo' : timerDisplay(rem);
      const bar = document.querySelector(`[data-dev-caja-bar='${c.id}']`); if(bar && c.timer.startsAt && c.timer.endsAt){ const pct = progressPct(c.timer); bar.style.width = Math.min(100,Math.max(0,pct)).toFixed(1)+'%'; }
    });
  },1000); }
  function startPolling(){ if(poll) clearInterval(poll); poll = setInterval(load, 15000); }

  document.addEventListener('click', e=>{
    const target = e.target instanceof HTMLElement ? e.target : null;
    if(!target) return;
    const removeBtn = target.closest('[data-scan-remove]');
    if(removeBtn){ const id = removeBtn.getAttribute('data-scan-remove'); if(id){ removeScanned(id); } return; }
    const scanProcessBtn = target.closest('[data-scan-process]');
    if(scanProcessBtn){ const id = scanProcessBtn.getAttribute('data-scan-process'); if(id){ processCaja(id); } return; }
    const btn = target.closest('[data-process-caja]');
    if(btn){ const id = btn.getAttribute('data-process-caja'); if(id){ processCaja(id); } return; }
    const card = target.closest('.caja-card');
    if(card && card.getAttribute('data-caja-id')){ openModal(card.getAttribute('data-caja-id')); }
  });

  // ---- Scan / Identificar Caja ----
  const multiWrap = qs('#dev-multi');
  const multiList = qs('#dev-multi-list');
  const multiCount = qs('#dev-multi-count');
  const multiClear = qs('#dev-multi-clear');

  const scannedCajas = new Map();
  const scannedCodes = new Set();
  const scanningCodes = new Set();
  const lookupQueue = [];
  let lookupBusy = false;
  let scanBuffer = '';

  function cajaLabelById(rawId){
    const key = String(rawId);
    const scanned = scannedCajas.get(key);
    if(scanned && (scanned.nombreCaja || scanned.codigoCaja)) return scanned.nombreCaja || scanned.codigoCaja;
    const listed = (data.cajas||[]).find(c=> String(c.id) === key);
    if(listed && (listed.nombreCaja || listed.codigoCaja || listed.lote)) return listed.nombreCaja || listed.codigoCaja || listed.lote;
    return key;
  }

  function inferTipo(nombre){ const n=(nombre||'').toLowerCase(); if(n.includes('vip')) return 'vip'; if(n.includes('tic')) return 'tic'; if(n.includes('cube')||n.includes('cubo')) return 'cube'; return 'otro'; }
  function miniCardHTML(c){
    const ordenStr = (c.orderNumero ? c.orderNumero : (c.orderId ? ('#'+c.orderId) : (c.order_num ? c.order_num : (c.order_id ? ('#'+c.order_id) : '-'))));
    const code = c.codigoCaja || c.lote || '';
    const displayName = c.nombreCaja || code;
    const titleText = displayName && code && displayName !== code ? `${displayName} · ${code}` : displayName || code;
    return `<div class='text-xs'>
      <div class='flex items-center justify-between text-[10px] uppercase opacity-60 mb-1'><span>Caja</span><span class='font-mono'>${code}</span></div>
      <div class='font-semibold text-[11px] break-all mb-2' title='${titleText}'>${displayName}</div>
      <div class='text-[10px] opacity-70 mb-1'>Orden: <span class='font-mono'>${ordenStr}</span></div>
      <div class='flex flex-wrap gap-1 mb-2'>${(c.componentes||[]).map(it=>{ let cls='badge-ghost'; if(it.tipo==='vip') cls='badge-info'; else if(it.tipo==='tic') cls='badge-warning'; else if(it.tipo==='cube') cls='badge-accent'; return `<span class='badge ${cls} badge-xs'>${(it.tipo||'').toUpperCase()}</span>`; }).join('') || "<span class='badge badge-ghost badge-xs'>Sin items</span>"}</div>
      <div class='text-[10px] font-mono opacity-70'>${c.timer? (c.timer.completedAt? 'Listo' : 'Cronómetro activo') : 'Sin cronómetro'}</div>
      <div class='mt-2'><button class='btn btn-xs btn-primary btn-outline w-full' data-process-caja='${c.id}'>➜ Procesar devolución</button></div>
    </div>`;
  }

  function componentesBadges(lista){
    if(!Array.isArray(lista) || !lista.length){ return "<span class='badge badge-ghost badge-xs'>Sin items</span>"; }
    return lista.map(it=>{
      const tipo = (it.tipo||'').toLowerCase();
      let cls = 'badge-ghost';
      if(tipo === 'vip') cls = 'badge-info';
      else if(tipo === 'tic') cls = 'badge-warning';
      else if(tipo === 'cube') cls = 'badge-accent';
      return `<span class='badge ${cls} badge-xs'>${(tipo||'').toUpperCase()}</span>`;
    }).join('');
  }

  function syncScannedFromData(payload){
    const latest = new Map((payload.cajas||[]).map(c=> [String(c.id), c]));
    const toRemove = [];
    scannedCajas.forEach((entry, key)=>{
      const next = latest.get(key);
      if(!next){
        toRemove.push(key);
        return;
      }
      scannedCajas.set(key, {
        ...entry,
        codigoCaja: next.codigoCaja || next.caja || entry.codigoCaja,
        nombreCaja: next.nombreCaja || entry.nombreCaja || null,
        orderId: next.orderId ?? next.order_id ?? entry.orderId ?? null,
        orderNumero: next.orderNumero ?? next.order_num ?? entry.orderNumero ?? null,
        timer: next.timer || null,
        componentes: Array.isArray(next.componentes) ? next.componentes : entry.componentes
      });
    });
    toRemove.forEach(key=>{
      const entry = scannedCajas.get(key);
      if(entry && entry.code) scannedCodes.delete(entry.code);
      scannedCajas.delete(key);
    });
    renderScannedList();
  }

  function renderScannedList(){
    if(!multiList) return;
    const entries = Array.from(scannedCajas.values());
    if(!entries.length){
      multiWrap?.classList.add('hidden');
      multiList.innerHTML='';
      if(multiCount) multiCount.textContent = '0';
      return;
    }
    multiWrap?.classList.remove('hidden');
    if(multiCount) multiCount.textContent = String(entries.length);
      multiList.innerHTML = entries.map(entry=>{
      const ordenStr = entry.orderNumero ? entry.orderNumero : (entry.orderId ? ('#'+entry.orderId) : '-');
      const code = entry.codigoCaja || '';
      const displayName = entry.nombreCaja || code;
      const titleText = displayName && code && displayName !== code ? `${displayName} · ${code}` : displayName || code;
      return `<div class='border border-base-300/40 rounded-lg p-3 space-y-2' data-scan-entry='${entry.id}'>
        <div class='flex items-center justify-between gap-2'>
          <span class='font-mono text-xs break-all'>${code}</span>
          <button class='btn btn-ghost btn-xs' data-scan-remove='${entry.id}' title='Quitar'>✕</button>
        </div>
        <div class='text-xs font-semibold leading-tight break-all' title='${titleText}'>${displayName}</div>
        <div class='text-[10px] opacity-70'>Orden: <span class='font-mono'>${ordenStr}</span></div>
        <div class='flex flex-wrap gap-1 text-[9px]'>${componentesBadges(entry.componentes)}</div>
        <button class='btn btn-xs btn-primary w-full' data-scan-process='${entry.id}'>Procesar</button>
      </div>`;
    }).join('');
  }

  function removeScanned(id){
    const key = String(id);
    const entry = scannedCajas.get(key);
    if(entry){
      scannedCajas.delete(key);
      if(entry.code) scannedCodes.delete(entry.code);
    }
    renderScannedList();
  }

  function addScannedCaja(caja, code){
    const key = String(caja.id);
    if(scannedCajas.has(key)){
      if(scanMsg) scanMsg.textContent = 'Caja ya escaneada';
      return false;
    }
    scannedCajas.set(key, {
      id: caja.id,
      codigoCaja: caja.codigoCaja || caja.lote || '',
      nombreCaja: caja.nombreCaja || null,
      orderId: caja.orderId ?? caja.order_id ?? null,
      orderNumero: caja.orderNumero ?? caja.order_num ?? null,
      timer: caja.timer || null,
      componentes: Array.isArray(caja.componentes) ? caja.componentes : [],
      code
    });
    scannedCodes.add(code);
    renderScannedList();
    return true;
  }

  function enqueueLookup(code){
    if(!code || code.length!==24) return;
    const upper = code.toUpperCase();
    if(scannedCodes.has(upper)){
      if(scanMsg) scanMsg.textContent = 'Caja ya escaneada';
      return;
    }
    if(scanningCodes.has(upper)) return;
    scanningCodes.add(upper);
    lookupQueue.push(upper);
    if(!lookupBusy) runLookupQueue();
  }

  async function runLookupQueue(){
    if(lookupBusy) return;
    lookupBusy = true;
    while(lookupQueue.length){
      const code = lookupQueue.shift();
      try {
        await lookupCaja(code);
      } finally {
        scanningCodes.delete(code);
      }
    }
    lookupBusy = false;
  }

  function clearScanUI(msg){
    scanBuffer = '';
    if(scanInput) scanInput.value='';
    if(scanCardBox) scanCardBox.innerHTML='';
    if(scanExtra) scanExtra.textContent='';
    if(scanResult) scanResult.classList.add('hidden');
    if(scanMsg) scanMsg.textContent = typeof msg === 'string' ? msg : '';
  }

  async function lookupCaja(code){
    if(scanMsg) scanMsg.textContent = `Buscando ${code}...`;
    if(scanResult) scanResult.classList.add('hidden');
    try {
      const r = await fetch('/operacion/caja/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code })});
      const j = await r.json();
      if(!j.ok){ if(scanMsg) scanMsg.textContent = j.error || 'No encontrado'; return false; }
      const cajaId = j.caja.id;
      let caja = (data.cajas||[]).find(c=> String(c.id)===String(cajaId));
      if(!caja){
        const cubeItem = (j.caja.items||[]).find(it=> inferTipo(it.nombre_modelo||it.nombre||'') === 'cube');
        const nombreCaja = j.caja.nombre_caja || j.caja.nombreCaja || cubeItem?.nombre_modelo || null;
        caja = {
          id: cajaId,
          codigoCaja: j.caja.lote,
          nombreCaja: nombreCaja || null,
          orderId: j.caja.order_id || null,
          orderNumero: j.caja.order_num || null,
          timer: j.caja.timer ? { startsAt: j.caja.timer.startsAt, endsAt: j.caja.timer.endsAt, completedAt: j.caja.timer.active===false? j.caja.timer.endsAt:null } : null,
          componentes: (j.caja.items||[]).map(it=> ({ codigo: it.rfid, tipo: inferTipo(it.nombre_modelo||it.nombre||'') }))
        };
      }
      const items = (j.caja.items||[]);
      const eligible = items.length>0 && items.every(it=> it.estado==='Operación' && it.sub_estado==='Transito');
      if(!eligible){
        if(scanMsg) scanMsg.textContent='Caja no elegible: requiere Operación · Tránsito';
        return false;
      }
      const added = addScannedCaja(caja, code);
      if(scanCardBox) scanCardBox.innerHTML = miniCardHTML(caja);
      if(scanExtra) scanExtra.textContent = `Items: ${(caja.componentes||[]).length} · ID ${caja.id}`;
      if(scanResult) scanResult.classList.remove('hidden');
      if(scanMsg) scanMsg.textContent = added ? 'Caja agregada' : 'Caja ya escaneada';
      return added;
    } catch(e){
      if(scanMsg) scanMsg.textContent='Error';
      return false;
    } finally {
      scanBuffer='';
      if(scanInput) scanInput.value='';
    }
  }
  function triggerLookup(){
    if(!scanInput) return;
    const val = (scanInput.value||'').replace(/[^A-Z0-9]/g,'').toUpperCase();
    if(!val){ if(scanMsg) scanMsg.textContent='Ingresa RFID'; return; }
    if(val.length!==24){ if(scanMsg) scanMsg.textContent='Debe tener 24 caracteres'; return; }
    scanInput.value='';
    scanBuffer='';
    enqueueLookup(val);
  }
  scanBtn?.addEventListener('click', triggerLookup);
  scanClear?.addEventListener('click', ()=>{
    scanBuffer='';
    if(scanInput) scanInput.value='';
    if(scanMsg) scanMsg.textContent='';
    if(scanResult) scanResult.classList.add('hidden');
    if(scanCardBox) scanCardBox.innerHTML='';
    if(scanExtra) scanExtra.textContent='';
  });
  scanInput?.addEventListener('keydown', e=>{
    if(e.key==='Enter'){
      e.preventDefault();
      triggerLookup();
    }
  });
  scanInput?.addEventListener('input', ()=>{
    if(!scanInput) return;
    let raw = (scanInput.value||'').toUpperCase();
    raw = raw.replace(/[^A-Z0-9]/g,'');
    scanBuffer = raw;
    while(scanBuffer.length >= 24){
      const chunk = scanBuffer.slice(0,24);
      scanBuffer = scanBuffer.slice(24);
      enqueueLookup(chunk);
    }
    scanInput.value = scanBuffer;
    if(scanBuffer.length && scanMsg){
      const remaining = 24 - scanBuffer.length;
      scanMsg.textContent = `Faltan ${remaining} caract.`;
    } else if(scanMsg && !lookupBusy && !lookupQueue.length){
      scanMsg.textContent = '';
    }
  });
  scanInput && setTimeout(()=> scanInput.focus(), 500);
  multiClear?.addEventListener('click', ()=>{
    scannedCajas.clear();
    scannedCodes.clear();
    renderScannedList();
    if(scanMsg) scanMsg.textContent='';
  });
  function updateModalTimer(){ if(!modalCajaId) return; const caja = (data.cajas||[]).find(c=> String(c.id)===String(modalCajaId)); if(!caja||!caja.timer) return; const span=document.getElementById('dev-modal-timer'); const bar=document.getElementById('dev-modal-bar'); if(span){ span.textContent = caja.timer.completedAt? 'Listo' : timerDisplay(msRemaining(caja.timer)); } if(bar && caja.timer.startsAt && caja.timer.endsAt){ bar.style.width = progressPct(caja.timer).toFixed(1)+'%'; } }
  modalReturn?.addEventListener('click', ()=>{ if(!modalCajaId) return; processCaja(modalCajaId); });
  async function processCaja(id){
    // 1) evaluar si es reusable (>50% restante)
    try {
      if(scanMsg) scanMsg.textContent='Evaluando...';
      const r = await fetch('/operacion/devolucion/evaluate',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: id })});
      const j = await r.json();
      if(!j.ok){ if(scanMsg) scanMsg.textContent=j.error||'No elegible'; if(scanResult) scanResult.classList.add('hidden'); return; }
      const reusable = !!j.reusable;
      const pct = Math.round((j.remaining_ratio||0)*100);
      let html = '';
      if(reusable){
        if(decideMsg) decideMsg.textContent = `Queda ${pct}% del cronómetro. ¿Deseas reutilizar la caja (volver a Acond · Lista para Despacho) o enviarla a Bodega · Pendiente a Inspección?`;
        html = `<button class='btn btn-primary btn-sm flex-1' data-act='reuse' data-id='${id}'>Reutilizar</button>
    <button class='btn btn-outline btn-sm flex-1' data-act='insp' data-id='${id}'>Pendiente a Inspección</button>`;
      } else {
        if(decideMsg) decideMsg.textContent = `Queda ${pct}% del cronómetro. No es posible reutilizar. ¿Deseas enviarla a Bodega · Pendiente a Inspección?`;
        html = `<button class='btn btn-error btn-sm flex-1' data-act='insp' data-id='${id}'>Enviar a Pendiente a Inspección</button>`;
      }
      if(decideActions) decideActions.innerHTML = html;
      try { decideDlg.showModal(); } catch { decideDlg.classList.remove('hidden'); }
    } catch(e){ if(scanMsg) scanMsg.textContent='Error'; }
  }

  // Manejar acciones de decisión
  document.addEventListener('click', async (e)=>{
    const t = e.target instanceof HTMLElement ? e.target : null;
    if(!t) return;
    if(t.closest('#dev-decide-actions [data-act]')){
      const btn = t.closest('[data-act]');
      const act = btn.getAttribute('data-act');
      const id = btn.getAttribute('data-id');
      if(!id) return;
      try {
        if(scanMsg) scanMsg.textContent='Aplicando...';
        if(act==='reuse'){
          const cajaLabel = cajaLabelById(id);
          const attempt = await postJSONWithSedeTransfer('/operacion/devolucion/reuse', { caja_id: id }, {
            promptMessage: (payload) => payload?.confirm || payload?.error || `La caja ${cajaLabel} pertenece a otra sede. ¿Deseas trasladarla a tu sede actual?`
          });
          if(attempt.cancelled){
            if(scanMsg) scanMsg.textContent = 'Operación cancelada.';
            return;
          }
          const payload = attempt.data || {};
          if(!attempt.httpOk || payload.ok === false){
            const message = payload.error || payload.message || `Error (${attempt.status || 0})`;
            throw new Error(message);
          }
          if(scanMsg) scanMsg.textContent='Caja enviada a Acondicionamiento · Lista para Despacho';
          await load();
          removeScanned(id);
          clearScanUI('');
        } else if(act==='insp'){
          // Abrir modal para horas/minutos; solo se envía tras Aceptar
          piCajaId = id;
          try { piDlg.showModal(); } catch { piDlg.classList.remove('hidden'); }
        }
        try{ modal.close(); }catch{ modal.classList.add('hidden'); }
        try{ decideDlg.close(); }catch{ decideDlg.classList.add('hidden'); }
        // load() se invocará tras aceptar en el modal
      } catch(err){ if(scanMsg) scanMsg.textContent = err.message || 'Error'; }
    }
  });

  // Manejar PI modal
  piAccept?.addEventListener('click', async ()=>{
    const h = parseInt(piHours?.value||'0',10)||0; const m = parseInt(piMins?.value||'0',10)||0; const sec = h*3600 + m*60;
    if(!piCajaId || sec<=0){ // exigir cronómetro positivo
      try{ piDlg.close(); }catch{ piDlg.classList.add('hidden'); }
      if(scanMsg) scanMsg.textContent = 'Debes asignar horas o minutos antes de enviar';
      return;
    }
    const currentId = piCajaId;
    let shouldReset = true;
    try {
      const cajaLabel = cajaLabelById(currentId);
      const attempt = await postJSONWithSedeTransfer('/operacion/devolucion/to-pend-insp', { caja_id: currentId, durationSec: sec }, {
        promptMessage: (payload) => payload?.confirm || payload?.error || `La caja ${cajaLabel} pertenece a otra sede. ¿Deseas trasladarla a tu sede actual?`
      });
      if(attempt.cancelled){
        shouldReset = false;
        if(scanMsg) scanMsg.textContent = 'Operación cancelada.';
        return;
      }
      const payload = attempt.data || {};
      if(!attempt.httpOk || payload.ok === false){
        const message = payload.error || payload.message || `Error (${attempt.status || 0})`;
        throw new Error(message);
      }
      if(scanMsg) scanMsg.textContent='Caja enviada a Bodega · Pendiente a Inspección';
      // refrescar inmediatamente la lista para que desaparezca y limpiar panel derecho
      await load();
      removeScanned(currentId);
      clearScanUI('');
    } catch(e){ if(scanMsg) scanMsg.textContent = e.message || 'Error'; }
    finally {
      if(shouldReset){
        piCajaId=null;
        piHours && (piHours.value='');
        piMins && (piMins.value='');
        try{ piDlg.close(); }catch{ piDlg.classList.add('hidden'); }
      }
    }
  });
  piCancel?.addEventListener('click', ()=>{ piCajaId=null; piHours && (piHours.value=''); piMins && (piMins.value=''); try{ piDlg.close(); }catch{ piDlg.classList.add('hidden'); } });

  // Cerrar con X
  decideClose?.addEventListener('click', (e)=>{ e.preventDefault(); try{ decideDlg.close(); }catch{ decideDlg.classList.add('hidden'); } });
  modalClose?.addEventListener('click', ()=>{ modalCajaId=null; try{ modal.close(); }catch{ modal.classList.add('hidden'); } });
  // también cerrar al backdrop form (native dialog auto cierra)

  load(); startPolling();
  // Hook modal timer refresh
  setInterval(updateModalTimer, 1000);
})();
