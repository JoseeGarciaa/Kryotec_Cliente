// Kanban summary loader (robusto con timeout y placeholders)
(function(){
  const spin = document.getElementById('kb-spin');
  const statusEl = document.getElementById('kb-status');
  const btn = document.getElementById('kb-refresh');
  if(!statusEl) return;
  const metricIds = ['kb-bodega-tics','kb-bodega-vips','kb-bodega-cubes','kb-cong-proc','kb-cong-done','kb-atem-proc','kb-atem-done','kb-ensam-items','kb-ensam-cajas','kb-op-cajas','kb-insp-cajas','kb-insp-elapsed'];
  let firstLoad = true;
  let lastTimers = { acond:[], operacion:[], preAcond:[], inspeccion:[] };
  let serverOffset = 0; // serverNow - Date.now()
  const timersBox = document.getElementById('kb-timers');
  let timerTick=null;
  let autoReload=null; let currentReloadMs=60000;
  function setAutoReload(ms){ if(currentReloadMs===ms) return; currentReloadMs=ms; if(autoReload) clearInterval(autoReload); autoReload=setInterval(load, currentReloadMs); }
  function setNum(id, val){ const el=document.getElementById(id); if(el) el.textContent = (val||0).toString(); }
  function setLoading(){ metricIds.forEach(id=>{ const el=document.getElementById(id); if(el) el.innerHTML='<span class="loading loading-spinner loading-xs"></span>'; }); }
  function setPlaceholders(){ metricIds.forEach(id=>{ const el=document.getElementById(id); if(el) el.textContent='–'; }); }
  async function load(){
    if(spin) spin.classList.remove('hidden');
    statusEl.textContent='Cargando...';
    if(firstLoad) setLoading();
    try {
      const ac = new AbortController();
      const timeout = setTimeout(()=> ac.abort(), 12000);
      const res = await fetch('/operacion/todas/data', { signal: ac.signal, cache:'no-store' });
      clearTimeout(timeout);
      if(!res.ok) throw new Error('HTTP '+res.status);
      const j = await res.json();
      if(!j.ok) throw new Error(j.error||'Respuesta inválida');
  const d = j.data;
  if(d && d.now){ serverOffset = new Date(d.now).getTime() - Date.now(); }
      setNum('kb-bodega-tics', d.enBodega.tics);
      setNum('kb-bodega-vips', d.enBodega.vips);
      setNum('kb-bodega-cubes', d.enBodega.cubes);
      setNum('kb-cong-proc', d.preAcond.congelamiento.en_proceso);
      setNum('kb-cong-done', d.preAcond.congelamiento.completado);
      setNum('kb-atem-proc', d.preAcond.atemperamiento.en_proceso);
      setNum('kb-atem-done', d.preAcond.atemperamiento.completado);
      setNum('kb-ensam-items', d.acond.ensamblaje);
      setNum('kb-ensam-cajas', d.acond.cajas);
  setNum('kb-op-cajas', d.operacion.cajas_op);
      const preArr = d.timers ? (d.timers.preAcond||[]) : [];
      const tp = preArr.length;
  const preGroups = preArr.filter(t=>!t.item && (t.remaining_sec||0)>0).length;
      const preItems = preArr.filter(t=>t.item).length;
      const ta = d.timers ? (d.timers.acond||[]).length : 0;
      const to = d.timers ? (d.timers.operacion||[]).length : 0;
  statusEl.textContent = 'Actualizado '+ new Date().toLocaleTimeString() + ` · Pre:${tp} (G${preGroups}/I${preItems}) A:${ta} Op:${d.operacion.cajas_op}`;
      if(d.timers){
        lastTimers = d.timers; renderTimers(); ensureTick();
  const anyActive = [...preArr, ...(d.timers.acond||[]), ...(d.timers.operacion||[])].some(t=> (t.remaining_sec||0) > 0);
  const groupActive = preArr.some(t=> !t.item && (t.remaining_sec||0)>0);
  const itemOnlyActive = anyActive && !groupActive && preArr.some(t=> t.item && (t.remaining_sec||0)>0);
  // 3s if only item timers active (for quicker visibility), 10s if any group/caja active, else 60s idle
  setAutoReload(itemOnlyActive ? 3000 : (anyActive ? 10000 : 15000));
  console.debug('[kanban] timers active', { anyActive, groupActive, itemOnlyActive, pre: preArr.length });
      }
    } catch(err){
      console.error('[kanban] load error', err);
      statusEl.textContent='Error al cargar';
      if(firstLoad) setPlaceholders();
    } finally {
      if(spin) spin.classList.add('hidden');
      firstLoad=false;
    }
  }
  function fmt(sec){ if(sec==null) return '--:--'; const s=Math.max(0,sec); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const ss=s%60; return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`; }
  function fmtElapsed(ms){ const s=Math.max(0, Math.floor(ms/1000)); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const ss=s%60; return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`; }
  function msSinceStart(ts){ return Date.now()+serverOffset - new Date(ts).getTime(); }
  function renderTimers(){ if(!timersBox) return; const rows=[]; const all=[];
  const congSpan = document.getElementById('kb-cong-timer');
  const atemSpan = document.getElementById('kb-atem-timer');
  const ensamSpan = document.getElementById('kb-ensam-timer');
  const opSpan = document.getElementById('kb-op-timer');
  let ensamShown=false;
    let congShown=false, atemShown=false;
    (lastTimers.preAcond||[]).forEach(t=>{
      // Compute remaining if not present (fallback)
      if(t.remaining_sec==null && t.started_at && t.duration_sec){
        const endMs = new Date(t.started_at).getTime() + t.duration_sec*1000; t.remaining_sec = Math.max(0, Math.floor((endMs-Date.now())/1000));
      }
      if(t.remaining_sec===0 && !t.item) return; // hide finished ONLY for group/caja timers, keep item-level 0 until next fetch removes
      const base = 'Pre Acond · '+(t.section||'sec');
      const label = t.item ? (base+' · '+(t.rfid? t.rfid.slice(0,6)+'…':'')) : base;
      all.push({ t, label });
      if(!t.item && t.section==='congelamiento' && congSpan){ if(t.remaining_sec!=null){ congSpan.textContent=fmt(t.remaining_sec); congShown=true; } }
      if(!t.item && t.section==='atemperamiento' && atemSpan){ if(t.remaining_sec!=null){ atemSpan.textContent=fmt(t.remaining_sec); atemShown=true; } }
    });
    // If no group timer active, show the soonest item-level timer for that section as placeholder
    if(!congShown && congSpan){
      const soon = (lastTimers.preAcond||[])
        .filter(t=> t.item && t.section==='congelamiento' && (t.remaining_sec||0)>0)
        .sort((a,b)=> (a.remaining_sec||999999) - (b.remaining_sec||999999))[0];
      congSpan.textContent = soon? fmt(soon.remaining_sec) : '—';
    }
    if(!atemShown && atemSpan){
      const soonA = (lastTimers.preAcond||[])
        .filter(t=> t.item && t.section==='atemperamiento' && (t.remaining_sec||0)>0)
        .sort((a,b)=> (a.remaining_sec||999999) - (b.remaining_sec||999999))[0];
      atemSpan.textContent = soonA? fmt(soonA.remaining_sec) : '—';
    }
  (lastTimers.acond||[]).forEach(t=>{ 
      if(t.remaining_sec===0 || t._finishedClient) return; 
      all.push({ t, label:'Caja (Acond)' }); 
    });
  // Ensamblaje placeholder: mostrar cronómetro de caja más cercano (acond timers)
    if(ensamSpan){
      const soonCaja = (lastTimers.acond||[])
        .filter(t=> (t.remaining_sec||0)>0)
        .sort((a,b)=> (a.remaining_sec||999999)-(b.remaining_sec||999999))[0];
      if(soonCaja){ ensamSpan.textContent = fmt(soonCaja.remaining_sec); ensamShown=true; }
      else ensamSpan.textContent = '—';
    }
    // Operación placeholder: nearest operacion caja timer
    if(opSpan){
      let opTimers = (lastTimers.operacion||[]).map(t=>{ // recompute if missing
        if(t.remaining_sec==null && t.started_at && t.duration_sec){
          const endMs = new Date(t.started_at).getTime()+t.duration_sec*1000; t.remaining_sec=Math.max(0,Math.floor((endMs-Date.now())/1000));
        }
        return t;
      });
      if(!opTimers.length && (lastTimers.acond||[]).length){ // fallback a acond si aún no hay timers registrados en operacion
        opTimers = (lastTimers.acond||[]).map(t=>{ if(t.remaining_sec==null && t.started_at && t.duration_sec){ const endMs=new Date(t.started_at).getTime()+t.duration_sec*1000; t.remaining_sec=Math.max(0,Math.floor((endMs-Date.now())/1000)); } return t; });
      }
      let soonOp = opTimers.filter(t=> (t.remaining_sec||0)>0).sort((a,b)=>(a.remaining_sec||999999)-(b.remaining_sec||999999))[0];
      if(!soonOp && opTimers.length){ // fallback to finished/recent
        soonOp = opTimers.sort((a,b)=>(a.remaining_sec||999999)-(b.remaining_sec||999999))[0];
      }
      opSpan.textContent = soonOp? fmt(soonOp.remaining_sec): '—';
      console.debug('[kanban] op placeholder timers', { op: (lastTimers.operacion||[]).length, acond: (lastTimers.acond||[]).length, chosen: soonOp? soonOp.lote:null });
    }
    // Inspección: contar cajas y mostrar la de mayor tiempo (elapsed)
    const inspCnt = (lastTimers.inspeccion||[]).length;
    const inspCntEl = document.getElementById('kb-insp-cajas'); if(inspCntEl) inspCntEl.textContent = String(inspCnt);
    const inspSpan = document.getElementById('kb-insp-elapsed');
    if(inspSpan){
      if(!inspCnt){ inspSpan.textContent = '—'; }
      else {
        const oldest = [...(lastTimers.inspeccion||[])].filter(t=> t.started_at).sort((a,b)=> new Date(a.started_at).getTime() - new Date(b.started_at).getTime())[0];
        if(oldest){ inspSpan.textContent = fmtElapsed(msSinceStart(oldest.started_at)); inspSpan.setAttribute('data-kb-insp-id', String(oldest.caja_id)); }
        else { inspSpan.textContent = '—'; inspSpan.removeAttribute('data-kb-insp-id'); }
      }
    }
  (lastTimers.operacion||[]).forEach(t=>{ if(t.remaining_sec===0 || t._finishedClient) return; all.push({ t, label:'Caja (Operación)' }); });
  // Nota: No forzamos '—' si no hay timer de grupo, porque ya mostramos fallback de item (evita parpadeo)
    // Order: the timer closest to finishing first (ascending remaining_sec)
    all.sort((a,b)=>{
      const ra = (a.t.remaining_sec==null? Infinity : a.t.remaining_sec);
      const rb = (b.t.remaining_sec==null? Infinity : b.t.remaining_sec);
      if(ra!==rb) return ra - rb; // smaller remaining first
      // tie-breaker: earlier started first
      return new Date(a.t.started_at).getTime() - new Date(b.t.started_at).getTime();
    });
    all.forEach(w=> rows.push(timerCard(w.label, w.t.lote, w.t.remaining_sec, w.t)));
    if(!rows.length){ timersBox.innerHTML='<div class="text-xs opacity-50 col-span-full">Sin cronómetros activos</div>'; return; }
    timersBox.innerHTML=rows.join(''); }
  function timerCard(title, lote, rem, t){
    const idLote = lote || (t.rfid ? t.rfid : '');
    const total = t.duration_sec||0; const left = Math.max(0, rem||0); const pct = total? ((total-left)/total)*100:0; const done = left===0;
    return `<div class='border rounded-lg p-3 bg-base-200/5 space-y-2'>
      <div class='flex items-center justify-between text-[11px] font-mono opacity-70'><span>${title}</span><span>${idLote}</span></div>
      <div class='h-1.5 w-full bg-base-300/30 rounded-full overflow-hidden'><div class='h-full ${done?'bg-success':'bg-primary'}' style='width:${pct.toFixed(1)}%'></div></div>
      <div class='text-[10px] font-mono flex items-center justify-between opacity-80'><span>${done?'Finalizado':'Restante'}</span><span data-timer-rem='${title}-${idLote}'>${done? '0:00:00': fmt(left)}</span></div>
    </div>`;
  }
  function ensureTick(){ if(timerTick) return; timerTick = setInterval(()=>{
    // update remaining seconds
    const now = Date.now();
    let anyFinished=false;
    [...(lastTimers.preAcond||[]), ...(lastTimers.acond||[]), ...(lastTimers.operacion||[])].forEach(t=>{
      if(!t.started_at || !t.duration_sec) return; const endMs=new Date(t.started_at).getTime()+t.duration_sec*1000; const remSec=Math.max(0,Math.floor((endMs-now)/1000));
      t.remaining_sec=remSec;
      if(remSec===0 && !t._finishedClient){ t._finishedClient=true; anyFinished=true; }
  const key=`${t.section?('Pre Acond · '+t.section):(t.caja_id?(t.lote? t.lote:'Caja'):'Caja')}-${t.lote || t.rfid || ''}`;
      const span=timersBox?.querySelector(`[data-timer-rem='${key}']`);
      if(span){ if(remSec===0){ span.remove(); } else { span.textContent=fmt(remSec); } }
      if(!t.item && t.section==='congelamiento'){ const s=document.getElementById('kb-cong-timer'); if(s) s.textContent=remSec===0? '—': fmt(remSec); }
      if(!t.item && t.section==='atemperamiento'){ const s=document.getElementById('kb-atem-timer'); if(s) s.textContent=remSec===0? '—': fmt(remSec); }
    });
    // Tick fallback: if no group timers still, update placeholders from item-level soonest
    const congSpan2=document.getElementById('kb-cong-timer');
    if(congSpan2 && ![...(lastTimers.preAcond||[])].some(t=> !t.item && t.section==='congelamiento' && (t.remaining_sec||0)>0)){
      const soon = (lastTimers.preAcond||[]).filter(t=> t.item && t.section==='congelamiento' && (t.remaining_sec||0)>0).sort((a,b)=> (a.remaining_sec||999999)-(b.remaining_sec||999999))[0];
      congSpan2.textContent = soon? fmt(soon.remaining_sec): '—';
    }
    const atemSpan2=document.getElementById('kb-atem-timer');
    if(atemSpan2 && ![...(lastTimers.preAcond||[])].some(t=> !t.item && t.section==='atemperamiento' && (t.remaining_sec||0)>0)){
      const soonA = (lastTimers.preAcond||[]).filter(t=> t.item && t.section==='atemperamiento' && (t.remaining_sec||0)>0).sort((a,b)=> (a.remaining_sec||999999)-(b.remaining_sec||999999))[0];
      atemSpan2.textContent = soonA? fmt(soonA.remaining_sec): '—';
    }
  if(anyFinished) renderTimers();
    // Tick update for Ensamblaje placeholder (nearest caja timer)
    const ensamSpan2=document.getElementById('kb-ensam-timer');
    if(ensamSpan2){
      const soonCaja = (lastTimers.acond||[]).filter(t=> (t.remaining_sec||0)>0).sort((a,b)=> (a.remaining_sec||999999)-(b.remaining_sec||999999))[0];
      ensamSpan2.textContent = soonCaja? fmt(soonCaja.remaining_sec): '—';
    }
    const opSpan2=document.getElementById('kb-op-timer');
    if(opSpan2){
      let opTimers = (lastTimers.operacion||[]);
      if(!opTimers.length && (lastTimers.acond||[]).length){ opTimers = (lastTimers.acond||[]); }
      let soonOp = opTimers.filter(t=> (t.remaining_sec||0)>0).sort((a,b)=> (a.remaining_sec||999999)-(b.remaining_sec||999999))[0];
      if(!soonOp && opTimers.length){ soonOp = opTimers.sort((a,b)=>(a.remaining_sec||999999)-(b.remaining_sec||999999))[0]; }
      opSpan2.textContent = soonOp? fmt(soonOp.remaining_sec): '—';
    }
    // Tick Inspección elapsed (update the currently longest one)
    const inspSpan2 = document.getElementById('kb-insp-elapsed');
    if(inspSpan2){
      const timers = (lastTimers.inspeccion||[]);
      if(!timers.length){ inspSpan2.textContent='—'; inspSpan2.removeAttribute('data-kb-insp-id'); }
      else {
        // Re-evaluate oldest in case a new older arrived
        const oldest = [...timers].filter(t=> t.started_at).sort((a,b)=> new Date(a.started_at).getTime() - new Date(b.started_at).getTime())[0];
        if(oldest){ inspSpan2.textContent = fmtElapsed(msSinceStart(oldest.started_at)); inspSpan2.setAttribute('data-kb-insp-id', String(oldest.caja_id)); }
        else { inspSpan2.textContent='—'; inspSpan2.removeAttribute('data-kb-insp-id'); }
      }
    }
  },1000); }
  btn?.addEventListener('click', load);
  load();
  // Se elimina intervalo fijo de 60s para evitar llamadas duplicadas y parpadeo; el autoReload dinámico gestiona frecuencia
})();
