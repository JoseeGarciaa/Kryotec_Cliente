// Acondicionamiento front-end module (clean consolidated version)
// Handles: data polling, rendering cajas (ensamblaje en progreso), listado listo para despacho, timers, scan + validation, creation, filtering, modal detail.
// Empty-state requirement: "Lista para Despacho" must NOT show perpetual spinner when empty; immediate neutral placeholder is rendered.

(function(){
  'use strict';

  // ========================= DOM SELECTORS =========================
  const sel = {
    contCajas: '#cajasContainer',                // card/grid view container
    contCajasTabla: '#cajasTablaBody',           // table view body
    contListo: '#listoDespachoBody',            // tbody for listo para despacho table
    placeholderListo: '#listoDespachoPlaceholder', // optional dedicated placeholder div (if exists)
    toggleVistaBtns: '[data-vista-toggle]',
    filtroInput: '#filtroCajaInput',
    scanInput: '#scanInput',
    scanForm: '#scanForm',
    validarBtn: '#validarParcialBtn',
    crearBtn: '#crearCajaBtn',
    listaParcial: '#scanItemsList',
    counts: {
      ensamblaje: '#countEnsamblaje',
      listo: '#countListo'
    },
    modal: '#detalleCajaModal',
    modalClose: '[data-close-modal]',
    modalContent: '#detalleCajaContent'
  };

  // ========================= STATE =========================
  let cajas = [];          // cajas en ensamblaje (con timers)
  let listoDespacho = [];  // items listos para despacho
  let scanBuffer = [];     // objetos escaneados (parcial)
  let viewMode = 'cards';  // 'cards' | 'table'
  let pollingTimer = null;
  let tickingTimer = null;
  let serverNowOffsetMs = 0; // serverNow - clientNow to sync timers

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
      return `<tr class="hover">\n        <td class="text-xs font-mono">${safeHTML(item.codigo || item.codigoCaja || '')}</td>\n        <td>${safeHTML(item.estado || '')}</td>\n        <td>${formatDateTime(item.updatedAt)}</td>\n        <td>${safeHTML(item.usuario || '')}</td>\n        <td>${safeHTML(item.observacion || '')}</td>\n        <td>${safeHTML(item.fase || '')}</td>\n      </tr>`;
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

    // Cards view
    contCards.innerHTML = filtered.map(c => cajaCardHTML(c)).join('');

    // Table rows
    contTableBody.innerHTML = filtered.map(c => cajaRowHTML(c)).join('');
  }

  function cajaCardHTML(c){
    const remaining = msRemaining(c);
    const timerText = timerDisplay(remaining, c.timer?.completedAt);
    const progress = timerProgressPct(c);
    return `<div class="card bg-base-100 shadow-sm border border-base-200 mb-3" data-caja-id="${safeHTML(c.id)}">\n      <div class="card-body p-4">\n        <div class="flex justify-between items-start mb-2">\n          <h2 class="card-title text-sm font-semibold">${safeHTML(c.codigoCaja||'Caja')}</h2>\n          ${timerBadgeHTML(c, remaining)}\n        </div>\n        <div class="text-xs space-y-1">\n          <div><span class="font-medium">Estado:</span> ${safeHTML(c.estado||'-')}</div>\n          <div><span class="font-medium">Creado:</span> ${formatDateTime(c.createdAt)}</div>\n          <div><span class="font-medium">Actualizado:</span> ${formatDateTime(c.updatedAt)}</div>\n        </div>\n        <div class="mt-2">\n          <progress class="progress progress-primary w-full" value="${progress}" max="100"></progress>\n          <div class="text-[10px] text-right mt-1">${timerText}</div>\n        </div>\n        <div class="mt-3 flex gap-2">\n          <button class="btn btn-xs btn-outline" data-action="detalle" data-caja-id="${safeHTML(c.id)}">Detalle</button>\n          ${timerControlButtonsHTML(c)}\n        </div>\n      </div>\n    </div>`;
  }

  function cajaRowHTML(c){
    const remaining = msRemaining(c);
    const progress = timerProgressPct(c);
    const timerText = timerDisplay(remaining, c.timer?.completedAt);
    return `<tr class="hover" data-caja-id="${safeHTML(c.id)}">\n      <td class="text-xs font-mono">${safeHTML(c.codigoCaja||'')}</td>\n      <td>${safeHTML(c.estado||'')}</td>\n      <td>${formatDateTime(c.createdAt)}</td>\n      <td>${formatDateTime(c.updatedAt)}</td>\n      <td class="w-32">\n        <progress class="progress progress-primary w-full" value="${progress}" max="100"></progress>\n        <div class="text-[10px] text-right">${timerText}</div>\n      </td>\n      <td class="text-center">${timerControlButtonsHTML(c)}</td>\n      <td><button class="btn btn-xs btn-outline" data-action="detalle" data-caja-id="${safeHTML(c.id)}">Detalle</button></td>\n    </tr>`;
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
    if(ensam) ensam.textContent = cajas.length.toString();
    if(listo) listo.textContent = listoDespacho.length.toString();
  }

  // ========================= FILTER =========================
  function applyFilter(){
    renderCajas();
  }

  // ========================= POLLING + DATA LOAD =========================
  async function loadData(){
    try {
      const res = await fetch('/operacion/acond/data');
      if(!res.ok) throw new Error('Error al cargar datos');
      const json = await res.json();
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
        // progress
        const progressEls = el.querySelectorAll('progress');
        const remaining = msRemaining(caja);
        const pct = timerProgressPct(caja);
        progressEls.forEach(p=>{ p.value = pct; });
        const small = el.querySelector('.text-[10px]');
        if(small){ small.textContent = timerDisplay(remaining, caja.timer?.completedAt); }
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
      const res = await fetch('/operacion/acond/ensamblaje/validate',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ componentes: scanBuffer.map(s=> s.codigo) })});
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
      const res = await fetch('/operacion/acond/ensamblaje/create',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ componentes: scanBuffer.map(s=> s.codigo) })});
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
  async function timerAction(id, action){
    let endpoint = '';
    if(action==='start') endpoint = '/operacion/acond/caja/timer/start';
    else if(action==='complete') endpoint = '/operacion/acond/caja/timer/complete';
    else if(action==='clear') endpoint = '/operacion/acond/caja/timer/clear';
    if(!endpoint) return;
    try{
      const res = await fetch(endpoint,{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id })});
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
    // Toggle vista
    qsa(sel.toggleVistaBtns).forEach(btn => {
      btn.addEventListener('click', e => {
        const mode = btn.getAttribute('data-vista-toggle');
        if(mode && mode !== viewMode){
          viewMode = mode;
          document.documentElement.setAttribute('data-acond-vista', viewMode);
          renderCajas();
        }
      });
    });

    // Filtro
    const filtro = qs(sel.filtroInput);
    if(filtro){ filtro.addEventListener('input', applyFilter); }

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
    loadData();
    startPolling();
  }

  // Wait DOM
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
