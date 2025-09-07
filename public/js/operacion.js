// Operación phase list view (similar style to acond) - polling + filter + timers per caja item rows
(function(){
  'use strict';
  const qs = s=>document.querySelector(s);
  const qsa = s=>Array.from(document.querySelectorAll(s));
  const tbody = qs('#op-tbody');
  const tbodyDone = qs('#op-tbody-done');
  const count = qs('#op-count');
  const countDone = qs('#op-count-done');
  const filterInput = qs('#op-filter');
  const btnAdd = qs('#op-btn-add');
  const btnAddDone = qs('#op-btn-add-done');
  const modal = document.getElementById('op-modal-add');
  const addScan = document.getElementById('op-add-scan');
  const addSummary = document.getElementById('op-add-summary');
  const addItemsWrap = document.getElementById('op-add-items');
  const addMsg = document.getElementById('op-add-msg');
  const addConfirm = document.getElementById('op-add-confirm');
  const addClear = document.getElementById('op-add-clear');
  const addHrs = document.getElementById('op-add-hrs');
  const addMin = document.getElementById('op-add-min');
  const bulkMsg = document.getElementById('op-bulk-msg');
  const bulkBtn = document.getElementById('op-bulk-start');
  const bulkHrs = document.getElementById('op-bulk-hrs');
  const bulkMin = document.getElementById('op-bulk-min');
  const countTic = document.getElementById('op-add-count-tic');
  const countVip = document.getElementById('op-add-count-vip');
  const countCube = document.getElementById('op-add-count-cube');
  let addCajaId = null;
  let addFirstScan = null; // first TIC to auto-group
  let addElegibles = []; // rfids elegibles de la caja
  let addRoles = []; // { rfid, rol }
  let dataCajas = []; // todas cajas (operación + completadas)
  let polling=null; let ticking=null; let serverOffset=0;

  function msRemaining(timer){ if(!timer||!timer.endsAt) return 0; return new Date(timer.endsAt).getTime() - (Date.now()+serverOffset); }
  function timerDisplay(rem){ if(rem<=0) return 'Finalizado'; const s=Math.max(0,Math.floor(rem/1000)); const m=Math.floor(s/60); return `${m}m ${s%60}s`; }
  function badgeClass(rem, completed){ if(completed) return 'badge-success'; if(rem<=0) return 'badge-warning'; if(rem<=60*1000) return 'badge-error'; if(rem<=5*60*1000) return 'badge-warning'; return 'badge-neutral'; }
  function controlButtonsHTML(caja){
    const id = caja.id;
    if(caja.estado==='Transito'){
      return `<button class="btn btn-ghost btn-xs" data-op-act="clear" data-caja="${id}" title="Reiniciar">⏹</button>`;
    }
    // Base (Operación) sin timer o estado Retorno permite iniciar nuevo ciclo
    return `<button class="btn btn-ghost btn-xs" data-op-act="start" data-caja="${id}" title="Iniciar">▶</button>`;
  }
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
        badge = `<span class="badge badge-xs ${badgeCls} gap-1" data-op-timer data-caja="${caja.id}">${timerTxt}</span> ${controlButtonsHTML(caja)}`;
      } else {
        badge = controlButtonsHTML(caja);
      }
    if(!comps.length){
      return `<tr data-caja-row="${caja.id}"><td class="font-mono text-[10px] opacity-50">(sin)</td><td class="hidden md:table-cell text-xs">-</td><td class="hidden lg:table-cell text-xs">${caja.estado}</td><td class="text-xs font-mono">${caja.codigoCaja}</td><td class="w-32">${badge}</td></tr>`;
    }
    return comps.map(it=> `<tr data-caja-row="${caja.id}">
      <td class="font-mono text-[10px]">${it.codigo}</td>
      <td class="hidden md:table-cell text-xs">${it.nombre||''}</td>
      <td class="hidden lg:table-cell text-xs">${caja.estado}</td>
      <td class="text-xs font-mono">${caja.codigoCaja}</td>
      <td class="w-32">${badge}</td>
    </tr>`).join('');
  }
  function render(){
    if(!tbody) return;
    const f = (filterInput?.value||'').trim().toLowerCase();
    const activos = dataCajas.filter(c=> c.estado!=='Completado');
    const completados = dataCajas.filter(c=> c.estado==='Completado');
    const filAct = f? activos.filter(c=> c.codigoCaja.toLowerCase().includes(f) || (c.componentes||[]).some(it=> it.codigo.toLowerCase().includes(f)) ): activos;
  tbody.innerHTML = filAct.length? filAct.map(c=> rowHTML(c)).join('') : `<tr><td colspan="5" class="text-center py-6 text-xs opacity-50">Sin resultados</td></tr>`;
    if(count) count.textContent = `(${filAct.reduce((a,c)=> a + (c.componentes||[]).length,0)} de ${activos.reduce((a,c)=> a + (c.componentes||[]).length,0)})`;
    if(tbodyDone){
      tbodyDone.innerHTML = completados.length? completados.map(c=>{
        const total = (c.componentes||[]).length;
        const finished = c.timer?.endsAt || '-';
        return `<tr><td class="font-mono text-[10px]">${c.codigoCaja}</td><td class="text-xs">${finished? new Date(finished).toLocaleString(): '-'}</td><td class="text-xs">${total}</td></tr>`;
      }).join('') : `<tr><td colspan="3" class="text-center py-6 text-xs opacity-50">Sin datos</td></tr>`;
      if(countDone) countDone.textContent = `(${completados.length})`;
    }
  }
  function ensureTick(){ if(ticking) return; ticking = setInterval(()=>{
    qsa('[data-op-timer]').forEach(b=>{
      const cid = b.getAttribute('data-caja');
      const caja = dataCajas.find(c=> String(c.id)===String(cid));
      if(!caja || !caja.timer) return; const rem = msRemaining(caja.timer); b.textContent = timerDisplay(rem); b.className = `badge badge-xs ${badgeClass(rem, !!caja.timer.completedAt)}`;
    });
  },1000); }

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
  filterInput?.addEventListener('input', render);
  function openAddModal(){ try { modal.showModal(); } catch{ modal.classList.remove('hidden'); } resetAdd(); setTimeout(()=> addScan?.focus(), 40); }
  btnAdd?.addEventListener('click', openAddModal);
  btnAddDone?.addEventListener('click', openAddModal);
  function resetAdd(){ addCajaId=null; addElegibles=[]; addRoles=[]; addFirstScan=null; if(addScan) addScan.value=''; if(addItemsWrap) addItemsWrap.innerHTML=''; if(addSummary) addSummary.classList.add('hidden'); if(addMsg) addMsg.textContent=''; if(addConfirm) addConfirm.disabled=true; updateCounts(); if(addHrs) addHrs.value=''; if(addMin) addMin.value=''; }
  function updateCounts(){ const t=addRoles.filter(r=>r.rol==='tic').length; const v=addRoles.filter(r=>r.rol==='vip').length; const c=addRoles.filter(r=>r.rol==='cube').length; if(countTic) countTic.textContent=t; if(countVip) countVip.textContent=v; if(countCube) countCube.textContent=c; const dur=(Number(addHrs?.value||0)*3600)+(Number(addMin?.value||0)*60); const complete = t===6 && v===1 && c===1 && dur>0; addConfirm.disabled = !complete; }
  async function lookupAdd(code){
    if(!code) return; if(addMsg) addMsg.textContent='Buscando...';
    try {
  const r= await fetch('/operacion/add/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code })});
      const j = await r.json();
      if(!j.ok){ if(addMsg) addMsg.textContent=j.error||'Error'; addCajaId=null; return; }
      addCajaId = j.caja_id;
      // Backend ya filtra solo sub_estado 'Lista para Despacho'
      addRoles = Array.isArray(j.roles)? j.roles.slice(): [];
      if(addSummary) addSummary.classList.remove('hidden');
      if(addItemsWrap){
        addItemsWrap.innerHTML = addRoles.map(ro=>`<span class='badge badge-outline badge-xs font-mono' data-rfid='${ro.rfid}' data-rol='${ro.rol}'>${ro.rol.toUpperCase()} · ${ro.rfid}</span>`).join('');
      }
      if(addMsg) addMsg.textContent = `Caja ${j.lote} detectada (${addRoles.length} items en Lista para Despacho)`;
      updateCounts();
    } catch(e){ if(addMsg) addMsg.textContent='Error'; }
  }
  addScan?.addEventListener('input', ()=>{ const v=addScan.value.trim(); if(v.length===24 || /^CAJA\d+-\d{8}$/i.test(v)) { lookupAdd(v); addScan.select(); } });
  addScan?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); const v=addScan.value.trim(); if(v) lookupAdd(v); }});
  addHrs?.addEventListener('input', updateCounts); addMin?.addEventListener('input', updateCounts);
  addClear?.addEventListener('click', resetAdd);
  addConfirm?.addEventListener('click', async ()=>{ if(!addCajaId) return; const dur=(Number(addHrs?.value||0)*3600)+(Number(addMin?.value||0)*60); if(dur<=0) return; addConfirm.disabled=true; if(addMsg) addMsg.textContent='Moviendo...'; try { const r= await fetch('/operacion/add/move',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: addCajaId })}); const j= await r.json(); if(!j.ok){ if(addMsg) addMsg.textContent=j.error||'Error'; addConfirm.disabled=false; return; } if(addMsg) addMsg.textContent='Caja movida'; await load(); setTimeout(()=>{ try { modal.close(); } catch{} }, 600); } catch(e){ if(addMsg) addMsg.textContent='Error moviendo'; addConfirm.disabled=false; } });
  modal?.addEventListener('close', resetAdd);

  // Timer action handlers (delegated)
  document.addEventListener('click', async (e)=>{
    const t = e.target; if(!(t instanceof HTMLElement)) return;
    const btn = t.closest('[data-op-act]'); if(!btn) return;
    const act = btn.getAttribute('data-op-act'); const cid = btn.getAttribute('data-caja'); if(!cid) return;
    try {
      if(act==='start'){
        let mins = prompt('Duración (minutos):','30'); if(mins==null) return; const m = Number(mins.trim()); if(!Number.isFinite(m)||m<=0) return;
  const res = await fetch('/operacion/caja/timer/start',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: cid, durationSec: m*60 })});
        await res.json();
      } else if(act==='clear'){
        if(!confirm('Reiniciar cronómetro?')) return;
  await fetch('/operacion/caja/timer/clear',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: cid })});
      } else if(act==='complete'){
  await fetch('/operacion/caja/timer/complete',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: cid })});
      }
      await load();
    } catch(err){ console.error('[Operación] timer action error', err); }
  });

  // Bulk start timer replication (same lote)
  bulkBtn?.addEventListener('click', async ()=>{
    const sel = dataCajas.find(c=> c.estado==='Operación' && c.timer==null); // pick first without timer
    const hrs = Number(bulkHrs?.value||0); const mins = Number(bulkMin?.value||0);
    const dur = (hrs*3600)+(mins*60);
    if(!sel){ if(bulkMsg) bulkMsg.textContent='No hay caja sin cronómetro'; return; }
    if(dur<=0){ if(bulkMsg) bulkMsg.textContent='Duración inválida'; return; }
    bulkBtn.disabled=true; if(bulkMsg) bulkMsg.textContent='Iniciando...';
    try {
  const r = await fetch('/operacion/caja/timer/start-bulk',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: sel.id, durationSec: dur })});
      const j = await r.json();
      if(!j.ok){ if(bulkMsg) bulkMsg.textContent=j.error||'Error'; bulkBtn.disabled=false; return; }
      if(bulkMsg) bulkMsg.textContent=`Timers iniciados (${j.cajas})`;
      await load();
    } catch(e){ if(bulkMsg) bulkMsg.textContent='Error'; }
    finally { bulkBtn.disabled=false; }
  });

  // Init
  load(); startPolling();
})();
