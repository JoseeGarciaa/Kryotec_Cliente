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
  // Focus by caja when scanning a single RFID
  let focusEnsCajaId = null;   // string|number|null
  let focusListoCajaId = null; // string|number|null
  const ubicacionesCache = { data: null, promise: null };
  let ensamZonaId = '';
  let ensamSeccionId = '';

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
  // Parse 24-char RFID chunks (supports raw gun bursts and mixed separators)
  function parseRfids(raw){
    const s = String(raw||'').toUpperCase().replace(/\s+/g,'');
    const out = [];
    for(let i=0;i+24<=s.length;i+=24){ out.push(s.slice(i,i+24)); }
    const rx=/[A-Z0-9]{24}/g; let m; while((m=rx.exec(s))){ const c=m[0]; if(!out.includes(c)) out.push(c); }
    return out;
  }

  function buildDefaultSedePrompt(data){
    if(data && typeof data.confirm === 'string' && data.confirm.trim()){ return data.confirm; }
    if(data && typeof data.error === 'string' && data.error.trim()){ return data.error; }
    return 'Las piezas seleccionadas pertenecen a otra sede. ¿Deseas trasladarlas a esta sede?';
  }

  async function postJSONWithSedeTransfer(url, body, options){
    const opts = options || {};
    const headers = Object.assign({ 'Content-Type':'application/json' }, opts.headers || {});
    const confirmFn = typeof opts.confirmFn === 'function' ? opts.confirmFn : (message) => window.confirm(message);
    const promptBuilder = typeof opts.promptMessage === 'function' ? opts.promptMessage : buildDefaultSedePrompt;

    const send = async (allowTransfer) => {
      const payload = allowTransfer ? Object.assign({}, body, { allowSedeTransfer: true }) : Object.assign({}, body);
      try {
        const res = await fetch(url, { method:'POST', headers, body: JSON.stringify(payload) });
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        return { httpOk: res.ok, status: res.status, data };
      } catch(err){
        return {
          httpOk: false,
          status: 0,
          data: { ok:false, error: err?.message || 'Error de red' },
          networkError: err
        };
      }
    };

    let attempt = await send(false);
    if(!attempt.httpOk && attempt.data && attempt.data.code === 'SEDE_MISMATCH'){
      const prompt = promptBuilder(attempt.data);
      const proceed = confirmFn ? await confirmFn(prompt, attempt.data) : false;
      if(!proceed){
        return Object.assign({ cancelled: true }, attempt);
      }
      attempt = await send(true);
    }
    return Object.assign({ cancelled: false }, attempt);
  }

  const atemperamientoCache = { map: new Map(), fetchedAt: 0, pending: null };
  const ATEMP_CACHE_TTL_MS = 30000;

  function resetAtemperamientoCache(){
    atemperamientoCache.map = new Map();
    atemperamientoCache.fetchedAt = 0;
    atemperamientoCache.pending = null;
  }

  async function loadAtemperamientoMap(force){
    if(!force){
      if(atemperamientoCache.pending) return atemperamientoCache.pending;
      if(atemperamientoCache.map.size && (Date.now() - atemperamientoCache.fetchedAt) < ATEMP_CACHE_TTL_MS){
        return atemperamientoCache.map;
      }
    }
    const fetchPromise = (async ()=>{
      try {
        const res = await fetch('/operacion/preacond/data', { headers:{ 'Accept':'application/json' } });
        let data;
        try { data = await res.json(); } catch(parseErr){
          throw new Error('Respuesta no valida al consultar preacondicion');
        }
        if(!res.ok || data?.ok === false){
          throw new Error((data && data.error) || 'Error consultando preacondicion');
        }
        const map = new Map();
        if(Array.isArray(data?.atemperamiento)){
          data.atemperamiento.forEach(item => {
            const code = String(item?.rfid || '').toUpperCase();
            if(code) map.set(code, item);
          });
        }
        atemperamientoCache.map = map;
        atemperamientoCache.fetchedAt = Date.now();
        return map;
      } finally {
        atemperamientoCache.pending = null;
      }
    })();
    atemperamientoCache.pending = fetchPromise;
    return fetchPromise;
  }

  async function getAtemperamientoInfo(code){
    if(!code) return null;
    try {
      const map = await loadAtemperamientoMap(false);
      return map.get(String(code).toUpperCase()) || null;
    } catch(err){
      console.error('[Acond] No se pudo consultar Atemperamiento', err);
      return null;
    }
  }

  async function completeAtemperamientoTimer(code){
    const res = await fetch('/operacion/preacond/item-timer/complete', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ section:'atemperamiento', rfid: code })
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    if(!res.ok || (json && json.ok === false)){
      const msg = (json && json.error) || 'No se pudo completar el cronometro';
      throw new Error(msg);
    }
    resetAtemperamientoCache();
  }

  async function maybeResolveAtemperamiento(code, opts){
    const options = opts || {};
    const info = await getAtemperamientoInfo(code);
    if(!info) return true;
    const sub = String(info.sub_estado||'').toLowerCase();
    if(sub !== 'atemperamiento') return true;
    const active = info.item_active === true || info.active === true;
    const hasTimer = active || (!!info.started_at && Number(info.duration_sec || 0) > 0);
    if(!hasTimer) return true;
    const confirmMessage = typeof options.confirmMessage === 'function'
      ? options.confirmMessage(code, info)
      : `El TIC ${code} esta en Atemperamiento con cronometro activo. Deseas completarlo para usarlo en Acondicionamiento?`;
    const confirmFn = typeof options.confirmFn === 'function' ? options.confirmFn : null;
    const proceed = confirmFn ? await confirmFn(confirmMessage, code, info) : window.confirm(confirmMessage);
    if(!proceed){
      if(typeof options.onCancel === 'function') options.onCancel();
      return false;
    }
    try {
      await completeAtemperamientoTimer(code);
      if(typeof options.onComplete === 'function') options.onComplete();
      return true;
    } catch(err){
      if(typeof options.onError === 'function') options.onError(err);
      else alert(err?.message || 'No se pudo completar el cronometro');
      return false;
    }
  }
  function ensureTableWhenMulti(isMulti){
    if(isMulti && viewMode !== 'table'){
      viewMode = 'table';
      try { localStorage.setItem('acondViewMode','table'); } catch {}
      updateViewVisibility();
    }
  }

  // ========================= INITIAL RENDER HELPERS =========================
  function renderInitialLoading(){
    const body = qs(sel.contListo);
    if(body){
  body.innerHTML = `<tr><td colspan="3" class="text-center py-6 text-sm text-gray-400">Cargando...</td></tr>`;
    }
    // Loading para vista en cards de Lista para Despacho
    const listoGrid = qs(sel.contListoCards);
    if(listoGrid){
      listoGrid.innerHTML = `<div class="col-span-full flex flex-col items-center gap-3 py-10 opacity-70">
        <span class="loading loading-spinner loading-md"></span>
        <span class="text-sm">Cargando lista despacho...</span>
      </div>`;
    }
    const gridCajas = qs(sel.contCajas);
    if(gridCajas){
      gridCajas.innerHTML = `<div class="col-span-full flex flex-col items-center gap-3 py-10 opacity-70">
        <span class="loading loading-spinner loading-md"></span>
        <span class="text-sm">Cargando cajas...</span>
      </div>`;
    }
    const cajasTableBody = qs(sel.contCajasTabla);
    if(cajasTableBody){
      cajasTableBody.innerHTML = `<tr><td colspan="3" class="text-center py-8 text-sm opacity-60">Cargando cajas...</td></tr>`;
    }
  }

  function renderListoEmpty(){
    const body = qs(sel.contListo);
    if(body){
  body.innerHTML = `<tr><td colspan="3" class="text-center py-8 text-sm opacity-60">No hay cajas</td></tr>`;
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
  const raw = (qs(sel.filtroListoInput)?.value || '');
  const firstRfid = parseRfids(raw)[0] || '';
  const filterValue = raw.trim().toLowerCase();
  // If a single RFID is scanned, derive caja_id and show the whole caja group
  if(firstRfid){
    const hit = listoDespacho.find(i => String(i.codigo||'').toUpperCase() === firstRfid);
    focusListoCajaId = hit ? (hit.caja_id || hit.cajaId || hit.cajaID) : null;
  } else {
    focusListoCajaId = null;
  }
  const filtered = focusListoCajaId != null
    ? listoDespacho.filter(i => String(i.caja_id||i.cajaId||i.cajaID) === String(focusListoCajaId))
    : (filterValue ? listoDespacho.filter(i => (i.codigo||'').toLowerCase().includes(filterValue) || (i.nombre||'').toLowerCase().includes(filterValue) || (i.lote||'').toLowerCase().includes(filterValue)) : listoDespacho);
  listoTotalCount = listoDespacho.length;
  listoFilteredCount = filtered.length;
  const rows = filtered.map(item => {
    const cajaIdRef = item.caja_id || item.cajaId || item.cajaID;
    const t = item.cronometro;
    // Derivar estado sin mostrar controles de timer por fila
    let estadoTxt = 'Lista para Despacho';
    if(t && t.startsAt && t.endsAt){
      const now = Date.now() + serverNowOffsetMs; const end = new Date(t.endsAt).getTime();
  if(now < end) estadoTxt = 'Despachando';
    }
    return `<tr class="hover" data-caja-id="${safeHTML(cajaIdRef || '')}">\n      <td class="text-sm font-mono">${safeHTML(item.lote || '')}</td>\n      <td class="text-sm flex flex-col leading-tight">\n        <span class="uppercase tracking-wide">${safeHTML(item.nombre || '')}</span>\n        <span class="font-mono text-xs opacity-40">${safeHTML(item.codigo || '')}</span>\n      </td>\n      <td class="text-sm">${safeHTML(estadoTxt)}</td>\n    </tr>`;
  }).join('');
        body.innerHTML = rows;
      }
    }
    if(grid){
      if(!listoDespacho || listoDespacho.length===0){
  grid.innerHTML = '<div class="col-span-full py-10 text-center text-sm opacity-60">No hay cajas</div>';
      } else {
  const raw = (qs(sel.filtroListoInput)?.value || '');
  const firstRfid = parseRfids(raw)[0] || '';
  const filterValue = raw.trim().toLowerCase();
  const filtered = focusListoCajaId != null
    ? listoDespacho.filter(i => String(i.caja_id||i.cajaId||i.cajaID) === String(focusListoCajaId))
    : (filterValue ? listoDespacho.filter(i => (i.codigo||'').toLowerCase().includes(filterValue) || (i.nombre||'').toLowerCase().includes(filterValue) || (i.lote||'').toLowerCase().includes(filterValue)) : listoDespacho);
  // Agrupar por caja_id para evitar colisión cuando dos cajas comparten mismo lote
  const groupsMap = new Map();
  filtered.forEach(it=>{
    const cajaId = it.caja_id || it.cajaId || it.cajaID || it.caja; // caja_id numérico real
    const key = cajaId ? `id:${cajaId}` : `lote:${it.lote}`; // fallback a lote sólo si no hay id
    if(!groupsMap.has(key)) groupsMap.set(key, { lote: it.lote, cajaId: cajaId || it.lote, timers: [], componentes: [], categorias: {} });
    const g = groupsMap.get(key);
    // Colectar timer (puede repetirse, tomaremos primero válido)
    if(it.cronometro && it.cronometro.startsAt && it.cronometro.endsAt){ g.timers.push(it.cronometro); }
    const tipo = (it.categoria||'').toLowerCase();
    g.componentes.push({ tipo, codigo: it.codigo });
    g.categorias[tipo] = (g.categorias[tipo]||0)+1;
  });
  const groups = Array.from(groupsMap.values()).map(g=>{
    // Consolidar timer único
    const t = g.timers.find(ti=> ti && ti.startsAt && ti.endsAt) || null;
    return { ...g, timers: t? [t]: [], timer: t };
  });
    // Reusar cajaCardHTML adaptando estructura a la esperada (id, codigoCaja, estado, timer, componentes)
    grid.innerHTML = groups.map(g => {
      const fakeCaja = {
        id: g.cajaId,
        codigoCaja: g.lote || ('CAJA-'+g.cajaId),
        estado: 'Lista para Despacho',
        timer: g.timer ? { startsAt: g.timer.startsAt, endsAt: g.timer.endsAt, completedAt: g.timer.completedAt } : null,
        componentes: g.componentes
      };
      return cajaCardHTML(fakeCaja);
    }).join('');
      }
    }
  }

  // ========================= RENDER FUNCTIONS (CAJAS) =========================
  function renderCajas(){
  const contCards = qs(sel.contCajas);
  const contTableBody = qs(sel.contCajasTabla);
  if(!contCards || !contTableBody) return;

    // Filter (client-side) by text if filter input present
  const raw = (qs(sel.filtroInput)?.value || '');
  const firstRfid = parseRfids(raw)[0] || '';
  const filterValue = raw.trim().toLowerCase();
  // Determine caja focus by RFID of any component
  if(firstRfid){
    const hit = cajas.find(c => (c.componentes||[]).some(cc => String(cc.codigo||'').toUpperCase() === firstRfid));
    focusEnsCajaId = hit ? hit.id : null;
  } else {
    focusEnsCajaId = null;
  }
  const filtered = focusEnsCajaId != null
    ? cajas.filter(c => String(c.id) === String(focusEnsCajaId))
    : (filterValue ? cajas.filter(c => (c.codigoCaja||'').toLowerCase().includes(filterValue) || (c.componentes||[]).some(cc => String(cc.codigo||'').toLowerCase().includes(filterValue))) : cajas.slice());

  // Contar componentes totales y filtrados
  totalComponentCount = cajas.reduce((acc,c)=> acc + ((c.componentes||[]).length || 0), 0);
  if(focusEnsCajaId != null){
    lastFilteredComponentCount = filtered.reduce((acc,c)=> acc + ((c.componentes||[]).length || 0), 0);
  } else if(filterValue){
    lastFilteredComponentCount = filtered.reduce((acc,c)=> acc + (c.componentes||[]).filter(cc => String(cc.codigo||'').toLowerCase().includes(filterValue)).length, 0);
    if(lastFilteredComponentCount===0){ lastFilteredComponentCount = filtered.reduce((acc,c)=> acc + ((c.componentes||[]).length||0), 0); }
  } else {
    lastFilteredComponentCount = filtered.reduce((acc,c)=> acc + ((c.componentes||[]).length || 0), 0);
  }

    // Cards view
  contCards.innerHTML = filtered.map(c => cajaCardHTML(c)).join('');
  if(!filtered.length){
    contCards.innerHTML = `<div class="col-span-full py-10 text-center text-sm opacity-60">No hay cajas</div>`;
  }

  // Table rows (una fila por componente para evitar agrupado de RFIDs)
  const tableRows = [];
  const compFilterSet = null; // when focusing by caja, show all its components; otherwise fallback by text below
  filtered.forEach(c => { tableRows.push(...cajaRowsHTML(c, compFilterSet, focusEnsCajaId==null ? filterValue : null)); });
  if(tableRows.length){
    contTableBody.innerHTML = tableRows.join('');
  } else {
    contTableBody.innerHTML = `<tr><td colspan="3" class="text-center py-8 text-sm opacity-60">No hay cajas</td></tr>`;
  }
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
          <span id='tm-caja-${safeHTML(c.id)}' class='font-mono whitespace-nowrap tabular-nums'>${timerText}</span>
          <button class='btn btn-ghost btn-xs px-1 h-4 shrink-0 stop-caja-timer' data-caja='${safeHTML(c.id)}' title='Cancelar'>✕</button>
        </span>`;
    } else if(c.timer && c.timer.completedAt){
  timerBadge = `<span class='badge badge-success badge-xs'>Listo</span>`;
    } else {
      // Si el sub_estado de todos los componentes es Ensamblado (o caja ya está Ensamblado) mostrar 'Listo'
      const allEnsamblado = (c.componentes||[]).length>0 ? (c.componentes.every(()=> true) && (c.estado==='Ensamblado' || /Ensamblado/i.test(c.sub_estado||''))) : /Ensamblado/i.test(c.sub_estado||c.estado||'');
      if(allEnsamblado || /Ensamblado/i.test(c.estado||'')){
        timerBadge = `<span class='badge badge-success badge-xs'>Listo</span>`;
      } else {
        // Sin cronómetro: ofrecer botón para iniciarlo nuevamente
        timerBadge = `
          <span class='badge badge-outline badge-xs opacity-60'>Sin cronómetro</span>
          <button class='btn btn-ghost btn-xs px-1 h-4 shrink-0' data-action='timer-start' data-caja-id='${safeHTML(c.id)}' title='Iniciar'>▶</button>
        `;
      }
    }
    const pct = Math.min(100, Math.max(0, progress));
    // Mostrar identificador: usar c.codigoCaja (lote) completo abreviado si muy largo
    const fullCode = c.codigoCaja || '';
    let rightId = '';
    if(fullCode.startsWith('CAJA-')){
      rightId = fullCode; // nuevo patrón CAJA-ddMMyyyy-XXXXX
    } else if(/^CAJA\d+/i.test(fullCode)){
      rightId = fullCode.split('-')[0];
    } else if(c.id != null){
      rightId = '#'+c.id;
    }
  return `<div class='caja-card rounded-lg border border-base-300/40 bg-base-200/10 p-3 flex flex-col gap-2 hover:border-primary/60 transition' data-caja-id='${safeHTML(c.id)}'>
        <div class='flex items-center justify-between text-[10px] tracking-wide uppercase opacity-60'>
          <span>Caja</span><span class='font-mono'>${safeHTML(rightId)}</span>
        </div>
  <div class='font-semibold text-xs leading-tight break-all pr-2' title='${safeHTML(fullCode||'Caja')}'>${safeHTML(fullCode||'Caja')}</div>
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

  function cajaRowsHTML(c, set /* Set<string> | null */, fallbackTextFilter /* string | null */){
    const remaining = msRemaining(c);
    const progress = timerProgressPct(c);
    const timerText = timerDisplay(remaining, c.timer?.completedAt);
    const comps = (c.componentes||[]);
    if(!comps.length){
  // Vista simplificada: sin cronómetro por componente/caja en tabla de Ensamblaje
  return [ `<tr class="hover" data-caja-id="${safeHTML(c.id)}">\n        <td class="text-sm font-mono">${safeHTML(c.codigoCaja||'')}</td>\n        <td class="text-sm opacity-60">(sin items)</td>\n        <td class="text-sm">${safeHTML(c.estado||'')}</td>\n      </tr>` ];
    }
    return comps.filter(cc => {
      if(set && set.size){ return set.has(String(cc.codigo||'').toUpperCase()); }
      if(fallbackTextFilter){ return String(cc.codigo||'').toLowerCase().includes(fallbackTextFilter); }
      return true;
    }).map(cc => {
  // Fila sin columna de cronómetro (solo caja, componente y estado)
  return `<tr class="hover" data-caja-id="${safeHTML(c.id)}">\n        <td class="text-sm font-mono">${safeHTML(c.codigoCaja||'')}</td>\n        <td class="text-sm flex flex-col leading-tight">\n          <span class="uppercase tracking-wide">${safeHTML(cc.tipo||cc.nombre||'')}</span>\n          <span class="font-mono text-xs opacity-40">${safeHTML(cc.codigo)}</span>\n        </td>\n        <td class="text-sm">${safeHTML(c.estado||'')}</td>\n      </tr>`;
    });
  }

  // Controles estilo tabla (similar a preacond) dependiendo del estado del timer
  function timerTableControlsHTML(c){
    if(!c.timer || (!c.timer.startsAt && !c.timer.endsAt)){
      // No iniciado
      return `<button class="btn btn-ghost btn-xs text-success" title="Iniciar" data-action="timer-start" data-caja-id="${safeHTML(c.id)}">\n        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>\n      </button>`;
    }
    if(c.timer && c.timer.completedAt){
  return `<span class="inline-flex items-center justify-center text-success" title="Listo">\n        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>\n      </span>`;
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
  if(completedAt) return 'Listo';
    if(remainingMs <= 0) return 'Finalizado';
    const totalSec = Math.floor(remainingMs/1000);
    const hours = Math.floor(totalSec/3600);
    const minutes = Math.floor((totalSec % 3600)/60);
    const seconds = totalSec % 60;
    // Always show HH:MM:SS (hours grows without cap for long timers)
    const hh = String(hours).padStart(2,'0');
    const mm = String(minutes).padStart(2,'0');
    const ss = String(seconds).padStart(2,'0');
    return `${hh}:${mm}:${ss}`;
  }

  function timerBadgeHTML(c, remaining){
    if(!c.timer) return '<span class="badge badge-ghost badge-xs">Sin timer</span>';
  if(c.timer.completedAt) return '<span class="badge badge-success badge-xs">Listo</span>';
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
    updateCounts();
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
  body.innerHTML = `<tr><td colspan="3" class="text-center py-6 text-error text-xs">${safeHTML(err.message||'Error cargando')}</td></tr>`;
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
  const remMs = end-now; const sec = Math.max(0, Math.floor(remMs/1000));
  const h = Math.floor(sec/3600); const m = Math.floor((sec%3600)/60); const s = sec%60;
  const hh = String(h).padStart(2,'0'); const mm = String(m).padStart(2,'0'); const ss = String(s).padStart(2,'0');
  el.textContent = `${hh}:${mm}:${ss}`;
        let cls='badge-info'; if(sec<=60) cls='badge-error'; else if(sec<=300) cls='badge-warning';
        el.className = `badge ${cls} badge-xs font-mono`;
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
        let caja = cajas.find(c=> String(c.id) === String(id));
        // Si no está en ensamblaje, intentar mapear timer desde listoDespacho
        if(!caja){
          const dispItems = listoDespacho.filter(it=> String(it.caja_id)===String(id));
          if(dispItems.length){
            const tIt = dispItems.find(it=> it.cronometro && (it.cronometro.startsAt||it.cronometro.endsAt));
            caja = { id, timer: tIt ? { startsAt: tIt.cronometro.startsAt, endsAt: tIt.cronometro.endsAt, completedAt: tIt.cronometro.completedAt } : null };
          }
        }
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
      // Timers de despacho en tarjetas agrupadas (data-timer-chrono)
      document.querySelectorAll('[data-timer-chrono]').forEach(el=>{
        if(!(el instanceof HTMLElement)) return;
        const cajaId = el.getAttribute('data-caja-id');
        if(!cajaId) return;
        const items = listoDespacho.filter(it=> String(it.caja_id)===String(cajaId));
        const tIt = items.find(it=> it.cronometro && (it.cronometro.startsAt||it.cronometro.endsAt));
        if(!tIt || !tIt.cronometro.startsAt || !tIt.cronometro.endsAt) return;
        const now = Date.now() + serverNowOffsetMs;
        const end = new Date(tIt.cronometro.endsAt).getTime();
        const label = el.getAttribute('data-label');
        if(now>=end){ el.textContent = label? `${label} 00:00:00` : 'Finalizado'; el.classList.remove('badge-error','badge-warning','badge-info'); el.classList.add('badge-warning'); return; }
        const remSec = Math.max(0, Math.floor((end-now)/1000));
        const h=Math.floor(remSec/3600), m=Math.floor((remSec%3600)/60), s=remSec%60;
        el.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        el.classList.remove('badge-error','badge-warning','badge-info');
        if(remSec<=60) el.classList.add('badge-error');
        else if(remSec<=300) el.classList.add('badge-warning');
        else el.classList.add('badge-info');
      });
  // Auto-completar cajas cuyo cronómetro llegó a cero
  autoCompleteTimers();
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

  // ========================= AUTO COMPLETE TIMERS =========================
  const autoCompleteFired = new Set();
  function autoCompleteTimers(){
    // Ensamblaje timers
    cajas.forEach(c => {
      if(!c.timer || c.timer.completedAt) return;
      const remaining = msRemaining(c);
      const key = 'ens-' + c.id;
      if(remaining <= 0 && !autoCompleteFired.has(key)){
        autoCompleteFired.add(key);
        fetch('/operacion/acond/caja/timer/complete', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: c.id })
        }).then(()=>{ loadData(); })
          .catch(()=>{ autoCompleteFired.delete(key); });
      }
    });
    // Despacho timers (cajas en Despachando dentro de listoDespacho)
    const dispatchTimers = new Map();
    listoDespacho.forEach(it=>{
      if(it.caja_id && it.cronometro && it.cronometro.startsAt && it.cronometro.endsAt && !it.cronometro.completedAt){
        // usamos el primero
        if(!dispatchTimers.has(it.caja_id)) dispatchTimers.set(it.caja_id, it.cronometro);
      }
    });
    dispatchTimers.forEach((t, cajaId)=>{
      const end = new Date(t.endsAt).getTime();
      const now = Date.now() + serverNowOffsetMs;
      const remaining = end - now;
      const key = 'desp-' + cajaId;
      if(remaining <= 0 && !autoCompleteFired.has(key)){
        autoCompleteFired.add(key);
        fetch('/operacion/acond/caja/timer/complete', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: cajaId })
        }).then(()=>{ loadData(); })
          .catch(()=>{ autoCompleteFired.delete(key); });
      }
    });
  }

  // ========================= MODAL DETALLE =========================
  // Nueva implementación alineada al markup real (#modal-caja-detalle)
  function openCajaDetalle(id){
    let caja = cajas.find(c=> String(c.id) === String(id));
    // Si no está en 'cajas' (ensamblaje), intentar construir desde lista para despacho
    if(!caja){
      let items = listoDespacho.filter(it => String(it.caja_id) === String(id));
      if(!items.length){
        // fallback: quizá el lote quedó pero filtrado; intentar por lote igual a id formateado
        items = listoDespacho.filter(it => String(it.lote) === String(id));
      }
      if(items.length){
        const tItem = items.find(it=> it.cronometro && (it.cronometro.startsAt || it.cronometro.endsAt));
        const anyEstado = items.find(it=> it.sub_estado) || {};
  const estado = /Despachando/i.test(anyEstado.sub_estado||'') ? 'Despachando' : 'Lista para Despacho';
        caja = {
          id,
          codigoCaja: items[0].lote || ('CAJA-'+id),
          estado,
          createdAt: null,
          timer: tItem ? { startsAt: tItem.cronometro.startsAt, endsAt: tItem.cronometro.endsAt, completedAt: tItem.cronometro.completedAt } : null,
          componentes: items.map(it=> ({ tipo: (it.categoria||'').toLowerCase(), codigo: it.codigo })),
          orderId: (tItem && (tItem.order_id!=null)) ? tItem.order_id : (items[0] && items[0].order_id!=null ? items[0].order_id : null),
          orderNumero: (tItem && tItem.order_num) ? tItem.order_num : (items[0] && items[0].order_num ? items[0].order_num : null)
        };
      }
    }
    if(!caja) return; // nada que mostrar
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
    // Orden vinculada (si existe)
    const ordenEl = document.getElementById('detalle-caja-orden');
    if(ordenEl){
      const num = caja.orderNumero || null;
      const idNum = caja.orderId || null;
      ordenEl.textContent = num ? String(num) : (idNum ? `#${idNum}` : '—');
      ordenEl.classList.toggle('opacity-60', !(num||idNum));
    }

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
        html = `<div class="flex items-center gap-2">
          <span class="text-sm opacity-60 italic">(Sin cronómetro)</span>
          <button class="btn btn-xs btn-primary" data-action="timer-start" data-caja-id="${safeHTML(caja.id)}">Iniciar</button>
        </div>`;
      } else if(caja.timer.completedAt){
  html = '<div class="badge badge-success badge-sm">Cronómetro Listo</div>';
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

  async function processScan(code){
    if(!code) return;
    const clean = String(code).trim().toUpperCase();
    if(!clean) return;
    if(scanBuffer.some(s=> s.codigo === clean)) return; // ignore duplicates
    const proceed = await maybeResolveAtemperamiento(clean);
    if(!proceed) return;
    scanBuffer.push({ codigo: clean });
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
  if(item.cronometro.completedAt || now >= end){ chrono='Listo'; }
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
        const remMs = end-now; const sec = Math.max(0, Math.floor(remMs/1000));
        const h = Math.floor(sec/3600); const m = Math.floor((sec%3600)/60); const s = sec%60;
        const hh = String(h).padStart(2,'0'); const mm = String(m).padStart(2,'0'); const ss = String(s).padStart(2,'0');
        const colorClass = sec<=60 ? 'badge-error' : (sec<=300 ? 'badge-warning' : 'badge-info');
  badgeHTML = `<span class=\"badge ${colorClass} badge-xs font-mono whitespace-nowrap tabular-nums\" data-timer-chrono data-label=\"Despachando\" data-caja-id=\"${safeHTML(group.cajaId)}\">${hh}:${mm}:${ss}</span>`;
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
  return `<div class=\"card bg-base-100 shadow-sm border border-base-200 p-2 cursor-pointer hover:border-primary/60 transition\" data-listo-caja=\"${safeHTML(group.lote)}\" data-caja-id=\"${safeHTML(group.cajaId)}\">\n      <div class=\"flex items-start justify-between mb-1 pointer-events-none\">\n        <span class=\"font-mono text-[10px]\">${safeHTML(group.lote)}</span>\n        <span class=\"badge badge-info badge-xs\">${group.items.length} items</span>\n      </div>\n      <div class=\"text-[10px] flex flex-wrap gap-1 mb-1 pointer-events-none\">${categoriaBadges||''}</div>\n      <div class=\"text-[10px] grid grid-cols-3 gap-1 mb-1 pointer-events-none\">${codes}</div>\n      <div class=\"flex items-center justify-between\">\n        <div class=\"text-[10px] opacity-80\">${badgeHTML}</div>\n        ${actionsHTML}\n      </div>\n    </div>`;
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
  // Prevent starting dispatch move here; separate flow ensures Ensamblado first.
    try{
      // Buscar referencia de caja en ambas colecciones (ensamblaje y despacho)
      let cajaRef = cajas.find(c=> String(c.id)===String(id));
      if(!cajaRef){
        const dispItems = listoDespacho.filter(it=> String(it.caja_id)===String(id));
        if(dispItems.length){
          const tIt = dispItems.find(it=> it.cronometro && (it.cronometro.startsAt||it.cronometro.endsAt));
          cajaRef = { id, timer: tIt ? { durationSec: tIt.cronometro.durationSec } : null };
        }
      }
      const payload = { caja_id: id };
      if(action==='start'){
        let dur = cajaRef?.timer?.durationSec;
        if(!Number.isFinite(dur) || dur<=0){
          const sec = askDurationSec();
          if(sec==null){ dur = 30*60; } else dur = sec;
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
  const filtroListo = qs(sel.filtroListoInput);
  let _fltTimerEns = 0, _fltTimerListo = 0;
  function scheduleEns(){ if(_fltTimerEns){ clearTimeout(_fltTimerEns); } _fltTimerEns = setTimeout(()=>{ _fltTimerEns=0; applyFilter(); }, 120); }
  function scheduleListo(){ if(_fltTimerListo){ clearTimeout(_fltTimerListo); } _fltTimerListo = setTimeout(()=>{ _fltTimerListo=0; renderListo(); updateCounts(); }, 120); }
  if(filtro){
    filtro.addEventListener('input', scheduleEns);
    filtro.addEventListener('paste', (e)=>{ const t=e.clipboardData?.getData('text')||''; if(t){ e.preventDefault(); filtro.value = (filtro.value||'') + t; scheduleEns(); } });
    filtro.addEventListener('keydown', (e)=>{ const k=e.key||e.code; if(k==='Enter'||k==='NumpadEnter'){ e.preventDefault(); scheduleEns(); } });
  }
  if(filtroListo){
    filtroListo.addEventListener('input', scheduleListo);
    filtroListo.addEventListener('paste', (e)=>{ const t=e.clipboardData?.getData('text')||''; if(t){ e.preventDefault(); filtroListo.value = (filtroListo.value||'') + t; scheduleListo(); } });
    filtroListo.addEventListener('keydown', (e)=>{ const k=e.key||e.code; if(k==='Enter'||k==='NumpadEnter'){ e.preventDefault(); scheduleListo(); } });
  }

    // Scan form
    const form = qs(sel.scanForm);
    const input = qs(sel.scanInput);
    if(form && input){
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const raw = (input.value || '').trim();
        input.value = '';
        if(!raw){ input.focus(); return; }
        await processScan(raw);
        input.focus();
      });
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
  // botón X dentro del badge (stop-caja-timer)
  if(t.classList.contains('stop-caja-timer')){ const id=t.getAttribute('data-caja'); if(id) timerAction(id,'clear'); }

      // mover a Lista para Despacho (solo Ensamblado)
  // (Botón mover-despacho retirado a solicitud del usuario)

      // detalle
      if(t.matches('[data-action="detalle"]')){ openCajaDetalle(t.getAttribute('data-caja-id')); }

      // Click directo en tarjeta o fila para abrir detalle (evitar si se clickeó un botón dentro)
      const cardEl = t.closest('.caja-card');
      if(cardEl && !t.closest('button') && cardEl.hasAttribute('data-caja-id')){
        openCajaDetalle(cardEl.getAttribute('data-caja-id'));
      }
      // click en tarjeta de Lista para Despacho (vista cards)
      const listoCajaEl = t.closest('[data-listo-caja]');
      if(listoCajaEl && !t.closest('button') && listoCajaEl.hasAttribute('data-caja-id')){
        openCajaDetalle(listoCajaEl.getAttribute('data-caja-id'));
      }
      const rowEl = t.closest('tr[data-caja-id]');
      if(rowEl && !t.closest('button')){
        openCajaDetalle(rowEl.getAttribute('data-caja-id'));
      }

      // Cerrar modal detalle SOLO si el click es directamente sobre el overlay
      // o en un botón que explícitamente tenga el atributo data-close="detalle".
      // (Antes se usaba closest() y cualquier click dentro cerraba el modal.)
      if(t.matches('[data-close="detalle"]')){
        // Si es el overlay (tiene el atributo) o el botón de cerrar también con el atributo
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
  // Ordenes
  const linkOrderChk = document.getElementById('ensam-link-order');
  const orderSelect = document.getElementById('ensam-order-select');
  const orderHint = document.getElementById('ensam-order-hint');
  const selectZona = document.getElementById('ensam-zona');
  const selectSeccion = document.getElementById('ensam-seccion');
  const locationHint = document.getElementById('ensam-location-hint');

  // Conjuntos de válidos por rol
  const ticSet = new Set();
  const vipSet = new Set();
  const cubeSet = new Set();
  // Buffer de escaneos (todos los códigos escaneados pendientes/validados)
  const scannedSet = new Set();
  let _validateTimer = 0;

    function setLocationMessage(text){ if(locationHint){ locationHint.textContent = text || ''; } }

    async function loadUbicaciones(){
      if(ubicacionesCache.data) return ubicacionesCache.data;
      if(!ubicacionesCache.promise){
        ubicacionesCache.promise = fetch('/inventario/ubicaciones', { headers:{ Accept:'application/json' } })
          .then((res)=> res.ok ? res.json() : null)
          .then((json)=>{
            const zonas = Array.isArray(json?.zonas) ? json.zonas : [];
            ubicacionesCache.data = zonas.map((z)=>({
              zona_id: z.zona_id,
              nombre: z.nombre,
              activa: z.activa,
              secciones: Array.isArray(z.secciones) ? z.secciones.map((s)=>({
                seccion_id: s.seccion_id,
                nombre: s.nombre,
                activa: s.activa,
              })) : [],
            }));
            return ubicacionesCache.data;
          })
          .catch((err)=>{
            console.error('[Acond] Error cargando ubicaciones', err);
            ubicacionesCache.data = [];
            return ubicacionesCache.data;
          })
          .finally(()=>{ ubicacionesCache.promise = null; });
      }
      return ubicacionesCache.promise;
    }

    function populateZonaSelect(selected){
      if(!selectZona) return;
      const zonas = ubicacionesCache.data || [];
      const opts = ['<option value="">Sin zona</option>'];
      zonas.forEach((z)=>{
        const label = safeHTML(z.nombre || `Zona ${z.zona_id}`) + (z.activa === false ? ' (inactiva)' : '');
        opts.push(`<option value="${safeHTML(z.zona_id)}">${label}</option>`);
      });
      selectZona.innerHTML = opts.join('');
      selectZona.disabled = zonas.length === 0;
      const desired = selected ? String(selected) : '';
      selectZona.value = desired;
      if(desired && selectZona.value !== desired){
        const opt = document.createElement('option');
        opt.value = desired;
        opt.textContent = `Zona ${desired}`;
        selectZona.appendChild(opt);
        selectZona.value = desired;
      }
      ensamZonaId = selectZona.value || '';
      if(zonas.length === 0){
        setLocationMessage('No hay zonas configuradas para tu sede.');
      }
    }

    function populateSeccionSelect(zonaId, selected){
      if(!selectSeccion) return;
      const zonas = ubicacionesCache.data || [];
      const opts = ['<option value="">Sin sección</option>'];
      let disable = false;
      let message = 'Selecciona una zona para listar las secciones disponibles (opcional).';

      if(!zonas.length){
        disable = true;
        message = 'No hay zonas configuradas para tu sede.';
      } else if(!zonaId){
        disable = true;
      } else {
        const zona = zonas.find((z)=> String(z.zona_id) === String(zonaId));
        if(!zona){
          disable = true;
          message = 'Zona no disponible para tu sede.';
        } else {
          const secciones = Array.isArray(zona.secciones) ? zona.secciones : [];
          if(!secciones.length){
            disable = true;
            message = 'Esta zona no tiene secciones registradas.';
          } else {
            message = 'Selecciona una sección (opcional).';
            secciones.forEach((s)=>{
              const label = safeHTML(s.nombre || `Sección ${s.seccion_id}`) + (s.activa === false ? ' (inactiva)' : '');
              opts.push(`<option value="${safeHTML(s.seccion_id)}">${label}</option>`);
            });
          }
        }
      }

      selectSeccion.innerHTML = opts.join('');
      selectSeccion.disabled = disable;
      const desired = !disable && selected ? String(selected) : '';
      if(desired){
        selectSeccion.value = desired;
        if(selectSeccion.value !== desired){
          const opt = document.createElement('option');
          opt.value = desired;
          opt.textContent = `Sección ${desired}`;
          selectSeccion.appendChild(opt);
          selectSeccion.value = desired;
        }
        ensamSeccionId = selectSeccion.value || '';
      } else {
        selectSeccion.value = '';
        if(disable){ ensamSeccionId = ''; }
      }
      setLocationMessage(message);
    }

    function ensureLocationSelectors(){
      if(!selectZona || !selectSeccion) return Promise.resolve();
      setLocationMessage('Cargando ubicaciones...');
      return loadUbicaciones()
        .then(()=>{
          populateZonaSelect(ensamZonaId);
          populateSeccionSelect(ensamZonaId, ensamSeccionId);
        })
        .catch(()=>{
          setLocationMessage('No se pudieron cargar las ubicaciones.');
          if(selectZona) selectZona.disabled = true;
          if(selectSeccion) selectSeccion.disabled = true;
        });
    }


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
      // Orden select state
      if(linkOrderChk && orderSelect){ orderSelect.disabled = !linkOrderChk.checked; }
    }
    function resetAll(){
      ticSet.clear();
      vipSet.clear();
      cubeSet.clear();
      scannedSet.clear();
      scanProcessQueue = Promise.resolve();
      renderLists();
      updateStatus();
      if(msg) msg.textContent='';
      if(orderSelect){ orderSelect.innerHTML = `<option value="">Selecciona una orden…</option>`; }
      if(linkOrderChk){ linkOrderChk.checked=false; }
      ensureLocationSelectors();
    }

    async function loadOrdenes(){
      if(!orderSelect) return;
      orderSelect.innerHTML = `<option value="">Cargando órdenes…</option>`;
      try{
        const r = await fetch('/ordenes/list', { headers:{ 'Accept':'application/json' } });
        const j = await r.json();
        if(!r.ok || j.ok===false){ throw new Error(j.error||'Error'); }
        const items = Array.isArray(j.items) ? j.items : [];
        // Build options label: numero_orden · cliente · producto · cantidad
        const opts = [`<option value="">Selecciona una orden…</option>`]
          .concat(items.map(o => {
            const num = (o.numero_orden||'').toString();
            const cli = (o.cliente||'').toString();
            const prod = (o.codigo_producto||'').toString();
            const cant = (o.cantidad!=null? o.cantidad: '').toString();
            const label = [num, cli, prod, cant?`x${cant}`:''].filter(Boolean).join(' · ');
            return `<option value="${o.id}">${label}</option>`;
          }));
        orderSelect.innerHTML = opts.join('');
      }catch(e){
        orderSelect.innerHTML = `<option value="">No se pudo cargar órdenes</option>`;
      }
    }

    async function validateAll(){
      const rfids = Array.from(scannedSet);
      if(rfids.length===0) return;
      try {
        const res = await fetch('/operacion/acond/ensamblaje/validate',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids })});
        const json = await res.json();
        if(!res.ok || !json.ok) throw new Error(json.error||'Error validando');
        // Backend: { ok:true, roles:[ { rfid, rol } ], invalid:[{rfid, reason}] }
        const roles = Array.isArray(json.roles) ? json.roles : [];
        const invalid = Array.isArray(json.invalid) ? json.invalid : [];
        // Reconstruir válidos por rol
        ticSet.clear(); vipSet.clear(); cubeSet.clear();
        roles.forEach(v=>{ const code=String(v.rfid||'').toUpperCase(); if(v.rol==='tic') ticSet.add(code); else if(v.rol==='vip') vipSet.add(code); else if(v.rol==='cube') cubeSet.add(code); });
        // Auto-filtrar: remover inválidos del buffer (no mostrar en UI ni revalidarlos)
        if(invalid.length){ invalid.forEach(it=> scannedSet.delete(String(it.rfid||'').toUpperCase())); }
        // Cap local: máximo 6 TICs visibles/seleccionables
        if(ticSet.size > 6){
          const keep = Array.from(ticSet).slice(0,6);
          ticSet.clear(); keep.forEach(r=> ticSet.add(r));
          if(msg) msg.textContent = 'Máximo 6 TICs';
        }
        renderLists(); updateStatus();
        if(msg && !invalid.length) msg.textContent='';
        console.debug('[Ensamblaje] Validación OK', json);
      } catch(e){ if(msg) msg.textContent = e.message||'Error'; }
    }
    function scheduleValidate(){ if(_validateTimer){ clearTimeout(_validateTimer); } _validateTimer = setTimeout(()=>{ _validateTimer=0; validateAll(); }, 120); }
    let scanProcessQueue = Promise.resolve();

    selectZona?.addEventListener('change', ()=>{
      ensamZonaId = selectZona.value || '';
      ensamSeccionId = '';
      populateSeccionSelect(ensamZonaId, ensamSeccionId);
    });

    selectSeccion?.addEventListener('change', ()=>{
      ensamSeccionId = selectSeccion.value || '';
    });

    function extractScanTokens(str){
      let v = (str||'').replace(/\s+/g,'').toUpperCase();
      const tokens = [];
      while(v.length>=24){
        tokens.push(v.slice(0,24));
        v = v.slice(24);
      }
      return { tokens, rest: v };
    }

    function queueScannedTokens(tokens){
      if(!tokens.length) return;
      scanProcessQueue = scanProcessQueue.then(async ()=>{
        let added = false;
        for(const code of tokens){
          if(scannedSet.has(code)) continue;
          const proceed = await maybeResolveAtemperamiento(code, {
            confirmMessage: (rfid)=> 'El TIC ' + rfid + ' esta en Atemperamiento con cronometro activo. Deseas completarlo para usarlo aqui?',
            onError: err => { if(msg) msg.textContent = err?.message || 'No se pudo completar el cronometro'; }
          });
          if(!proceed) continue;
          scannedSet.add(code);
          added = true;
        }
        if(added){
          renderLists();
          updateStatus();
          scheduleValidate();
          if(msg) msg.textContent = '';
        }
      }).catch(err=>{
        console.error('[Ensamblaje] error procesando escaneo', err);
        if(msg) msg.textContent = err?.message || 'Error procesando escaneo';
      });
    }

    function handleScan(force){
      if(!scanInput) return;
      const raw = (scanInput.value||'');
      if(!raw.trim()){
        if(force && msg){ msg.textContent = 'RFID incompleto'; }
        return;
      }
      const { tokens, rest } = extractScanTokens(raw);
      scanInput.value = rest;
      if(force && !tokens.length && rest.length){
        if(msg) msg.textContent = 'RFID incompleto';
      }
      if(tokens.length) queueScannedTokens(tokens);
    }

    scanInput?.addEventListener('input', ()=> handleScan(false));
    scanInput?.addEventListener('paste', e=>{
      const text = e.clipboardData?.getData('text') || '';
      if(!text) return;
      e.preventDefault();
      const { tokens, rest } = extractScanTokens(text);
      scanInput.value = rest;
      if(tokens.length) queueScannedTokens(tokens);
    });
    scanInput?.addEventListener('keydown', e=>{
      if(e.key==='Enter'){
        e.preventDefault();
        handleScan(true);
      }
    });
    horas?.addEventListener('input', updateStatus);
    minutos?.addEventListener('input', updateStatus);
    limpiarBtn?.addEventListener('click', ()=>{ resetAll(); scanInput?.focus(); });
    crearBtn?.addEventListener('click', async ()=>{
      if(crearBtn.disabled) return;
      const rfids = [...ticSet, ...vipSet, ...cubeSet];
      if(rfids.length!==8){ if(msg) msg.textContent='Composición incompleta'; return; }
      const durMin = durationMinutes();
      if(durMin<=0){ if(msg) msg.textContent='Duración inválida'; return; }
      // Optional order id
      let orderId = null;
      if(linkOrderChk && linkOrderChk.checked && orderSelect && orderSelect.value){ orderId = Number(orderSelect.value); if(!Number.isFinite(orderId)) orderId = null; }
      const zonaId = selectZona ? String(selectZona.value || '').trim() : '';
      const seccionId = selectSeccion ? String(selectSeccion.value || '').trim() : '';
      ensamZonaId = zonaId;
      ensamSeccionId = seccionId;
      crearBtn.disabled = true; if(msg) msg.textContent='Creando caja...';
      try {
        const attempt = await postJSONWithSedeTransfer('/operacion/acond/ensamblaje/create', { rfids, order_id: orderId, zona_id: zonaId, seccion_id: seccionId }, {
          promptMessage: (data) => data?.confirm || data?.error || 'Las piezas seleccionadas pertenecen a otra sede. ¿Deseas trasladarlas a tu sede actual?'
        });
        if(attempt.cancelled){ if(msg) msg.textContent = 'Operación cancelada.'; return; }
        const json = attempt.data || {};
        if(!attempt.httpOk || !json.ok) throw new Error(json.error||'Error creando caja');
        // Inicia cronómetro inmediatamente
        try { await fetch('/operacion/acond/caja/timer/start',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: json.caja_id, durationSec: durMin*60 })}); } catch(e){ console.warn('No se pudo iniciar timer', e); }
        if(msg) msg.textContent = `Caja ${json.lote} creada`;
        await loadData();
  setTimeout(()=>{ try { dialog.close(); } catch { } }, 700);
      } catch(e){ if(msg) msg.textContent = e.message || 'Error creando'; }
      finally { crearBtn.disabled=false; }
    });
    // Toggle checkbox enabling select
    linkOrderChk?.addEventListener('change', ()=>{ updateStatus(); if(linkOrderChk.checked){ loadOrdenes(); } });
    openBtns.forEach(b=> b.addEventListener('click', ()=>{ try { dialog.showModal(); } catch { dialog.classList.remove('hidden'); } resetAll(); scanInput?.focus(); if(linkOrderChk && linkOrderChk.checked){ loadOrdenes(); } }));
  }

  // ========================= MODAL DESPACHO =========================
  (function setupDespachoModal(){
    const openBtn = document.getElementById('btn-add-listo');
    const dialog = document.getElementById('modal-despacho');
    if(!openBtn || !dialog) return;
    const input = document.getElementById('despacho-scan');
    const clearBtn = document.getElementById('despacho-clear');
    const countLabel = document.getElementById('despacho-count');
    const queueWrap = document.getElementById('despacho-queue');
    const queueList = document.getElementById('despacho-queue-list');
    const msg = document.getElementById('despacho-msg');
    const confirmBtn = document.getElementById('btn-despacho-confirm');
    const minInput = document.getElementById('despacho-min');
    const hrInput = document.getElementById('despacho-hr');

    let queue = [];
    let selectedCajaId = null;
    const seenRfids = new Set();
    const pendingRfids = new Set();

    function badgeForRol(rol){
      const type = String(rol || '').toLowerCase();
      if(type === 'vip') return 'badge-info';
      if(type === 'cube') return 'badge-accent';
      return 'badge-warning';
    }

    function normalizeComponentes(source){
      if(!Array.isArray(source) || !source.length) return [];
      if(typeof source[0] === 'string'){
        return source.map(code => ({ rfid: code, rol: 'tic' }));
      }
      return source.map(item => ({
        rfid: item.rfid || item.codigo || '',
        rol: item.rol || item.tipo || ''
      }));
    }

    function computeDurationSec(){
      const hrs = Number(hrInput?.value || '0');
      const mins = Number(minInput?.value || '0');
      const totalMin = (Number.isFinite(hrs) ? hrs : 0) * 60 + (Number.isFinite(mins) ? mins : 0);
      return totalMin > 0 ? totalMin * 60 : 0;
    }

    function updateConfirmState(){
      const durationSec = computeDurationSec();
      if(confirmBtn){
        confirmBtn.disabled = !(queue.length && durationSec > 0);
      }
    }

    function updateCount(){
      if(countLabel){
        countLabel.textContent = queue.length ? `Cajas detectadas: ${queue.length}` : '';
      }
    }

    function reset(){
      queue = [];
      selectedCajaId = null;
      seenRfids.clear();
      pendingRfids.clear();
      if(input){ input.value = ''; }
      if(queueList){ queueList.innerHTML = ''; }
      if(queueWrap){ queueWrap.classList.add('hidden'); }
      if(msg){ msg.textContent = ''; }
      if(minInput){ minInput.value = ''; }
      if(hrInput){ hrInput.value = ''; }
      updateCount();
      updateConfirmState();
    }

    function formatComponents(entry){
      if(entry.componentes && entry.componentes.length){
        return entry.componentes.map(comp => {
          const cls = badgeForRol(comp.rol);
          const label = safeHTML(comp.rol || comp.tipo || '');
          const code = safeHTML(comp.rfid || comp.codigo || '');
          return `<div class="flex items-center justify-between gap-2 px-2 py-1 bg-base-200 rounded"><span class="badge ${cls} badge-xs font-semibold uppercase">${label}</span><span class="font-mono text-[10px]">${code}</span></div>`;
        }).join('');
      }
      if(entry.componentesOcultos){
        return '<div class="text-[11px] text-warning">Componentes ocultos: la caja no esta completa.</div>';
      }
      return '<div class="text-[10px] opacity-60">Sin componentes disponibles</div>';
    }

    function renderQueue(){
      if(!queueList) return;
      if(!queue.length){
        queueList.innerHTML = '';
        if(queueWrap){ queueWrap.classList.add('hidden'); }
        updateCount();
        updateConfirmState();
        return;
      }
      if(queueWrap){ queueWrap.classList.remove('hidden'); }
      queueList.innerHTML = queue.map((entry, idx) => {
        const isSelected = String(entry.cajaId) === String(selectedCajaId);
        const orderLabel = entry.orderNum ? entry.orderNum : (entry.orderId ? `#${entry.orderId}` : '-');
        const pendLabel = entry.pendientes != null ? entry.pendientes : '?';
        const needsForce = (!entry.allEnsamblado || entry.timerActive);
        const pendienteBadge = !entry.allEnsamblado ? `<span class="badge badge-error badge-xs">Pend ${pendLabel}</span>` : '';
        const timerBadge = entry.timerActive ? '<span class="badge badge-info badge-xs">Cronometro activo</span>' : '';
        const forceBadge = (needsForce && entry.force) ? '<span class="badge badge-warning badge-xs">Forzado</span>' : '';
        const headerBadges = [pendienteBadge, timerBadge, forceBadge].filter(Boolean).join(' ');
        const warnHtmlParts = [];
        const warnPlainParts = [];
        if(!entry.allEnsamblado){ warnHtmlParts.push('<span>La caja tiene componentes pendientes o en Ensamblaje.</span>'); warnPlainParts.push('Componentes pendientes.'); }
        if(entry.timerActive){ warnHtmlParts.push('<span>Cronometro en progreso.</span>'); warnPlainParts.push('Cronometro activo.'); }
        const warnings = needsForce
          ? `<div class="mt-2 text-[11px] text-warning flex flex-wrap items-center gap-2">${warnHtmlParts.join(' ')}<button type="button" class="btn btn-ghost btn-xs" data-toggle-force="${safeHTML(entry.cajaId)}">${entry.force ? 'Cancelar forzar' : 'Permitir mover incompleta'}</button></div>`
          : '';
        const collapsedNotice = (!isSelected && needsForce)
          ? `<div class="px-3 pb-3 text-[10px] text-warning">${warnPlainParts.join(' ')}</div>`
          : '';
        const details = isSelected
          ? `<div class="px-3 pb-3 space-y-2">${formatComponents(entry)}${warnings}</div>`
          : collapsedNotice;
        return `<div class="border rounded-lg ${isSelected ? 'border-primary bg-base-200/40' : 'border-base-300/60 bg-base-200/10'} cursor-pointer" data-select-caja="${safeHTML(entry.cajaId)}">
          <div class="flex items-center justify-between gap-3 px-3 py-2">
            <div class="flex items-center gap-2 text-xs font-semibold">
              <span class="text-[10px] opacity-60">${idx + 1}</span>
              <span>${safeHTML(entry.lote || ('Caja ' + entry.cajaId))}</span>
            </div>
            <div class="flex items-center gap-2 text-[10px] uppercase opacity-70">
              <span>Orden: ${safeHTML(orderLabel)}</span>
              <span>${entry.total || 0} items</span>
              ${headerBadges}
              <button type="button" class="btn btn-ghost btn-xs" data-remove-caja="${safeHTML(entry.cajaId)}">x</button>
            </div>
          </div>
          ${details}
        </div>`;
      }).join('');
      updateCount();
      updateConfirmState();
    }

    function setSelectedCaja(id, opts){
      const force = opts && opts.force === true;
      if(force){
        selectedCajaId = id;
      } else if(selectedCajaId && String(selectedCajaId) === String(id)){
        selectedCajaId = null;
      } else {
        selectedCajaId = id;
      }
      renderQueue();
    }

    function toggleForce(cajaId){
      const entry = queue.find(item => String(item.cajaId) === String(cajaId));
      if(!entry) return;
      const needsForce = (!entry.allEnsamblado || entry.timerActive);
      if(!needsForce) return;
      entry.force = !entry.force;
      renderQueue();
      if(msg){
        const reasons = [];
        if(!entry.allEnsamblado) reasons.push('componentes pendientes');
        if(entry.timerActive) reasons.push('cronometro activo');
        if(entry.force){
          msg.textContent = `Caja ${entry.lote} marcada para mover (${reasons.join(' y ')}).`;
        } else {
          msg.textContent = `Caja ${entry.lote} requiere completar ${reasons.join(' y ')} o habilitar el forzado.`;
        }
      }
    }

    async function lookup(code){
      if(!code || pendingRfids.has(code)) return;
      pendingRfids.add(code);
      if(msg){ msg.textContent = `Buscando ${code}...`; }
      try{
        const res = await fetch('/operacion/acond/despacho/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfid: code })});
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        if(!res.ok || !data || data.ok === false){
          if(msg){ msg.textContent = (data && (data.error || data.message)) ? (data.error || data.message) : 'Error buscando caja.'; }
          return;
        }
        const cajaId = data.caja_id;
        if(!cajaId){
          if(msg){ msg.textContent = 'Caja no encontrada.'; }
          return;
        }
        const yaLista = Array.isArray(listoDespacho) && listoDespacho.some(it => String(it.caja_id) === String(cajaId));
        if(yaLista){
          if(msg){ msg.textContent = `La caja ${data.lote || cajaId} ya esta en Lista para Despacho.`; }
          return;
        }
        const isComplete = data.allEnsamblado === true;
        const timerActive = !!(data.timer && data.timer.active === true);
        const componentes = (()=>{
          if(Array.isArray(data.componentes) && data.componentes.length){
            return normalizeComponentes(data.componentes);
          }
          if(Array.isArray(data.rfids) && data.rfids.length){
            return normalizeComponentes(data.rfids);
          }
          return [];
        })();
        let entry = queue.find(item => String(item.cajaId) === String(cajaId));
        const needsForce = (!isComplete || timerActive);
        if(!entry){
          entry = {
            cajaId,
            lote: data.lote || `Caja ${cajaId}`,
            orderId: data.order_id ?? null,
            orderNum: data.order_num ?? null,
            componentes,
            total: data.total ?? componentes.length,
            pendientes: data.pendientes ?? 0,
            componentesOcultos: data.componentesOcultos === true,
            rfids: [],
            allEnsamblado: isComplete,
            timer: data.timer || null,
            timerActive,
            force: !needsForce
          };
          queue.push(entry);
        } else {
          entry.lote = data.lote || entry.lote;
          entry.orderId = data.order_id ?? entry.orderId;
          entry.orderNum = data.order_num ?? entry.orderNum;
          entry.componentes = componentes.length ? componentes : entry.componentes;
          entry.total = data.total ?? entry.total;
          entry.pendientes = data.pendientes ?? entry.pendientes;
          entry.componentesOcultos = data.componentesOcultos === true;
          entry.allEnsamblado = isComplete;
          entry.timer = data.timer || entry.timer;
          entry.timerActive = timerActive;
          if(!needsForce) entry.force = true;
        }
        if(!entry.rfids.includes(code)) entry.rfids.push(code);
        seenRfids.add(code);
        selectedCajaId = entry.cajaId;
        renderQueue();
        if(msg){
          if(needsForce){
            const reasons = [];
            if(!isComplete) reasons.push(`${entry.pendientes ?? 'algunos'} pendientes`);
            if(timerActive) reasons.push('cronometro activo');
            msg.textContent = `Caja ${entry.lote} tiene ${reasons.join(' y ')}. Usa "Permitir mover incompleta" para forzar.`;
          } else {
            msg.textContent = `Caja ${entry.lote} lista (${entry.total || 0} items).`;
          }
        }
      } catch(err){
        console.error('[Acond] despacho lookup error', err);
        if(msg){ msg.textContent = err?.message || 'Error buscando caja.'; }
      } finally {
        pendingRfids.delete(code);
        updateConfirmState();
      }
    }

    async function processRaw(raw){
      const tokens = parseRfids(raw);
      const candidates = tokens.filter(code => !seenRfids.has(code));
      if(!candidates.length) return;
      if(input){ input.value = ''; }
      for(const code of candidates){
        await lookup(code);
      }
    }

    function removeCaja(cajaId){
      const idx = queue.findIndex(entry => String(entry.cajaId) === String(cajaId));
      if(idx === -1) return;
      const removed = queue.splice(idx, 1)[0];
      if(removed && Array.isArray(removed.rfids)){
        removed.rfids.forEach(rf => seenRfids.delete(rf));
      }
      if(selectedCajaId && String(selectedCajaId) === String(cajaId)){
        selectedCajaId = null;
      }
      renderQueue();
      if(!queue.length && msg){ msg.textContent = ''; }
    }

    openBtn.addEventListener('click', ()=>{
      try { dialog.showModal(); } catch { dialog.classList.remove('hidden'); }
      reset();
      setTimeout(()=> input?.focus(), 40);
    });

    confirmBtn?.addEventListener('click', async ()=>{
      const durationSec = computeDurationSec();
      if(durationSec <= 0){
        if(msg){ msg.textContent = 'Define una duracion valida antes de marcar.'; }
        updateConfirmState();
        return;
      }
      if(!queue.length){
        if(msg){ msg.textContent = 'No hay cajas escaneadas.'; }
        return;
      }
      confirmBtn.disabled = true;
      if(msg){ msg.textContent = 'Marcando cajas...'; }
      const errors = [];
      const processedIds = [];
      const codesToRelease = new Set();
      for(const entry of queue){
        const rfid = entry.rfids && entry.rfids.length ? entry.rfids[0] : null;
        if(!rfid){
          errors.push(`Caja ${entry.lote}: sin RFID para mover.`);
          continue;
        }
        const needsForce = (!entry.allEnsamblado || entry.timerActive);
        if(needsForce && !entry.force){
          errors.push(`Caja ${entry.lote}: habilita "Permitir mover incompleta".`);
          continue;
        }
        const reasons = [];
        if(!entry.allEnsamblado) reasons.push('componentes pendientes');
        if(entry.timerActive) reasons.push('cronometro en progreso');
        if(needsForce){
          const proceed = window.confirm(`La caja ${entry.lote} tiene ${reasons.join(' y ')}. Deseas moverla de todas formas?`);
          if(!proceed){
            errors.push(`Caja ${entry.lote}: cancelada por el usuario.`);
            continue;
          }
        }
        const attempt = await postJSONWithSedeTransfer('/operacion/acond/despacho/move', { rfid, durationSec, allowIncomplete: needsForce }, {
          promptMessage: (data) => data?.confirm || data?.error || `La caja ${entry.lote} pertenece a otra sede. ¿Deseas trasladarla a tu sede actual?`
        });
        if(attempt.cancelled){
          errors.push(`Caja ${entry.lote}: operación cancelada por el usuario.`);
          continue;
        }
        const payload = attempt.data || {};
        if(!attempt.httpOk || payload.ok === false){
          const message = payload.error || payload.message || `Error (${attempt.status || 0})`;
          errors.push(`Caja ${entry.lote}: ${message}`);
          continue;
        }
        processedIds.push(entry.cajaId);
        if(Array.isArray(entry.rfids)) entry.rfids.forEach(code => codesToRelease.add(code));
      }
      if(processedIds.length){
        queue = queue.filter(entry => !processedIds.includes(entry.cajaId));
        codesToRelease.forEach(code => seenRfids.delete(code));
        selectedCajaId = null;
        renderQueue();
        try { await loadData(); } catch(err){ console.error('[Acond] reload after despacho move', err); }
      } else {
        renderQueue();
      }
      if(msg){
        if(errors.length){
          const summary = errors.slice(0, 2).join(' | ');
          msg.textContent = processedIds.length ? `Marcadas ${processedIds.length}. Errores: ${summary}${errors.length > 2 ? '...' : ''}` : summary;
        } else {
          msg.textContent = `Marcadas ${processedIds.length} caja${processedIds.length === 1 ? '' : 's'}.`;
        }
      }
      confirmBtn.disabled = false;
      updateConfirmState();
      if(!queue.length){
        setTimeout(()=>{ try { dialog.close(); } catch { dialog.classList.add('hidden'); } }, 600);
      }
    });

    clearBtn?.addEventListener('click', ()=>{
      reset();
      setTimeout(()=> input?.focus(), 10);
    });

    queueList?.addEventListener('click', ev=>{
      const removeBtn = ev.target.closest('[data-remove-caja]');
      if(removeBtn){
        const id = removeBtn.getAttribute('data-remove-caja');
        if(id) removeCaja(id);
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      const toggle = ev.target.closest('[data-toggle-force]');
      if(toggle){
        const id = toggle.getAttribute('data-toggle-force');
        if(id) toggleForce(id);
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      const card = ev.target.closest('[data-select-caja]');
      if(card){
        const id = card.getAttribute('data-select-caja');
        if(id) setSelectedCaja(id);
      }
    });

    input?.addEventListener('input', async ()=>{
      const raw = input.value || '';
      if(parseRfids(raw).length){
        await processRaw(raw.toUpperCase());
      }
    });
    input?.addEventListener('keydown', async ev=>{
      const key = ev.key || ev.code;
      if(key === 'Enter' || key === 'NumpadEnter'){
        ev.preventDefault();
        const raw = input.value || '';
        if(raw){
          await processRaw(raw.toUpperCase());
        }
      } else if(key === 'Escape'){
        input.value = '';
      }
    });

    hrInput?.addEventListener('input', updateConfirmState);
    minInput?.addEventListener('input', updateConfirmState);

    dialog.addEventListener('close', reset);
  })();

// =================== NUEVA VINCULACIÓN DE ORDEN EN DETALLE ===================
// =================== NUEVA VINCULACIÓN DE ORDEN EN DETALLE ===================
  async function loadOrdenesForDetalle(selectEl){
    if(!selectEl) return;
    selectEl.innerHTML = '<option value="">Cargando órdenes…</option>';
    try {
      const r = await fetch('/ordenes/list', { headers:{ 'Accept':'application/json' } });
      const j = await r.json();
      if(!r.ok || j.ok===false) throw new Error(j.error||'Error');
      const items = Array.isArray(j.items)? j.items:[];
      const opts = ['<option value="">Selecciona una orden…</option>'].concat(items.map(o=>{
        const num = (o.numero_orden||'').toString();
        const cli = (o.cliente||'').toString();
        const prod = (o.codigo_producto||'').toString();
        const cant = (o.cantidad!=null? o.cantidad: '').toString();
        const label = [num, cli, prod, cant?`x${cant}`:''].filter(Boolean).join(' · ');
        return `<option value="${o.id}">${label}</option>`;
      }));
      selectEl.innerHTML = opts.join('');
    } catch(e){ selectEl.innerHTML = '<option value="">No se pudo cargar órdenes</option>'; }
  }
  // Extender openCajaDetalle para inyectar UI de orden
  const _origOpenCajaDetalle = openCajaDetalle;
  openCajaDetalle = function(id){
    _origOpenCajaDetalle(id);
    const wrap = document.getElementById('detalle-order-actions');
    const ordenSpan = document.getElementById('detalle-caja-orden');
    if(!wrap || !ordenSpan) return;
    const currentTxt = ordenSpan.textContent?.trim();
    // Si ya tiene una orden (no '—'), permitir cambiarla también
    wrap.innerHTML = `
      <div class='border border-base-300/40 rounded-lg p-3 bg-base-200/30 space-y-3'>
        <div class='flex items-center justify-between'>
          <span class='font-semibold'>Orden</span>
          <button class='btn btn-ghost btn-xs' id='detalle-refresh-orden' title='Recargar'>↻</button>
        </div>
        <div class='text-[11px] opacity-70'>${currentTxt && currentTxt!=='—' ? 'Cambiar la orden asociada' : 'Vincular esta caja a una orden existente'}</div>
        <div class='flex items-center gap-2'>
          <select id='detalle-orden-select' class='select select-bordered select-sm flex-1'>
            <option value=''>Selecciona una orden…</option>
          </select>
          <button class='btn btn-sm btn-primary' id='detalle-orden-aplicar'>Guardar</button>
        </div>
        <div id='detalle-orden-msg' class='text-[11px] opacity-70 min-h-[14px]'></div>
      </div>`;
    const sel = document.getElementById('detalle-orden-select');
    const msg = document.getElementById('detalle-orden-msg');
    const applyBtn = document.getElementById('detalle-orden-aplicar');
    const refreshBtn = document.getElementById('detalle-refresh-orden');
    loadOrdenesForDetalle(sel);
    applyBtn?.addEventListener('click', async ()=>{
      const val = sel && sel.value ? Number(sel.value) : null;
      if(!val){ if(msg) msg.textContent='Selecciona una orden'; return; }
      applyBtn.disabled=true; if(msg) msg.textContent='Aplicando...';
      try {
        const r = await fetch('/operacion/acond/caja/set-order',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: id, order_id: val })});
        const j = await r.json();
        if(!j.ok) throw new Error(j.error||'Error');
        if(msg) msg.textContent='Orden vinculada';
        // Refrescar data general
        await loadData();
        // Actualizar texto de orden en meta
        ordenSpan.textContent = j.order_num ? j.order_num : ('#'+val);
        ordenSpan.classList.remove('opacity-60');
      } catch(e){ if(msg) msg.textContent=e.message||'Error'; }
      finally { applyBtn.disabled=false; }
    });
    refreshBtn?.addEventListener('click', ()=> loadOrdenesForDetalle(sel));
  };
})();
