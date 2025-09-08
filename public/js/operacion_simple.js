// Simplified Operación scanning script
(function(){
  let serverOffsetMs = 0;
  const input = document.getElementById('op-scan-simple');
  const result = document.getElementById('op-result');
  function fmtRemain(ms){
    if(ms<=0) return '00:00:00';
    const s=Math.floor(ms/1000); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const sec=s%60;
    return [h,m,sec].map(v=> String(v).padStart(2,'0')).join(':');
  }
  function renderCaja(caja){
    if(!caja){ result.innerHTML = '<div class="text-xs opacity-60">Sin resultados.</div>'; return; }
    const items = caja.items||[];
    const roles = { tic:0, vip:0, cube:0 };
    items.forEach(i=>{ roles[i.rol] = (roles[i.rol]||0)+1; });
    let timerHTML = '<span class="badge badge-outline badge-xs">Sin cronómetro</span>';
    if(caja.timer){
      const now = Date.now()+serverOffsetMs;
      const end = new Date(caja.timer.endsAt).getTime();
      const remaining = end - now;
      const completed = caja.timer.completedAt || remaining <=0;
      if(completed){ timerHTML = '<span class="badge badge-success badge-xs">Listo</span>'; }
      else {
        const cls = remaining<=60000? 'badge-error' : (remaining<=300000? 'badge-warning':'badge-neutral');
        timerHTML = `<span class="badge ${cls} badge-xs font-mono" data-op-timer data-end="${end}">${fmtRemain(remaining)}</span>`;
      }
    }
    result.innerHTML = `
      <div class="border rounded-lg p-4 bg-base-200/20">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div class="font-mono text-sm font-semibold">${caja.lote}</div>
          <div>${timerHTML}</div>
        </div>
        <div class="flex flex-wrap gap-2 text-[10px] mb-2">
          <span class="badge badge-warning badge-xs">TIC ${roles.tic}</span>
          <span class="badge badge-info badge-xs">VIP ${roles.vip}</span>
          <span class="badge badge-accent badge-xs">CUBE ${roles.cube}</span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-1">
          ${items.map(i=> `<span class="badge badge-neutral badge-xs font-mono" title="${i.rfid}">${i.rfid.slice(-6)}</span>`).join('')}
        </div>
      </div>`;
  }
  async function scan(val){
    if(!val) return;
    result.innerHTML = '<div class="text-xs opacity-60">Buscando...</div>';
    try{
      const r = await fetch('/operacion/scan',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code: val })});
      const j = await r.json();
      if(!r.ok || j.ok===false){ throw new Error(j.error||'Error'); }
      if(j.caja && j.caja.timer && j.caja.timer.startsAt){
        // server offset
        const srvNow = Date.now();
        serverOffsetMs = 0; // could derive if endpoint returned server time; omitted for simplicity
      }
      renderCaja(j.caja);
    }catch(e){
      result.innerHTML = `<div class="text-error text-xs">${(e.message||'Error').slice(0,160)}</div>`;
    }
  }
  if(input){
    input.addEventListener('keydown', e=>{
      if(e.key==='Enter'){
        e.preventDefault();
        const v = input.value.trim();
        if(v){ scan(v); input.value=''; }
      }
    });
    input.focus();
  }
  // ticking
  setInterval(()=>{
    document.querySelectorAll('[data-op-timer]').forEach(el=>{
      const end = Number(el.getAttribute('data-end'))||0;
      const remaining = end - (Date.now()+serverOffsetMs);
      if(remaining<=0){ el.textContent='00:00:00'; el.className='badge badge-success badge-xs font-mono'; el.removeAttribute('data-op-timer'); }
      else { el.textContent = fmtRemain(remaining); }
    });
  },1000);
})();
