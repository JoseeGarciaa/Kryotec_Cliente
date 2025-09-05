// Pre Acondicionamiento UX (tipo "registro masivo")
(function(){
  const qs = (sel)=>document.querySelector(sel);
  const tableCongBody = qs('#tabla-cong tbody');
  const tableAtemBody = qs('#tabla-atem tbody');
  const countCong = qs('#count-cong');
  const countAtem = qs('#count-atem');
  const spinCong = qs('#spin-cong');
  const spinAtem = qs('#spin-atem');
  const timerCongEl = qs('#timer-cong');
  const timerAtemEl = qs('#timer-atem');

  // Modal elements
  const dlg = qs('#dlg-scan');
  const scanInput = qs('#scan-input');
  const chipsBox = qs('#chips');
  const msg = qs('#scan-msg');
  const btnConfirm = qs('#btn-confirm');
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
      render(tableCongBody, j.congelamiento, 'No hay TICs en congelamiento');
      render(tableAtemBody, j.atemperamiento, 'No hay TICs en atemperamiento');
      countCong.textContent = `(${j.congelamiento.length} de ${j.congelamiento.length})`;
      countAtem.textContent = `(${j.atemperamiento.length} de ${j.atemperamiento.length})`;
      setupSectionTimer('congelamiento', j.timers?.congelamiento || null);
      setupSectionTimer('atemperamiento', j.timers?.atemperamiento || null);
    }catch(e){ console.error(e); }
    finally{ setSpin('cong', false); setSpin('atem', false); }
  }

  function render(tbody, rows, emptyText){
    tbody.innerHTML = '';
    if(!rows || !rows.length){
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = 5; td.className = 'text-center py-10 opacity-70'; td.textContent = emptyText;
      tr.appendChild(td); tbody.appendChild(tr); return;
    }
    for(const r of rows){
      const tr = document.createElement('tr');
      const started = r.started_at ? new Date(r.started_at).getTime() : null;
      const tableId = (tbody.closest('table') && tbody.closest('table').id) || 'x';
      const timerId = `tm-${tableId}-${r.rfid}`;
      tr.innerHTML = `<td>${r.rfid}</td><td>${r.nombre_unidad||''}</td><td>${r.lote||''}</td><td>${r.estado||''}</td><td><span id="${timerId}">${started? '00:00:00' : ''}</span></td>`;
      if(started){
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
        const id = tr.getAttribute('data-timer-id');
        if(started && id){ const el = document.getElementById(id); if(el) el.textContent = fmt(now - started); }
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
    congelamiento: { startedAt: null, durationSec: 0, active: false },
    atemperamiento: { startedAt: null, durationSec: 0, active: false }
  };
  function setupSectionTimer(section, data){
    const t = sectionTimers[section];
    t.startedAt = data && data.started_at ? new Date(data.started_at).getTime() : null;
    t.durationSec = data && Number.isFinite(data.duration_sec) ? Number(data.duration_sec) : 0;
    t.active = !!(data && data.active);
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
    el.textContent = `⏱️ ${hh}:${mm}:${ss}`;
    if(remaining===0){ t.active=false; }
  }

  async function startSectionTimer(section){
    const minutesStr = prompt('Duración (minutos):');
    if(!minutesStr) return; const minutes = Number(minutesStr);
    if(!Number.isFinite(minutes) || minutes<=0) return;
    const durationSec = Math.round(minutes*60);
    await fetch('/operacion/preacond/timer/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ section, durationSec }) });
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
  document.querySelectorAll('[data-open-timer]')?.forEach((el)=>{
    el.addEventListener('click', ()=>{ const s=(el).getAttribute('data-open-timer'); startSectionTimer(s); });
  });
  document.querySelectorAll('[data-clear-timer]')?.forEach((el)=>{
    el.addEventListener('click', ()=>{ const s=(el).getAttribute('data-clear-timer'); clearSectionTimer(s); });
  });

  // Also primary buttons
  qs('#btn-add-cong')?.addEventListener('click', ()=>openModal('congelamiento'));
  qs('#btn-add-atem')?.addEventListener('click', ()=>openModal('atemperamiento'));

  loadData();
})();
