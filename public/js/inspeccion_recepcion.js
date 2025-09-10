(function(){
  'use strict';
  const qs = (s)=> document.querySelector(s);
  const grid = qs('#insp-rec-caja-grid');
  const spin = qs('#insp-rec-spin');
  const scan = qs('#insp-rec-scan');
  const h = qs('#insp-rec-hours');
  const m = qs('#insp-rec-mins');
  const pullBtn = qs('#insp-rec-pull');
  const clearBtn = qs('#insp-rec-clear');
  const msg = qs('#insp-rec-msg');
  const state = { cajas:[], serverOffset:0 };

  function msElapsed(timer){ if(!timer||!timer.startsAt) return 0; return (Date.now()+state.serverOffset) - new Date(timer.startsAt).getTime(); }
  function timerDisplay(ms){ const s=Math.max(0,Math.floor(ms/1000)); const hh=Math.floor(s/3600); const mm=Math.floor((s%3600)/60); const ss=s%60; return `${hh}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`; }

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
      ? `<span class='badge badge-neutral badge-xs font-mono'>${timerDisplay(msElapsed(caja.timer))}</span>`
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

  async function load(){
    try{ spin?.classList.remove('hidden');
      const r = await fetch('/operacion/inspeccion/data');
      const j = await r.json();
      if(j.ok){ state.cajas = j.cajas||[]; if(j.serverNow){ state.serverOffset = new Date(j.serverNow).getTime() - Date.now(); } }
      grid && (grid.innerHTML = (state.cajas||[]).map(cardHTML).join(''));
    } catch(e){ console.error('inspeccion recepcion load',e); }
    finally { spin?.classList.add('hidden'); }
  }

  async function doPull(){
    const code = (scan?.value||'').trim();
    const hours = parseInt(h?.value||'0',10)||0; const mins = parseInt(m?.value||'0',10)||0; const sec = hours*3600 + mins*60;
    if(code.length!==24){ msg && (msg.textContent='RFID inválido'); return; }
    if(sec<=0){ msg && (msg.textContent='Asigna horas/minutos'); return; }
    msg && (msg.textContent='Jalando...');
    try{
      const r = await fetch('/operacion/inspeccion/pull',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfid: code, durationSec: sec })});
      const j = await r.json();
      if(!j.ok){ msg && (msg.textContent = j.error || 'Error'); return; }
      msg && (msg.textContent='Caja jalada a Inspección');
      await load();
    } catch(e){ msg && (msg.textContent='Error'); }
  }

  pullBtn?.addEventListener('click', doPull);
  clearBtn?.addEventListener('click', ()=>{ scan && (scan.value=''); h && (h.value=''); m && (m.value=''); msg && (msg.textContent=''); scan?.focus(); });
  scan?.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); doPull(); }});
  scan && setTimeout(()=> scan.focus(), 400);

  load();
  setInterval(load, 15000);
})();
