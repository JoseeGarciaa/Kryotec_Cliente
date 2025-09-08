// Acondicionamiento front-end module (clean consolidated version)
// Handles: data polling, rendering cajas (ensamblaje en progreso), listado listo para despacho, timers, scan + validation, creation, filtering, modal detail.
// Empty-state requirement: "Lista para Despacho" must NOT show perpetual spinner when empty; immediate neutral placeholder is rendered.

(function(){
  'use strict';

  // ========================= DOM SELECTORS =========================
  const sel = {
  contCajas: '#grid-cajas',                // card/grid view container (ajustado a markup real)
    contCajasTabla: '#cajasTablaBody',           // table view body
    contListo: '#listoDespachoBody',            // tbody for listo para despacho table
  contListoCardsWrap: '#grid-listo-wrapper',  // wrapper grid listo
  contListoCards: '#grid-listo',
    placeholderListo: '#listoDespachoPlaceholder', // optional dedicated placeholder div (if exists)
  toggleVistaBtns: '[data-vista-toggle]', // (legacy no-op)
    // Ajustado a ID real en la vista acond.ejs
    filtroInput: '#search-ensam',
  filtroListoInput: '#search-listo',
    scanInput: '#scanInput',
    scanForm: '#scanForm',
    validarBtn: '#validarParcialBtn',
    crearBtn: '#crearCajaBtn',
    listaParcial: '#scanItemsList',
    counts: {
      // IDs reales en el markup
      ensamblaje: '#count-ensam',
      listo: '#count-listo'
    },
    modal: '#detalleCajaModal',
    modalClose: '[data-close-modal]',
    modalContent: '#detalleCajaContent'
  };

  // ========================= STATE =========================
  let cajas = [];          // cajas en ensamblaje (con timers)
  let listoDespacho = [];  // items listos para despacho
  let scanBuffer = [];     // objetos escaneados (parcial)
  let viewMode = localStorage.getItem('acondViewMode') || 'cards';  // persist across reloads
  let pollingTimer = null;
  let tickingTimer = null;
  let pollInterval = null; // usado por startPolling
  let serverNowOffsetMs = 0; // serverNow - clientNow to sync timers
  let lastFilteredComponentCount = 0; // para mostrar (filtrados de total)
  let totalComponentCount = 0;
  let listoFilteredCount = 0; // nuevos contadores filtrado lista despacho
  let listoTotalCount = 0;

  // ========================= UTILITIES =========================
  function qs(selector){ return document.querySelector(selector); }
  function qsa(selector){ return Array.from(document.querySelectorAll(selector)); }
  function createEl(tag, cls){ const el = document.createElement(tag); if(cls) el.className = cls; return el; }
  function formatDateTime(iso){ if(!iso) return '-'; const d = new Date(iso); return d.toLocaleString(); }
  function safeHTML(str){ return (str||'').toString().replace(/[&<>\"]/g, s=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[s])); }
  // Remaining milliseconds based on server time (serverNow = Date.now() + serverNowOffsetMs)
  function msRemaining(caja){
    if(!caja.timer || !caja.timer.endsAt) return 0;
    const end = new Date(caja.timer.endsAt).getTime();
    const serverNow = Date.now() + serverNowOffsetMs;
    return end - serverNow;
  }

  // ========================= INITIAL RENDER HELPERS =========================
  function renderInitialLoading(){
    const body = qs(sel.contListo);
    if(body){
      body.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-sm text-gray-400">Cargando...</td></tr>`;
    }
  }

  function renderListoEmpty(){
    const body = qs(sel.contListo);
    if(body){
      body.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-sm text-gray-400">Sin items listos para despacho</td></tr>`;
    }
  }

  // ========================= RENDER FUNCTIONS (LISTO) =========================
  function renderListo(){
    const body = qs(sel.contListo);
    const grid = qs(sel.contListoCards);
    if(body){
      if(!listoDespacho || listoDespacho.length===0){
        renderListoEmpty();
      } else {
  const filterValue = (qs(sel.filtroListoInput)?.value || '').trim().toLowerCase();
  const filtered = filterValue ? listoDespacho.filter(i => (i.codigo||'').toLowerCase().includes(filterValue) || (i.nombre||'').toLowerCase().includes(filterValue) || (i.lote||'').toLowerCase().includes(filterValue)) : listoDespacho;
  listoTotalCount = listoDespacho.length;
  listoFilteredCount = filtered.length;
  const rows = filtered.map(item => {
    const cajaIdRef = item.caja_id || item.cajaId || item.cajaID;
    const t = item.cronometro;
    let timerCell = '<span class="badge badge-neutral badge-xs">-</span>';
    if(t && t.startsAt && t.endsAt){
      const now = Date.now() + serverNowOffsetMs;
      const end = new Date(t.endsAt).getTime();
      if(now < end){
        const rem=end-now; const sec=Math.max(0,Math.floor(rem/1000)); const m=Math.floor(sec/60); const s=sec%60;
        const cls = sec<=60 ? 'bg-error' : (sec<=300 ? 'bg-warning':'bg-info');
        timerCell = `<span class="inline-flex items-center gap-1">\n            <span class="w-2 h-2 rounded-full ${cls} animate-pulse" data-listo-dot data-caja-id="${safeHTML(cajaIdRef)}"></span>\n            <span class="badge badge-neutral badge-xs font-mono" data-listo-remaining data-caja-id="${safeHTML(cajaIdRef)}">${m}m ${s.toString().padStart(2,'0')}s</span>\n            <button class="btn btn-ghost btn-xs" data-action="timer-clear" data-caja-id="${safeHTML(cajaIdRef)}" title="Reiniciar">⏹</button>\n          </span>`;
      } else {
        timerCell = `<span class="inline-flex items-center gap-1">\n            <button class="btn btn-ghost btn-xs" data-action="timer-start" data-caja-id="${safeHTML(cajaIdRef)}" title="Reiniciar">▶</button>\n          </span>`;
      }
    } else if(cajaIdRef){
      timerCell = `<button class="btn btn-ghost btn-xs" data-action="timer-start" data-caja-id="${safeHTML(cajaIdRef)}" title="Iniciar">▶</button>`;
    }
    let estadoTxt = 'Lista para Despacho';
    if(t && t.startsAt && t.endsAt){
      const now = Date.now() + serverNowOffsetMs; const end = new Date(t.endsAt).getTime();
      if(now < end) estadoTxt = 'Despachando';
    }
  return `<tr class="hover" data-caja-id="${safeHTML(cajaIdRef || '')}">\n      <td class="text-sm font-mono">${safeHTML(item.lote || '')}</td>\n      <td class="text-sm flex flex-col leading-tight">\n        <span class="uppercase tracking-wide">${safeHTML(item.nombre || '')}</span>\n        <span class="font-mono text-xs opacity-40">${safeHTML(item.codigo || '')}</span>\n      </td>\n      <td class="text-sm">${safeHTML(estadoTxt)}</td>\n      <td class="w-40">${timerCell}</td>\n    </tr>`;
  }).join('');
        body.innerHTML = rows;
      }
    }
    if(grid){
      if(!listoDespacho || listoDespacho.length===0){
        grid.innerHTML = '<div class="col-span-full text-center text-xs text-gray-400 py-4">Sin items listos para despacho</div>';
      } else {
  const filterValue = (qs(sel.filtroListoInput)?.value || '').trim().toLowerCase();
  const filtered = filterValue ? listoDespacho.filter(i => (i.codigo||'').toLowerCase().includes(filterValue) || (i.nombre||'').toLowerCase().includes(filterValue) || (i.lote||'').toLowerCase().includes(filterValue)) : listoDespacho;
  // Agrupar por caja (usamos lote si existe, si no caja_id / fallback)
  const groupsMap = new Map();
  filtered.forEach(it=>{
    const key = it.lote; // grouping by lote (caja)
    if(!groupsMap.has(key)) groupsMap.set(key,{ lote: it.lote, cajaId: it.caja_id || it.cajaId || it.cajaId || it.cajaID, items:[], categorias:{}, timers:[] });
    const g = groupsMap.get(key);
    g.items.push(it);
    const cat = it.categoria||'NA';
    g.categorias[cat] = (g.categorias[cat]||0)+1;
    if(it.cronometro){
      g.timers.push({ startsAt: it.cronometro.startsAt, endsAt: it.cronometro.endsAt, completedAt: it.cronometro.completedAt });
    }
  });
  const groups = Array.from(groupsMap.values());
  grid.innerHTML = groups.map(g => listoCajaCardHTML(g)).join('');
      }
    }
  }

  // ========================= RENDER FUNCTIONS (CAJAS) =========================
  function renderCajas(){
  const contCards = qs(sel.contCajas);
  const contTableBody = qs(sel.contCajasTabla);
  if(!contCards || !contTableBody) return;

    // Filter (client-side) by text if filter input present
    const filterValue = (qs(sel.filtroInput)?.value || '').trim().toLowerCase();
  const filtered = filterValue ? cajas.filter(c => (c.codigoCaja||'').toLowerCase().includes(filterValue) ) : cajas.slice();

  // Contar componentes totales y filtrados
  totalComponentCount = cajas.reduce((acc,c)=> acc + ((c.componentes||[]).length || 0), 0);
  lastFilteredComponentCount = filtered.reduce((acc,c)=> acc + ((c.componentes||[]).length || 0), 0);

    // Cards view
  contCards.innerHTML = filtered.map(c => cajaCardHTML(c)).join('');

  // Table rows (una fila por componente para evitar agrupado de RFIDs)
  const tableRows = [];
  filtered.forEach(c => { tableRows.push(...cajaRowsHTML(c)); });
  contTableBody.innerHTML = tableRows.join('');
  }

  function cajaCardHTML(c){
    const remaining = msRemaining(c);
    const timerText = timerDisplay(remaining, c.timer?.completedAt);
    const progress = timerProgressPct(c);
    // === Pretty legacy style card ===
    const comps = (c.componentes||[]);
    const vip = comps.filter(x=>x.tipo==='vip');
    const tics = comps.filter(x=>x.tipo==='tic');
    const cubes = comps.filter(x=>x.tipo==='cube');
    const compBadges = [
      ...vip.map(()=>`<span class='badge badge-info badge-xs font-semibold'>VIP</span>`),
      ...tics.map(()=>`<span class='badge badge-warning badge-xs font-semibold'>TIC</span>`),
      ...cubes.map(()=>`<span class='badge badge-accent badge-xs font-semibold'>CUBE</span>`)
    ].join(' ');
    // Timer badge used inside bottom row (not top-right now)
    let timerBadge='';
    if(c.timer && c.timer.startsAt && c.timer.endsAt && !c.timer.completedAt){
      timerBadge = `<span class='badge badge-neutral badge-xs flex items-center gap-1' data-caja-timer-started='${new Date(c.timer.startsAt).getTime()}' data-caja-timer-duration='${Math.round((new Date(c.timer.endsAt).getTime() - new Date(c.timer.startsAt).getTime())/1000)}' data-caja-id='${safeHTML(c.id)}'>
          <span id='tm-caja-${safeHTML(c.id)}'>${timerText}</span>
          <button class='btn btn-ghost btn-xs px-1 h-4 shrink-0 stop-caja-timer' data-caja='${safeHTML(c.id)}' title='Cancelar'>✕</button>
        </span>`;
    } else if(c.timer && c.timer.completedAt){
      timerBadge = `<span class='badge badge-success badge-xs'>Completado</span>`;
    } else {
      timerBadge = `<span class='badge badge-outline badge-xs opacity-60'>Sin cronómetro</span>`;
    }
    const pct = Math.min(100, Math.max(0, progress));
    return `<div class='caja-card rounded-lg border border-base-300/40 bg-base-200/10 p-3 flex flex-col gap-2 hover:border-primary/60 transition cursor-pointer' data-caja-id='${safeHTML(c.id)}'>
        <div class='flex items-center justify-between text-[10px] tracking-wide uppercase opacity-60'>
          <span>Caja</span><span class='font-mono'>#${safeHTML(c.id)}</span>
        </div>
        <div class='font-semibold text-sm leading-tight truncate pr-2' title='${safeHTML(c.codigoCaja||'Caja')}'>${safeHTML(c.codigoCaja||'Caja')}</div>
        <div class='flex flex-wrap gap-1 text-[9px] flex-1'>${compBadges || "<span class='badge badge-ghost badge-xs'>Sin items</span>"}</div>
        <div class='timer-progress h-1.5 w-full bg-base-300/30 rounded-full overflow-hidden'>
          <div class='timer-bar h-full bg-gradient-to-r from-primary via-primary to-primary/70' style='width:${pct.toFixed(1)}%' data-caja-bar='${safeHTML(c.id)}'></div>
        </div>
        <div class='flex items-center justify-between text-[10px] font-mono opacity-70'>
          <span class='inline-flex items-center gap-1'>${timerBadge}</span>
          <span class='opacity-50'>restante</span>
        </div>
      </div>`;
  }

  // ========================= VIEW TOGGLE =========================
  function updateViewVisibility(){
    const gridWrap = document.getElementById('grid-cajas-wrapper');
    const tableEl = document.getElementById('tabla-ensam');
    const tableWrap = tableEl ? tableEl.parentElement : null;
    const listoGridWrap = document.querySelector(sel.contListoCardsWrap);
  const listoTable = document.getElementById('tabla-listo');
    const btnCards = document.getElementById('btn-view-cards-global');
    const btnText = document.getElementById('btn-view-text-global');
    const showCards = viewMode === 'cards';
    if(gridWrap) gridWrap.classList.toggle('hidden', !showCards);
    if(tableWrap) tableWrap.classList.toggle('hidden', showCards);
    if(listoGridWrap) listoGridWrap.classList.toggle('hidden', !showCards);
  if(listoTable) listoTable.classList.toggle('hidden', showCards); // ocultar solo la tabla, no su contenedor
    if(btnCards) btnCards.classList.toggle('btn-active', showCards);
    if(btnText) btnText.classList.toggle('btn-active', !showCards);
  }

  function cajaRowsHTML(c){
    const remaining = msRemaining(c);
    const progress = timerProgressPct(c);
    const timerText = timerDisplay(remaining, c.timer?.completedAt);
    const comps = (c.componentes||[]);
    if(!comps.length){
      // Cronómetro estilo "anterior": badge pequeño + (si aplica) botón acción
      const controls = timerTableControlsHTML(c);
  return [ `<tr class="hover" data-caja-id="${safeHTML(c.id)}">\n        <td class="text-sm font-mono">${safeHTML(c.codigoCaja||'')}</td>\n        <td class="text-sm opacity-60">(sin items)</td>\n        <td class="text-sm">${safeHTML(c.estado||'')}</td>\n        <td class="w-32 flex items-center gap-1">\n          <span class="badge badge-neutral badge-xs" data-timer-badge><span data-timer-text>${timerText}</span></span>\n          ${controls}\n        </td>\n      </tr>` ];
    }
    return comps.map(cc => {
      const controls = timerTableControlsHTML(c);
      // Nombre (tipo) en mayúsculas discretas y código en monoespaciado reducido
  return `<tr class="hover" data-caja-id="${safeHTML(c.id)}">\n        <td class="text-sm font-mono">${safeHTML(c.codigoCaja||'')}</td>\n        <td class="text-sm flex flex-col leading-tight">\n          <span class="uppercase tracking-wide">${safeHTML(cc.tipo||cc.nombre||'')}</span>\n          <span class="font-mono text-xs opacity-40">${safeHTML(cc.codigo)}</span>\n        </td>\n        <td class="text-sm">${safeHTML(c.estado||'')}</td>\n        <td class="w-32 flex items-center gap-1">\n          <span class="badge badge-neutral badge-xs" data-timer-badge><span data-timer-text>${timerText}</span></span>\n          ${controls}\n        </td>\n      </tr>`;
    });
  }

  // Controles estilo tabla (similar a preacond) dependiendo del estado del timer
  function timerTableControlsHTML(c){
    if(!c.timer || (!c.timer.startsAt && !c.timer.endsAt)){
      // No iniciado
      return `<button class="btn btn-ghost btn-xs text-success" title="Iniciar" data-action="timer-start" data-caja-id="${safeHTML(c.id)}">\n        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>\n      </button>`;
    }
    if(c.timer && c.timer.completedAt){
      return `<span class="inline-flex items-center justify-center text-success" title="Completado">\n        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>\n      </span>`;
    }
    const remaining = msRemaining(c);
    if(remaining <= 0){
      return `<button class="btn btn-ghost btn-xs text-primary" title="Completar" data-action="timer-complete" data-caja-id="${safeHTML(c.id)}">\n        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>\n      </button>`;
    }
    // En progreso
    return `<button class="btn btn-ghost btn-xs text-error" title="Reiniciar" data-action="timer-clear" data-caja-id="${safeHTML(c.id)}">\n      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>\n    </button>`;
  }

  function timerProgressPct(c){
    if(!c.timer || !c.timer.startsAt || !c.timer.endsAt) return 0;
    const start = new Date(c.timer.startsAt).getTime();
    const end = new Date(c.timer.endsAt).getTime();
  const now = Date.now() + serverNowOffsetMs; // server-aligned current time
    if(now <= start) return 0;
    if(now >= end) return 100;
    return ((now - start) / (end - start)) * 100;
  }

  function timerDisplay(remainingMs, completedAt){
    if(completedAt) return 'Completado';
    if(remainingMs <= 0) return 'Finalizado';
    const sec = Math.floor(remainingMs/1000);
    const m = Math.floor(sec/60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  }

  function timerBadgeHTML(c, remaining){
    if(!c.timer) return '<span class="badge badge-ghost badge-xs">Sin timer</span>';
    if(c.timer.completedAt) return '<span class="badge badge-success badge-xs">Completado</span>';
    if(remaining <= 0) return '<span class="badge badge-warning badge-xs">Finalizado</span>';
    return '<span class="badge badge-info badge-xs">En progreso</span>';
  }

  function timerControlButtonsHTML(c){
    // Buttons adapt to timer state
    if(!c.timer || (!c.timer.startsAt && !c.timer.endsAt)){
      return `<button class="btn btn-xs btn-primary" data-action="timer-start" data-caja-id="${safeHTML(c.id)}">Iniciar</button>`;
    }
    if(c.timer && c.timer.completedAt){
      return `<button class="btn btn-xs" disabled>Listo</button>`;
    }
    const remaining = msRemaining(c);
    if(remaining <= 0 && !c.timer.completedAt){
      return `<button class="btn btn-xs btn-success" data-action="timer-complete" data-caja-id="${safeHTML(c.id)}">Completar</button>`;
    }
    return `<button class="btn btn-xs btn-outline" data-action="timer-clear" data-caja-id="${safeHTML(c.id)}">Reiniciar</button>`;
  }

  // ========================= COUNTS =========================
  function updateCounts(){
    const ensam = qs(sel.counts.ensamblaje);
    const listo = qs(sel.counts.listo);
  if(ensam) ensam.textContent = `(${lastFilteredComponentCount} de ${totalComponentCount})`;
  if(listo){
    if(listoTotalCount===0){ listo.textContent = '(0 de 0)'; }
    else listo.textContent = `(${listoFilteredCount} de ${listoTotalCount})`;
  }
  }

  // ========================= FILTER =========================
  function applyFilter(){
    renderCajas();
  }

  // ========================= POLLING + DATA LOAD =========================
  async function loadData(){
    try {
      const res = await fetch('/operacion/acond/data', { headers: { 'Accept':'application/json' }});
      const ct = res.headers.get('content-type')||'';
      if(!ct.includes('application/json')){
        const text = await res.text();
        throw new Error(`Respuesta no JSON (status ${res.status}). Posible sesión expirada o ruta incorrecta. Primeros 120 chars: ${text.slice(0,120)}`);
      }
      let json;
      try { json = await res.json(); } catch(parseErr){
        throw new Error('No se pudo parsear JSON: '+ (parseErr?.message||parseErr));
      }
      if(!res.ok || json.ok===false){
        throw new Error('Error al cargar datos: '+ (json.error||res.status));
      }
      const serverNow = json.serverNow ? new Date(json.serverNow).getTime() : Date.now();
      serverNowOffsetMs = serverNow - Date.now();
      cajas = Array.isArray(json.cajas) ? json.cajas : [];
      listoDespacho = Array.isArray(json.listoDespacho) ? json.listoDespacho : [];
      renderCajas();
      renderListo();
      updateCounts();
      ensureTicking();
    } catch(err){
      console.error('[Acond] loadData error:', err);
      const body = qs(sel.contCajasTabla);
      if(body && body.innerHTML.trim()===''){
        body.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-error text-xs">${safeHTML(err.message||'Error cargando')}</td></tr>`;
      }
    }
  }

  function startPolling(){
    if(pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(()=>{ loadData(); }, 12000);
    // local lightweight ticking of visible countdown (every second) without hitting server
    setInterval(()=>{
      const timersByCaja = {};
      listoDespacho.forEach(it=>{ if(it.caja_id && it.cronometro && it.cronometro.startsAt && it.cronometro.endsAt){ if(!timersByCaja[it.caja_id]) timersByCaja[it.caja_id]=it.cronometro; }});
      document.querySelectorAll('[data-timer-chrono]').forEach(el=>{
        if(!(el instanceof HTMLElement)) return;
        const cajaId = el.getAttribute('data-caja-id');
        const t = cajaId ? timersByCaja[cajaId] : null;
        if(!t) return;
        const now = Date.now() + serverNowOffsetMs;
        const end = new Date(t.endsAt).getTime();
        if(now>=end){ el.textContent='Finalizado'; el.className='badge badge-warning badge-xs font-mono'; return; }
        const remMs = end-now; const sec = Math.max(0, Math.floor(remMs/1000)); const mm=Math.floor(sec/60); const ss=sec%60;
        el.textContent = `${mm}m ${ss.toString().padStart(2,'0')}s`;
        let cls='badge-info'; if(sec<=60) cls='badge-error'; else if(sec<=300) cls='badge-warning';
        el.className = `badge ${cls} badge-xs font-mono`;
      });
      // Actualizar cronómetro en tabla Listo
      document.querySelectorAll('[data-listo-remaining]').forEach(el=>{
        if(!(el instanceof HTMLElement)) return;
        const cajaId = el.getAttribute('data-caja-id');
        const t = cajaId ? timersByCaja[cajaId] : null;
        const dot = document.querySelector(`[data-listo-dot][data-caja-id="${cajaId}"]`);
        if(!t) return;
        const now = Date.now() + serverNowOffsetMs;
        const end = new Date(t.endsAt).getTime();
        if(now>=end){
          el.textContent='Finalizado';
          el.className='badge badge-warning badge-xs';
          if(dot) dot.className='w-2 h-2 rounded-full bg-warning';
          return;
        }
        const remMs = end-now; const sec = Math.max(0, Math.floor(remMs/1000)); const mm=Math.floor(sec/60); const ss=sec%60;
        el.textContent = `${mm}m ${ss.toString().padStart(2,'0')}s`;
        let cls='bg-info'; if(sec<=60) cls='bg-error'; else if(sec<=300) cls='bg-warning';
        if(dot) dot.className=`w-2 h-2 rounded-full ${cls} animate-pulse`;
      });
    },1000);
  }
  function stopPolling(){ if(pollingTimer) clearInterval(pollingTimer); pollingTimer = null; }

  function ensureTicking(){
    if(tickingTimer) return; // already ticking
    tickingTimer = setInterval(()=>{
      // Only update timers (progress + remaining text) without re-rendering entire DOM structure for performance
      qsa('[data-caja-id]').forEach(el => {
        const id = el.getAttribute('data-caja-id');
        const caja = cajas.find(c=> String(c.id) === String(id));
        if(!caja) return;
        const remaining = msRemaining(caja);
        // Actualizar span de tiempo dentro del badge si existe
        const tmSpan = el.querySelector(`#tm-caja-${caja.id}`);
        if(tmSpan){ tmSpan.textContent = timerDisplay(remaining, caja.timer?.completedAt); }
        // Actualizar clases del badge (si hay cronómetro)
        const badge = el.querySelector('[data-caja-timer-started]');
        if(badge && caja.timer && !caja.timer.completedAt){
          const remSec = Math.max(0, Math.floor(remaining/1000));
          badge.classList.remove('badge-info','badge-warning','badge-error','badge-success','badge-neutral');
          if(remSec<=0){
            badge.classList.add('badge-info');
          } else if(remSec<=60){
            badge.classList.add('badge-error');
          } else if(remSec<=300){
            badge.classList.add('badge-warning');
          } else {
            badge.classList.add('badge-neutral');
          }
        }
        // Progress bar update for pretty card
        const bar = el.querySelector('[data-caja-bar]');
        if(bar && caja.timer && caja.timer.startsAt && caja.timer.endsAt){
          const pct = timerProgressPct(caja);
          bar.style.width = Math.min(100, Math.max(0, pct)).toFixed(1) + '%';
          const remSec = Math.max(0, Math.floor(remaining/1000));
          bar.classList.toggle('bg-error', remSec<=0);
          bar.classList.toggle('bg-warning', remSec>0 && remSec<=60);
        }
      });
      // Actualizar si modal de detalle está visible
      const visibleModal = !document.getElementById('modal-caja-detalle')?.classList.contains('hidden');
      if(visibleModal){
        const remSpans = document.querySelectorAll('[data-detalle-remaining]');
        remSpans.forEach(sp=>{
          const cajaId = sp.getAttribute('data-detalle-remaining');
          const c = cajas.find(cc=> String(cc.id)===String(cajaId));
          if(!c) return;
          const rem = msRemaining(c);
          sp.textContent = timerDisplay(rem, c.timer?.completedAt);
          const bar = document.querySelector(`[data-detalle-bar="${cajaId}"]`);
          if(bar && c.timer && c.timer.startsAt && c.timer.endsAt){
            bar.style.width = Math.min(100, Math.max(0, timerProgressPct(c))).toFixed(1)+'%';
          }
        });
      }
    }, 1000);
  }

  // ========================= MODAL DETALLE =========================
  // Nueva implementación alineada al markup real (#modal-caja-detalle)
  function openCajaDetalle(id){
    const caja = cajas.find(c=> String(c.id) === String(id));
    if(!caja) return;
    const modalWrap = document.getElementById('modal-caja-detalle');
    if(!modalWrap) return;

    // Meta básica
    const comps = (caja.componentes||[]);
    const counts = { vip:0, tic:0, cube:0 };
    comps.forEach(x=>{ if(x && x.tipo){ counts[x.tipo] = (counts[x.tipo]||0)+1; } });

    const setText = (id, val) => { const el=document.getElementById(id); if(el) el.textContent = val; };
    setText('detalle-caja-titulo', caja.codigoCaja || 'Caja');
    setText('detalle-caja-lote', caja.codigoCaja || '');
    setText('detalle-caja-id', `#${caja.id}`);
    setText('detalle-caja-comp', `VIP:${counts.vip||0} · TIC:${counts.tic||0} · CUBE:${counts.cube||0}`);
    setText('detalle-caja-fecha', formatDateTime(caja.createdAt));

    // Items
    const itemsBox = document.getElementById('detalle-caja-items');
    if(itemsBox){
      if(comps.length===0){
        itemsBox.innerHTML = '<div class="col-span-full text-center text-xs opacity-60 italic">Sin componentes</div>';
      } else {
        itemsBox.innerHTML = comps.map(cc => {
          const tipo = (cc.tipo||'').toLowerCase();
          let color='badge-ghost';
          if(tipo==='vip') color='badge-info';
          else if(tipo==='tic') color='badge-warning';
          else if(tipo==='cube') color='badge-accent';
          return `<div class="border rounded-lg p-3 bg-base-300/10 flex flex-col gap-2" title="${safeHTML(cc.codigo||'')}">
            <div class="flex items-center justify-between">
              <span class="badge ${color} badge-xs font-semibold uppercase">${safeHTML(cc.tipo||'')}</span>
            </div>
            <div class="font-mono text-sm break-all">${safeHTML(cc.codigo||'')}</div>
          </div>`;
        }).join('');
      }
    }

    // Timer
    const timerBox = document.getElementById('detalle-caja-timer-box');
    if(timerBox){
      let html='';
      if(!caja.timer){
        html = '<div class="text-sm opacity-60 italic">(Sin cronómetro)</div>';
      } else if(caja.timer.completedAt){
        html = '<div class="badge badge-success badge-sm">Cronómetro Completado</div>';
      } else if(caja.timer.startsAt && caja.timer.endsAt){
        const remaining = msRemaining(caja);
        const remTxt = timerDisplay(remaining, caja.timer.completedAt);
        const pct = timerProgressPct(caja);
        html = `<div class="space-y-2">
          <div class="text-sm">Tiempo restante: <span class="font-mono" data-detalle-remaining="${safeHTML(caja.id)}">${remTxt}</span></div>
          <div class="h-2 rounded bg-base-300/40 overflow-hidden">
            <div class="h-full bg-primary" style="width:${pct.toFixed(1)}%" data-detalle-bar="${safeHTML(caja.id)}"></div>
          </div>
        </div>`;
      } else {
        html = '<div class="text-sm opacity-60 italic">(Cronómetro sin iniciar)</div>';
      }
      timerBox.innerHTML = html;
    }

    modalWrap.classList.remove('hidden');
  }
  function closeCajaDetalle(){
    const modalWrap = document.getElementById('modal-caja-detalle');
    if(modalWrap) modalWrap.classList.add('hidden');
  }

  // ========================= SCAN / VALIDACION / CREACION =========================
  function refreshScanList(){
    const ul = qs(sel.listaParcial);
    if(!ul) return;
    if(scanBuffer.length===0){
      ul.innerHTML = '<li class="text-xs text-gray-400">Sin componentes escaneados</li>';
      return;
    }
    ul.innerHTML = scanBuffer.map(s=> `<li class=\"text-xs font-mono flex justify-between items-center\">${safeHTML(s.codigo)} <button class=\"btn btn-ghost btn-xs\" data-action=\"scan-remove\" data-codigo=\"${safeHTML(s.codigo)}\">✕</button></li>`).join('');
  }

  function processScan(code){
    if(!code) return;
    code = code.trim();
    if(!code) return;
    if(scanBuffer.some(s=> s.codigo === code)) return; // ignore duplicates
    scanBuffer.push({ codigo: code });
    refreshScanList();
  }

  async function validarParcial(){
    if(scanBuffer.length===0) return;
    disableBtn(sel.validarBtn, true);
    try{
      const res = await fetch('/operacion/acond/ensamblaje/validate',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids: scanBuffer.map(s=> s.codigo) })});
      const json = await res.json();
      if(!res.ok){ throw new Error(json.message || 'Error de validación'); }
      console.log('[Acond] Validación parcial OK', json);
    }catch(err){
      console.error('[Acond] validarParcial error:', err);
      alert(err.message || 'Error validando');
    }finally{ disableBtn(sel.validarBtn, false); }
  }

  function listoCardHTML(item){
    let chrono='-';
    if(item.cronometro && item.cronometro.startsAt && item.cronometro.endsAt){
      const now = Date.now() + serverNowOffsetMs;
      const start = item.cronometro.startsAt ? new Date(item.cronometro.startsAt).getTime() : null;
      const end = item.cronometro.endsAt ? new Date(item.cronometro.endsAt).getTime() : null;
      if(start && end){
        if(item.cronometro.completedAt || now >= end){ chrono='Completado'; }
        else {
          const rem=end-now; const sec=Math.max(0,Math.floor(rem/1000)); const m=Math.floor(sec/60); const s=sec%60; chrono=`${m}m ${s}s`;
        }
      }
    }
    return `<div class="card bg-base-100 shadow-sm border border-base-200 p-2" data-listo-rfid="${safeHTML(item.codigo)}">
      <div class="flex items-start justify-between mb-1">
        <span class="font-mono text-[10px]">${safeHTML(item.codigo)}</span>
        <span class="badge badge-ghost badge-xs uppercase">${safeHTML(item.categoria||'')}</span>
      </div>
      <div class="text-[11px] font-semibold leading-tight mb-1">${safeHTML(item.nombre||'-')}</div>
      <div class="text-[10px] opacity-70 mb-1">${safeHTML(item.estado||'')}</div>
      <div class="text-[10px] text-right">${chrono}</div>
    </div>`;
  }
  // Card agrupada por caja
  function listoCajaCardHTML(group){
    // Solo mostrar tiempo restante sin estado Completado
    let badgeHTML = '<span class="badge badge-ghost badge-xs">Sin timer</span>'; let actionsHTML='';
    const timer = group.timers && group.timers.length ? group.timers[0] : null;
    if(timer && timer.startsAt && timer.endsAt){
      const now = Date.now() + serverNowOffsetMs;
      const end = new Date(timer.endsAt).getTime();
      if(now < end){
        const remMs = end-now; const sec = Math.max(0, Math.floor(remMs/1000)); const mm=Math.floor(sec/60); const ss=sec%60;
        const colorClass = sec<=60 ? 'badge-error' : (sec<=300 ? 'badge-warning' : 'badge-info');
        badgeHTML = `<span class=\"badge ${colorClass} badge-xs font-mono\" data-timer-chrono data-caja-id=\"${safeHTML(group.cajaId)}\">Despachando ${mm}m ${ss.toString().padStart(2,'0')}s</span>`;
        actionsHTML = `<div class=\"flex gap-1\" data-timer-actions data-caja-id=\"${safeHTML(group.cajaId)}\">\n            <button class=\"btn btn-ghost btn-xs\" data-action=\"timer-clear\" data-caja-id=\"${safeHTML(group.cajaId)}\" title=\"Reiniciar\"><span class=\"material-icons text-[14px]\">restart_alt</span></button>\n          </div>`;
      } else {
        badgeHTML = `<span class=\"badge badge-success badge-xs font-mono\">Lista para Despacho</span>`;
        actionsHTML = `<div class=\"flex gap-1\" data-timer-actions data-caja-id=\"${safeHTML(group.cajaId)}\">\n            <button class=\"btn btn-ghost btn-xs\" data-action=\"timer-start\" data-caja-id=\"${safeHTML(group.cajaId)}\" title=\"Iniciar\"><span class=\"material-icons text-[14px]\">play_arrow</span></button>\n          </div>`;
      }
    } else {
      actionsHTML = `<button class=\"btn btn-ghost btn-xs\" data-action=\"timer-start\" data-caja-id=\"${safeHTML(group.cajaId)}\" title=\"Iniciar\"><span class=\"material-icons text-[14px]\">play_arrow</span></button>`;
    }
    const categoriaBadges = Object.entries(group.categorias).sort().map(([k,v])=>`<span class=\"badge badge-ghost badge-xs\">${k} x${v}</span>`).join(' ');
    const codes = group.items.slice(0,8).map(it=>`<span class=\"badge badge-neutral badge-xs font-mono\" title=\"${safeHTML(it.codigo)}\">${safeHTML(it.codigo.slice(-6))}</span>`).join(' ');
    return `<div class=\"card bg-base-100 shadow-sm border border-base-200 p-2\" data-listo-caja=\"${safeHTML(group.lote)}\" data-caja-id=\"${safeHTML(group.cajaId)}\">\n      <div class=\"flex items-start justify-between mb-1\">\n        <span class=\"font-mono text-[10px]\">${safeHTML(group.lote)}</span>\n        <span class=\"badge badge-info badge-xs\">${group.items.length} items</span>\n      </div>\n      <div class=\"text-[10px] flex flex-wrap gap-1 mb-1\">${categoriaBadges||''}</div>\n      <div class=\"text-[10px] grid grid-cols-3 gap-1 mb-1\">${codes}</div>\n      <div class=\"flex items-center justify-between\">\n        <div class=\"text-[10px] opacity-80\">${badgeHTML}</div>\n        ${actionsHTML}\n      </div>\n    </div>`;
  }
  

  async function crearCaja(){
    if(scanBuffer.length===0){ alert('Agregue componentes primero.'); return; }
    disableBtn(sel.crearBtn, true);
    try{
  // Backend espera { rfids: [] }
  const res = await fetch('/operacion/acond/ensamblaje/create',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids: scanBuffer.map(s=> s.codigo) })});
      const json = await res.json();
      if(!res.ok) throw new Error(json.message || 'Error creando caja');
      // Reset buffer
      scanBuffer = [];
      refreshScanList();
      // Reload data to include the new caja
      await loadData();
    }catch(err){
      console.error('[Acond] crearCaja error:', err);
      alert(err.message || 'Error creando caja');
    }finally{ disableBtn(sel.crearBtn, false); }
  }

  function disableBtn(selector, flag){
    const btn = qs(selector);
    if(btn){ btn.disabled = !!flag; btn.classList.toggle('loading', !!flag); }
  }

  // ========================= TIMER ACTIONS =========================
  function askDurationSec(){
    let minStr = prompt('Duración en minutos para el cronómetro de la caja:', '30');
    if(minStr==null) return null;
    const mins = Number(minStr.trim());
    if(!Number.isFinite(mins) || mins<=0) return null;
    return Math.round(mins*60);
  }
  async function timerAction(id, action){
    let endpoint = '';
    if(action==='start') endpoint = '/operacion/acond/caja/timer/start';
    else if(action==='complete') endpoint = '/operacion/acond/caja/timer/complete';
    else if(action==='clear') endpoint = '/operacion/acond/caja/timer/clear';
    if(!endpoint) return;
    try{
      const payload = { caja_id: id };
      if(action==='start'){
        let dur = cajas.find(c=> String(c.id)===String(id))?.timer?.durationSec;
        if(!Number.isFinite(dur) || dur<=0){
          const sec = askDurationSec();
          if(sec==null){ // default 30 min si usuario cancela
            dur = 30*60;
          } else dur = sec;
        }
        payload.durationSec = dur;
      }
      const res = await fetch(endpoint,{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
      const json = await res.json();
      if(!res.ok) throw new Error(json.message||'Error timer');
      await loadData();
    }catch(err){
      console.error('[Acond] timerAction error:', err);
      alert(err.message || 'Error en timer');
    }
  }

  // ========================= EVENTS =========================
  function bindEvents(){
  // Toggle global (cards/text) afecta ambos bloques
  const btnCards = document.getElementById('btn-view-cards-global');
  const btnText = document.getElementById('btn-view-text-global');
  if(btnCards){ btnCards.addEventListener('click', ()=>{ if(viewMode!=='cards'){ viewMode='cards'; localStorage.setItem('acondViewMode','cards'); updateViewVisibility(); renderCajas(); renderListo(); }}); }
  if(btnText){ btnText.addEventListener('click', ()=>{ if(viewMode!=='table'){ viewMode='table'; localStorage.setItem('acondViewMode','table'); updateViewVisibility(); renderCajas(); renderListo(); }}); }

    // Filtro
  const filtro = qs(sel.filtroInput);
  if(filtro){ filtro.addEventListener('input', ()=>{ applyFilter(); updateCounts(); }); }
  const filtroListo = qs(sel.filtroListoInput);
  if(filtroListo){ filtroListo.addEventListener('input', ()=>{ renderListo(); updateCounts(); }); }

    // Scan form
    const form = qs(sel.scanForm);
    const input = qs(sel.scanInput);
    if(form && input){
      form.addEventListener('submit', e => { e.preventDefault(); processScan(input.value); input.value=''; input.focus(); });
    }

    // Buttons validar / crear
    const validar = qs(sel.validarBtn);
    if(validar){ validar.addEventListener('click', e => { e.preventDefault(); validarParcial(); }); }
    const crear = qs(sel.crearBtn);
    if(crear){ crear.addEventListener('click', e => { e.preventDefault(); crearCaja(); }); }

    // Delegation (remove scanned, timer actions, detalle)
    document.addEventListener('click', e => {
      const t = e.target;
      if(!(t instanceof HTMLElement)) return;

      // remove scanned item
      if(t.matches('[data-action="scan-remove"]')){
        const codigo = t.getAttribute('data-codigo');
        scanBuffer = scanBuffer.filter(s=> s.codigo !== codigo);
        refreshScanList();
      }

      // timer actions
      if(t.matches('[data-action="timer-start"]')){ const id=t.getAttribute('data-caja-id'); if(id) timerAction(id,'start'); }
      if(t.matches('[data-action="timer-complete"]')){ const id=t.getAttribute('data-caja-id'); if(id) timerAction(id,'complete'); }
      if(t.matches('[data-action="timer-clear"]')){ const id=t.getAttribute('data-caja-id'); if(id) timerAction(id,'clear'); }

      // detalle
      if(t.matches('[data-action="detalle"]')){ openCajaDetalle(t.getAttribute('data-caja-id')); }

      // Click directo en tarjeta o fila para abrir detalle (evitar si se clickeó un botón dentro)
      const cardEl = t.closest('.caja-card');
      if(cardEl && !t.closest('button') && cardEl.hasAttribute('data-caja-id')){
        openCajaDetalle(cardEl.getAttribute('data-caja-id'));
      }
      const rowEl = t.closest('tr[data-caja-id]');
      if(rowEl && !t.closest('button')){
        openCajaDetalle(rowEl.getAttribute('data-caja-id'));
      }

      // Cerrar modal detalle
      if(t.matches('[data-close="detalle"]') || t.closest('[data-close="detalle"]')){
        closeCajaDetalle();
      }

      // close modal
      if(t.matches(sel.modalClose) || t.closest(sel.modalClose)){
        closeCajaDetalle();
      }
    });

    // Close modal on backdrop click if using label/checkbox pattern not present -> manual fallback
    const modal = qs(sel.modal);
    if(modal){
      modal.addEventListener('click', e => { if(e.target === modal) closeCajaDetalle(); });
    }
  }

  // ========================= INIT =========================
  function init(){
    renderInitialLoading();
    bindEvents();
    refreshScanList();
  setupLegacyModal(); // activa soporte para los botones "Agregar Items"
    loadData();
    startPolling();
  updateViewVisibility();
  }

  // Wait DOM
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
  // ========================= LEGACY / NUEVO MODAL DE ENSAMBLAJE =========================
  // El markup existe en la vista (dialog#modal-ensam). Aquí gestionamos escaneo y validación.
  function setupLegacyModal(){
  const openBtns = [document.getElementById('btn-add-ensam')].filter(Boolean);
    const dialog = document.getElementById('modal-ensam');
    if(!dialog || openBtns.length===0) return; // nada que hacer
    const scanInput = document.getElementById('scan-box');
    const msg = document.getElementById('msg-ensam');
    const listTic = document.getElementById('list-tic');
    const listVip = document.getElementById('list-vip');
    const listCube = document.getElementById('list-cube');
    const ticCount = document.getElementById('tic-count');
    const vipCount = document.getElementById('vip-count');
    const cubeCount = document.getElementById('cube-count');
    const hint = document.getElementById('scan-hint');
    const horas = document.getElementById('ensam-hr');
    const minutos = document.getElementById('ensam-min');
    const crearBtn = document.getElementById('btn-crear-caja');
    const limpiarBtn = document.getElementById('btn-clear-ensam');

    const ticSet = new Set();
    const vipSet = new Set();
    const cubeSet = new Set();

    function renderLists(){
      if(listTic) listTic.innerHTML = [...ticSet].map(r=>`<li class="px-2 py-1 bg-base-200 rounded text-xs font-mono truncate">${r}</li>`).join('');
      if(listVip) listVip.innerHTML = [...vipSet].map(r=>`<li class="px-2 py-1 bg-base-200 rounded text-xs font-mono truncate">${r}</li>`).join('');
      if(listCube) listCube.innerHTML = [...cubeSet].map(r=>`<li class="px-2 py-1 bg-base-200 rounded text-xs font-mono truncate">${r}</li>`).join('');
    }
    function compComplete(){ return ticSet.size===6 && vipSet.size===1 && cubeSet.size===1; }
    function durationMinutes(){
      const h = Number(horas?.value||'0');
      const m = Number(minutos?.value||'0');
      return (isFinite(h)?h:0)*60 + (isFinite(m)?m:0);
    }
    function updateStatus(){
      if(ticCount) ticCount.textContent = `${ticSet.size} / 6`;
      if(vipCount) vipCount.textContent = `${vipSet.size} / 1`;
      if(cubeCount) cubeCount.textContent = `${cubeSet.size} / 1`;
      const faltTic = Math.max(0, 6 - ticSet.size);
      const faltVip = Math.max(0, 1 - vipSet.size);
      const faltCube = Math.max(0, 1 - cubeSet.size);
      if(hint) hint.textContent = compComplete() ? 'Composición completa. Indica duración y crea la caja.' : `Faltan: ${faltTic} TIC · ${faltVip} VIP · ${faltCube} CUBE`;
      if(crearBtn) crearBtn.disabled = !(compComplete() && durationMinutes()>0);
    }
    function resetAll(){ ticSet.clear(); vipSet.clear(); cubeSet.clear(); renderLists(); updateStatus(); if(msg) msg.textContent=''; }

    async function validateAll(last){
      const rfids = [...ticSet, ...vipSet, ...cubeSet];
      if(last && !rfids.includes(last)) rfids.push(last);
      if(rfids.length===0 && !last) return;
      try {
        const res = await fetch('/operacion/acond/ensamblaje/validate',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids })});
        const json = await res.json();
        if(!res.ok || !json.ok) throw new Error(json.error||'Error validando');
  // Nuevo backend devuelve { ok:true, counts:{...}, roles:[ { rfid, rol } ] }
  const roles = Array.isArray(json.roles) ? json.roles : [];
  // Limpiar sets y reconstruir desde roles válidos
  ticSet.clear(); vipSet.clear(); cubeSet.clear();
        roles.forEach(v=>{ if(v.rol==='tic') ticSet.add(v.rfid); else if(v.rol==='vip') vipSet.add(v.rfid); else if(v.rol==='cube') cubeSet.add(v.rfid); });
        renderLists(); updateStatus();
        if(msg) msg.textContent='';
        if(Array.isArray(json.invalid) && json.invalid.length){
          // Buscar si el último escaneado está inválido
            const inv = last ? json.invalid.find(i=>i.rfid===last) : null;
            if(inv && msg) msg.textContent = `${inv.rfid}: ${inv.reason}`;
        }
        console.debug('[Ensamblaje] Validación OK', json);
      } catch(e){ if(msg) msg.textContent = e.message||'Error'; }
    }
    function handleScan(force){
      if(!scanInput) return;
      let raw = (scanInput.value||'').trim().toUpperCase();
      if(!raw) return;
      if(raw.length===24 || force){
        validateAll(raw); scanInput.value='';
      } else if(raw.length>24){
        let i=0; while(i+24<=raw.length){ validateAll(raw.slice(i,i+24)); i+=24; }
        scanInput.value = raw.slice(i);
      }
    }
    scanInput?.addEventListener('input', ()=>handleScan(false));
    scanInput?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); handleScan(true); }});
    horas?.addEventListener('input', updateStatus);
    minutos?.addEventListener('input', updateStatus);
    limpiarBtn?.addEventListener('click', ()=>{ resetAll(); scanInput?.focus(); });
    crearBtn?.addEventListener('click', async ()=>{
      if(crearBtn.disabled) return;
      const rfids = [...ticSet, ...vipSet, ...cubeSet];
      if(rfids.length!==8){ if(msg) msg.textContent='Composición incompleta'; return; }
      const durMin = durationMinutes();
      if(durMin<=0){ if(msg) msg.textContent='Duración inválida'; return; }
      crearBtn.disabled = true; if(msg) msg.textContent='Creando caja...';
      try {
        const res = await fetch('/operacion/acond/ensamblaje/create',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids })});
        const json = await res.json();
        if(!res.ok || !json.ok) throw new Error(json.error||'Error creando caja');
        // Inicia cronómetro inmediatamente
        try { await fetch('/operacion/acond/caja/timer/start',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: json.caja_id, durationSec: durMin*60 })}); } catch(e){ console.warn('No se pudo iniciar timer', e); }
        if(msg) msg.textContent = `Caja ${json.lote} creada`;
        await loadData();
  setTimeout(()=>{ try { dialog.close(); } catch { } }, 700);
      } catch(e){ if(msg) msg.textContent = e.message || 'Error creando'; }
      finally { crearBtn.disabled=false; }
    });

  openBtns.forEach(b=> b.addEventListener('click', ()=>{ try { dialog.showModal(); } catch { dialog.classList.remove('hidden'); } resetAll(); scanInput?.focus(); }));
  }

  // ========================= MODAL DESPACHO =========================
  (function setupDespachoModal(){
    const btn = document.getElementById('btn-add-listo');
    const dialog = document.getElementById('modal-despacho');
    if(!btn || !dialog) return;
    const input = document.getElementById('despacho-scan');
    const summary = document.getElementById('despacho-summary');
    const msg = document.getElementById('despacho-msg');
    const confirmBtn = document.getElementById('btn-despacho-confirm');
    let lastCajaId = null; let lastRfid = '';
    function reset(){ lastCajaId=null; lastRfid=''; if(summary){ summary.classList.add('hidden'); summary.innerHTML=''; } if(msg) msg.textContent=''; if(confirmBtn) confirmBtn.disabled=true; if(input) input.value=''; }
    async function lookup(code){
      if(!code || code.length!==24) return; if(msg) msg.textContent='Buscando caja...';
      try {
        const r = await fetch('/operacion/acond/despacho/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfid: code })});
        const j = await r.json();
        if(!j.ok){ if(msg) msg.textContent = j.error||'Error'; if(confirmBtn) confirmBtn.disabled=true; return; }
        lastCajaId = j.caja_id; lastRfid = code;
        if(summary){
          summary.innerHTML = `<div class='mb-2'><strong>Caja:</strong> ${j.lote} (ID ${j.caja_id})</div>
            <div class='mb-2'>Componentes (${j.total}):<div class='mt-1 grid grid-cols-2 gap-1 max-h-40 overflow-auto'>${(j.rfids||[]).map(rf=>`<span class='badge badge-ghost badge-xs font-mono'>${rf}</span>`).join('')}</div></div>
            <div class='opacity-70'>Pendientes por marcar: ${j.pendientes}</div>`;
          summary.classList.remove('hidden');
        }
        if(msg) msg.textContent='';
        if(confirmBtn) confirmBtn.disabled = false;
      } catch(e){ if(msg) msg.textContent='Error lookup'; }
    }
    input?.addEventListener('input', ()=>{ const v=input.value.replace(/\s+/g,''); if(v.length===24){ lookup(v); } });
  // Enforce máximo 24
  input?.addEventListener('input', ()=>{ if(input.value.length>24){ input.value = input.value.slice(0,24); } });
    input?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); const v=input.value.trim(); if(v.length===24) lookup(v); }});
    confirmBtn?.addEventListener('click', async ()=>{
      if(!lastCajaId || !lastRfid) return; confirmBtn.disabled=true; if(msg) msg.textContent='Marcando...';
      try {
        const r = await fetch('/operacion/acond/despacho/move',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfid: lastRfid })});
        const j = await r.json();
        if(!j.ok){ if(msg) msg.textContent=j.error||'Error'; confirmBtn.disabled=false; return; }
        if(msg) msg.textContent='Caja marcada lista.';
        await loadData();
        setTimeout(()=>{ try { dialog.close(); } catch{} }, 600);
      } catch(e){ if(msg) msg.textContent='Error moviendo'; confirmBtn.disabled=false; }
    });
    btn.addEventListener('click', ()=>{ try { dialog.showModal(); } catch { dialog.classList.remove('hidden'); } reset(); setTimeout(()=>input?.focus(),50); });
    dialog?.addEventListener('close', reset);
  })();
})();
