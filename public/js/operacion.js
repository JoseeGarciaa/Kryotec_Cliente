// Operación phase front-end: scan single caja (by lote code or any component RFID) to group items and manage manual timer
(function(){
  'use strict';
  const el = id=>document.getElementById(id);
  const scanInput = el('op-scan');
  const btnLookup = el('op-btn-lookup');
  const btnMove = el('op-btn-move');
  const btnTimerStart = el('op-btn-timer-start');
  const btnTimerClear = el('op-btn-timer-clear');
  const btnTimerComplete = el('op-btn-timer-complete');
  const tbody = el('op-tbody');
  const msg = el('op-msg');
  const cajaLote = el('op-caja-lote');
  const cajaIdEl = el('op-caja-id');
  const cajaEstado = el('op-caja-estado');
  const cajaTimer = el('op-caja-timer');
  const timerMin = el('op-timer-min');
  const count = el('op-count');
  let caja = null; // { id,lote,items[], allListo, allOperacion, timer }
  let ticking = null; let serverOffset=0;

  function setMsg(t, type){ if(msg){ msg.textContent=t||''; msg.className='mt-3 text-xs '+(type==='err'?'text-error':'opacity-80'); } }
  function renderItems(){
    if(!tbody) return;
    if(!caja){ tbody.innerHTML='<tr><td colspan="5" class="text-center py-6 text-xs opacity-50">Sin datos</td></tr>'; if(count) count.textContent='(0)'; return; }
    if(!caja.items || !caja.items.length){ tbody.innerHTML='<tr><td colspan="5" class="text-center py-6 text-xs opacity-50">Caja sin componentes</td></tr>'; if(count) count.textContent='(0)'; return; }
    tbody.innerHTML = caja.items.map(it=>`<tr class="hover" data-rfid="${it.rfid}">
        <td class="font-mono text-[10px]">${it.rfid}</td>
        <td class="hidden md:table-cell text-xs">${it.nombre_modelo||''}</td>
        <td class="hidden lg:table-cell text-xs">${it.estado}</td>
        <td class="uppercase text-xs">${it.rol}</td>
        <td class="text-xs">${it.sub_estado||''}</td>
      </tr>`).join('');
    if(count) count.textContent = `(${caja.items.length})`;
  }
  function updateMeta(){
    if(!caja){ cajaLote.textContent=''; cajaIdEl.textContent=''; cajaEstado.textContent=''; cajaTimer.textContent='--'; return; }
    cajaLote.textContent = caja.lote; cajaIdEl.textContent = caja.id; 
  cajaEstado.textContent = caja.allOperacion? 'Operación' : (caja.allListo ? 'Lista para Despacho' : 'Parcial');
    updateTimerBadge();
    // Buttons enabling
    btnMove.disabled = !caja.allListo; // only move if all items listos para despacho
    const t = caja.timer;
    if(!t || (!t.startsAt && !t.endsAt)){
      btnTimerStart.disabled=false; btnTimerClear.disabled=true; btnTimerComplete.disabled=true;
    } else {
      const now = Date.now();
      const start = t.startsAt? new Date(t.startsAt).getTime():0;
      const end = t.endsAt? new Date(t.endsAt).getTime():0;
      const remaining = end - now;
      if(remaining<=0){
        btnTimerStart.disabled=true; btnTimerClear.disabled=true; btnTimerComplete.disabled=false;
      } else {
        btnTimerStart.disabled=true; btnTimerClear.disabled=false; btnTimerComplete.disabled=true;
      }
    }
  }
  function timerDisplay(rem){ if(rem<=0) return 'Finalizado'; const s=Math.floor(rem/1000); const m=Math.floor(s/60); return `${m}m ${s%60}s`; }
  function updateTimerBadge(){
    if(!cajaTimer) return; const t = caja?.timer; if(!t){ cajaTimer.textContent='--'; cajaTimer.className='badge badge-ghost badge-xs'; return; }
    const start = t.startsAt? new Date(t.startsAt).getTime():0; const end = t.endsAt? new Date(t.endsAt).getTime():0; const now = Date.now();
    const rem = end - now; cajaTimer.textContent = timerDisplay(rem);
    cajaTimer.className='badge badge-xs ' + (rem<=0? 'badge-warning':'badge-info');
  }
  function ensureTick(){ if(ticking) return; ticking = setInterval(()=>{ if(caja && caja.timer) updateTimerBadge(); },1000); }

  async function lookup(val){
    val = (val||'').trim(); if(!val) return setMsg('Ingrese código', 'err');
    setMsg('Buscando...');
    try {
      const r = await fetch('/operacion/operacion/caja/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code: val })});
      const j = await r.json(); if(!j.ok) throw new Error(j.error||'Error lookup');
      caja = j.caja; renderItems(); updateMeta(); ensureTick(); setMsg('Caja cargada');
    } catch(e){ caja=null; renderItems(); updateMeta(); setMsg(e.message||'Error', 'err'); }
  }
  async function moveCaja(){ if(!caja) return; setMsg('Moviendo...'); try { const r = await fetch('/operacion/operacion/caja/move',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code: caja.lote })}); const j = await r.json(); if(!j.ok) throw new Error(j.error||'Error'); await lookup(caja.lote); setMsg('Caja movida a Operación'); } catch(e){ setMsg(e.message||'Error', 'err'); } }
  function askDuration(){ let m = prompt('Duración (minutos):','30'); if(m==null) return null; const n=Number(m); if(!Number.isFinite(n)||n<=0) return null; return Math.round(n*60); }
  async function timerAction(kind){ if(!caja) return; try { let endpoint=''; let payload={ caja_id: caja.id }; if(kind==='start'){ endpoint='/operacion/operacion/caja/timer/start'; let mins = Number(timerMin?.value||'0'); if(!mins){ const sec = askDuration(); if(sec==null) return; payload['durationSec']=sec; } else { payload['durationSec']=mins*60; } } else if(kind==='clear'){ endpoint='/operacion/operacion/caja/timer/clear'; } else if(kind==='complete'){ endpoint='/operacion/operacion/caja/timer/complete'; }
    if(!endpoint) return; setMsg('Actualizando timer...');
    const r = await fetch(endpoint,{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)}); const j = await r.json(); if(!j.ok) throw new Error(j.error||'Error timer'); await lookup(caja.lote); setMsg('Timer actualizado'); } catch(e){ setMsg(e.message||'Error timer','err'); } }

  // Events
  btnLookup?.addEventListener('click',()=> lookup(scanInput?.value));
  scanInput?.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); lookup(scanInput.value); }});
  btnMove?.addEventListener('click', moveCaja);
  btnTimerStart?.addEventListener('click', ()=> timerAction('start'));
  btnTimerClear?.addEventListener('click', ()=> timerAction('clear'));
  btnTimerComplete?.addEventListener('click', ()=> timerAction('complete'));

})();
