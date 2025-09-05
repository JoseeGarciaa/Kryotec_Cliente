// Pre Acondicionamiento UX (tipo "registro masivo")
(function(){
  const qs = (sel)=>document.querySelector(sel);
  const tableCongBody = qs('#tabla-cong tbody');
  const tableAtemBody = qs('#tabla-atem tbody');
  const countCong = qs('#count-cong');
  const countAtem = qs('#count-atem');
  const qtyCongEl = qs('#qty-cong');
  const qtyAtemEl = qs('#qty-atem');
  const spinCong = qs('#spin-cong');
  const spinAtem = qs('#spin-atem');
  const timerCongEl = qs('#timer-cong');
  const timerAtemEl = qs('#timer-atem');
  const searchCong = qs('#search-cong');
  const searchAtem = qs('#search-atem');

  // Modal elements
  const dlg = qs('#dlg-scan');
  const scanInput = qs('#scan-input');
  const chipsBox = qs('#chips');
  const msg = qs('#scan-msg');
  const btnConfirm = qs('#btn-confirm');

  // Group timer modal elements
  const gDlg = qs('#dlg-gtimer');
  const gLote = qs('#gtimer-lote');
  const gMin = qs('#gtimer-min');
  const gMsg = qs('#gtimer-msg');
  const gConfirm = qs('#gtimer-confirm');
  const gSectionLabel = qs('#gtimer-section-label');
  const gCount = qs('#gtimer-count');
  // We'll reuse group timer modal for per-item start
  let pendingItemStart = null; // { section, rfid }

  let currentSectionForModal = 'congelamiento';
  let target = 'congelamiento';
  let rfids = [];
  let invalid = [];
  let valid = [];

  function setSpin(which, on){
    const el = which === 'cong' ? spinCong : spinAtem;
    if(!el) return;
    el.classList.toggle('hidden', !on);
  }

  let serverNowOffsetMs = 0; // client_now - server_now to keep sync
  function fmt(ms){
    const s = Math.max(0, Math.floor(ms/1000));
    const hh = String(Math.floor(s/3600)).padStart(2,'0');
    const mm = String(Math.floor((s%3600)/60)).padStart(2,'0');
    const ss = String(s%60).padStart(2,'0');
    return `${hh}:${mm}:${ss}`;
  }

  async function loadData(){
    try{
      setSpin('cong', true); setSpin('atem', true);
      const r = await fetch('/operacion/preacond/data', { headers: { 'Accept':'application/json' } });
      const j = await r.json();
      const serverNow = new Date(j.now).getTime();
      serverNowOffsetMs = Date.now() - serverNow;
  render(tableCongBody, j.congelamiento, 'No hay TICs en congelamiento', 'congelamiento');
  render(tableAtemBody, j.atemperamiento, 'No hay TICs en atemperamiento', 'atemperamiento');
  const nCong = j.congelamiento.length;
  const nAtem = j.atemperamiento.length;
  countCong.textContent = `(${nCong} de ${nCong})`;
  countAtem.textContent = `(${nAtem} de ${nAtem})`;
  if(qtyCongEl) qtyCongEl.textContent = String(nCong);
  if(qtyAtemEl) qtyAtemEl.textContent = String(nAtem);
      setupSectionTimer('congelamiento', j.timers?.congelamiento || null);
      setupSectionTimer('atemperamiento', j.timers?.atemperamiento || null);
    }catch(e){ console.error(e); }
    finally{ setSpin('cong', false); setSpin('atem', false); }
  }

  function render(tbody, rows, emptyText, section){
    tbody.innerHTML = '';
    if(!rows || !rows.length){
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = 5; td.className = 'text-center py-10 opacity-70'; td.textContent = emptyText;
      tr.appendChild(td); tbody.appendChild(tr); return;
    }
    for(const r of rows){
      const tr = document.createElement('tr');
  const started = r.started_at ? new Date(r.started_at).getTime() : null;
      const duration = Number(r.duration_sec)||0;
      const active = !!r.item_active && !!started && duration>0;
      const tableId = (tbody.closest('table') && tbody.closest('table').id) || 'x';
      const timerId = `tm-${tableId}-${r.rfid}`;
      const isCompleted = /Congelado|Atemperado/i.test(r.sub_estado||'');
      if(isCompleted){ tr.classList.add('bg-info/10'); }
      const controls = active
        ? `<button class="btn btn-ghost btn-xs text-error" title="Detener" data-item-clear="${r.rfid}" data-section="${section}">
             <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
           </button>`
        : `<button class="btn btn-ghost btn-xs text-success" title="Iniciar" data-item-start="${r.rfid}" data-section="${section}">
             <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
           </button>`;
      const loteVal = r.item_lote || r.lote || '';
      const lotePill = loteVal ? `<span class="badge badge-ghost badge-xs sm:badge-sm whitespace-nowrap">L: ${loteVal}</span>` : '';
      tr.innerHTML = `<td>${r.rfid}</td><td class="hidden md:table-cell">${r.nombre_unidad||''}</td><td class="hidden lg:table-cell">${r.lote||r.item_lote||''}</td><td class="hidden md:table-cell">${r.estado||''}</td>
        <td class="flex flex-wrap items-center gap-1 sm:gap-2">
          <span class="badge ${isCompleted?'badge-info':'badge-neutral'} badge-sm" data-threshold="1"><span id="${timerId}">${active? '00:00:00' : ''}</span></span>
          ${lotePill}
          ${controls}
        </td>`;
      if(active){
        tr.setAttribute('data-item-duration', String(duration));
        tr.setAttribute('data-timer-started', String(started));
        tr.setAttribute('data-timer-id', timerId);
      }
      tbody.appendChild(tr);
    }
    // ensure ticking is running
    startGlobalTick();
  }

  let ticking = false, rafId = 0;
  function startGlobalTick(){
    if(ticking) return; ticking = true;
    const step = ()=>{
      const now = Date.now() - serverNowOffsetMs;
      document.querySelectorAll('tr[data-timer-started]').forEach((tr)=>{
        const started = Number(tr.getAttribute('data-timer-started')||'');
        const duration = Number(tr.getAttribute('data-item-duration')||'0');
        const id = tr.getAttribute('data-timer-id');
        if(started && id){
          const el = document.getElementById(id);
          if(el){
            if(duration>0){
              const remaining = Math.max(0, duration - Math.floor((now - started)/1000));
              el.textContent = fmt(remaining*1000);
              const badge = el.closest('.badge');
              if(badge){
                badge.classList.toggle('badge-info', remaining===0);
                const warn = remaining>0 && remaining<=300; // <=5m
                const danger = remaining>0 && remaining<=60; // <=1m
                badge.classList.toggle('badge-warning', warn && !danger);
                badge.classList.toggle('badge-error', danger);
                // neutral when not info/warn/danger
                const neutral = remaining>300;
                badge.classList.toggle('badge-neutral', neutral);
              }
              if(remaining===0 && !tr.getAttribute('data-done')){
                tr.setAttribute('data-done','1');
                const rfid = tr.querySelector('td')?.textContent?.trim();
                const tableId = tr.closest('table')?.id || '';
                const section = tableId==='tabla-cong' ? 'congelamiento' : 'atemperamiento';
                if(rfid){
                  fetch('/operacion/preacond/item-timer/complete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ section, rfid }) })
                    .then(()=>loadData());
                }
              }
            } else {
              el.textContent = fmt(now - started);
            }
          }
        }
      });
      // Update section timers
      updateSectionTimer(now, 'congelamiento');
      updateSectionTimer(now, 'atemperamiento');
      rafId = requestAnimationFrame(step);
    };
    step();
  }

  // Section Timers (global per section)
  const sectionTimers = {
    congelamiento: { startedAt: null, durationSec: 0, active: false, lote: '' },
    atemperamiento: { startedAt: null, durationSec: 0, active: false, lote: '' }
  };
  function setupSectionTimer(section, data){
    const t = sectionTimers[section];
    t.startedAt = data && data.started_at ? new Date(data.started_at).getTime() : null;
    t.durationSec = data && Number.isFinite(data.duration_sec) ? Number(data.duration_sec) : 0;
    t.active = !!(data && data.active);
    t.lote = data && data.lote ? String(data.lote) : '';
  }
  function sectionEl(section){ return section==='congelamiento' ? timerCongEl : timerAtemEl; }
  function updateSectionTimer(now, section){
    const t = sectionTimers[section]; const el = sectionEl(section); if(!el) return;
    if(!t.active || !t.startedAt || !t.durationSec){ el.textContent=''; return; }
    const elapsed = Math.floor((now - t.startedAt)/1000);
    const remaining = Math.max(0, t.durationSec - elapsed);
    const hh = String(Math.floor(remaining/3600)).padStart(2,'0');
    const mm = String(Math.floor((remaining%3600)/60)).padStart(2,'0');
    const ss = String(remaining%60).padStart(2,'0');
    el.textContent = `⏱️ ${hh}:${mm}:${ss}${t.lote?` • Lote: ${t.lote}`:''}`;
    if(remaining===0){
      if(t.active){
        t.active=false;
        fetch('/operacion/preacond/timer/complete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ section }) })
          .then(()=>loadData());
      }
    }
  }

  async function startSectionTimer(section, lote, minutes, rfids){
    const durationSec = Math.round(minutes*60);
    await fetch('/operacion/preacond/timer/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ section, durationSec, lote, rfids }) });
    await loadData();
  }
  async function clearSectionTimer(section){
    await fetch('/operacion/preacond/timer/clear', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ section }) });
    await loadData();
  }

  function openModal(toTarget){
    target = toTarget;
    rfids = []; invalid = []; valid = [];
    chipsBox.innerHTML=''; msg.textContent='';
    btnConfirm.disabled = true;
    dlg?.showModal?.();
    setTimeout(()=>scanInput?.focus?.(), 50);
  }

  function renderChips(){
    const items = rfids.map(code=>{
      const isInvalid = invalid.some(x=>x.rfid===code);
      const isOk = valid.includes(code);
      const cls = isInvalid ? 'badge badge-error gap-2' : (isOk ? 'badge badge-success gap-2' : 'badge badge-outline gap-2');
      const status = isInvalid ? '<div class="text-[10px] text-error">inválido</div>' : (isOk ? '<div class="text-[10px] text-success">ok</div>' : '');
      return `<div class="inline-flex flex-col items-center">
                <span class="${cls}">${code}<button type="button" class="btn btn-ghost btn-xs" data-remove="${code}">✕</button></span>
                ${status}
              </div>`;
    }).join('');
    chipsBox.innerHTML = items || '<div class="opacity-60 text-sm">Sin RFIDs</div>';
    btnConfirm.disabled = valid.length === 0;
  }

  function addCode(chunk){
    if(chunk && chunk.length===24 && !rfids.includes(chunk)) rfids.push(chunk);
  }

  function processBuffer(raw){
    let v = (raw||'').replace(/\s+/g,'');
    while(v.length>=24){ const c=v.slice(0,24); addCode(c); v=v.slice(24); }
    return v;
  }

  async function validate(){
    if(!rfids.length){ invalid=[]; valid=[]; renderChips(); return; }
    try{
      const r = await fetch('/operacion/preacond/validate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ target, rfids }) });
      const j = await r.json();
      invalid = Array.isArray(j.invalid)? j.invalid : [];
      valid = Array.isArray(j.valid)? j.valid : [];
      renderChips();
      msg.textContent = invalid.length ? 'Elimine o corrija los RFIDs inválidos.' : '';
    }catch{ /* keep state */ }
  }

  // Input handlers
  scanInput?.addEventListener('input', ()=>{ scanInput.value = processBuffer(scanInput.value); validate(); });
  scanInput?.addEventListener('paste', (e)=>{ const t=e.clipboardData?.getData('text')||''; if(t){ e.preventDefault(); scanInput.value = processBuffer(t); validate(); } });

  chipsBox?.addEventListener('click', (e)=>{
    const t = e.target; if(!(t instanceof Element)) return;
    const code = t.getAttribute('data-remove');
    if(code){ rfids = rfids.filter(x=>x!==code); valid = valid.filter(x=>x!==code); invalid = invalid.filter(x=>x.rfid!==code); renderChips(); validate(); }
  });

  btnConfirm?.addEventListener('click', async ()=>{
    if(!valid.length) return;
    const r = await fetch('/operacion/preacond/scan', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ target, rfids: valid }) });
    const j = await r.json().catch(()=>({ok:false}));
    if(!j.ok){ msg.textContent = 'Error al confirmar'; return; }
    dlg?.close?.();
    await loadData();
  });

  // Openers from dropdowns
  document.querySelectorAll('[data-open-scan]')?.forEach((el)=>{
    el.addEventListener('click', ()=>{ const to=(el).getAttribute('data-open-scan'); openModal(to==='atemperamiento'?'atemperamiento':'congelamiento'); });
  });
  // Old dropdown timer actions removed

  // New Start All / Clear All buttons
  qs('#btn-startall-cong')?.addEventListener('click', ()=>openGroupTimer('congelamiento'));
  qs('#btn-clearall-cong')?.addEventListener('click', ()=>clearSectionTimer('congelamiento'));
  qs('#btn-startall-atem')?.addEventListener('click', ()=>openGroupTimer('atemperamiento'));
  qs('#btn-clearall-atem')?.addEventListener('click', ()=>clearSectionTimer('atemperamiento'));

  function openGroupTimer(section){
    currentSectionForModal = section;
    if(gSectionLabel) gSectionLabel.textContent = section === 'congelamiento' ? 'Congelamiento' : 'Atemperamiento';
    const n = section==='congelamiento' ? (qtyCongEl?.textContent||'0') : (qtyAtemEl?.textContent||'0');
    if(gCount) gCount.textContent = n;
    if(gMsg) gMsg.textContent = '';
    if(gLote) gLote.value = '';
    if(gMin) gMin.value = '';
    gDlg?.showModal?.();
    setTimeout(()=>gLote?.focus?.(), 50);
  }

  gConfirm?.addEventListener('click', async ()=>{
    const lote = (gLote?.value||'').trim();
    const minutes = Number(gMin?.value||'');
    if(!lote || !Number.isFinite(minutes) || minutes<=0){ if(gMsg) gMsg.textContent='Completa lote y minutos.'; return; }
    if(pendingItemStart){
      const { section, rfid } = pendingItemStart;
      pendingItemStart = null;
      gDlg?.close?.();
      const durationSec = Math.round(minutes*60);
      await fetch('/operacion/preacond/item-timer/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ section, rfid, durationSec, lote }) });
      await loadData();
      return;
    }
    // Collect visible RFIDs in that section now
    const tbody = currentSectionForModal==='congelamiento' ? tableCongBody : tableAtemBody;
    const rfids = Array.from(tbody?.querySelectorAll('tr>td:first-child')||[]).map(td=>td.textContent?.trim()).filter(Boolean);
    gDlg?.close?.();
    await startSectionTimer(currentSectionForModal, lote, minutes, rfids);
  });

  // Item timer actions (event delegation on both tables)
  function onTableClick(e){
    const t = e.target; if(!(t instanceof Element)) return;
    const startR = t.closest('[data-item-start]');
    const clearR = t.closest('[data-item-clear]');
    if(startR){
      const rfid = startR.getAttribute('data-item-start');
      const section = startR.getAttribute('data-section');
      // Reuse modal for per-item
      pendingItemStart = { section, rfid };
      currentSectionForModal = section;
      if(gSectionLabel) gSectionLabel.textContent = '1 TIC seleccionado';
      if(gMsg) gMsg.textContent = '';
      if(gLote) gLote.value = '';
      if(gMin) gMin.value = '';
      gDlg?.showModal?.();
      setTimeout(()=>gLote?.focus?.(), 50);
    } else if(clearR){
      const rfid = clearR.getAttribute('data-item-clear');
      const section = clearR.getAttribute('data-section');
      fetch('/operacion/preacond/item-timer/clear', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ section, rfid }) })
        .then(()=>loadData());
    }
  }
  tableCongBody?.addEventListener('click', onTableClick);
  tableAtemBody?.addEventListener('click', onTableClick);

  // Also primary buttons
  qs('#btn-add-cong')?.addEventListener('click', ()=>openModal('congelamiento'));
  qs('#btn-add-atem')?.addEventListener('click', ()=>openModal('atemperamiento'));

  loadData();

  // Client-side filtering
  function applyFilter(inputEl, tbody, countEl){
    const q = (inputEl?.value||'').trim().toLowerCase();
    const trs = Array.from(tbody?.querySelectorAll('tr')||[]);
    let visible = 0, total = 0;
    trs.forEach(tr=>{
      const tds = tr.querySelectorAll('td');
      if(!tds || tds.length===1){
        // empty state row
        tr.style.display = q? 'none' : '';
        return;
      }
      total++;
      const hay = Array.from(tds).slice(0,4).map(td=>td.textContent||'').join(' ').toLowerCase();
      const show = !q || hay.includes(q);
      tr.style.display = show? '' : 'none';
      if(show) visible++;
    });
    if(countEl){
      const text = countEl.textContent||'';
      const m = text.match(/\((\d+) de (\d+)\)/);
      const totalCount = m? Number(m[2]) : total;
      countEl.textContent = `(${visible} de ${totalCount})`;
    }
  }
  searchCong?.addEventListener('input', ()=>applyFilter(searchCong, tableCongBody, countCong));
  searchAtem?.addEventListener('input', ()=>applyFilter(searchAtem, tableAtemBody, countAtem));
})();
