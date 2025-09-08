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
  // Confirm dialog
  const confirmDlg = qs('#dev-confirm');
  const confirmYes = qs('#dev-confirm-yes');
  const confirmNo = qs('#dev-confirm-no');
  const confirmMsg = qs('#dev-confirm-msg');
  let confirmCajaId = null; let confirmFromModal = false;
  let modalCajaId = null;
  let data = { cajas: [], serverNow: null };
  let serverOffset = 0; // serverNow - Date.now()
  let tick = null; let poll = null;

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
  return `<div class='caja-card rounded-lg border border-base-300/40 bg-base-200/10 p-3 flex flex-col gap-2 hover:border-primary/60 transition cursor-pointer' data-caja-id='${caja.id}'>
      <div class='flex items-center justify-between text-[10px] tracking-wide uppercase opacity-60'><span>Caja</span><span class='font-mono'>${caja.codigoCaja||''}</span></div>
      <div class='font-semibold text-xs leading-tight break-all pr-2' title='${caja.codigoCaja||''}'>${caja.codigoCaja||''}</div>
      <div class='flex flex-wrap gap-1 text-[9px] flex-1'>${compBadges || "<span class='badge badge-ghost badge-xs'>Sin items</span>"}</div>
      <div class='h-1.5 w-full bg-base-300/30 rounded-full overflow-hidden'>
        <div class='h-full bg-gradient-to-r from-primary via-primary to-primary/70' style='width:${progress.toFixed(1)}%' data-dev-caja-bar='${caja.id}'></div>
      </div>
      <div class='flex items-center justify-between text-[10px] font-mono opacity-70'>
        <span class='inline-flex items-center gap-1'>${timerBadge}</span>
        <button class='btn btn-ghost btn-[6px] btn-xs text-error' data-return-caja='${caja.id}' title='Devolver a Bodega'>↩</button>
      </div>
    </div>`;
  }
  function render(){
    if(!grid) return; const cajas = data.cajas||[];
    if(!cajas.length){ grid.innerHTML = `<div class='col-span-full py-10 text-center text-xs opacity-60'>Sin cajas en Operación</div>`; return; }
    grid.innerHTML = cajas.map(c=> cardHTML(c)).join('');
  }
  async function load(){
    try { spin?.classList.remove('hidden');
      const r = await fetch('/operacion/devolucion/data');
      const j = await r.json();
      if(j.ok){ data = j; if(j.serverNow){ serverOffset = new Date(j.serverNow).getTime() - Date.now(); } }
      else { data = { cajas:[], serverNow:null }; }
      render(); ensureTick();
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
    const btn = target ? target.closest('[data-return-caja]') : null;
  if(btn){ const id = btn.getAttribute('data-return-caja'); if(id){ openConfirm(id, false); } }
  const card = target ? target.closest('.caja-card') : null;
  if(card && card.getAttribute('data-caja-id')){ openModal(card.getAttribute('data-caja-id')); }
  });

  // ---- Scan / Identificar Caja ----
  function inferTipo(nombre){ const n=(nombre||'').toLowerCase(); if(n.includes('vip')) return 'vip'; if(n.includes('tic')) return 'tic'; if(n.includes('cube')||n.includes('cubo')) return 'cube'; return 'otro'; }
  function miniCardHTML(c){
    return `<div class='text-xs'>
      <div class='flex items-center justify-between text-[10px] uppercase opacity-60 mb-1'><span>Caja</span><span class='font-mono'>${c.codigoCaja||''}</span></div>
      <div class='font-semibold text-[11px] break-all mb-2'>${c.codigoCaja||''}</div>
      <div class='flex flex-wrap gap-1 mb-2'>${(c.componentes||[]).map(it=>{ let cls='badge-ghost'; if(it.tipo==='vip') cls='badge-info'; else if(it.tipo==='tic') cls='badge-warning'; else if(it.tipo==='cube') cls='badge-accent'; return `<span class='badge ${cls} badge-xs'>${(it.tipo||'').toUpperCase()}</span>`; }).join('') || "<span class='badge badge-ghost badge-xs'>Sin items</span>"}</div>
      <div class='text-[10px] font-mono opacity-70'>${c.timer? (c.timer.completedAt? 'Listo' : 'Cronómetro activo') : 'Sin cronómetro'}</div>
      <div class='mt-2'><button class='btn btn-xs btn-error btn-outline w-full' data-return-caja='${c.id}'>↩ Devolver a Bodega</button></div>
    </div>`;
  }
  async function lookupCaja(code){
    if(scanMsg) scanMsg.textContent='Buscando...'; if(scanResult) scanResult.classList.add('hidden');
    try {
      const r = await fetch('/operacion/caja/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code })});
      const j = await r.json();
      if(!j.ok){ if(scanMsg) scanMsg.textContent = j.error || 'No encontrado'; return; }
      const cajaId = j.caja.id;
      let caja = (data.cajas||[]).find(c=> String(c.id)===String(cajaId));
      if(!caja){
        caja = { id: cajaId, codigoCaja: j.caja.lote, timer: j.caja.timer? { startsAt: j.caja.timer.startsAt, endsAt: j.caja.timer.endsAt, completedAt: j.caja.timer.active===false? j.caja.timer.endsAt:null }: null, componentes: (j.caja.items||[]).map(it=> ({ codigo: it.rfid, tipo: inferTipo(it.nombre_modelo||it.nombre||'') })) };
      }
      if(scanCardBox) scanCardBox.innerHTML = miniCardHTML(caja);
      if(scanExtra) scanExtra.textContent = `Items: ${(caja.componentes||[]).length} · ID ${caja.id}`;
      if(scanResult) scanResult.classList.remove('hidden');
      if(scanMsg) scanMsg.textContent='';
    } catch(e){ if(scanMsg) scanMsg.textContent='Error'; }
  }
  function triggerLookup(){ if(!scanInput) return; const val = (scanInput.value||'').trim(); if(!val){ if(scanMsg) scanMsg.textContent='Ingresa RFID'; return; } if(val.length!==24){ if(scanMsg) scanMsg.textContent='Debe tener 24 caracteres'; return; } lookupCaja(val); }
  scanBtn?.addEventListener('click', triggerLookup);
  scanClear?.addEventListener('click', ()=>{ if(scanInput) scanInput.value=''; if(scanMsg) scanMsg.textContent=''; if(scanResult) scanResult.classList.add('hidden'); scanInput?.focus(); });
  scanInput?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); triggerLookup(); }});
  // Forzar máximo 24 y auto buscar al completar
  scanInput?.addEventListener('input', ()=>{ if(!scanInput) return; if(scanInput.value.length>24) scanInput.value = scanInput.value.slice(0,24); if(scanInput.value.length===24){ triggerLookup(); }});
  scanInput && setTimeout(()=> scanInput.focus(), 500);

  // ---- Modal ----
  function openModal(id){
    const caja = (data.cajas||[]).find(c=> String(c.id)===String(id));
    if(!caja) return;
    modalCajaId = caja.id;
    if(modalTitle) modalTitle.textContent = caja.codigoCaja || 'Caja';
    if(modalBody){
      const comps = caja.componentes||[];
      const timerTxt = caja.timer? (caja.timer.completedAt? 'Listo' : timerDisplay(msRemaining(caja.timer))) : 'Sin cronómetro';
      const pct = progressPct(caja.timer);
      modalBody.innerHTML = `
        <div class='space-y-2'>
          <div class='text-[11px] font-mono break-all'>${caja.codigoCaja||''}</div>
          <div class='flex flex-wrap gap-1'>${comps.map(it=>{ let cls='badge-ghost'; if(it.tipo==='vip') cls='badge-info'; else if(it.tipo==='tic') cls='badge-warning'; else if(it.tipo==='cube') cls='badge-accent'; return `<span class='badge ${cls} badge-xs'>${(it.tipo||'').toUpperCase()}</span>`; }).join('') || "<span class='badge badge-ghost badge-xs'>Sin items</span>"}</div>
          <div class='space-y-1'>
            <div class='flex items-center justify-between text-[10px] font-mono'><span>Cronómetro</span><span id='dev-modal-timer'>${timerTxt}</span></div>
            <div class='h-1.5 bg-base-300/30 rounded-full overflow-hidden'><div class='h-full bg-primary' style='width:${pct.toFixed(1)}%' id='dev-modal-bar'></div></div>
          </div>
        </div>`;
    }
    try { modal.showModal(); } catch { modal.classList.remove('hidden'); }
  }
  function updateModalTimer(){ if(!modalCajaId) return; const caja = (data.cajas||[]).find(c=> String(c.id)===String(modalCajaId)); if(!caja||!caja.timer) return; const span=document.getElementById('dev-modal-timer'); const bar=document.getElementById('dev-modal-bar'); if(span){ span.textContent = caja.timer.completedAt? 'Listo' : timerDisplay(msRemaining(caja.timer)); } if(bar && caja.timer.startsAt && caja.timer.endsAt){ bar.style.width = progressPct(caja.timer).toFixed(1)+'%'; } }
  modalReturn?.addEventListener('click', ()=>{ if(!modalCajaId) return; openConfirm(modalCajaId, true); });

  function openConfirm(id, fromModal){
    confirmCajaId = id; confirmFromModal = !!fromModal;
    if(confirmMsg) confirmMsg.textContent = '¿Devolver caja '+id+' a Bodega?';
    try { confirmDlg.showModal(); } catch { confirmDlg.classList.remove('hidden'); }
  }
  function doReturn(){ if(!confirmCajaId) return; const id = confirmCajaId; confirmYes?.setAttribute('disabled','true');
    fetch('/operacion/devolucion/caja/return',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: id })})
      .then(r=> r.json().catch(()=>({})))
      .then(()=>{
        if(confirmFromModal){ modalCajaId=null; try{ modal.close(); }catch{ modal.classList.add('hidden'); } }
        if(scanInput) scanInput.value='';
        if(scanMsg) scanMsg.textContent='';
        if(scanResult) scanResult.classList.add('hidden');
        if(scanCardBox) scanCardBox.innerHTML='';
        load();
      })
      .finally(()=>{ confirmYes?.removeAttribute('disabled'); confirmCajaId=null; confirmFromModal=false; try{ confirmDlg.close(); }catch{ confirmDlg.classList.add('hidden'); } });
  }
  confirmYes?.addEventListener('click', (e)=>{ e.preventDefault(); doReturn(); });
  confirmNo?.addEventListener('click', (e)=>{ e.preventDefault(); confirmCajaId=null; confirmFromModal=false; try{ confirmDlg.close(); }catch{ confirmDlg.classList.add('hidden'); } });
  modalClose?.addEventListener('click', ()=>{ modalCajaId=null; try{ modal.close(); }catch{ modal.classList.add('hidden'); } });
  // también cerrar al backdrop form (native dialog auto cierra)

  load(); startPolling();
  // Hook modal timer refresh
  setInterval(updateModalTimer, 1000);
})();
