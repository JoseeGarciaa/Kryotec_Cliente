(function(){
  'use strict';
  const grid = document.getElementById('pend-insp-grid');
  const reloadBtn = document.getElementById('pend-insp-reload');
  if(!grid) return;
  let data = { cajas:[], serverNow:null }; let serverOffset=0; let tick=null;

  function msRemaining(timer){ if(!timer||!timer.endsAt) return 0; return new Date(timer.endsAt).getTime() - (Date.now()+serverOffset); }
  function fmt(rem){ if(rem<=0) return 'Finalizado'; const s=Math.max(0,Math.floor(rem/1000)); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const sec=s%60; return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }
  function pct(timer){ if(!timer||!timer.startsAt||!timer.endsAt) return 0; const start=new Date(timer.startsAt).getTime(); const end=new Date(timer.endsAt).getTime(); const now=Date.now()+serverOffset; if(now<=start) return 0; if(now>=end) return 100; return ((now-start)/(end-start))*100; }
  function cardHTML(c){
    const comps = c.componentes||[];
    const badge = comps.map(it=>{ let cls='badge-ghost'; if(it.tipo==='vip') cls='badge-info'; else if(it.tipo==='tic') cls='badge-warning'; else if(it.tipo==='cube') cls='badge-accent'; return `<span class="badge ${cls} badge-xs">${(it.tipo||'').toUpperCase()}</span>`; }).join(' ');
    const timerTxt = c.timer? (c.timer.completedAt? 'Listo' : fmt(msRemaining(c.timer))) : 'Sin cronómetro';
    const progress = pct(c.timer);
    return `<div class='rounded-lg border border-base-300/50 bg-base-100/50 p-3 space-y-2' data-caja='${c.id}'>
      <div class='flex items-center justify-between text-[10px] uppercase opacity-60'><span>Caja</span><span class='font-mono'>${c.codigoCaja||''}</span></div>
      <div class='font-semibold text-xs break-all'>${c.codigoCaja||''}</div>
      <div class='flex flex-wrap gap-1'>${badge || "<span class='badge badge-ghost badge-xs'>Sin items</span>"}</div>
      <div class='h-1.5 bg-base-300/30 rounded-full overflow-hidden'><div class='h-full bg-primary' style='width:${progress.toFixed(1)}%' data-pi-bar='${c.id}'></div></div>
      <div class='text-[10px] font-mono opacity-70' id='pi-timer-${c.id}'>${timerTxt}</div>
  <!-- Bodega no puede cambiar ni cancelar el cronómetro -->
    </div>`;
  }
  function render(){ if(!grid) return; const cajas = data.cajas||[]; grid.innerHTML = cajas.length? cajas.map(cardHTML).join('') : `<div class='col-span-full text-xs opacity-60 text-center py-6'>Sin cajas pendientes</div>`; }
  async function load(){ try{ const r=await fetch('/operacion/bodega-pend-insp/data'); const j = await r.json(); if(j.ok){ data=j; if(j.serverNow){ serverOffset=new Date(j.serverNow).getTime()-Date.now(); } render(); ensureTick(); } }catch(e){ console.error('pend insp load',e); } }
  function ensureTick(){ if(tick) return; tick=setInterval(()=>{ (data.cajas||[]).forEach(c=>{ if(!c.timer) return; const el=document.getElementById('pi-timer-'+c.id); if(el) el.textContent=c.timer.completedAt? 'Listo' : fmt(msRemaining(c.timer)); const bar=document.querySelector(`[data-pi-bar='${c.id}']`); if(bar&&c.timer.startsAt&&c.timer.endsAt){ bar.style.width=pct(c.timer).toFixed(1)+'%'; } }); },1000); }

  // No actions: timers son de solo lectura aquí
  reloadBtn && reloadBtn.addEventListener('click', load);
  load();
})();
