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
    placeholderListo: '#listoDespachoPlaceholder', // optional dedicated placeholder div (if exists)
    toggleVistaBtns: '[data-vista-toggle]',
    // Ajustado a ID real en la vista acond.ejs
    filtroInput: '#search-ensam',
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
  let viewMode = 'table';  // 'cards' | 'table' (por defecto tabla como en la vista actual)
  let pollingTimer = null;
  let tickingTimer = null;
  let serverNowOffsetMs = 0; // serverNow - clientNow to sync timers
  let lastFilteredComponentCount = 0; // para mostrar (filtrados de total)
  let totalComponentCount = 0;

  // ========================= UTILITIES =========================
  function qs(selector){ return document.querySelector(selector); }
  function qsa(selector){ return Array.from(document.querySelectorAll(selector)); }
  function createEl(tag, cls){ const el = document.createElement(tag); if(cls) el.className = cls; return el; }
  function formatDateTime(iso){ if(!iso) return '-'; const d = new Date(iso); return d.toLocaleString(); }
  function safeHTML(str){ return (str||'').toString().replace(/[&<>\"]/g, s=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[s])); }
  function msRemaining(caja){ if(!caja.timer || !caja.timer.endsAt) return 0; const end = new Date(caja.timer.endsAt).getTime(); return end - Date.now() - serverNowOffsetMs; }

  // ========================= INITIAL RENDER HELPERS =========================
  function renderInitialLoading(){
    const body = qs(sel.contListo);
    if(body){
      body.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-sm text-gray-400">Cargando...</td></tr>`;
    }
  }

  function renderListoEmpty(){
    const body = qs(sel.contListo);
    if(body){
      body.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-sm text-gray-400">Sin items listos para despacho</td></tr>`;
    }
  }

  // ========================= RENDER FUNCTIONS (LISTO) =========================
  function renderListo(){
    const body = qs(sel.contListo);
    if(!body) return;
    if(!listoDespacho || listoDespacho.length===0){
      renderListoEmpty();
      return;
    }
    const rows = listoDespacho.map(item => {
      // cronometro: if provided show remaining or 'Completado'
      let chrono = '-';
      if(item.cronometro){
        const now = Date.now();
        const start = item.cronometro.startsAt ? new Date(item.cronometro.startsAt).getTime() : null;
        const end = item.cronometro.endsAt ? new Date(item.cronometro.endsAt).getTime() : null;
        if(start && end){
          if(item.cronometro.completedAt || now >= end){
            chrono = 'Completado';
          } else {
            const rem = end - now;
            const sec = Math.max(0, Math.floor(rem/1000));
            const m = Math.floor(sec/60); const s = sec % 60;
            chrono = `${m}m ${s}s`;
          }
        }
      }
    return `<tr class="hover">\n        <td class="text-xs font-mono">${safeHTML(item.codigo || '')}</td>\n        <td>${safeHTML(item.nombre || '')}</td>\n        <td>${safeHTML(item.estado || '')}</td>\n        <td>${safeHTML(item.lote || '')}</td>\n        <td class="text-xs">${chrono}</td>\n        <td class="uppercase">${safeHTML(item.categoria || '')}</td>\n      </tr>`;
    }).join('');
    body.innerHTML = rows;
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
  return `<div class="card bg-base-100 shadow-sm border border-base-200 mb-3" data-caja-id="${safeHTML(c.id)}">\n      <div class="card-body p-4">\n        <div class="flex justify-between items-start mb-2">\n          <h2 class="card-title text-sm font-semibold">${safeHTML(c.codigoCaja||'Caja')}</h2>\n          ${timerBadgeHTML(c, remaining)}\n        </div>\n        <div class="text-xs space-y-1">\n          <div><span class="font-medium">Estado:</span> ${safeHTML(c.estado||'-')}</div>\n          <div><span class="font-medium">Creado:</span> ${formatDateTime(c.createdAt)}</div>\n          <div><span class="font-medium">Actualizado:</span> ${formatDateTime(c.updatedAt)}</div>\n        </div>\n        <div class="mt-2">\n          <progress class="progress progress-primary w-full" value="${progress}" max="100"></progress>\n          <div class="text-[10px] text-right mt-1" data-timer-text>${timerText}</div>\n        </div>\n        <div class="mt-3 flex gap-2">\n          <button class="btn btn-xs btn-outline" data-action="detalle" data-caja-id="${safeHTML(c.id)}">Detalle</button>\n          ${timerControlButtonsHTML(c)}\n        </div>\n      </div>\n    </div>`;
  }

  // ========================= VIEW TOGGLE =========================
  function updateViewVisibility(){
    const gridWrap = document.getElementById('grid-cajas-wrapper');
    const tableEl = document.getElementById('tabla-ensam');
    const tableWrap = tableEl ? tableEl.parentElement : null; // overflow container
    if(gridWrap) gridWrap.classList.toggle('hidden', viewMode !== 'cards');
    if(tableWrap) tableWrap.classList.toggle('hidden', viewMode === 'cards');
    const btnCards = document.getElementById('btn-view-cards');
    const btnText = document.getElementById('btn-view-text');
    if(btnCards) btnCards.classList.toggle('btn-active', viewMode === 'cards');
    if(btnText) btnText.classList.toggle('btn-active', viewMode === 'table');
  }

  function cajaRowsHTML(c){
    const remaining = msRemaining(c);
    const progress = timerProgressPct(c);
    const timerText = timerDisplay(remaining, c.timer?.completedAt);
    const comps = (c.componentes||[]);
    if(!comps.length){
      // Cronómetro estilo "anterior": badge pequeño + (si aplica) botón acción
      const controls = timerTableControlsHTML(c);
      return [ `<tr class="hover" data-caja-id="${safeHTML(c.id)}">\n        <td class="text-[10px] font-mono leading-tight text-gray-400">(sin items)</td>\n        <td class="text-xs">-</td>\n        <td class="text-xs">${safeHTML(c.estado||'')}</td>\n        <td class="text-xs">${safeHTML(c.codigoCaja||'')}</td>\n        <td class="w-32">\n          <span class="badge badge-neutral badge-xs" data-timer-badge><span data-timer-text>${timerText}</span></span>\n          ${controls}\n        </td>\n        <td class="text-xs">-</td>\n      </tr>` ];
    }
    return comps.map(cc => {
      const controls = timerTableControlsHTML(c);
      return `<tr class="hover" data-caja-id="${safeHTML(c.id)}">\n      <td class="text-[10px] font-mono leading-tight">${safeHTML(cc.codigo)}</td>\n      <td class="text-xs">${safeHTML(cc.tipo||cc.nombre||'')}</td>\n      <td class="text-xs">${safeHTML(c.estado||'')}</td>\n      <td class="text-xs">${safeHTML(c.codigoCaja||'')}</td>\n      <td class="w-32 flex items-center gap-1">\n        <span class="badge badge-neutral badge-xs" data-timer-badge><span data-timer-text>${timerText}</span></span>\n        ${controls}\n      </td>\n      <td class="text-xs uppercase">${safeHTML(cc.tipo||'')}</td>\n    </tr>`;
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
    const now = Date.now() - serverNowOffsetMs;
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
  if(listo) listo.textContent = `(${listoDespacho.length} de ${listoDespacho.length})`;
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
    stopPolling();
    pollingTimer = setInterval(loadData, 8000); // 8s
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
        const small = el.querySelector('[data-timer-text]');
        if(small){
          small.textContent = timerDisplay(remaining, caja.timer?.completedAt);
          // Update badge color semantics similar a preacond (warning/danger thresholds)
          const badge = small.closest('[data-timer-badge]');
          if(badge && caja.timer && !caja.timer.completedAt){
            const remSec = Math.max(0, Math.floor(remaining/1000));
            badge.classList.remove('badge-info','badge-warning','badge-error','badge-success','badge-neutral');
            if(caja.timer.completedAt){
              badge.classList.add('badge-success');
            } else if(remSec<=0){
              badge.classList.add('badge-info');
            } else if(remSec<=60){
              badge.classList.add('badge-error');
            } else if(remSec<=300){
              badge.classList.add('badge-warning');
            } else {
              badge.classList.add('badge-neutral');
            }
          }
        }
      });
    }, 1000);
  }

  // ========================= MODAL DETALLE =========================
  function openCajaDetalle(id){
    const caja = cajas.find(c=> String(c.id) === String(id));
    if(!caja) return;
    const modal = qs(sel.modal);
    const content = qs(sel.modalContent);
    if(content){
      content.innerHTML = cajaDetalleHTML(caja);
    }
    if(modal){ modal.classList.add('modal-open'); }
  }
  function closeCajaDetalle(){
    const modal = qs(sel.modal);
    if(modal){ modal.classList.remove('modal-open'); }
  }
  function cajaDetalleHTML(c){
    const comps = (c.componentes||[]).map(cc=> `<li class="leading-tight">${safeHTML(cc.tipo||'')} - <span class="font-mono">${safeHTML(cc.codigo||'')}</span></li>`).join('');
    return `\n      <h3 class="font-semibold mb-2">${safeHTML(c.codigoCaja||'Caja')}</h3>\n      <div class="text-xs space-y-1 mb-2">\n        <div><span class="font-medium">Estado:</span> ${safeHTML(c.estado||'-')}</div>\n        <div><span class="font-medium">Creado:</span> ${formatDateTime(c.createdAt)}</div>\n        <div><span class="font-medium">Actualizado:</span> ${formatDateTime(c.updatedAt)}</div>\n      </div>\n      <div><span class="font-medium text-xs">Componentes:</span>\n        <ul class="text-xs mt-1 space-y-0.5">${comps||'<li class="text-gray-400">Sin componentes</li>'}</ul>\n      </div>`;
  }

  // ========================= SCAN / VALIDACION / CREACION =========================
  function refreshScanList(){
    const ul = qs(sel.listaParcial);
    if(!ul) return;
    if(scanBuffer.length===0){
      ul.innerHTML = '<li class="text-xs text-gray-400">Sin componentes escaneados</li>';
      return;
    }
    ul.innerHTML = scanBuffer.map(s=> `<li class="text-xs font-mono flex justify-between items-center">${safeHTML(s.codigo)} <button class="btn btn-ghost btn-xs" data-action="scan-remove" data-codigo="${safeHTML(s.codigo)}">✕</button></li>`).join('');
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
  // Backend espera { rfids: [] }
  const res = await fetch('/operacion/acond/ensamblaje/validate',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids: scanBuffer.map(s=> s.codigo) })});
      const json = await res.json();
      if(!res.ok){ throw new Error(json.message || 'Error de validación'); }
      // Could show validations details / highlight required pending pieces
      // For now we just log
      console.log('[Acond] Validación parcial OK', json);
    }catch(err){
      console.error('[Acond] validarParcial error:', err);
      alert(err.message || 'Error validando');
    }finally{ disableBtn(sel.validarBtn, false); }
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
          if(sec==null){ return; }
          dur = sec;
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
  // Toggle vista usando los IDs existentes
  const btnCards = document.getElementById('btn-view-cards');
  const btnText = document.getElementById('btn-view-text');
  if(btnCards){ btnCards.addEventListener('click', ()=>{ if(viewMode!=='cards'){ viewMode='cards'; updateViewVisibility(); renderCajas(); }}); }
  if(btnText){ btnText.addEventListener('click', ()=>{ if(viewMode!=='table'){ viewMode='table'; updateViewVisibility(); renderCajas(); }}); }

    // Filtro
    const filtro = qs(sel.filtroInput);
  if(filtro){ filtro.addEventListener('input', ()=>{ applyFilter(); updateCounts(); }); }

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
      if(t.matches('[data-action="timer-start"]')){ timerAction(t.getAttribute('data-caja-id'),'start'); }
      if(t.matches('[data-action="timer-complete"]')){ timerAction(t.getAttribute('data-caja-id'),'complete'); }
      if(t.matches('[data-action="timer-clear"]')){ timerAction(t.getAttribute('data-caja-id'),'clear'); }

      // detalle
      if(t.matches('[data-action="detalle"]')){ openCajaDetalle(t.getAttribute('data-caja-id')); }

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
        // Reconstruir sets desde respuesta valid (rol)
        ticSet.clear(); vipSet.clear(); cubeSet.clear();
        json.valid.forEach(v=>{ if(v.rol==='tic') ticSet.add(v.rfid); else if(v.rol==='vip') vipSet.add(v.rfid); else if(v.rol==='cube') cubeSet.add(v.rfid); });
        renderLists(); updateStatus();
        if(msg) msg.textContent='';
        if(json.invalid && json.invalid.length){
          const inv = json.invalid.find(i=>i.rfid===last);
          if(inv && msg) msg.textContent = `${inv.rfid}: ${inv.reason}`;
        }
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
  setTimeout(()=>{ try { dialog.close(); } catch(_){} }, 700);
      } catch(e){ if(msg) msg.textContent = e.message||'Error creando'; }
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
