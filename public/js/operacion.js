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
  const modal = document.getElementById('op-modal-add');
  const addScan = document.getElementById('op-add-scan');
  const addSummary = document.getElementById('op-add-summary');
  const addMsg = document.getElementById('op-add-msg');
  const addConfirm = document.getElementById('op-add-confirm');
  let addCajaId = null;
  let dataCajas = []; // todas cajas (operación + completadas)
  let polling=null; let ticking=null; let serverOffset=0;

  function msRemaining(timer){ if(!timer||!timer.endsAt) return 0; return new Date(timer.endsAt).getTime() - (Date.now()+serverOffset); }
  function timerDisplay(rem){ if(rem<=0) return 'Finalizado'; const s=Math.max(0,Math.floor(rem/1000)); const m=Math.floor(s/60); return `${m}m ${s%60}s`; }
  function badgeClass(rem, completed){ if(completed) return 'badge-success'; if(rem<=0) return 'badge-warning'; if(rem<=60*1000) return 'badge-error'; if(rem<=5*60*1000) return 'badge-warning'; return 'badge-neutral'; }
  function rowHTML(caja){
    const comps = caja.componentes||[];
    const timer = caja.timer;
    const remaining = timer? msRemaining(timer):0;
    const timerTxt = timer? timerDisplay(remaining): '-';
    const badge = timer? `<span class="badge badge-xs ${badgeClass(remaining, !!timer.completedAt)}" data-op-timer data-caja="${caja.id}">${timerTxt}</span>`:'<span class="badge badge-ghost badge-xs">-</span>';
    if(!comps.length){
      return `<tr data-caja-row="${caja.id}"><td class="font-mono text-[10px] opacity-50">(sin)</td><td class="hidden md:table-cell text-xs">-</td><td class="hidden lg:table-cell text-xs">${caja.estado}</td><td class="text-xs font-mono">${caja.codigoCaja}</td><td class="w-32">${badge}</td><td class="hidden md:table-cell text-xs">-</td></tr>`;
    }
    return comps.map(it=> `<tr data-caja-row="${caja.id}">
      <td class="font-mono text-[10px]">${it.codigo}</td>
      <td class="hidden md:table-cell text-xs">${it.nombre||''}</td>
      <td class="hidden lg:table-cell text-xs">${it.estado}</td>
      <td class="text-xs font-mono">${caja.codigoCaja}</td>
      <td class="w-32">${badge}</td>
      <td class="hidden md:table-cell text-xs uppercase">${it.tipo}</td>
    </tr>`).join('');
  }
  function render(){
    if(!tbody) return;
    const f = (filterInput?.value||'').trim().toLowerCase();
    const activos = dataCajas.filter(c=> c.estado!=='Completado');
    const completados = dataCajas.filter(c=> c.estado==='Completado');
    const filAct = f? activos.filter(c=> c.codigoCaja.toLowerCase().includes(f) || (c.componentes||[]).some(it=> it.codigo.toLowerCase().includes(f)) ): activos;
    tbody.innerHTML = filAct.length? filAct.map(c=> rowHTML(c)).join('') : `<tr><td colspan="6" class="text-center py-6 text-xs opacity-50">Sin resultados</td></tr>`;
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
      const r = await fetch('/operacion/operacion/data');
      const j = await r.json(); if(!j.ok) throw new Error(j.error||'Error');
      dataCajas = Array.isArray(j.cajas)? j.cajas:[];
      const serverNow = j.now? new Date(j.now).getTime():Date.now(); serverOffset = serverNow - Date.now();
      render(); ensureTick();
    } catch(e){ console.error('[Operación] load error', e); if(tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-error text-xs">Error cargando</td></tr>`; }
    finally { const spin = qs('#op-spin'); if(spin) spin.classList.add('hidden'); }
  }
  function startPolling(){ if(polling) clearInterval(polling); polling = setInterval(load, 10000); }

  // Events
  filterInput?.addEventListener('input', render);
  btnAdd?.addEventListener('click', ()=>{ try { modal.showModal(); } catch{ modal.classList.remove('hidden'); } resetAdd(); setTimeout(()=> addScan?.focus(), 40); });
  function resetAdd(){ addCajaId=null; if(addScan) addScan.value=''; if(addSummary){ addSummary.classList.add('hidden'); addSummary.innerHTML=''; } if(addMsg) addMsg.textContent=''; if(addConfirm) addConfirm.disabled=true; }
  async function lookupAdd(code){ if(!code) return; if(addMsg) addMsg.textContent='Buscando...'; try { const r= await fetch('/operacion/operacion/add/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code })}); const j = await r.json(); if(!j.ok) { if(addMsg) addMsg.textContent=j.error||'Error'; addCajaId=null; if(addConfirm) addConfirm.disabled=true; return; } addCajaId=j.caja_id; if(addSummary){ addSummary.innerHTML = `<div class='mb-1'><strong>Caja:</strong> ${j.lote} (#${j.caja_id})</div><div class='mb-1'>Items elegibles: ${j.elegibles.length} / ${j.total}</div><div class='grid grid-cols-2 gap-1 max-h-32 overflow-auto'>${j.elegibles.map(rf=>`<span class='badge badge-ghost badge-xs font-mono'>${rf}</span>`).join('')}</div>`; addSummary.classList.remove('hidden'); } if(addMsg) addMsg.textContent=''; if(addConfirm) addConfirm.disabled=false; } catch(e){ if(addMsg) addMsg.textContent='Error'; } }
  addScan?.addEventListener('input', ()=>{ const v=addScan.value.trim(); if(v.length===24 || /^CAJA\d+-\d{8}$/i.test(v)) lookupAdd(v); });
  addScan?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); const v=addScan.value.trim(); if(v) lookupAdd(v); }});
  addConfirm?.addEventListener('click', async ()=>{ if(!addCajaId) return; addConfirm.disabled=true; if(addMsg) addMsg.textContent='Moviendo...'; try { const r= await fetch('/operacion/operacion/add/move',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: addCajaId })}); const j= await r.json(); if(!j.ok){ if(addMsg) addMsg.textContent=j.error||'Error'; addConfirm.disabled=false; return; } if(addMsg) addMsg.textContent='Caja movida'; await load(); setTimeout(()=>{ try { modal.close(); } catch{} }, 600); } catch(e){ if(addMsg) addMsg.textContent='Error moviendo'; addConfirm.disabled=false; } });
  modal?.addEventListener('close', resetAdd);

  // Init
  load(); startPolling();
})();
