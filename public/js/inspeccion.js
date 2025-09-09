// Inspección: listar cajas en estado Inspección con mismo diseño de tarjetas
(function(){
  'use strict';
  const qs = (s)=> document.querySelector(s);
  const grid = qs('#insp-caja-grid');
  const spin = qs('#insp-spin');
  const state = { cajas: [], serverOffset: 0, cajaSel: null, tics: [], ticChecks: new Map(), activeTic: null };

  function msElapsed(timer){ if(!timer||!timer.startsAt) return 0; return (Date.now()+state.serverOffset) - new Date(timer.startsAt).getTime(); }
  function timerDisplay(ms){ const s=Math.max(0,Math.floor(ms/1000)); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const sec=s%60; return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }

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
      if(el) el.textContent = timerDisplay(msElapsed(c.timer));
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
  const list = qs('#insp-tic-list');
  const completeBtn = qs('#insp-complete');
  // TIC scan elements
  const ticScan = qs('#insp-tic-scan');
  const ticScanBtn = qs('#insp-tic-scan-btn');
  const ticScanClear = qs('#insp-tic-scan-clear');
  const ticMsg = qs('#insp-tic-msg');

  function renderChecklist(){
    if(!panel||!list) return;
    panel.classList.remove('hidden');
    panelLote && (panelLote.textContent = state.cajaSel?.lote || '—');
    panelCount && (panelCount.textContent = String(state.tics.length||0));
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

  async function lookupCaja(){
    const code = (scanInput?.value||'').trim();
    if(code.length!==24){ scanMsg && (scanMsg.textContent='RFID inválido'); return; }
    try {
      scanMsg && (scanMsg.textContent='Buscando...');
      const r = await fetch('/operacion/inspeccion/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfid: code })});
      const j = await r.json();
      if(!j.ok){ scanMsg && (scanMsg.textContent=j.error||'No encontrado'); return; }
  state.cajaSel = j.caja; state.tics = j.tics||[]; state.ticChecks = new Map(); state.activeTic = null;
      renderChecklist();
      scanMsg && (scanMsg.textContent='');
    } catch(e){ scanMsg && (scanMsg.textContent='Error'); }
  }

  function updateCompleteBtn(){
    const all = (state.tics||[]).length===6 && (state.tics||[]).every(t=>{
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
})();
