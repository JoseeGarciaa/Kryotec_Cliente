// Acondicionamiento UI (visual skeleton)
(function(){
  const qs=(s)=>document.querySelector(s);
  const tableEnsBody = qs('#tabla-ensam tbody');
  const tableListoBody = qs('#tabla-listo tbody');
  const searchEns = qs('#search-ensam');
  const searchListo = qs('#search-listo');
  const countEns = qs('#count-ensam');
  const countListo = qs('#count-listo');
  const btnAddEns = qs('#btn-add-ensam');
  const btnAddListo = qs('#btn-add-listo');

  function emptyRow(text){ const tr=document.createElement('tr'); const td=document.createElement('td'); td.colSpan=6; td.className='py-10 text-center opacity-60'; td.innerHTML=`<div class='flex flex-col items-center gap-2'><svg xmlns='http://www.w3.org/2000/svg' class='h-8 w-8 opacity-40' viewBox='0 0 24 24' fill='currentColor'><path d='M4 4h16v16H4z' opacity='.1'/><path d='M4 4h2v2H4zm4 0h2v2H8zm4 0h2v2h-2zM4 8h2v2H4zm0 4h2v2H4zm0 4h2v2H4z'/></svg><span>${text}</span></div>`; tr.appendChild(td); return tr; }

  let disponibles = { tics:[], cubes:[], vips:[] };
  let cajas = [];
  let cajaItems = [];
  let vistaTexto = false; // false=cards, true=texto (filas completas de cada componente)
  const btnViewCards = document.getElementById('btn-view-cards');
  const btnViewText = document.getElementById('btn-view-text');
  let currentCat = null; // 'tic' | 'vip' | 'cube'
  const modal = document.getElementById('modal-ensam');
  const scanBox = document.getElementById('scan-box');
  const listTic = document.getElementById('list-tic');
  const listVip = document.getElementById('list-vip');
  const listCube = document.getElementById('list-cube');
  const ticCount = document.getElementById('tic-count');
  const vipCount = document.getElementById('vip-count');
  const cubeCount = document.getElementById('cube-count');
  const btnCrear = document.getElementById('btn-crear-caja');
  const btnClear = document.getElementById('btn-clear-ensam');
  const msg = document.getElementById('msg-ensam');
  const catButtons = document.querySelectorAll('.cat-btn');
  const scanHint = document.getElementById('scan-hint');
  const sel = { tic: new Set(), vip: new Set(), cube: new Set() };
  let serverNowOffsetMs = 0; // Date.now() - serverNow

  function fmt(ms){
    const s = Math.max(0, Math.floor(ms/1000));
    const mm = String(Math.floor(s/60)).padStart(2,'0');
    const ss = String(s%60).padStart(2,'0');
    return mm+':'+ss;
  }

  function updateCounts(){
    if(ticCount) ticCount.textContent = `${sel.tic.size} / 6`;
    if(vipCount) vipCount.textContent = `${sel.vip.size} / 1`;
    if(cubeCount) cubeCount.textContent = `${sel.cube.size} / 1`;
    const complete = sel.tic.size===6 && sel.vip.size===1 && sel.cube.size===1;
    if(btnCrear) btnCrear.disabled = !complete;
  }

  function renderLists(){
  listTic.innerHTML=''; listVip.innerHTML=''; listCube.innerHTML='';
  const cls='px-2 py-1 rounded bg-base-200 text-xs flex items-center justify-between';
  [...sel.tic].forEach(r=>{ const li=document.createElement('li'); li.className=cls; li.textContent=r; listTic.appendChild(li); });
  [...sel.vip].forEach(r=>{ const li=document.createElement('li'); li.className=cls; li.textContent=r; listVip.appendChild(li); });
  [...sel.cube].forEach(r=>{ const li=document.createElement('li'); li.className=cls; li.textContent=r; listCube.appendChild(li); });
    updateCounts();
  }

  function setCategory(cat){
    currentCat = cat;
    catButtons.forEach(b=>{
      if(b.getAttribute('data-cat')===cat){ b.classList.add('btn-active'); }
      else { b.classList.remove('btn-active'); }
    });
  scanHint.textContent = `Escanee RFIDs para ${cat.toUpperCase()}${cat==='tic'?' (deben estar Atemperadas)':''}`;
  scanBox.focus();
  }

  catButtons.forEach(b=> b.addEventListener('click', (e)=>{ e.preventDefault(); setCategory(b.getAttribute('data-cat')); }));

  function normalizeScan(raw){
    return raw.replace(/\s+/g,'').toUpperCase();
  }

  // Captura tipo “stream”: cada 24 chars agrega automáticamente, Enter fuerza captura.
  function processScanBuffer(force){
    const raw = normalizeScan(scanBox.value||'');
    if(!raw){ return; }
    if(!currentCat){ msg.textContent='Seleccione categoría primero'; return; }
    if(raw.length === 24 || (force && raw.length>0)){
      addScanned(raw, currentCat);
      scanBox.value='';
    } else if(raw.length>24){
      // En caso que la pistola pegue varios juntos, cortamos en bloques de 24
      let i=0; while(i+24<=raw.length){
        const chunk = raw.slice(i,i+24);
        addScanned(chunk, currentCat);
        i+=24;
      }
      scanBox.value = raw.slice(i); // sobrante parcial
    }
  }
  scanBox?.addEventListener('input', ()=> processScanBuffer(false));
  scanBox?.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); processScanBuffer(true); } });

  function addScanned(rfid, cat){
  if(rfid.length!==24){ msg.textContent='Debe tener 24 caracteres'; return; }
    // avoid duplicates across categories
    if(sel.tic.has(rfid)||sel.vip.has(rfid)||sel.cube.has(rfid)){ msg.textContent=`${rfid} ya agregado`; return; }
    // quick local constraints
    if(cat==='tic' && sel.tic.size>=6) return msg.textContent='Ya hay 6 TIC';
    if(cat==='vip' && sel.vip.size>=1) return msg.textContent='Ya hay VIP';
    if(cat==='cube' && sel.cube.size>=1) return msg.textContent='Ya hay CUBE';
    validatePartial([...sel.tic, ...sel.vip, ...sel.cube, rfid], rfid, cat);
  }

  async function validatePartial(all, last, cat){
    try {
      const r = await fetch('/operacion/acond/ensamblaje/validate',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids: all }) });
      const j = await r.json();
      if(!j.ok){ msg.textContent=j.error||'Error'; return; }
      const invalidEntry = j.invalid.find(x=>x.rfid===last);
      if(invalidEntry){ msg.textContent=`${last}: ${invalidEntry.reason}`; return; }
      // Determine role assigned
      const v = j.valid.find(x=>x.rfid===last);
      if(!v){ msg.textContent='No válido'; return; }
      sel[v.rol].add(last);
      msg.textContent='';
      renderLists();
    } catch(e){ console.error(e); msg.textContent='Error de red'; }
  }

  btnClear?.addEventListener('click', ()=>{ sel.tic.clear(); sel.vip.clear(); sel.cube.clear(); renderLists(); msg.textContent=''; scanBox.value=''; scanBox.focus(); });
  btnCrear?.addEventListener('click', async ()=>{
    const rfids=[...sel.tic, ...sel.vip, ...sel.cube];
    if(rfids.length!==8){ return; }
    btnCrear.disabled=true; msg.textContent='Creando caja...';
    try {
      const r = await fetch('/operacion/acond/ensamblaje/create',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids }) });
      const j = await r.json();
      if(!j.ok){ msg.textContent=j.error||'Error'; btnCrear.disabled=false; return; }
      msg.textContent=`Caja ${j.caja_id} creada Lote ${j.lote}`;
      // reset selection
      sel.tic.clear(); sel.vip.clear(); sel.cube.clear(); renderLists();
      loadData();
      setTimeout(()=>{ (modal).close(); }, 1200);
    } catch(e){ console.error(e); msg.textContent='Error creando'; btnCrear.disabled=false; }
  });

  function openModal(){
    if(typeof modal.showModal==='function') modal.showModal();
  setTimeout(()=>scanBox.focus(),100);
  }
  let firstLoad = true;
  function renderInitialLoading(){
    if(tableEnsBody){
      tableEnsBody.innerHTML='';
      const tr=document.createElement('tr');
      const td=document.createElement('td'); td.colSpan=6; td.className='py-10 text-center opacity-60';
      td.innerHTML = `<div class='flex flex-col items-center gap-3'>
        <span class="loading loading-spinner loading-md"></span>
        <span class='text-sm'>Cargando cajas...</span>
      </div>`;
      tr.appendChild(td); tableEnsBody.appendChild(tr);
    }
    if(tableListoBody){
      tableListoBody.innerHTML='';
      const tr=document.createElement('tr'); const td=document.createElement('td'); td.colSpan=6; td.className='py-10 text-center opacity-60';
      td.innerHTML = `<div class='flex flex-col items-center gap-3'>
        <span class="loading loading-spinner loading-md"></span>
        <span class='text-sm'>Cargando items...</span>
      </div>`; tr.appendChild(td); tableListoBody.appendChild(tr);
    }
    if(countEns) countEns.textContent='(0 de 0)';
    if(countListo) countListo.textContent='(0 de 0)';
  }

  function setSpin(on){
    const spinA = document.getElementById('spin-acond');
    const spinB = document.getElementById('spin-listo');
    spinA?.classList.toggle('hidden', !on);
    spinB?.classList.toggle('hidden', !on);
  }

  async function loadData(force){
    try {
      if(firstLoad) { renderInitialLoading(); setSpin(true); }
      const r = await fetch('/operacion/acond/data?ts=' + Date.now(), { cache:'no-store', headers:{ 'Accept':'application/json', 'Cache-Control':'no-cache'} });
      const j = await r.json();
      if(!j.ok) throw new Error(j.error||'Error');
      if(j.now){ serverNowOffsetMs = Date.now() - new Date(j.now).getTime(); }
      const prevMap = new Map(cajas.map(c=>[c.caja_id, {a:c.timer_active, s:c.timer_started_at, d:c.timer_duration_sec}]));
      const prevIds = new Set(cajas.map(c=>c.caja_id));
      disponibles = j.disponibles; cajas = j.cajas; cajaItems = j.cajaItems||[];
      const newIds = new Set(cajas.map(c=>c.caja_id));
      let changed = force || prevIds.size !== newIds.size;
      if(!changed){
        for(const id of prevIds){ if(!newIds.has(id)){ changed=true; break; } }
      }
      if(!changed){
        // Detect timer field changes
        for(const c of cajas){
          const prev = prevMap.get(c.caja_id);
          if(!prev || prev.a!==c.timer_active || prev.s!==c.timer_started_at || prev.d!==c.timer_duration_sec){ changed=true; break; }
        }
      }
      if(changed){ renderCajas(); }
      startTick();
    } catch(e){ console.error('acond data', e); }
    finally { firstLoad=false; setSpin(false); }
  }

  function renderCajas(){
    if(!tableEnsBody) return;
    tableEnsBody.innerHTML='';
    const grid = document.getElementById('grid-cajas');
    if(grid) grid.innerHTML='';
    if(!cajas.length){
      tableEnsBody.appendChild(emptyRow('No hay cajas en ensamblaje <br><span class="text-xs">Use el botón para armar una caja (1 CUBE, 1 VIP, 6 TIC Atemperadas)</span>'));
      if(countEns) countEns.textContent='(0 de 0)';
      return;
    }
  if(!vistaTexto){
      // Modo tarjetas
      cajas.forEach(c=>{
        const tr=document.createElement('tr');
        tr.className='hover';
        const categoria=`Caja (C:${c.cubes||0} V:${c.vips||0} T:${c.tics||0})`;
        tr.innerHTML=`<td class='font-mono'>#${c.caja_id}</td>
          <td>Caja</td>
          <td>Ensamblaje</td>
          <td>${c.lote||''}</td>
          <td>-</td>
          <td>${c.litraje? (c.litraje+'L'):categoria}</td>`;
        tableEnsBody.appendChild(tr);
        if(grid){
          const items = cajaItems.filter(ci=>ci.caja_id===c.caja_id);
          const vipFirst = items.filter(i=>i.rol==='vip');
          const tics = items.filter(i=>i.rol==='tic');
          const cube = items.filter(i=>i.rol==='cube');
          const div=document.createElement('div');
          div.className='caja-card rounded-lg border border-base-300/40 bg-base-200/10 p-3 flex flex-col gap-2 hover:border-primary/60 transition cursor-pointer';
          div.dataset.cajaId = c.caja_id;
          const remaining = computeRemaining(c);
          const timerBadge = remaining!==null ? `
            <div class='caja-timer flex items-center gap-1 text-[11px] font-mono px-2 py-1 rounded-lg bg-base-300/30 border border-base-300/40'
                 data-caja='${c.caja_id}' data-start='${c.timer_started_at||''}' data-dur='${c.timer_duration_sec||''}' data-active='${c.timer_active?1:0}'>
              <span class='time'></span>
              <button class='btn btn-ghost btn-xs px-1 h-5 shrink-0 stop-caja-timer' title='Cancelar' data-caja='${c.caja_id}'>✕</button>
            </div>` : `<button class='btn btn-outline btn-xs start-caja-timer' data-caja='${c.caja_id}'>Iniciar</button>`;
          div.innerHTML=`<div class='flex items-center justify-between text-xs opacity-60'><span>Caja</span><span class='font-mono'>#${c.caja_id}</span></div>
            <div class='font-semibold text-sm truncate'>${c.lote||''}</div>
            <div class='flex flex-wrap gap-1 text-[9px]'>
              ${vipFirst.map(v=>`<span class='badge badge-info badge-xs'>VIP</span>`).join('')}
              ${tics.map(t=>`<span class='badge badge-warning badge-xs'>TIC</span>`).join('')}
              ${cube.map(cb=>`<span class='badge badge-accent badge-xs'>CUBE</span>`).join('')}
            </div>
            <div class='mt-1'>${timerBadge}</div>`;
          grid.appendChild(div);
        }
      });
      if(countEns) countEns.textContent=`(${cajas.length} de ${cajas.length})`;
    } else {
      // Modo texto: mostrar CAJA como primera columna (antes era RFID) y ocultar la col repetida
      cajas.forEach(c=>{
        const items = cajaItems.filter(ci=>ci.caja_id===c.caja_id);
        items.sort((a,b)=> a.rol===b.rol?0: (a.rol==='vip'? -1 : (b.rol==='vip'?1 : (a.rol==='tic'? -1:1))));
        items.forEach(it=>{
          const tr=document.createElement('tr');
          tr.className='hover';
          // Columnas finales en texto mode: CAJA | NOMBRE | ESTADO | CRONÓMETRO
          tr.innerHTML=`<td class='font-mono'>${c.lote||''}</td>
            <td>${it.rol.toUpperCase()}</td>
            <td>Ensamblaje</td>
            <td>-</td>`;
          tableEnsBody.appendChild(tr);
        });
      });
      if(countEns) countEns.textContent=`(${cajaItems.length} de ${cajaItems.length})`;
    }
    ajustarHeadersEns();
  }

  function applyFilter(inputEl, tbody, countEl){
    const q=(inputEl?.value||'').trim().toLowerCase();
    const trs=[...tbody.querySelectorAll('tr')]; let visible=0,total=0;
    trs.forEach(tr=>{ const tds=tr.querySelectorAll('td'); if(tds.length===1){ tr.style.display=q?'none':''; return; } total++; const hay=[...tds].slice(0,5).map(td=>td.textContent||'').join(' ').toLowerCase(); const show=!q||hay.includes(q); tr.style.display=show?'':'none'; if(show) visible++; });
    if(countEl){ countEl.textContent=`(${visible} de ${total})`; }
  }
  searchEns?.addEventListener('input', ()=>applyFilter(searchEns, tableEnsBody, countEns));
  searchListo?.addEventListener('input', ()=>applyFilter(searchListo, tableListoBody, countListo));

  // Placeholder actions (will be wired later)
  btnAddEns?.addEventListener('click', ()=> { openModal(); });
  btnAddListo?.addEventListener('click', ()=> alert('Agregar a Lista para Despacho (pendiente)'));
  function updateViewButtons(){
    if(btnViewCards) btnViewCards.classList.toggle('btn-active', !vistaTexto);
    if(btnViewText) btnViewText.classList.toggle('btn-active', vistaTexto);
  }
  btnViewCards?.addEventListener('click', ()=>{ vistaTexto=false; renderCajas(); updateViewButtons(); });
  btnViewText?.addEventListener('click', ()=>{ vistaTexto=true; renderCajas(); updateViewButtons(); });

  // =========== Modal Detalle Caja ===========
  const modalCaja = document.getElementById('modal-caja-detalle');
  function openCajaDetalle(cajaId){
    const caja = cajas.find(c=>c.caja_id===cajaId);
    if(!caja || !modalCaja) return;
    const items = cajaItems.filter(i=>i.caja_id===cajaId);
    items.sort((a,b)=>{
      const rank={vip:0,tic:1,cube:2}; return (rank[a.rol]??9)-(rank[b.rol]??9);
    });
    const setText=(id,val)=>{ const el=document.getElementById(id); if(el) el.textContent=val; };
    setText('detalle-caja-lote', caja.lote||'');
    setText('detalle-caja-id', '#'+caja.caja_id);
    setText('detalle-caja-comp', `VIP:${caja.vips||0} · TIC:${caja.tics||0} · CUBE:${caja.cubes||0}`);
    setText('detalle-caja-fecha', formatFecha(caja.created_at));
    const cont = document.getElementById('detalle-caja-items');
    if(cont){
      cont.innerHTML='';
      items.forEach(it=>{
        const div=document.createElement('div');
        div.className='detalle-item border rounded-lg p-3 text-[11px] space-y-1 '+it.rol;
        const colorCls = it.rol==='vip'?'badge-info': it.rol==='tic'?'badge-warning':'badge-accent';
  div.innerHTML=`<div><span class='badge ${colorCls} badge-xs mr-1'>${it.rol.toUpperCase()}</span></div>
          <code class='block bg-base-300/40 rounded px-1 py-0.5 text-[10px] font-mono overflow-x-auto'>${it.rfid}</code>`;
        cont.appendChild(div);
      });
    }
    // Timer box
    const tBox = document.getElementById('detalle-caja-timer-box');
    if(tBox){
      const remaining = computeRemaining(caja);
      if(remaining!==null){
        tBox.innerHTML = `<div class='flex items-center gap-2'>
           <div class="caja-timer flex items-center gap-1 text-[12px] font-mono px-3 py-1 rounded-lg bg-base-300/30 border border-base-300/40"
             data-caja='${caja.caja_id}' data-start='${caja.timer_started_at||''}' data-dur='${caja.timer_duration_sec||''}' data-active='${caja.timer_active?1:0}'>
             <span class='time'></span>
             <button class='btn btn-ghost btn-xs px-1 h-5 shrink-0 stop-caja-timer' data-caja='${caja.caja_id}' title='Cancelar'>✕</button>
           </div>
         </div>`;
      } else {
        tBox.innerHTML = `<button class='btn btn-outline btn-sm start-caja-timer' data-caja='${caja.caja_id}'>Iniciar cronómetro</button>`;
      }
    }
    modalCaja.classList.remove('hidden');
  }
  function closeCajaDetalle(){ modalCaja?.classList.add('hidden'); }
  document.addEventListener('click', (e)=>{
    const card = e.target.closest('.caja-card');
    if(card && card.dataset.cajaId){ openCajaDetalle(Number(card.dataset.cajaId)); }
    if(e.target.matches('[data-close="detalle"]')){ closeCajaDetalle(); }
    if(e.target===modalCaja?.querySelector('[data-close="detalle"]')){ closeCajaDetalle(); }
    if(e.target===modalCaja){ closeCajaDetalle(); }
  });
  function formatFecha(str){ if(!str) return '-'; const d=new Date(str); if(isNaN(d.getTime())) return '-'; return d.toLocaleString(); }

  let originalEnsHeadHTML = null;
  function ajustarHeadersEns(){
    const table = document.querySelector('#tabla-ensam');
    if(!table) return;
    const thead = table.querySelector('thead');
    if(!thead) return;
    if(originalEnsHeadHTML===null){ originalEnsHeadHTML = thead.innerHTML; }
    if(vistaTexto){
      // Replace entire header with 4 columns
      thead.innerHTML = `<tr>
        <th class="w-40">CAJA</th>
        <th class="w-32">NOMBRE</th>
        <th class="w-32">ESTADO</th>
        <th class="w-24">CRONÓMETRO</th>
      </tr>`;
    } else {
      // Restore original full header (RFID, NOMBRE, ESTADO, CAJA, CRONÓMETRO, CATEGORÍA)
      thead.innerHTML = originalEnsHeadHTML;
    }
  }

  function computeRemaining(c){
    if(!c.timer_active || !c.timer_started_at || !c.timer_duration_sec) return null;
    const started = new Date(c.timer_started_at).getTime();
    const now = Date.now() - serverNowOffsetMs;
    const elapsedSec = Math.floor((now - started)/1000);
    const remaining = c.timer_duration_sec - elapsedSec;
    return remaining;
  }
  let ticking=false, rafId=0;
  function startTick(){
    if(ticking) return; ticking=true;
    const step=()=>{
      const now = Date.now() - serverNowOffsetMs;
      document.querySelectorAll('.caja-timer').forEach(b=>{
        const active = b.getAttribute('data-active')==='1';
        if(!active){ return; }
        const started = b.getAttribute('data-start');
        const dur = Number(b.getAttribute('data-dur')||'0');
        if(!started||!dur) return;
        const st = new Date(started).getTime();
        const rem = dur - Math.floor((now - st)/1000);
        const abs = Math.max(0, rem);
        const hh = Math.floor(abs/3600);
        const mm = Math.floor((abs%3600)/60);
        const ss = abs%60;
        const display = hh>0 ? `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}` : `${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
        const span = b.querySelector('.time'); if(span) span.textContent = display;
        b.classList.toggle('timer-done', rem<=0);
        b.classList.toggle('timer-warn', rem>0 && rem<=60);
        b.classList.toggle('timer-ok', rem>60);
        if(rem<=0 && !b.dataset.completed){
          b.dataset.completed='1';
            b.classList.add('animate-pulse');
          fetch('/operacion/acond/caja/timer/complete',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: b.getAttribute('data-caja') })}).then(()=>loadData());
        }
      });
      rafId = requestAnimationFrame(step);
    };
    step();
  }
  // ===== Timer Modal Logic =====
  const modalTimer = document.getElementById('modal-timer');
  let cajaTimerTarget = null;
  function openTimerModal(cajaId){ cajaTimerTarget = cajaId; if(modalTimer?.showModal) modalTimer.showModal(); }
  function startTimerFor(mins){
    if(!cajaTimerTarget) return;
    const m = Number(mins);
    if(!Number.isFinite(m) || m<=0) return;
    fetch('/operacion/acond/caja/timer/start',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: cajaTimerTarget, durationSec: m*60 })})
      .then(r=>r.json())
  .then(j=>{ if(!j.ok){ alert(j.error||'Error'); } cajaTimerTarget=null; modalTimer?.close(); loadData(true); })
  .catch(()=>{ alert('Error iniciando cronómetro'); });
  }
  document.addEventListener('click', (e)=>{
    const startBtn = e.target.closest('.start-caja-timer');
    if(startBtn){ e.stopPropagation(); openTimerModal(startBtn.getAttribute('data-caja')); }
    const stopBtn = e.target.closest('.stop-caja-timer');
    if(stopBtn){ e.stopPropagation(); const id=stopBtn.getAttribute('data-caja'); if(confirm('Cancelar cronómetro?')){
  fetch('/operacion/acond/caja/timer/clear',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: id })}).then(()=>loadData(true));
    }}
  });
  document.getElementById('timer-presets')?.addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-min]');
    if(!btn) return; e.preventDefault(); startTimerFor(btn.getAttribute('data-min'));
  });
  document.getElementById('timer-custom')?.addEventListener('submit', (e)=>{ e.preventDefault(); const v=document.getElementById('timer-mins').value; startTimerFor(v); });

  // Inject minimal CSS
  (function addTimerStyles(){
    if(document.getElementById('caja-timer-styles')) return;
    const css=`.caja-timer.timer-ok{background:linear-gradient(135deg,rgba(56,189,248,.15),rgba(30,41,59,.2));border-color:rgba(56,189,248,.4);} .caja-timer.timer-warn{background:linear-gradient(135deg,rgba(251,191,36,.18),rgba(120,53,15,.25));border-color:rgba(251,191,36,.5);} .caja-timer.timer-done{background:linear-gradient(135deg,rgba(252,165,165,.25),rgba(127,29,29,.35));border-color:rgba(239,68,68,.6);} .caja-timer .stop-caja-timer{opacity:.4;transition:opacity .2s;} .caja-timer:hover .stop-caja-timer{opacity:1;} .caja-timer.timer-done .time{text-decoration:line-through;}`;
    const style=document.createElement('style'); style.id='caja-timer-styles'; style.textContent=css; document.head.appendChild(style);
  })();
  // Inicialización (faltaba tras refactor timers)
  renderInitialLoading();
  loadData(true);
  // Auto refresco cada 15s para evitar datos obsoletos si se modifican desde otro proceso
  setInterval(()=>loadData(false), 15000);
  // Botón manual de refresco (si se agrega en HTML con id btn-refresh-acond)
  const btnRefresh = document.getElementById('btn-refresh-acond');
  btnRefresh?.addEventListener('click', ()=>loadData(true));
  updateViewButtons();
})();
