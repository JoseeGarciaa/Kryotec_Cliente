// Operación phase list view (similar style to acond) - polling + filter + timers per caja item rows
(function(){
  'use strict';
  const qs = s=>document.querySelector(s);
  const qsa = s=>Array.from(document.querySelectorAll(s));
  const tbody = qs('#op-tbody');
  const count = qs('#op-count');
  const filterInput = qs('#op-filter');
  const btnAdd = qs('#op-btn-add');
  const btnViewCards = qs('#op-view-cards');
  const btnViewList = qs('#op-view-list');
  const gridWrapper = qs('#op-grid-wrapper');
  const grid = qs('#op-grid');
  const tableWrapper = qs('#op-table-wrapper');
  const modal = document.getElementById('op-modal-add');
  const addScan = document.getElementById('op-add-scan');
  const addSummary = document.getElementById('op-add-summary');
  const addItemsWrap = document.getElementById('op-add-items');
  const addMsg = document.getElementById('op-add-msg');
  const addConfirm = document.getElementById('op-add-confirm');
  const addClear = document.getElementById('op-add-clear');
  // Se eliminaron inputs de duración y contadores del modal; referencias removidas
  let addCajaId = null;
  let addFirstScan = null; // first TIC to auto-group
  let addElegibles = []; // rfids elegibles de la caja
  let addRoles = []; // { rfid, rol }
  let dataCajas = []; // todas cajas (operación + completadas)
  let addScanLocked = false; // evita más escritura tras código válido
  let lastLookupCode = null; // evita lookups duplicados consecutivos
  let polling=null; let ticking=null; let serverOffset=0;
  // Focus de caja al escanear un RFID (igual patrón que acond.js)
  let focusCajaId = null; // number | null
  let filterLastScanRfid = ''; // last scanned code for focus
  let addQueue = [];
  let selectedCajaId = null;

  // Parse RFIDs de 24 chars consecutivos (permite bursts del lector)
  function parseRfids(raw){
    const original = String(raw||'').toUpperCase();
    const s = original.replace(/\s+/g,'');
    const out = [];
    for(let i=0;i+24<=s.length;i+=24){ out.push(s.slice(i,i+24)); }
    const rx=/[A-Z0-9]{24}/g; let m; while((m=rx.exec(s))){ const c=m[0]; if(!out.includes(c)) out.push(c); }
    const cajaRx=/CAJA-[0-9]{8}-[A-Z0-9]{4,8}/g; let mc; while((mc=cajaRx.exec(original))){ const code=mc[0]; if(!out.includes(code)) out.push(code); }
    return out;
  }

  function msRemaining(timer){ if(!timer||!timer.endsAt) return 0; return new Date(timer.endsAt).getTime() - (Date.now()+serverOffset); }
  function timerDisplay(rem){
    if(rem<=0) return 'Finalizado';
    const s = Math.max(0, Math.floor(rem/1000));
    const h = Math.floor(s/3600);
    const m = Math.floor((s%3600)/60);
    const sec = s%60;
    return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; // HH:MM:SS
  }
  function badgeClass(rem, completed){ if(completed) return 'badge-success'; if(rem<=0) return 'badge-warning'; if(rem<=60*1000) return 'badge-error'; if(rem<=5*60*1000) return 'badge-warning'; return 'badge-neutral'; }
  // Timers son solo lectura (definidos en Listo para Despacho). No hay controles en Operación.
  function controlButtonsHTML(_caja){ return ''; }
  function rowHTML(caja){
    const comps = caja.componentes||[];
    const timer = caja.timer;
  const isTransito = caja.estado==='Transito';
  const isRetorno = caja.estado==='Retorno';
    const remaining = timer? msRemaining(timer):0;
      let timerTxt='';
    if(timer){
      timerTxt = isRetorno? 'Finalizado' : timerDisplay(remaining);
    }
  const badgeCls = timer? badgeClass(remaining, !!timer.completedAt) : 'badge-ghost';
      let badge;
      if(timer){
        badge = `<span class="badge badge-xs ${badgeCls} gap-1" data-op-timer data-caja="${caja.id}">${timerTxt}</span>`;
      } else { badge=''; }
    if(!comps.length){
      return `<tr data-caja-row="${caja.id}" data-caja-id="${caja.id}"><td class="font-mono text-[10px] opacity-50">(sin)</td><td class="hidden md:table-cell text-xs">-</td><td class="hidden lg:table-cell text-xs">${caja.estado}</td><td class="text-xs font-mono">${caja.codigoCaja}</td><td class="w-32">${badge}</td></tr>`;
    }
    return comps.map(it=> `<tr data-caja-row="${caja.id}" data-caja-id="${caja.id}">
      <td class="font-mono text-[10px]">${it.codigo}</td>
      <td class="hidden md:table-cell text-xs">${it.nombre||''}</td>
      <td class="hidden lg:table-cell text-xs">${caja.estado}</td>
      <td class="text-xs font-mono">${caja.codigoCaja}</td>
      <td class="w-32">${badge}</td>
    </tr>`).join('');
  }
  function timerProgressPct(caja){
    if(!caja.timer || !caja.timer.startsAt || !caja.timer.endsAt) return 0;
    const start = new Date(caja.timer.startsAt).getTime();
    const end = new Date(caja.timer.endsAt).getTime();
    const now = Date.now()+serverOffset;
    if(now<=start) return 0;
    if(now>=end) return 100;
    return ((now-start)/(end-start))*100;
  }
  function cardHTML(caja){
    // Replica del diseño de tarjetas de acond.js
    const comps = caja.componentes||[];
    const vip = comps.filter(x=>x.tipo==='vip');
    const tics = comps.filter(x=>x.tipo==='tic');
    const cubes = comps.filter(x=>x.tipo==='cube');
    const compBadges = [
      ...vip.map(()=>`<span class='badge badge-info badge-xs font-semibold'>VIP</span>`),
      ...tics.map(()=>`<span class='badge badge-warning badge-xs font-semibold'>TIC</span>`),
      ...cubes.map(()=>`<span class='badge badge-accent badge-xs font-semibold'>CUBE</span>`)
    ].join(' ');
    const remaining = caja.timer? msRemaining(caja.timer):0;
    const progress = timerProgressPct(caja);
    const timerTxt = caja.timer? timerDisplay(remaining):'';
    let timerBadge='';
    if(caja.timer && caja.timer.startsAt && caja.timer.endsAt && !caja.timer.completedAt){
      timerBadge = `<span class='badge badge-neutral badge-xs flex items-center gap-1' data-op-timer data-caja='${caja.id}' data-caja-timer-started='${new Date(caja.timer.startsAt).getTime()}' data-caja-timer-duration='${Math.round((new Date(caja.timer.endsAt).getTime()-new Date(caja.timer.startsAt).getTime())/1000)}'>
          <span id='tm-caja-${caja.id}' class='font-mono whitespace-nowrap tabular-nums'>${timerTxt}</span>
          <button class='btn btn-ghost btn-xs px-1 h-4 shrink-0 stop-caja-timer' disabled title='Solo lectura'>✕</button>
        </span>`;
    } else if(caja.timer && caja.timer.completedAt){
      timerBadge = `<span class='badge badge-success badge-xs'>Listo</span>`;
    } else {
      timerBadge = `<span class='badge badge-outline badge-xs opacity-60'>Sin cronómetro</span>`;
    }
    const pct = Math.min(100, Math.max(0, progress));
    const fullCode = caja.codigoCaja||'';
    let rightId = fullCode.startsWith('CAJA-')? fullCode : (caja.id!=null? '#'+caja.id: fullCode);
    return `<div class='caja-card rounded-lg border border-base-300/40 bg-base-200/10 p-3 flex flex-col gap-2 hover:border-primary/60 transition' data-caja-card='${caja.id}' data-caja-id='${caja.id}'>
      <div class='flex items-center justify-between text-[10px] tracking-wide uppercase opacity-60'><span>Caja</span><span class='font-mono'>${rightId}</span></div>
      <div class='font-semibold text-xs leading-tight break-all pr-2' title='${fullCode}'>${fullCode}</div>
      <div class='flex flex-wrap gap-1 text-[9px] flex-1'>${compBadges || "<span class='badge badge-ghost badge-xs'>Sin items</span>"}</div>
      <div class='timer-progress h-1.5 w-full bg-base-300/30 rounded-full overflow-hidden'>
        <div class='timer-bar h-full bg-gradient-to-r from-primary via-primary to-primary/70' style='width:${pct.toFixed(1)}%' data-caja-bar='${caja.id}'></div>
      </div>
      <div class='flex items-center justify-between text-[10px] font-mono opacity-70'>
        <span class='inline-flex items-center gap-1'>${timerBadge}</span>
        <span class='opacity-50'>restante</span>
      </div>
    </div>`;
  }
  function render(){
    if(!tbody) return;
    const raw = (filterInput?.value||'');
    const tokens = parseRfids(raw);
    const activeCode = tokens[0] || filterLastScanRfid || '';
    const f = raw.trim().toLowerCase();
    const activos = dataCajas.filter(c=> c.estado!=='Completado');

    // Determinar focusCajaId si el token escaneado corresponde a un RFID o codigo de caja
    if(activeCode){
      const target = activeCode.toUpperCase();
      const hit = activos.find(c=> {
        if(String(c.codigoCaja||'').toUpperCase() === target) return true;
        return (c.componentes||[]).some(it=> String(it.codigo||'').toUpperCase() === target);
      });
      focusCajaId = hit ? hit.id : null;
    } else {
      focusCajaId = null;
    }

    const filAct = focusCajaId != null
      ? activos.filter(c=> String(c.id) === String(focusCajaId))
      : (f? activos.filter(c=> c.codigoCaja.toLowerCase().includes(f) || (c.componentes||[]).some(it=> it.codigo.toLowerCase().includes(f)) ): activos);

    // Tabla
    tbody.innerHTML = filAct.length? filAct.map(c=> rowHTML(c)).join('') : `<tr><td colspan="5" class="text-center py-6 text-xs opacity-50">Sin resultados</td></tr>`;
    // Tarjetas (solo una por caja, no por componente)
    if(grid){
      grid.innerHTML = filAct.length? filAct.map(c=> cardHTML(c)).join('') : `<div class="text-xs opacity-50 col-span-full py-6 text-center">Sin resultados</div>`;
    }
    if(count){
      const totalComp = activos.reduce((a,c)=> a + (c.componentes||[]).length,0);
      let filteredComp;
      if(focusCajaId != null){
        filteredComp = filAct.reduce((a,c)=> a + (c.componentes||[]).length,0);
      } else if(f){
        // Contar sólo los componentes cuyo código coincide; si resulta 0, caer a todos los de las cajas filtradas
        filteredComp = filAct.reduce((a,c)=> a + (c.componentes||[]).filter(it=> it.codigo.toLowerCase().includes(f)).length,0);
        if(filteredComp===0){ filteredComp = filAct.reduce((a,c)=> a + (c.componentes||[]).length,0); }
      } else {
        filteredComp = filAct.reduce((a,c)=> a + (c.componentes||[]).length,0);
      }
      count.textContent = `(${filteredComp} de ${totalComp})`;
    }
  }
  function ensureTick(){ if(ticking) return; ticking = setInterval(()=>{
    qsa('[data-op-timer]').forEach(b=>{
      const cid = b.getAttribute('data-caja');
      const caja = dataCajas.find(c=> String(c.id)===String(cid));
      if(!caja || !caja.timer) return; const rem = msRemaining(caja.timer); 
      const span = b.querySelector('#tm-caja-'+cid);
      if(span) span.textContent = timerDisplay(rem);
      else b.textContent = timerDisplay(rem);
      b.className = `badge badge-xs flex items-center gap-1 ${badgeClass(rem, !!caja.timer.completedAt)}`;
      const bar = document.querySelector(`[data-caja-bar='${cid}']`);
      if(bar && caja.timer.startsAt && caja.timer.endsAt){
        const pct = timerProgressPct(caja);
        bar.style.width = Math.min(100, Math.max(0, pct)).toFixed(1)+'%';
      }
    });
    // Update modal if open
    const modalWrap = document.getElementById('modal-caja-detalle');
    if(modalWrap && !modalWrap.classList.contains('hidden')){
      const mid = modalWrap.getAttribute('data-current-id');
      if(mid){
        const caja = dataCajas.find(c=> String(c.id)===String(mid));
        if(caja && caja.timer){
          const remSpan = modalWrap.querySelector('[data-detalle-remaining]');
          if(remSpan){ remSpan.textContent = timerDisplay(msRemaining(caja.timer)); }
          const bar = modalWrap.querySelector('[data-detalle-bar]');
          if(bar && caja.timer.startsAt && caja.timer.endsAt){
            const pct = timerProgressPct(caja);
            bar.style.width = Math.min(100, Math.max(0, pct)).toFixed(1)+'%';
          }
        }
      }
    }
  },1000); }

  // -------- Detalle Modal --------
  function openCajaDetalle(id){
    const modal = document.getElementById('modal-caja-detalle'); if(!modal) return;
    const caja = dataCajas.find(c=> String(c.id)===String(id)); if(!caja) return;
    modal.setAttribute('data-current-id', id);
    const comps = caja.componentes||[];
    const counts = { vip:0, tic:0, cube:0 };
    comps.forEach(c=>{ if(c.tipo) counts[c.tipo]=(counts[c.tipo]||0)+1; });
    const setText = (sel,val)=>{ const el=document.getElementById(sel); if(el) el.textContent=val; };
    setText('detalle-caja-titulo', caja.codigoCaja||'Caja');
    setText('detalle-caja-lote', caja.codigoCaja||'');
    setText('detalle-caja-id', '#'+caja.id);
    setText('detalle-caja-comp', `VIP:${counts.vip||0} · TIC:${counts.tic||0} · CUBE:${counts.cube||0}`);
    setText('detalle-caja-fecha', '-');
    // Orden vinculada si existe
    (function(){
      const el = document.getElementById('detalle-caja-orden');
      if(!el) return;
      const num = caja.orderNumero || null;
      const idNum = caja.orderId || null;
      el.textContent = num ? String(num) : (idNum ? `#${idNum}` : '—');
      el.classList.toggle('opacity-60', !(num||idNum));
    })();
    const itemsBox = document.getElementById('detalle-caja-items');
    if(itemsBox){
      itemsBox.innerHTML = comps.map(cc=>{
        let color='badge-ghost'; if(cc.tipo==='vip') color='badge-info'; else if(cc.tipo==='tic') color='badge-warning'; else if(cc.tipo==='cube') color='badge-accent';
        return `<div class="border rounded-lg p-3 bg-base-300/10 flex flex-col gap-2" title="${cc.codigo||''}">
          <div class="flex items-center justify-between"><span class="badge ${color} badge-xs font-semibold uppercase">${cc.tipo||''}</span></div>
          <div class="font-mono text-sm break-all">${cc.codigo||''}</div>
        </div>`;
      }).join('');
      if(!comps.length) itemsBox.innerHTML='<div class="col-span-full text-center text-xs opacity-60 italic">Sin componentes</div>';
    }
    const tBox = document.getElementById('detalle-caja-timer-box');
    if(tBox){
      if(!caja.timer){ tBox.innerHTML='<div class="text-sm opacity-60 italic">(Sin cronómetro)</div>'; }
      else {
        const remaining = msRemaining(caja.timer);
        const remTxt = timerDisplay(remaining);
        const pct = timerProgressPct(caja);
        tBox.innerHTML = `<div class="space-y-2">
          <div class="text-sm">Tiempo restante: <span class="font-mono" data-detalle-remaining>${remTxt}</span></div>
          <div class="h-2 rounded bg-base-300/40 overflow-hidden">
            <div class="h-full bg-primary" style="width:${pct.toFixed(1)}%" data-detalle-bar></div>
          </div>
        </div>`;
      }
    }
    modal.classList.remove('hidden');
  }
  function closeCajaDetalle(){ const modal=document.getElementById('modal-caja-detalle'); if(modal){ modal.classList.add('hidden'); modal.removeAttribute('data-current-id'); } }

  document.addEventListener('click', e=>{
    const card = e.target.closest('.caja-card'); if(card && card.getAttribute('data-caja-id')){ openCajaDetalle(card.getAttribute('data-caja-id')); }
    const row = e.target.closest('tr[data-caja-id]'); if(row && row.getAttribute('data-caja-id')){ openCajaDetalle(row.getAttribute('data-caja-id')); }
    if(e.target.closest('[data-close="detalle"]')) closeCajaDetalle();
  });

  async function load(){
    try {
      const spin = qs('#op-spin'); if(spin) spin.classList.remove('hidden');
  const r = await fetch('/operacion/data');
      const j = await r.json(); if(!j.ok) throw new Error(j.error||'Error');
      dataCajas = Array.isArray(j.cajas)? j.cajas:[];
      const serverNow = j.now? new Date(j.now).getTime():Date.now(); serverOffset = serverNow - Date.now();
      render(); ensureTick();
  } catch(e){ console.error('[Operación] load error', e); if(tbody) tbody.innerHTML = `<tr><td colspan="5" class="text-center py-6 text-error text-xs">Error cargando</td></tr>`; }
    finally { const spin = qs('#op-spin'); if(spin) spin.classList.add('hidden'); }
  }
  function startPolling(){ if(polling) clearInterval(polling); polling = setInterval(load, 10000); }

  // Events
  const handleFilterInput = ()=>{
    if(!filterInput) return;
    const raw = filterInput.value || '';
    const tokens = parseRfids(raw);
    if(tokens.length){
      filterLastScanRfid = tokens[tokens.length-1].toUpperCase();
      filterInput.value = '';
    } else {
      filterLastScanRfid = '';
    }
    render();
  };
  if(filterInput){
    filterInput.addEventListener('input', handleFilterInput);
    filterInput.addEventListener('keydown', (ev)=>{
      const key = ev.key || ev.code;
      if(key === 'Enter' || key === 'NumpadEnter'){
        ev.preventDefault();
        handleFilterInput();
      } else if(key === 'Escape'){
        filterLastScanRfid = '';
        focusCajaId = null;
        filterInput.value = '';
        render();
      }
    });
  }

  addItemsWrap?.addEventListener('click', (ev)=>{
    const removeBtn = ev.target.closest('[data-remove-caja]');
    if(removeBtn){
      ev.preventDefault();
      ev.stopPropagation();
      const id = Number(removeBtn.getAttribute('data-remove-caja')) || 0;
      if(id){
        addQueue = addQueue.filter(q=> q.id !== id);
        const nextId = selectedCajaId === id ? (addQueue[addQueue.length-1]?.id || null) : selectedCajaId;
        setSelectedCaja(nextId);
      }
      return;
    }
    const card = ev.target.closest('[data-select-caja]');
    if(card){
      const id = Number(card.getAttribute('data-select-caja')) || 0;
      if(id){ setSelectedCaja(id); }
    }
  });

  // Vista tarjetas/lista
  function activateCards(){ if(!gridWrapper||!tableWrapper) return; gridWrapper.classList.remove('hidden'); tableWrapper.classList.add('hidden'); btnViewCards?.classList.add('btn-active'); btnViewList?.classList.remove('btn-active'); }
  function activateList(){ if(!gridWrapper||!tableWrapper) return; tableWrapper.classList.remove('hidden'); gridWrapper.classList.add('hidden'); btnViewList?.classList.add('btn-active'); btnViewCards?.classList.remove('btn-active'); }
  btnViewCards?.addEventListener('click', ()=> activateCards());
  btnViewList?.addEventListener('click', ()=> activateList());
  // Por defecto vista tarjetas (cubo)
  activateCards();
  function openAddModal(){ try { modal.showModal(); } catch{ modal.classList.remove('hidden'); } resetAdd(); setTimeout(()=> addScan?.focus(), 40); }
  btnAdd?.addEventListener('click', openAddModal);
  function resetAdd(){
    addQueue = [];
    selectedCajaId = null;
    addCajaId = null;
    addElegibles = [];
    addRoles = [];
    addFirstScan = null;
    addScanLocked = false;
    lastLookupCode = null;
    if(addScan){ addScan.value=''; addScan.readOnly=false; }
    if(addItemsWrap) addItemsWrap.innerHTML='';
    if(addSummary) addSummary.classList.add('hidden');
    if(addMsg) addMsg.textContent='';
    if(addConfirm) addConfirm.disabled=true;
  }
  function updateCounts(){
    const entry = selectedCajaId ? addQueue.find(q=> q.id === selectedCajaId) : null;
    addConfirm.disabled = !(entry && entry.roles.length>0);
  }
  function setSelectedCaja(id){
    selectedCajaId = id || null;
    const entry = selectedCajaId ? addQueue.find(q=> q.id === selectedCajaId) : null;
    if(entry){
      addCajaId = entry.id;
      addRoles = entry.roles.slice();
      if(addMsg){ addMsg.textContent = `Cajas escaneadas: ${addQueue.length}. Seleccionada ${entry.lote}`; }
    } else {
      addCajaId = null;
      addRoles = [];
      if(addMsg){ addMsg.textContent = addQueue.length ? `Cajas escaneadas: ${addQueue.length}` : ''; }
    }
    renderQueue();
    updateCounts();
  }
  function renderQueue(){
    if(!addItemsWrap) return;
    if(!addQueue.length){
      addItemsWrap.innerHTML='';
      if(addSummary) addSummary.classList.add('hidden');
      return;
    }
    if(addSummary) addSummary.classList.remove('hidden');
    addItemsWrap.className = 'flex flex-col gap-2 max-h-48 overflow-auto';
    addItemsWrap.innerHTML = addQueue.map(entry => {
      const isActive = entry.id === selectedCajaId;
      const orderLabel = entry.orderNum ? entry.orderNum : (entry.orderId ? `#${entry.orderId}` : '-');
      const summaryCount = entry.roles?.length || 0;
      const itemsHtml = (entry.roles||[]).map(ro=>{
        const cls = badgeForRol(ro.rol);
        const label = String(ro.rol||'').toUpperCase();
        return `<div class='flex items-center justify-between gap-2 px-2 py-1 bg-base-200 rounded'><span class='badge ${cls} badge-xs font-semibold uppercase'>${label}</span><span class='font-mono text-[10px]'>${ro.rfid}</span></div>`;
      }).join('');
      const chevron = isActive ? 'v' : '>';

      const details = isActive ? `<div class='mt-2 grid gap-1'>${itemsHtml || "<span class='text-[10px] opacity-60'>Sin items</span>"}</div>` : '';
      return `<div class='border rounded-lg bg-base-200/20 ${isActive ? 'border-primary' : 'border-base-300/60'} flex flex-col cursor-pointer transition-colors' data-select-caja='${entry.id}'>
        <div class='flex items-center justify-between gap-3 px-3 py-2'>
          <div class='flex items-center gap-2 text-xs font-semibold'>
            <span class='text-[10px] opacity-70'>${chevron}</span>
            <span>${entry.lote}</span>
          </div>
          <div class='flex items-center gap-3 text-[10px] uppercase opacity-70'>
            <span>Orden: ${orderLabel}</span>
            <span>${summaryCount} items</span>
            <button type='button' class='btn btn-ghost btn-xs' data-remove-caja='${entry.id}'>&times;</button>
          </div>
        </div>
        ${details}
      </div>`;
    }).join('');
  }
  async function lookupAdd(code){
    if(!code) return false;
    if(addMsg) addMsg.textContent='Buscando...';
    try {
      const res = await fetch('/operacion/add/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code })});
      const ct = res.headers.get('content-type') || '';
      if(!ct.includes('application/json')){
        const raw = await res.text();
        console.error('[Operacion] lookupAdd respuesta no JSON', { status: res.status, body: raw });
        if(addMsg) addMsg.textContent = 'Respuesta inesperada (' + res.status + ')'; 
        return false;
      }
      const j = await res.json();
      if(!res.ok || j?.ok === false){
        const message = j?.error || j?.message || ('Error (' + res.status + ')'); 
        if(addMsg) addMsg.textContent = message;
        console.error('[Operacion] lookupAdd error', { status: res.status, body: j });
        return false;
      }
      const entry = {
        id: j.caja_id,
        lote: j.lote,
        orderId: j.order_id ?? null,
        orderNum: j.order_num ?? null,
        roles: Array.isArray(j.roles)? j.roles.slice(): [],
        timer: j.timer || null
      };
      const existingIndex = addQueue.findIndex(q=> q.id === entry.id);
      if(existingIndex >= 0){
        addQueue[existingIndex] = entry;
      } else {
        addQueue.push(entry);
      }
      setSelectedCaja(entry.id);
      return true;
    } catch(e){
      console.error('[Operacion] lookupAdd exception', e);
      if(addMsg) addMsg.textContent = e?.message ? ('Error: ' + e.message) : 'Error';
      return false;
    }
  }
  }
  addScan?.addEventListener('input', async ()=>{
    const raw = (addScan.value || '').toUpperCase();
    const tokens = parseRfids(raw);
    if(!tokens.length){
      return;
    }
    const code = tokens[tokens.length-1];
    if(code === lastLookupCode) return;
    addScan.value = '';
    const success = await lookupAdd(code);
    if(success) lastLookupCode = code;
  });
  addScan?.addEventListener('keydown', async e=>{ if(e.key==='Enter'){ e.preventDefault(); const raw=(addScan.value||'').toUpperCase(); const tokens=parseRfids(raw); if(tokens.length){ const code=tokens[tokens.length-1]; if(code === lastLookupCode) return; addScan.value=''; const success = await lookupAdd(code); if(success) lastLookupCode = code; } }});
  // Inputs de duración removidos
  addClear?.addEventListener('click', resetAdd);
  addConfirm?.addEventListener('click', async ()=>{
    if(!addCajaId) return;
    addConfirm.disabled=true;
    if(addMsg) addMsg.textContent='Moviendo...';
    try {
      const r= await fetch('/operacion/add/move',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: addCajaId })});
      const j= await r.json();
      if(!j.ok){ if(addMsg) addMsg.textContent=j.error||'Error'; addConfirm.disabled=false; return; }
      if(addMsg) addMsg.textContent='Caja movida';
      addQueue = addQueue.filter(q=> q.id !== selectedCajaId);
      const nextId = addQueue[0]?.id || null;
      setSelectedCaja(nextId);
      if(!addQueue.length){ setTimeout(()=>{ try { modal.close(); } catch{} }, 600); }
      await load();
    } catch(e){ if(addMsg) addMsg.textContent='Error moviendo'; addConfirm.disabled=false; }
  });
  modal?.addEventListener('close', resetAdd);

  // Timer action handlers (delegated)
  // Se elimina listener de acciones de timer (solo lectura)

  // Bulk start timer replication (same lote)
  // Botón bulk ya no aplica; si existe en DOM lo deshabilitamos
  // Lógica bulk eliminada, no aplica

  // Init
  load(); startPolling();
})();


















