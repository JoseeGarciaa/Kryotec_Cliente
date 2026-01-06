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
  const NEGATIVE_REFRESH_DELAY_MS = 160;
  const NEGATIVE_SYNC_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutos para alinear cronómetros sin saltos grandes
  let scanNegatives = new Map(); // RFIDs -> elapsed seconds
  let scanValidationTimerId = 0;
  let scanValidationController = null;
  let scanNegativeWarningEl = null;
  let viewMode = localStorage.getItem('acondViewMode') || 'cards';  // persist across reloads
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

  // ========================= TIMER DEFAULTS =========================
  const timerDefaults = new Map();

  const normalizeModeloId = (value) => {
    const num = Number(value);
    if(!Number.isFinite(num) || num <= 0) return null;
    return Math.trunc(num);
  };

  const refreshTimerDefaults = (payload) => {
    timerDefaults.clear();
    if(!Array.isArray(payload)) return;
    payload.forEach((entry) => {
      const modeloId = normalizeModeloId(entry?.modeloId ?? entry?.modelo_id);
      if(!modeloId) return;
      timerDefaults.set(modeloId, {
        minCongelamientoSec: Number(entry?.minCongelamientoSec ?? entry?.min_congelamiento_sec ?? 0),
        atemperamientoSec: Number(entry?.atemperamientoSec ?? entry?.atemperamiento_sec ?? 0),
        maxSobreAtemperamientoSec: Number(entry?.maxSobreAtemperamientoSec ?? entry?.max_sobre_atemperamiento_sec ?? 0),
        vidaCajaSec: Number(entry?.vidaCajaSec ?? entry?.vida_caja_sec ?? 0),
        minReusoSec: Number(entry?.minReusoSec ?? entry?.min_reuso_sec ?? 0),
        modeloNombre: entry?.modeloNombre ?? entry?.modelo_nombre ?? null
      });
    });
  };

  const formatMinutesLabel = (minutes) => {
    const total = Math.max(0, Math.round(Number(minutes) || 0));
    const hrs = Math.floor(total / 60);
    const mins = total % 60;
    if(hrs && mins) return `${hrs} h ${mins} min`;
    if(hrs) return `${hrs} h`;
    return `${mins} min`;
  };

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
  function formatNegativeElapsed(sec){
    const total = Math.max(0, Math.floor(Number(sec)||0));
    const hh = String(Math.floor(total/3600)).padStart(2,'0');
    const mm = String(Math.floor((total%3600)/60)).padStart(2,'0');
    const ss = String(total%60).padStart(2,'0');
    return `-${hh}:${mm}:${ss}`;
  }

  function mapsEqual(a, b){
    if(a.size !== b.size) return false;
    for(const [k,v] of a.entries()){
      if(!b.has(k) || b.get(k)!==v) return false;
    }
    return true;
  }

  function normalizeOrders(raw){
    if(!Array.isArray(raw)) return [];
    const seen = new Set();
    const result = [];
    for(const entry of raw){
      if(!entry || typeof entry !== 'object') continue;
      const orderIdRaw = Number(entry.orderId);
      const orderId = Number.isFinite(orderIdRaw) && orderIdRaw > 0 ? Math.trunc(orderIdRaw) : null;
      const numeroOrden = entry.numeroOrden != null ? String(entry.numeroOrden) : null;
      const cliente = entry.cliente != null ? String(entry.cliente) : null;
      if(orderId == null && !numeroOrden && !cliente) continue;
      const key = [orderId ?? '', numeroOrden ? numeroOrden.toLowerCase() : '', cliente ? cliente.toLowerCase() : ''].join('|');
      if(seen.has(key)) continue;
      seen.add(key);
      result.push({ orderId, numeroOrden, cliente });
    }
    return result;
  }

  function buildOrderSearch(orders, fallbackNumero, fallbackCliente){
    const tokens = new Set();
    const pushToken = (value)=>{
      const clean = String(value||'').trim();
      if(clean){ tokens.add(clean.toLowerCase()); }
    };
    orders.forEach(o => {
      pushToken(o.numeroOrden);
      pushToken(o.cliente);
      if(o.orderId){ pushToken(`#${o.orderId}`); pushToken(o.orderId); }
    });
    pushToken(fallbackNumero);
    pushToken(fallbackCliente);
    return Array.from(tokens).join(' ');
  }

  function normalizeCajaOrders(entry){
    if(!entry || typeof entry !== 'object') return entry;
    const cleanedOrders = normalizeOrders(entry.orders);
    const fallbackId = Number(entry.orderId);
    const fallbackNumero = entry.orderNumero != null ? String(entry.orderNumero) : null;
    const fallbackCliente = entry.orderCliente != null ? String(entry.orderCliente) : null;
    const ensureOrderPresent = (orderId, numero, cliente)=>{
      if(orderId == null && !numero && !cliente) return;
      if(orderId != null && cleanedOrders.some(o => o.orderId === orderId)) return;
      if(orderId == null && cleanedOrders.some(o => o.numeroOrden === numero && o.cliente === cliente)) return;
      cleanedOrders.push({ orderId, numeroOrden: numero, cliente });
    };
    if(Number.isFinite(fallbackId) && fallbackId > 0){
      ensureOrderPresent(Math.trunc(fallbackId), fallbackNumero, fallbackCliente);
    } else if(fallbackNumero || fallbackCliente){
      ensureOrderPresent(null, fallbackNumero, fallbackCliente);
    }
    const primary = cleanedOrders[0] || null;
    const normalized = {
      ...entry,
      orders: cleanedOrders,
      orderId: primary?.orderId ?? (Number.isFinite(fallbackId) && fallbackId > 0 ? Math.trunc(fallbackId) : null),
      orderNumero: primary?.numeroOrden ?? fallbackNumero,
      orderCliente: primary?.cliente ?? fallbackCliente
    };
    normalized.orderSearch = buildOrderSearch(cleanedOrders, normalized.orderNumero, normalized.orderCliente);
    return normalized;
  }

  function ordersSummaryHTML(source, opts){
    const options = opts || {};
    const orders = Array.isArray(source?.orders) && source.orders.length
      ? source.orders
      : (() => {
          const numero = source?.orderNumero || (source?.orderId ? `#${source.orderId}` : null);
          const cliente = source?.orderCliente || null;
          if(!numero && !cliente) return [];
          return [{ orderId: source?.orderId ?? null, numeroOrden: numero, cliente }];
        })();
    if(!orders.length) return '';
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : orders.length;
    const rows = orders.slice(0, limit).map(o => {
      const numero = o.numeroOrden || (o.orderId ? `#${o.orderId}` : null);
      const numeroHtml = numero ? `<span class="font-mono">${safeHTML(numero)}</span>` : '<span class="font-mono opacity-40">—</span>';
      const cliente = o.cliente ? `<span class="opacity-70">${safeHTML(o.cliente)}</span>` : '';
      const separator = cliente ? '<span class="opacity-40">·</span>' : '';
      return `<div class="flex items-center gap-1 flex-wrap">${numeroHtml}${cliente ? `${separator}${cliente}` : ''}</div>`;
    }).join('');
    const extra = orders.length > limit
      ? `<div class="text-[10px] opacity-60 leading-snug">+${orders.length - limit} más</div>`
      : '';
    const title = options.showTitle ? '<div class="uppercase tracking-wide text-[9px] opacity-60">Ordenes</div>' : '';
    const cls = options.className || 'text-[10px] opacity-70 leading-snug space-y-1';
    return `<div class="${cls}">${title}${rows}${extra}</div>`;
  }

  function ordersPlainStrings(source){
    const normalized = normalizeCajaOrders(source || {});
    const list = Array.isArray(normalized.orders) ? normalized.orders : [];
    if(list.length){
      return list.map(o => {
        const num = o.numeroOrden || (o.orderId ? `#${o.orderId}` : null);
        const cli = o.cliente ? ` (${o.cliente})` : '';
        return (num || '#?') + cli;
      });
    }
    const fallbackNum = normalized.orderNumero || (normalized.orderId ? `#${normalized.orderId}` : null);
    if(!fallbackNum) return [];
    const fallbackCli = normalized.orderCliente ? ` (${normalized.orderCliente})` : '';
    return [String(fallbackNum) + fallbackCli];
  }

  function renderOrdersDetail(container, source){
    if(!container) return;
    const normalized = normalizeCajaOrders(source || {});
    const orders = Array.isArray(normalized.orders) ? normalized.orders : [];
    if(!orders.length){
      container.innerHTML = '<span class="opacity-60 font-mono">—</span>';
      container.classList.add('opacity-60');
      container.removeAttribute('title');
      return;
    }
    container.classList.remove('opacity-60');
    const rows = orders.map(o => {
      const numero = o.numeroOrden || (o.orderId ? `#${o.orderId}` : '—');
      const cliente = o.cliente ? `<span class="opacity-70">${safeHTML(o.cliente)}</span>` : '';
      const separator = cliente ? '<span class="opacity-40">·</span>' : '';
      return `<div class="flex flex-wrap items-center gap-1"><span class="font-mono">${safeHTML(numero)}</span>${cliente ? `${separator}${cliente}` : ''}</div>`;
    }).join('');
    container.innerHTML = rows;
    container.title = orders.map(o => {
      const numero = o.numeroOrden || (o.orderId ? `#${o.orderId}` : '—');
      return o.cliente ? `${numero} · ${o.cliente}` : numero;
    }).join('\n');
  }

  function enableSimpleMultiSelect(selectEl){
    if(!selectEl || selectEl.__simpleMultiBound) return;
    selectEl.addEventListener('mousedown', (event)=>{
      const option = event.target;
      if(!option || option.tagName !== 'OPTION') return;
      event.preventDefault();
      const alreadySelected = option.selected;
      option.selected = !alreadySelected;
      if(typeof selectEl.focus === 'function'){ selectEl.focus(); }
      const inputEvt = new Event('input', { bubbles: true });
      const changeEvt = new Event('change', { bubbles: true });
      selectEl.dispatchEvent(inputEvt);
      selectEl.dispatchEvent(changeEvt);
    });
    selectEl.__simpleMultiBound = true;
  }

  function ensureNegativeWarningElement(){
    if(scanNegativeWarningEl && scanNegativeWarningEl.isConnected){
      return scanNegativeWarningEl;
    }
    scanNegativeWarningEl = document.getElementById('scan-negative-warning');
    if(scanNegativeWarningEl && scanNegativeWarningEl.isConnected){
      return scanNegativeWarningEl;
    }
    const el = document.createElement('div');
    el.id = 'scan-negative-warning';
    el.className = 'mt-3 hidden rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-content flex flex-col gap-1';
    const anchor = document.getElementById('scan-negative-anchor')
      || (listaParcial ? listaParcial.parentElement : null)
      || document.querySelector('#scan-form-wrapper')
      || document.querySelector('#scan-modal-body');
    if(anchor){ anchor.appendChild(el); }
    else { document.body.appendChild(el); }
    scanNegativeWarningEl = el;
    return el;
  }

  function renderNegativeWarning(){
    const btnCrear = qs(sel.crearBtn);
    if(!scanNegatives.size){
      if(scanNegativeWarningEl && scanNegativeWarningEl.isConnected){
        scanNegativeWarningEl.classList.add('hidden');
        scanNegativeWarningEl.innerHTML = '';
      }
      if(btnCrear){
        btnCrear.classList.remove('btn-warning');
        btnCrear.classList.remove('btn-error');
      }
      return;
    }
    const el = ensureNegativeWarningElement();
    const lines = Array.from(scanNegatives.entries()).map(([code, seconds])=>{
      const pretty = formatNegativeElapsed(seconds);
      return `<li class="flex items-center justify-between gap-2"><span class="font-mono">${safeHTML(code)}</span><span class="font-mono text-error">${pretty}</span></li>`;
    }).join('');
    el.innerHTML = `<div class="font-semibold text-warning">TICs con cronómetro negativo</div><ul class="space-y-1">${lines}</ul><div class="text-[11px] opacity-80">Debes confirmar la creación para continuar con estas TICs.</div>`;
    el.classList.remove('hidden');
    if(btnCrear){ btnCrear.classList.add('btn-warning'); }
  }

  function scheduleValidationRefresh(){
    if(scanValidationTimerId){ clearTimeout(scanValidationTimerId); }
    scanValidationTimerId = setTimeout(()=>{
      scanValidationTimerId = 0;
      refreshScanValidation();
    }, NEGATIVE_REFRESH_DELAY_MS);
  }

  async function refreshScanValidation(){
    if(!scanBuffer.length){
        if(scanValidationController) scanValidationController.abort();
        if(scanNegatives.size) {
          scanNegatives = new Map();
          renderNegativeWarning();
        }
        return;
    }
    if(scanValidationController){
      scanValidationController.abort();
    }
    const controller = new AbortController();
    scanValidationController = controller;
    try{
      const codes = scanBuffer.map((s)=> s.codigo);
      const res = await fetch('/operacion/acond/ensamblaje/validate', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ rfids: codes }),
        signal: controller.signal
      });
      let json = null;
      try{ json = await res.json(); }catch{ json = null; }
      if(scanValidationController !== controller){ return; }
      scanValidationController = null;
      if(!res.ok || json?.ok === false){
        console.warn('[Acond] refreshScanValidation: respuesta no válida', json);
        if(scanNegatives.size){
          scanNegatives = new Map();
          renderNegativeWarning();
        }
        return;
      }
      const valid = Array.isArray(json?.valid) ? json.valid : [];
      let negatives = [];
      try{
        negatives = await collectNegativeElapsed(valid, { forceMap: false });
      }catch(err){
        console.warn('[Acond] collectNegativeElapsed falló', err);
        negatives = [];
      }
      const nextMap = new Map();
      negatives.forEach((entry)=>{
        const key = String(entry.rfid || '').toUpperCase();
        const secNum = Math.max(0, Math.floor(Number(entry.elapsed)||0));
        if(key && secNum > 0){
          nextMap.set(key, secNum);
        }
      });
      const changed = !mapsEqual(nextMap, scanNegatives);
      scanNegatives = nextMap;
      renderNegativeWarning();
      if(changed){
        refreshScanList();
      }
    }catch(err){
      if(err?.name === 'AbortError') return;
      scanValidationController = null;
      console.warn('[Acond] refreshScanValidation error:', err);
    }
  }

  async function collectNegativeElapsed(validList, options){
    const opts = options || {};
    const ticValid = Array.isArray(validList)
      ? validList.filter((it)=> it && it.rol === 'tic')
      : [];
    if(!ticValid.length) return [];
    const nowMs = Date.now() + serverNowOffsetMs;

    const buildFromMap = (map)=>{
      const parseMs = (value)=>{
        if(!value) return NaN;
        const ms = new Date(value).getTime();
        return Number.isFinite(ms) ? ms : NaN;
      };
      const entries = [];
      const fallback = [];
      const missing = new Set();
      ticValid.forEach((item)=>{
        const code = String(item.rfid || '').toUpperCase();
        if(!code) return;
        const info = map.get(code) || null;
        let lote = '';
        let completedMs = NaN;
        if(info){
          lote = typeof info.lote === 'string' ? info.lote.trim() : info.lote ? String(info.lote) : '';
          const compMs = parseMs(info.item_completed_at || info.completed_at || info.completedAt);
          const updMs = parseMs(info.item_updated_at || info.updated_at || info.updatedAt);
          if(Number.isFinite(compMs) && Number.isFinite(updMs)) completedMs = Math.max(compMs, updMs);
          else if(Number.isFinite(compMs)) completedMs = compMs;
          else if(Number.isFinite(updMs)) completedMs = updMs;
        } else {
          missing.add(code);
        }
        let elapsed = Number(item.atemperadoElapsedSec);
        if(Number.isFinite(completedMs)){
          elapsed = Math.max(0, Math.floor((nowMs - completedMs)/1000));
        }
        if(Number.isFinite(elapsed) && elapsed > 0){
          if(Number.isFinite(completedMs)){
            entries.push({ rfid: code, elapsed, completedMs, lote });
          } else {
            fallback.push({ rfid: code, elapsed, lote });
          }
        }
      });
      return { entries, fallback, missing };
    };

    const ensureMap = async(force)=>{
      try {
        const map = await loadAtemperamientoMap(force);
        return map instanceof Map ? map : new Map(map || []);
      } catch(err){
        console.warn('[Acond] No se pudo consultar mapa de atemperamiento', err);
        return new Map();
      }
    };

    let map = await ensureMap(!!opts.forceMap);
    let { entries, fallback, missing } = buildFromMap(map);

    if((missing.size && !opts.forceMap) || (!entries.length && fallback.length)){ // reintentar con mapa fresco
      map = await ensureMap(true);
      ({ entries, fallback, missing } = buildFromMap(map));
    }

    if(entries.length){
      const groups = new Map();
      entries.forEach((entry)=>{
        const loteKey = entry.lote ? entry.lote : '__sin_lote__';
        if(!groups.has(loteKey)) groups.set(loteKey, []);
        groups.get(loteKey).push(entry);
      });
      groups.forEach((list)=>{
        if(!Array.isArray(list) || list.length <= 1) return;
        const valid = list.filter((it)=> Number.isFinite(it.completedMs));
        if(valid.length <= 1) return;
        const minMs = Math.min(...valid.map((it)=> it.completedMs));
        const maxMs = Math.max(...valid.map((it)=> it.completedMs));
        if((maxMs - minMs) > NEGATIVE_SYNC_THRESHOLD_MS) return;
        list.forEach((it)=>{
          if(Number.isFinite(it.completedMs)){
            it.completedMs = maxMs;
            it.elapsed = Math.max(0, Math.floor((nowMs - maxMs)/1000));
          }
        });
      });
      return entries
        .map(({ rfid, elapsed })=> ({ rfid, elapsed }))
        .filter((it)=> Number.isFinite(it.elapsed) && it.elapsed > 0);
    }

    return fallback
      .map(({ rfid, elapsed })=> ({ rfid, elapsed }))
      .filter((it)=> Number.isFinite(it.elapsed) && it.elapsed > 0);
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
        if(firstRfid){
          const hit = listoDespacho.find(i => String(i.codigo||'').toUpperCase() === firstRfid);
          focusListoCajaId = hit ? (hit.caja_id || hit.cajaId || hit.cajaID) : null;
        } else {
          focusListoCajaId = null;
        }
        const filtered = focusListoCajaId != null
          ? listoDespacho.filter(i => String(i.caja_id||i.cajaId||i.cajaID) === String(focusListoCajaId))
          : (filterValue
            ? listoDespacho.filter(i =>
              (i.codigo||'').toLowerCase().includes(filterValue) ||
              (i.nombre||'').toLowerCase().includes(filterValue) ||
              (i.lote||'').toLowerCase().includes(filterValue) ||
              (i.orderSearch||'').includes(filterValue))
            : listoDespacho);
        listoTotalCount = listoDespacho.length;
        listoFilteredCount = filtered.length;
        const rows = filtered.map(item => {
          const cajaIdRef = item.caja_id || item.cajaId || item.cajaID;
          const t = item.cronometro;
          let estadoTxt = 'Lista para Despacho';
          if(t && t.startsAt && t.endsAt){
            const now = Date.now() + serverNowOffsetMs;
            const end = new Date(t.endsAt).getTime();
            if(now < end) estadoTxt = 'Despachando';
          }
          return `<tr class="hover" data-caja-id="${safeHTML(cajaIdRef || '')}">
      <td class="text-sm font-mono">${safeHTML(item.lote || '')}</td>
      <td class="text-sm flex flex-col leading-tight">
        <span class="uppercase tracking-wide">${safeHTML(item.nombre || '')}</span>
        <span class="font-mono text-xs opacity-40">${safeHTML(item.codigo || '')}</span>
      </td>
      <td class="text-sm">${safeHTML(estadoTxt)}</td>
    </tr>`;
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
          : (filterValue
              ? listoDespacho.filter(i =>
                  (i.codigo||'').toLowerCase().includes(filterValue) ||
                  (i.nombre||'').toLowerCase().includes(filterValue) ||
                  (i.lote||'').toLowerCase().includes(filterValue) ||
                  (i.orderSearch||'').includes(filterValue))
              : listoDespacho);
        const groupsMap = new Map();
        filtered.forEach(it=>{
          const cajaId = it.caja_id || it.cajaId || it.cajaID || it.caja;
          const key = cajaId ? `id:${cajaId}` : `lote:${it.lote}`;
          if(!groupsMap.has(key)){
            groupsMap.set(key, {
              lote: it.lote,
              cajaId: cajaId || it.lote,
              timer: null,
              componentes: [],
              categorias: {},
              items: [],
              orderId: it.order_id ?? null,
              orderNumero: it.order_num ?? (it.order_id != null ? `#${it.order_id}` : null),
              orderCliente: it.order_client || '',
              orders: [],
              _orderKeySet: new Set()
            });
          }
          const g = groupsMap.get(key);
          if(!g.timer && it.cronometro && it.cronometro.startsAt && it.cronometro.endsAt){
            g.timer = it.cronometro;
          }
          const tipo = (it.categoria||'').toLowerCase();
          g.componentes.push({ tipo, codigo: it.codigo, nombreUnidad: it.nombre_unidad || null });
          g.items.push({ codigo: it.codigo });
          g.categorias[tipo] = (g.categorias[tipo]||0)+1;
          if(g.orderId == null && it.order_id != null){ g.orderId = it.order_id; }
          if(!g.orderNumero && (it.order_num || it.order_id != null)){ g.orderNumero = it.order_num || `#${it.order_id}`; }
          if(!g.orderCliente && it.order_client){ g.orderCliente = it.order_client; }
          const ensureOrder = (orderObj)=>{
            if(!orderObj || typeof orderObj !== 'object') return;
            const candidateId = Number(orderObj.orderId);
            const orderIdNorm = Number.isFinite(candidateId) && candidateId > 0 ? Math.trunc(candidateId) : null;
            const numeroNorm = orderObj.numeroOrden != null ? String(orderObj.numeroOrden) : null;
            const clienteNorm = orderObj.cliente != null ? String(orderObj.cliente) : null;
            const keyParts = [orderIdNorm ?? '', numeroNorm ?? '', clienteNorm ?? ''];
            const rawKey = keyParts.join('|').toLowerCase();
            if(!rawKey.trim()) return;
            if(g._orderKeySet.has(rawKey)) return;
            g._orderKeySet.add(rawKey);
            g.orders.push({ orderId: orderIdNorm, numeroOrden: numeroNorm, cliente: clienteNorm });
          };
          if(Array.isArray(it.orders) && it.orders.length){
            it.orders.forEach(ensureOrder);
          } else {
            ensureOrder({ orderId: it.order_id ?? null, numeroOrden: it.order_num ?? null, cliente: it.order_client ?? null });
          }
        });
        const groups = Array.from(groupsMap.values());
        grid.innerHTML = groups.map(g => {
          const cubeComp = g.componentes.find(comp => comp.tipo === 'cube' && comp.nombreUnidad);
          const nombreCaja = cubeComp?.nombreUnidad || g.lote || (`CAJA-${g.cajaId}`);
          const fakeCaja = {
            id: g.cajaId,
            codigoCaja: g.lote || (`CAJA-${g.cajaId}`),
            nombreCaja,
            estado: 'Lista para Despacho',
            timer: g.timer ? { startsAt: g.timer.startsAt, endsAt: g.timer.endsAt, completedAt: g.timer.completedAt } : null,
            componentes: g.componentes,
            orderId: g.orderId ?? null,
            orderNumero: g.orderNumero || null,
            orderCliente: g.orderCliente || '',
            orders: g.orders
          };
          return cajaCardHTML(fakeCaja, { hideTimerUI: false, hideTimerActions: true, listTimer: g.timer });
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
    : (filterValue ? cajas.filter(c => (c.codigoCaja||'').toLowerCase().includes(filterValue) || (c.nombreCaja||'').toLowerCase().includes(filterValue) || (c.orderSearch||'').includes(filterValue) || (c.componentes||[]).some(cc => String(cc.codigo||'').toLowerCase().includes(filterValue))) : cajas.slice());

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

  function cajaCardHTML(c, options){
    const opts = options || {};
    const hideTimerUI = opts.hideTimerUI === true;
    const listTimer = opts.listTimer || null;
    const listTimerOnly = hideTimerUI && listTimer;
    const cardTimer = options?.listTimer ? {
      ...options.listTimer,
      startsAt: options.listTimer.startsAt,
      endsAt: options.listTimer.endsAt,
      completedAt: options.listTimer.completedAt || null
    } : c.timer;
    const remaining = cardTimer ? (()=>{
      if(!cardTimer.endsAt) return 0;
      const endMs = new Date(cardTimer.endsAt).getTime();
      const nowMs = Date.now() + serverNowOffsetMs;
      return endMs - nowMs;
    })() : msRemaining(c);
    const timerText = timerDisplay(remaining, cardTimer?.completedAt);
    const progress = cardTimer ? (()=>{
      if(!cardTimer.startsAt || !cardTimer.endsAt) return 0;
      const startMs = new Date(cardTimer.startsAt).getTime();
      const endMs = new Date(cardTimer.endsAt).getTime();
      if(endMs <= startMs) return 100;
      const total = endMs - startMs;
      const elapsed = Math.max(0, Math.min(total, (Date.now() + serverNowOffsetMs) - startMs));
      return (elapsed / total) * 100;
    })() : timerProgressPct(c);
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
    const orderBlock = ordersSummaryHTML(c, { className: 'text-[10px] opacity-70 leading-snug space-y-0.5', limit: 3 });
    // Timer badge used inside bottom row (not top-right now)
    let timerSection = '';
    if(!hideTimerUI){
      let timerBadge='';
      const cardTimer = listTimer ? listTimer : c.timer;
      if(cardTimer && cardTimer.startsAt && cardTimer.endsAt && !cardTimer.completedAt){
        const startMs = new Date(cardTimer.startsAt).getTime();
        const endMs = new Date(cardTimer.endsAt).getTime();
        const durationSec = Math.round((endMs - startMs)/1000);
        const showActions = !opts.hideTimerActions && !listTimer;
        timerBadge = `<span class='badge badge-neutral badge-xs flex items-center gap-1' data-caja-timer-started='${startMs}' data-caja-timer-duration='${durationSec}' data-caja-id='${safeHTML(c.id)}'>
            <span id='tm-caja-${safeHTML(c.id)}' class='font-mono whitespace-nowrap tabular-nums'>${timerText}</span>
            ${showActions ? `<button class='btn btn-ghost btn-xs px-1 h-4 shrink-0 stop-caja-timer' data-caja='${safeHTML(c.id)}' title='Cancelar'>✕</button>` : ''}
          </span>`;
      } else if(cardTimer && cardTimer.completedAt){
        timerBadge = `<span class='badge badge-success badge-xs'>Listo</span>`;
      } else {
        const allEnsamblado = (c.componentes||[]).length>0 ? (c.componentes.every(()=> true) && (c.estado==='Ensamblado' || /Ensamblado/i.test(c.sub_estado||''))) : /Ensamblado/i.test(c.sub_estado||c.estado||'');
        if(allEnsamblado || /Ensamblado/i.test(c.estado||'')){
          timerBadge = `<span class='badge badge-success badge-xs'>Listo</span>`;
        } else {
          const showActions = !opts.hideTimerActions && !listTimer;
          timerBadge = `
            <span class='badge badge-outline badge-xs opacity-60'>Sin cronómetro</span>
            ${showActions ? `<button class='btn btn-ghost btn-xs px-1 h-4 shrink-0' data-action='timer-start' data-caja-id='${safeHTML(c.id)}' title='Iniciar'>▶</button>` : ''}
          `;
        }
      }
      const pct = Math.min(100, Math.max(0, progress));
      timerSection = `
        <div class='timer-progress h-1.5 w-full bg-base-300/30 rounded-full overflow-hidden'>
          <div class='timer-bar h-full bg-gradient-to-r from-primary via-primary to-primary/70' style='width:${pct.toFixed(1)}%' data-caja-bar='${safeHTML(c.id)}'></div>
        </div>
        <div class='flex items-center justify-between text-[10px] font-mono opacity-70'>
          <span class='inline-flex items-center gap-1'>${timerBadge}</span>
          <span class='opacity-50'>restante</span>
        </div>`;
    }
    const code = c.codigoCaja || '';
    const displayName = c.nombreCaja || code || 'Caja';
    const titleText = displayName && code && displayName !== code ? `${displayName} · ${code}` : displayName || code || 'Caja';
  return `<div class='caja-card rounded-lg border border-base-300/40 bg-base-200/10 p-3 flex flex-col gap-2 hover:border-primary/60 transition' data-caja-id='${safeHTML(c.id)}' title='${safeHTML(titleText)}'>
        <div class='text-[10px] uppercase opacity-60 tracking-wide'>Caja</div>
  <div class='font-semibold text-xs leading-tight break-all pr-2'>${safeHTML(displayName)}</div>
  ${orderBlock}
        <div class='flex flex-wrap gap-1 text-[9px] flex-1'>${compBadges || "<span class='badge badge-ghost badge-xs'>Sin items</span>"}</div>
        ${timerSection}
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
    const code = c.codigoCaja || '';
    const displayName = c.nombreCaja || code || '';
    const codeLine = code && displayName !== code ? `<span class="block font-mono text-[10px] opacity-60">${safeHTML(code)}</span>` : '';
    const cajaTd = `<td class="text-sm leading-tight">${safeHTML(displayName)}${codeLine}</td>`;
    if(!comps.length){
  // Vista simplificada: sin cronómetro por componente/caja en tabla de Ensamblaje
  return [ `<tr class="hover" data-caja-id="${safeHTML(c.id)}">\n        ${cajaTd}\n        <td class="text-sm opacity-60">(sin items)</td>\n        <td class="text-sm">${safeHTML(c.estado||'')}</td>\n      </tr>` ];
    }
    return comps.filter(cc => {
      if(set && set.size){ return set.has(String(cc.codigo||'').toUpperCase()); }
      if(fallbackTextFilter){ return String(cc.codigo||'').toLowerCase().includes(fallbackTextFilter); }
      return true;
    }).map(cc => {
  // Fila sin columna de cronómetro (solo caja, componente y estado)
  return `<tr class="hover" data-caja-id="${safeHTML(c.id)}">\n        ${cajaTd}\n        <td class="text-sm flex flex-col leading-tight">\n          <span class="uppercase tracking-wide">${safeHTML(cc.tipo||cc.nombre||'')}</span>\n          <span class="font-mono text-xs opacity-40">${safeHTML(cc.codigo)}</span>\n        </td>\n        <td class="text-sm">${safeHTML(c.estado||'')}</td>\n      </tr>`;
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
    if(remainingMs <= 0){
      const overSec = Math.max(0, Math.ceil(Math.abs(remainingMs)/1000));
      return formatNegativeElapsed(overSec);
    }
    const totalSec = Math.floor(remainingMs/1000);
    const hours = Math.floor(totalSec/3600);
    const minutes = Math.floor((totalSec % 3600)/60);
    const seconds = totalSec % 60;
    const hh = String(hours).padStart(2,'0');
    const mm = String(minutes).padStart(2,'0');
    const ss = String(seconds).padStart(2,'0');
    return `${hh}:${mm}:${ss}`;
  }

  function timerBadgeHTML(c, remaining){
    if(!c.timer) return '<span class="badge badge-ghost badge-xs">Sin timer</span>';
  if(c.timer.completedAt) return '<span class="badge badge-success badge-xs">Listo</span>';
    if(remaining <= 0) return '<span class="badge badge-error badge-xs">En negativo</span>';
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
      refreshTimerDefaults(json.timerDefaults);
      cajas = Array.isArray(json.cajas) ? json.cajas.map(normalizeCajaOrders) : [];
      listoDespacho = Array.isArray(json.listoDespacho) ? json.listoDespacho.map(normalizeCajaOrders) : [];
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
  }
  function stopPolling(){ if(pollInterval) clearInterval(pollInterval); pollInterval = null; }

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
          const remSecRaw = Math.floor(remaining/1000);
          const remSec = Math.max(0, remSecRaw);
          badge.classList.remove('badge-info','badge-warning','badge-error','badge-success','badge-neutral');
          if(remSecRaw<=0){
            badge.classList.add('badge-error');
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
          const remSecRaw = Math.floor(remaining/1000);
          const remSec = Math.max(0, remSecRaw);
          bar.classList.toggle('bg-error', remSecRaw<=0);
          bar.classList.toggle('bg-warning', remSec>0 && remSec<=60);
        }
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
  }

  // ========================= MODAL DETALLE =========================
  // Nueva implementación alineada al markup real (#modal-caja-detalle)
  function openCajaDetalle(id){
    let caja = cajas.find(c=> String(c.id) === String(id));
    let allowTimerActions = true;
    // Si no está en 'cajas' (ensamblaje), intentar construir desde lista para despacho
    if(!caja){
      allowTimerActions = false;
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
          orderNumero: (tItem && tItem.order_num) ? tItem.order_num : (items[0] && items[0].order_num ? items[0].order_num : null),
          orderCliente: (tItem && tItem.order_client) ? tItem.order_client : (items[0] && items[0].order_client ? items[0].order_client : '')
        };
      }
    }
    if(caja){
      caja = normalizeCajaOrders(caja);
    }
    if(!caja) return; // nada que mostrar
    const modalWrap = document.getElementById('modal-caja-detalle');
    if(!modalWrap) return;

    // Meta básica
    const comps = (caja.componentes||[]);
    const counts = { vip:0, tic:0, cube:0 };
    comps.forEach(x=>{ if(x && x.tipo){ counts[x.tipo] = (counts[x.tipo]||0)+1; } });

    const setText = (id, val) => { const el=document.getElementById(id); if(el) el.textContent = val; };
    setText('detalle-caja-titulo', caja.nombreCaja || caja.codigoCaja || 'Caja');
    setText('detalle-caja-lote', caja.codigoCaja || '');
    setText('detalle-caja-id', `#${caja.id}`);
    setText('detalle-caja-comp', `VIP:${counts.vip||0} · TIC:${counts.tic||0} · CUBE:${counts.cube||0}`);
    setText('detalle-caja-fecha', formatDateTime(caja.createdAt));
    // Orden vinculada (si existe)
    const ordenEl = document.getElementById('detalle-caja-orden');
    if(ordenEl){
      renderOrdersDetail(ordenEl, caja);
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
        html = allowTimerActions
          ? `<div class="flex items-center gap-2">
          <span class="text-sm opacity-60 italic">(Sin cronómetro)</span>
          <button class="btn btn-xs btn-primary" data-action="timer-start" data-caja-id="${safeHTML(caja.id)}">Iniciar</button>
        </div>`
          : '<div class="text-sm opacity-60 italic">(Cronómetro gestionado en Ensamblaje)</div>';
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
        html = allowTimerActions
          ? '<div class="text-sm opacity-60 italic">(Cronómetro sin iniciar)</div>'
          : '<div class="text-sm opacity-60 italic">(Cronómetro gestionado en Ensamblaje)</div>';
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
      if(scanNegatives.size){
        scanNegatives = new Map();
      }
      renderNegativeWarning();
      return;
    }
    ul.innerHTML = scanBuffer.map((s)=>{
      const code = String(s.codigo || '').toUpperCase();
      const negativeSec = scanNegatives.get(code);
      const hasNegative = Number.isFinite(negativeSec) && negativeSec > 0;
      const badge = hasNegative
        ? `<span class='badge badge-error badge-xs font-mono tabular-nums ml-2'>${formatNegativeElapsed(negativeSec)}</span>`
        : '';
      const textCls = hasNegative ? 'text-error' : '';
      return `<li class='text-xs font-mono flex justify-between items-center ${textCls}'>
                <span class='flex items-center gap-2'>${safeHTML(code)}${badge}</span>
                <button class='btn btn-ghost btn-xs' data-action='scan-remove' data-codigo='${safeHTML(code)}'>✕</button>
              </li>`;
    }).join('');
    renderNegativeWarning();
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
    scheduleValidationRefresh();
  }

  async function validarParcial(){
    if(scanBuffer.length===0) return;
    disableBtn(sel.validarBtn, true);
    try{
      const res = await fetch('/operacion/acond/ensamblaje/validate',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids: scanBuffer.map(s=> s.codigo) })});
      const json = await res.json();
      if(!res.ok){ throw new Error(json.message || 'Error de validación'); }
      console.log('[Acond] Validación parcial OK', json);
      const negatives = await collectNegativeElapsed(json?.valid, { forceMap: false });
      if(Array.isArray(negatives) && negatives.length){
        const detail = negatives.map((it)=> `${it.rfid} · ${formatNegativeElapsed(it.elapsed)}`).join('\n');
        alert(`Advertencia: las siguientes TICs ya superaron su atemperamiento:\n\n${detail}`);
      }
    }catch(err){
      console.error('[Acond] validarParcial error:', err);
      alert(err.message || 'Error validando');
    }finally{ disableBtn(sel.validarBtn, false); }
  }

  async function confirmNegativeTimersBeforeCreate(rfidsOverride){
    try{
      const rfids = Array.isArray(rfidsOverride) && rfidsOverride.length
        ? rfidsOverride.map((code)=> String(code || '').toUpperCase())
        : scanBuffer.map((s)=> String(s.codigo || '').toUpperCase());
      if(!rfids.length){
        alert('No hay componentes para validar.');
        return false;
      }
      const res = await fetch('/operacion/acond/ensamblaje/validate',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids })});
      const json = await res.json();
      if(!res.ok || json?.ok === false){
        throw new Error(json?.message || json?.error || 'Error verificando la composición');
      }
      const invalid = Array.isArray(json?.invalid) ? json.invalid : [];
      if(invalid.length){
        const details = invalid.map((it)=> `${it.rfid || 'RFID'}: ${it.reason || 'Motivo desconocido'}`).join('\n');
        alert(`Revisa los componentes antes de crear la caja:\n\n${details}`);
        return false;
      }
      const valid = Array.isArray(json?.valid) ? json.valid : [];
      let finalNegatives = await collectNegativeElapsed(valid, { forceMap: false });
      const metaByCode = new Map();
      valid.forEach((item)=>{
        if(!item) return;
        const code = String(item.rfid || '').toUpperCase();
        if(!code) return;
        metaByCode.set(code, {
          rol: item.rol,
          modeloId: normalizeModeloId(item.modeloId ?? item.modelo_id)
        });
      });
      const overLimitBlocks = [];
      if(Array.isArray(finalNegatives) && finalNegatives.length){
        finalNegatives.forEach((entry)=>{
          if(!entry) return;
          const code = String(entry.rfid || '').toUpperCase();
          if(!code) return;
          const meta = metaByCode.get(code);
          if(!meta || meta.rol !== 'tic') return;
          const elapsedSec = Math.max(0, Math.floor(Number(entry.elapsed) || 0));
          if(elapsedSec <= 0) return;
          const modeloId = meta.modeloId;
          if(!modeloId) return;
          const cfg = timerDefaults.get(modeloId);
          const maxSec = cfg ? Number(cfg.maxSobreAtemperamientoSec ?? 0) : 0;
          if(!Number.isFinite(maxSec) || maxSec <= 0) return;
          if(elapsedSec > maxSec){
            overLimitBlocks.push({
              code,
              elapsedSec,
              maxSec,
              modeloNombre: cfg?.modeloNombre || null
            });
          }
        });
      }
      if(overLimitBlocks.length){
        const lines = overLimitBlocks.map((issue)=>{
          const elapsedLabel = formatMinutesLabel(Math.round(issue.elapsedSec / 60));
          const maxLabel = formatMinutesLabel(Math.round(issue.maxSec / 60));
          const name = issue.modeloNombre ? ` (${issue.modeloNombre})` : '';
          return `· ${issue.code}${name}: ${elapsedLabel} > máx ${maxLabel}`;
        });
        alert(`No es posible crear la caja porque algunos TICs superaron el tiempo máximo permitido:\n\n${lines.join('\n')}\n\nRetira esos TICs y vuelve a intentar.`);
        return false;
      }
      if(!finalNegatives.length) return true;
      const lines = finalNegatives.map((it)=> `${it.rfid} · ${formatNegativeElapsed(it.elapsed)}`);
      const message = `Los TICs atemperados tienen tiempo negativo desde que finalizaron el atemperamiento:\n\n${lines.join('\n')}\n\n¿Seguro que deseas crear la caja?`;
      return window.confirm(message);
    }catch(err){
      console.error('[Acond] confirmNegativeTimersBeforeCreate error:', err);
      alert(err?.message || 'Error verificando el estado de las TICs');
      return false;
    }
  }

  function listoCardHTML(item){
    const chronoLabel = 'Cronómetro en Ensamblaje';
    const orderBlock = ordersSummaryHTML(item, { className: 'text-[10px] opacity-70 leading-snug space-y-1', limit: 2 });
    return `<div class="card bg-base-100 shadow-sm border border-base-200 p-2" data-listo-rfid="${safeHTML(item.codigo)}">
      <div class="flex items-start justify-between mb-1">
        <span class="font-mono text-[10px]">${safeHTML(item.codigo)}</span>
        <span class="badge badge-ghost badge-xs uppercase">${safeHTML(item.categoria||'')}</span>
      </div>
      <div class="text-[11px] font-semibold leading-tight mb-1">${safeHTML(item.nombre||'-')}</div>
      <div class="text-[10px] opacity-70 mb-1">${safeHTML(item.estado||'')}</div>
      ${orderBlock}
      <div class="text-[10px] text-right opacity-60">${chronoLabel}</div>
    </div>`;
  }
  // Card agrupada por caja
  function listoCajaCardHTML(group){
    const badgeHTML = '<span class="badge badge-ghost badge-xs">Cronómetro en Ensamblaje</span>';
    const actionsHTML = '<span class="text-[10px] opacity-50">Sin acciones</span>';
    const categoriaBadges = Object.entries(group.categorias).sort().map(([k,v])=>`<span class="badge badge-ghost badge-xs">${k} x${v}</span>`).join(' ');
    const codes = group.items.slice(0,8).map(it=>`<span class="badge badge-neutral badge-xs font-mono" title="${safeHTML(it.codigo)}">${safeHTML(it.codigo.slice(-6))}</span>`).join(' ');
    const orderBlock = ordersSummaryHTML(group, { className: 'text-[10px] opacity-70 leading-snug space-y-1 pointer-events-none', limit: 3 });
    return `<div class="card bg-base-100 shadow-sm border border-base-200 p-2 cursor-pointer hover:border-primary/60 transition" data-listo-caja="${safeHTML(group.lote)}" data-caja-id="${safeHTML(group.cajaId)}">
      <div class="flex items-start justify-between mb-1 pointer-events-none">
        <span class="font-mono text-[10px]">${safeHTML(group.lote)}</span>
        <span class="badge badge-info badge-xs">${group.items.length} items</span>
      </div>
      <div class="text-[10px] flex flex-wrap gap-1 mb-1 pointer-events-none">${categoriaBadges||''}</div>
      <div class="text-[10px] grid grid-cols-3 gap-1 mb-1 pointer-events-none">${codes}</div>
      ${orderBlock}
      <div class="flex items-center justify-between">
        <div class="text-[10px] opacity-80">${badgeHTML}</div>
        ${actionsHTML}
      </div>
    </div>`;
  }
  

  async function crearCaja(){
    if(scanBuffer.length===0){ alert('Agregue componentes primero.'); return; }
    const proceed = await confirmNegativeTimersBeforeCreate();
    if(!proceed) return;
    disableBtn(sel.crearBtn, true);
    try{
  // Backend espera { rfids: [] }
  const res = await fetch('/operacion/acond/ensamblaje/create',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfids: scanBuffer.map(s=> s.codigo) })});
      const json = await res.json();
      if(!res.ok) throw new Error(json.message || 'Error creando caja');
      // Reset buffer
      scanBuffer = [];
      if(scanValidationController){
        scanValidationController.abort();
        scanValidationController = null;
      }
      scanNegatives = new Map();
      refreshScanList();
      renderNegativeWarning();
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
        const normalized = codigo ? String(codigo).toUpperCase() : '';
        if(normalized){ scanNegatives.delete(normalized); }
        refreshScanList();
        scheduleValidationRefresh();
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
    const timerHintEl = document.getElementById('ensam-timer-hint');
    const defaultTimerHint = timerHintEl ? (timerHintEl.textContent || '') : '';
  // Ordenes
  const linkOrderChk = document.getElementById('ensam-link-order');
  const orderSelect = document.getElementById('ensam-order-select');
  const orderHint = document.getElementById('ensam-order-hint');
  const selectZona = document.getElementById('ensam-zona');
  const selectSeccion = document.getElementById('ensam-seccion');
  const locationHint = document.getElementById('ensam-location-hint');

    const ticNegatives = new Map();
    let negativeSyncMs = Date.now();
    let negativeTickerId = 0;
    let negativeConsentRequired = false;
    let negativeConsentChecked = false;
    let negativeConsentContainer = null;
    let negativeConsentList = null;
    let negativeConsentCheckbox = null;

  // Conjuntos de válidos por rol
  const ticSet = new Set();
  const vipSet = new Set();
  const cubeSet = new Set();
  const componentMeta = new Map();
    const overLimitRfids = new Map();
  // Buffer de escaneos (todos los códigos escaneados pendientes/validados)
  const scannedSet = new Set();
  let _validateTimer = 0;
    let lastDurationSuggestion = null;
    let userDurationTouched = false;

    function setLocationMessage(text){ if(locationHint){ locationHint.textContent = text || ''; } }

    const locationController = (typeof window !== 'undefined' && window.LocationSelector && typeof window.LocationSelector.create === 'function')
      ? window.LocationSelector.create({
          zonaSelect: selectZona,
          seccionSelect: selectSeccion,
          hintElement: locationHint
        })
      : null;

    function ensureLocationSelectors(){
      if(!locationController) return Promise.resolve();
      return locationController.ensure({ zonaId: ensamZonaId, seccionId: ensamSeccionId })
        .then(()=>{
          const current = locationController.getValue();
          ensamZonaId = current.zonaId || '';
          ensamSeccionId = current.seccionId || '';
        });
    }

    const roleNames = { tic: 'TIC', vip: 'VIP', cube: 'CUBE' };

    const formatRolesList = (roles) => {
      if(!Array.isArray(roles) || !roles.length) return '';
      const normalized = Array.from(new Set(roles.map((role) => String(role || '').toLowerCase())));
      const display = normalized.map((role) => roleNames[role] || role.toUpperCase());
      if(!display.length) return '';
      if(display.length === 1) return display[0];
      if(display.length === 2) return `${display[0]} y ${display[1]}`;
      const last = display.pop();
      return `${display.join(', ')} y ${last}`;
    };

    function setTimerHint(message, tone){
      if(!timerHintEl) return;
      const text = message || '';
      timerHintEl.textContent = text;
      timerHintEl.classList.remove('text-error','text-success','text-info','text-warning','opacity-60');
      const preset = tone || 'default';
      if(preset === 'error'){
        timerHintEl.classList.add('text-error');
      } else if(preset === 'success'){
        timerHintEl.classList.add('text-success');
      } else if(preset === 'info'){
        timerHintEl.classList.add('text-info');
      } else {
        timerHintEl.classList.add('opacity-60');
      }
    }

    const resetTimerHint = () => {
      setTimerHint(defaultTimerHint, 'default');
    };

    function setDurationInputsFromMinutes(totalMinutes){
      if(!horas || !minutos) return;
      const total = Math.max(0, Math.round(Number(totalMinutes) || 0));
      const hrs = Math.floor(total / 60);
      const mins = total - hrs * 60;
      horas.value = hrs > 0 ? String(hrs) : '';
      minutos.value = String(mins);
    }

    function buildDurationSuggestion(){
      if(componentMeta.size === 0) return null;
      const sourcesByModelo = new Map();
      const missingRolesSet = new Set();
      componentMeta.forEach((meta) => {
        if(!meta) return;
        const modeloId = normalizeModeloId(meta.modeloId);
        if(!modeloId){
          if(meta.rol) missingRolesSet.add(String(meta.rol).toLowerCase());
          return;
        }
        const cfg = timerDefaults.get(modeloId);
        if(!cfg || !Number.isFinite(cfg.vidaCajaSec) || cfg.vidaCajaSec <= 0){
          if(meta.rol) missingRolesSet.add(String(meta.rol).toLowerCase());
          return;
        }
        const minutes = Math.max(1, Math.round(cfg.vidaCajaSec / 60));
        if(!sourcesByModelo.has(modeloId)){
          sourcesByModelo.set(modeloId, {
            minutes,
            rol: meta.rol,
            litraje: meta.litraje || null,
            modeloId,
            modeloNombre: cfg.modeloNombre || meta.modeloNombre || null
          });
        }
      });
      const sources = Array.from(sourcesByModelo.values());
      const missingRoles = Array.from(missingRolesSet);
      if(!sources.length){
        return { status: 'missing', missingRoles };
      }
      const minutesSet = new Set(sources.map((entry) => entry.minutes));
      const minutesList = Array.from(minutesSet);
      if(minutesList.length > 1){
        return { status: 'conflict', minutesList, sources, missingRoles };
      }
      const minutes = minutesList[0];
      const priority = { cube: 1, vip: 2, tic: 3 };
      const primary = sources.slice().sort((a, b) => (priority[a.rol] || 99) - (priority[b.rol] || 99))[0] || sources[0];
      return { status: 'ok', minutes, primary, sources, missingRoles };
    }

    function recalculateOverLimit(){
      overLimitRfids.clear();
      componentMeta.forEach((meta, code) => {
        if(!meta || meta.rol !== 'tic') return;
        const elapsed = Number(meta.atemperadoElapsedSec);
        if(!Number.isFinite(elapsed) || elapsed <= 0) return;
        const modeloId = normalizeModeloId(meta.modeloId);
        if(!modeloId) return;
        const cfg = timerDefaults.get(modeloId);
        const maxSec = cfg ? Number(cfg.maxSobreAtemperamientoSec ?? 0) : 0;
        if(!Number.isFinite(maxSec) || maxSec <= 0) return;
        if(elapsed > maxSec){
          overLimitRfids.set(code, {
            elapsed,
            maxSec,
            modeloNombre: cfg?.modeloNombre || meta.modeloNombre || null,
            litraje: meta.litraje || null
          });
        }
      });
    }

    function applyDurationSuggestion(suggestion){
      lastDurationSuggestion = suggestion;
      if(!suggestion){
        resetTimerHint();
        return;
      }
      const status = suggestion.status;
      if(status === 'missing'){
        setTimerHint('Sin configuración de vida de caja para los componentes escaneados. Ingresa la duración manualmente.', 'error');
        return;
      }
      if(status === 'conflict'){
        const labels = suggestion.minutesList.map((value) => formatMinutesLabel(value)).join(' vs ');
        setTimerHint(`Las configuraciones de vida de caja no coinciden (${labels}). Ajusta la duración manualmente.`, 'error');
        return;
      }
      if(status === 'ok'){
        if(suggestion.minutes > 0){
          setDurationInputsFromMinutes(suggestion.minutes);
          userDurationTouched = false;
        }
        const parts = [`Tiempo predeterminado: ${formatMinutesLabel(suggestion.minutes)}`];
        if(suggestion.primary?.litraje){
          parts.push(`Litraje ${suggestion.primary.litraje}`);
        } else if(suggestion.primary?.modeloNombre){
          parts.push(suggestion.primary.modeloNombre);
        }
        let tone = 'success';
        if(Array.isArray(suggestion.missingRoles) && suggestion.missingRoles.length){
          const rolesLabel = formatRolesList(suggestion.missingRoles);
          if(rolesLabel){ parts.push(`Sin configuración para ${rolesLabel}`); }
          tone = 'info';
        }
        setTimerHint(parts.join(' · '), tone);
      } else {
        resetTimerHint();
      }
      if(overLimitRfids.size){
        const first = overLimitRfids.entries().next().value;
        if(first){
          const code = first[0];
          const info = first[1];
          const elapsedLabel = formatMinutesLabel(Math.round(Number(info.elapsed || 0) / 60));
          const maxLabel = formatMinutesLabel(Math.round(Number(info.maxSec || 0) / 60));
          setTimerHint(`TIC ${code} excede el máximo permitido (${elapsedLabel} > ${maxLabel}). Retíralo antes de crear la caja.`, 'error');
        }
      }
    }


    function stopNegativeTicker(){
      if(!negativeTickerId) return;
      clearInterval(negativeTickerId);
      negativeTickerId = 0;
    }

    function updateNegativeBadges(){
      if(!negativeConsentList) return;
      const delta = Math.max(0, Math.floor((Date.now() - negativeSyncMs)/1000));
      negativeConsentList.querySelectorAll('[data-negative-code]').forEach((badge)=>{
        if(!(badge instanceof HTMLElement)) return;
        const code = badge.dataset.negativeCode;
        if(!code) return;
        const base = ticNegatives.get(code);
        if(base == null) return;
        badge.textContent = formatNegativeElapsed(base + delta);
      });
    }

    function ensureNegativeTicker(){
      if(negativeTickerId) return;
      negativeTickerId = window.setInterval(()=>{
        if(!ticNegatives.size){
          stopNegativeTicker();
          return;
        }
        updateNegativeBadges();
      }, 1000);
    }

    function ensureNegativeConsentElements(){
      if(negativeConsentContainer || !crearBtn) return;
      const host = crearBtn.parentElement;
      if(!host) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'basis-full rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning-content hidden flex flex-col gap-2';
      const title = document.createElement('div');
      title.className = 'font-semibold text-warning';
      title.textContent = 'TICs atemperados con tiempo negativo';
      const list = document.createElement('ul');
      list.className = 'space-y-1 font-mono text-[11px] text-warning';
      const label = document.createElement('label');
      label.className = 'mt-1 flex items-start gap-2 text-[11px] text-warning';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'checkbox checkbox-warning checkbox-xs mt-[2px]';
      const span = document.createElement('span');
      span.className = 'leading-snug font-medium';
      span.textContent = 'Comprendo que estas TICs vencieron su atemperamiento y deseo crear la caja igualmente.';
      label.appendChild(checkbox);
      label.appendChild(span);
      wrapper.appendChild(title);
      wrapper.appendChild(list);
      wrapper.appendChild(label);
      host.classList.add('flex', 'flex-wrap', 'gap-3');
      host.appendChild(wrapper);
      negativeConsentContainer = wrapper;
      negativeConsentList = list;
      negativeConsentCheckbox = checkbox;
      negativeConsentCheckbox.addEventListener('change', ()=>{
        negativeConsentChecked = !!negativeConsentCheckbox?.checked;
        updateStatus();
      });
    }

    function renderNegativeConsent(){
      if(!crearBtn) return;
      ensureNegativeConsentElements();
      if(!negativeConsentContainer || !negativeConsentList || !negativeConsentCheckbox){
        negativeConsentRequired = false;
        negativeConsentChecked = false;
        return;
      }
      if(!ticNegatives.size){
        negativeConsentContainer.classList.add('hidden');
        negativeConsentList.innerHTML = '';
        negativeConsentCheckbox.checked = false;
        negativeConsentRequired = false;
        negativeConsentChecked = false;
        stopNegativeTicker();
        return;
      }
      const items = Array.from(ticNegatives.entries()).map(([code, seconds])=>{
        const meta = componentMeta.get(code);
        const unit = meta && meta.nombreUnidad ? meta.nombreUnidad : '';
        const unitLine = unit ? `<span class="text-[11px] leading-tight text-warning-content/80">${safeHTML(unit)}</span>` : '';
        const overInfo = overLimitRfids.get(code);
        const badgeClass = overInfo ? 'badge badge-error badge-xs font-mono tabular-nums' : 'badge badge-warning badge-xs font-mono tabular-nums';
        const limitLine = overInfo
          ? `<span class="text-[10px] text-error font-semibold leading-tight">Supera máx ${safeHTML(formatMinutesLabel(Math.round(Number(overInfo.maxSec || 0) / 60)))}</span>`
          : '';
        return `<li class="flex items-center justify-between gap-2 text-warning">
            <span class="flex flex-col">
              <span class="font-semibold">${safeHTML(code)}</span>
              ${unitLine}
              ${limitLine}
            </span>
            <span class="${badgeClass}" data-negative-code="${safeHTML(code)}">${formatNegativeElapsed(seconds)}</span>
          </li>`;
      }).join('');
      negativeConsentList.innerHTML = items;
      negativeConsentContainer.classList.remove('hidden');
      negativeConsentRequired = true;
      if(!negativeConsentChecked){
        negativeConsentCheckbox.checked = false;
      }
      negativeConsentChecked = !!negativeConsentCheckbox.checked;
      updateNegativeBadges();
      ensureNegativeTicker();
    }


    function renderLists(){
      if(listTic){
        listTic.innerHTML = [...ticSet].map(r=>{
          const code = String(r || '').toUpperCase();
          const meta = componentMeta.get(code);
          const unit = meta && meta.nombreUnidad ? meta.nombreUnidad : '';
          const unitLine = unit ? `<span class="text-[10px] leading-tight text-base-content/70">${safeHTML(unit)}</span>` : '';
          const overInfo = overLimitRfids.get(code);
          const maxLabel = overInfo ? formatMinutesLabel(Math.round(Number(overInfo.maxSec || 0) / 60)) : '';
          const elapsedLabel = overInfo ? formatMinutesLabel(Math.round(Number(overInfo.elapsed || 0) / 60)) : '';
          const overLine = overInfo
            ? `<span class="text-[10px] text-error font-semibold leading-tight">Supera límite: ${safeHTML(elapsedLabel)} (máx ${safeHTML(maxLabel)})</span>`
            : '';
          const cls = overInfo
            ? 'px-2 py-1 rounded text-xs flex flex-col gap-1 border border-error/50 bg-error/10'
            : 'px-2 py-1 bg-base-200 rounded text-xs flex flex-col';
          return `<li class="${cls}">
              <span class="font-mono">${safeHTML(code)}</span>
              ${unitLine}
              ${overLine}
            </li>`;
        }).join('');
      }
      if(listVip){
        listVip.innerHTML = [...vipSet].map(r=>{
          const code = String(r || '').toUpperCase();
          const meta = componentMeta.get(code);
          const unit = meta && meta.nombreUnidad ? meta.nombreUnidad : '';
          const unitLine = unit ? `<span class="text-[10px] leading-tight text-base-content/70">${safeHTML(unit)}</span>` : '';
          return `<li class="px-2 py-1 bg-base-200 rounded text-xs flex flex-col">
              <span class="font-mono">${safeHTML(code)}</span>
              ${unitLine}
            </li>`;
        }).join('');
      }
      if(listCube){
        listCube.innerHTML = [...cubeSet].map(r=>{
          const code = String(r || '').toUpperCase();
          const meta = componentMeta.get(code);
          const unit = meta && meta.nombreUnidad ? meta.nombreUnidad : '';
          const unitLine = unit ? `<span class="text-[10px] leading-tight text-base-content/70">${safeHTML(unit)}</span>` : '';
          return `<li class="px-2 py-1 bg-base-200 rounded text-xs flex flex-col">
              <span class="font-mono">${safeHTML(code)}</span>
              ${unitLine}
            </li>`;
        }).join('');
      }
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
      if(hint){
        if(compComplete()){
          hint.textContent = overLimitRfids.size
            ? 'Retira los TICs que superaron el máximo de sobre atemperado antes de crear la caja.'
            : 'Composición completa. Indica duración y crea la caja.';
        } else {
          hint.textContent = `Faltan: ${faltTic} TIC · ${faltVip} VIP · ${faltCube} CUBE`;
        }
      }
      if(crearBtn){
        const ready = compComplete() && durationMinutes()>0;
        const consentOk = !negativeConsentRequired || negativeConsentChecked;
        const overLimitOk = overLimitRfids.size === 0;
        crearBtn.disabled = !(ready && consentOk && overLimitOk);
      }
      // Orden select state
      if(linkOrderChk && orderSelect){
        orderSelect.disabled = !linkOrderChk.checked;
        if(!linkOrderChk.checked){
          orderSelect.selectedIndex = -1;
        }
      }
    }
    function resetAll(){
      ticSet.clear();
      vipSet.clear();
      cubeSet.clear();
      componentMeta.clear();
      overLimitRfids.clear();
      scannedSet.clear();
      scanProcessQueue = Promise.resolve();
      ticNegatives.clear();
      negativeConsentRequired = false;
      negativeConsentChecked = false;
      lastDurationSuggestion = null;
      userDurationTouched = false;
      if(horas) horas.value = '';
      if(minutos) minutos.value = '';
      resetTimerHint();
      renderLists();
      renderNegativeConsent();
      updateStatus();
      if(msg) msg.textContent='';
      if(orderSelect){
        orderSelect.innerHTML = `<option value="" disabled>Selecciona una o más órdenes…</option>`;
        orderSelect.selectedIndex = -1;
        orderSelect.scrollTop = 0;
        orderSelect.multiple = true;
        orderSelect.size = 3;
        enableSimpleMultiSelect(orderSelect);
      }
      if(linkOrderChk){ linkOrderChk.checked=false; }
      ensureLocationSelectors();
    }

    async function loadOrdenes(){
      if(!orderSelect) return;
      orderSelect.innerHTML = `<option value="" disabled>Cargando órdenes…</option>`;
      try{
        const r = await fetch('/ordenes/list', { headers:{ 'Accept':'application/json' } });
        const j = await r.json();
        if(!r.ok || j.ok===false){ throw new Error(j.error||'Error'); }
        const items = Array.isArray(j.items) ? j.items : [];
        // Build options label: numero_orden · cliente · producto · cantidad
        const opts = [`<option value="" disabled>Selecciona una o más órdenes…</option>`]
          .concat(items.map(o => {
            const num = (o.numero_orden||'').toString();
            const cli = (o.cliente||'').toString();
            const prod = (o.codigo_producto||'').toString();
            const cant = (o.cantidad!=null? o.cantidad: '').toString();
            const label = [num, cli, prod, cant?`x${cant}`:''].filter(Boolean).join(' · ');
            return `<option value="${o.id}">${label}</option>`;
          }));
        orderSelect.innerHTML = opts.join('');
        orderSelect.multiple = true;
        const visibleCount = Math.min(6, Math.max(3, items.length || 3));
        orderSelect.size = visibleCount;
        orderSelect.selectedIndex = -1;
        enableSimpleMultiSelect(orderSelect);
      }catch(e){
        orderSelect.innerHTML = `<option value="" disabled>No se pudo cargar órdenes</option>`;
        orderSelect.multiple = true;
        orderSelect.size = 3;
        orderSelect.selectedIndex = -1;
        enableSimpleMultiSelect(orderSelect);
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
        ticSet.clear();
        vipSet.clear();
        cubeSet.clear();
        componentMeta.clear();
        roles.forEach(v=>{
          const code = String(v.rfid||'').toUpperCase();
          if(!code) return;
          const nombreUnidad = v.nombre_unidad || v.nombreUnidad || v.nombre_modelo || '';
          const litraje = v.litraje || v.litrajeValor || null;
          const modeloId = normalizeModeloId(v.modeloId ?? v.modelo_id);
          const modeloNombre = typeof v.nombre_modelo === 'string' ? v.nombre_modelo : (typeof v.modeloNombre === 'string' ? v.modeloNombre : null);
          const elapsedRaw = Number(v.atemperadoElapsedSec ?? v.atemperado_elapsed_sec);
          const atemperadoElapsedSec = Number.isFinite(elapsedRaw) && elapsedRaw > 0 ? Math.max(0, Math.floor(elapsedRaw)) : null;
          componentMeta.set(code, { rol: v.rol, nombreUnidad, litraje, modeloId, modeloNombre, atemperadoElapsedSec });
          if(v.rol==='tic') ticSet.add(code);
          else if(v.rol==='vip') vipSet.add(code);
          else if(v.rol==='cube') cubeSet.add(code);
        });
        // Auto-filtrar: remover inválidos del buffer (no mostrar en UI ni revalidarlos)
        if(invalid.length){
          invalid.forEach(it=>{
            const code = String(it.rfid||'').toUpperCase();
            scannedSet.delete(code);
            componentMeta.delete(code);
          });
        }
        // Cap local: máximo 6 TICs visibles/seleccionables
        if(ticSet.size > 6){
          const keep = Array.from(ticSet).slice(0,6);
          const removed = Array.from(ticSet).slice(6);
          ticSet.clear(); keep.forEach(r=> ticSet.add(r));
          removed.forEach(code=>{
            componentMeta.delete(code);
            ticNegatives.delete(code);
          });
          if(msg) msg.textContent = 'Máximo 6 TICs';
        }
        const prevNegatives = new Map(ticNegatives);
        ticNegatives.clear();
        roles.forEach(v=>{
          if(v.rol!=='tic') return;
          const code = String(v.rfid||'').toUpperCase();
          const elapsed = Number(v.atemperadoElapsedSec);
          if(code && Number.isFinite(elapsed) && elapsed > 0 && ticSet.has(code)){
            ticNegatives.set(code, Math.max(0, Math.floor(elapsed)));
          }
        });
        if(!ticNegatives.size){
          try{
            const fallback = await collectNegativeElapsed(roles, { forceMap:false });
            fallback.forEach(({ rfid, elapsed })=>{
              const code = String(rfid||'').toUpperCase();
              const sec = Math.max(0, Math.floor(Number(elapsed)||0));
              if(code && sec>0 && ticSet.has(code)){
                ticNegatives.set(code, sec);
              }
            });
          }catch(err){
            console.warn('[Ensamblaje] No se pudo obtener tiempos negativos', err);
          }
        }
        ticNegatives.forEach((seconds, code) => {
          const meta = componentMeta.get(code);
          if(meta){
            const sec = Math.max(0, Math.floor(Number(seconds) || 0));
            meta.atemperadoElapsedSec = sec;
            componentMeta.set(code, meta);
          }
        });
        negativeSyncMs = Date.now();
        const negativesChanged = !mapsEqual(ticNegatives, prevNegatives);
        if(negativesChanged){
          negativeConsentChecked = false;
          negativeConsentCheckbox && (negativeConsentCheckbox.checked = false);
        }
        recalculateOverLimit();
        const suggestion = buildDurationSuggestion();
        renderLists();
        renderNegativeConsent();
        updateNegativeBadges();
        applyDurationSuggestion(suggestion);
        updateStatus();
        if(msg){
          if(invalid.length){
            const first = invalid[0] || {};
            msg.textContent = first.reason ? `Advertencia: ${first.reason}` : 'Hay componentes inválidos.';
          } else {
            msg.textContent = '';
          }
        }
        console.debug('[Ensamblaje] Validación OK', json);
      } catch(e){ if(msg) msg.textContent = e.message||'Error'; }
    }
    function scheduleValidate(){ if(_validateTimer){ clearTimeout(_validateTimer); } _validateTimer = setTimeout(()=>{ _validateTimer=0; validateAll(); }, 120); }
    let scanProcessQueue = Promise.resolve();

    selectZona?.addEventListener('change', ()=>{
      if(!locationController) return;
      const value = locationController.getValue();
      ensamZonaId = value.zonaId || '';
      ensamSeccionId = '';
      locationController.setValue(ensamZonaId, ensamSeccionId);
    });

    selectSeccion?.addEventListener('change', ()=>{
      if(!locationController) return;
      const value = locationController.getValue();
      ensamZonaId = value.zonaId || '';
      ensamSeccionId = value.seccionId || '';
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
    horas?.addEventListener('input', ()=>{
      userDurationTouched = true;
      setTimerHint('Duración personalizada aplicada manualmente.', 'info');
      updateStatus();
    });
    minutos?.addEventListener('input', ()=>{
      userDurationTouched = true;
      setTimerHint('Duración personalizada aplicada manualmente.', 'info');
      updateStatus();
    });
    limpiarBtn?.addEventListener('click', ()=>{ resetAll(); scanInput?.focus(); });
    crearBtn?.addEventListener('click', async ()=>{
      if(crearBtn.disabled) return;
      const rfids = [...ticSet, ...vipSet, ...cubeSet];
      if(rfids.length!==8){ if(msg) msg.textContent='Composición incompleta'; return; }
      const durMin = durationMinutes();
      if(durMin<=0){ if(msg) msg.textContent='Duración inválida'; return; }
      if(negativeConsentRequired && !negativeConsentChecked){
        if(msg) msg.textContent = 'Debes confirmar que aceptas crear la caja con TICs vencidos.';
        negativeConsentCheckbox?.focus();
        return;
      }
      // Optional order ids (multi)
      let orderIds = [];
      if(linkOrderChk && linkOrderChk.checked && orderSelect){
        orderIds = Array.from(orderSelect.selectedOptions || [])
          .map(opt => Number(opt.value))
          .filter(id => Number.isFinite(id) && id > 0);
      }
      let zonaId = '';
      let seccionId = '';
      if(locationController){
        const value = locationController.getValue();
        zonaId = value.zonaId || '';
        seccionId = value.seccionId || '';
      } else {
        zonaId = selectZona ? String(selectZona.value || '').trim() : '';
        seccionId = selectSeccion ? String(selectSeccion.value || '').trim() : '';
      }
      ensamZonaId = zonaId;
      ensamSeccionId = seccionId;
      crearBtn.disabled = true; if(msg) msg.textContent='Validando cronómetro...';
      try {
        const confirmed = await confirmNegativeTimersBeforeCreate(rfids);
        if(!confirmed){ crearBtn.disabled=false; if(!msg.textContent) msg.textContent = 'Operación cancelada.'; return; }
        if(msg) msg.textContent='Creando caja...';
        const attempt = await postJSONWithSedeTransfer('/operacion/acond/ensamblaje/create', { rfids, order_ids: orderIds, zona_id: zonaId, seccion_id: seccionId }, {
          promptMessage: (data) => data?.confirm || data?.error || 'Las piezas seleccionadas pertenecen a otra sede. ¿Deseas trasladarlas a tu sede actual?'
        });
        if(attempt.cancelled){ if(msg) msg.textContent = 'Operación cancelada.'; return; }
        const json = attempt.data || {};
        if(!attempt.httpOk || !json.ok) throw new Error(json.error||'Error creando caja');
        // Inicia cronómetro inmediatamente
        try { await fetch('/operacion/acond/caja/timer/start',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: json.caja_id, durationSec: durMin*60 })}); } catch(e){ console.warn('No se pudo iniciar timer', e); }
        if(msg) msg.textContent = `Caja ${json.lote} creada`;
        await loadData();
        resetAll();
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
    const selectZona = document.getElementById('despacho-zona');
    const selectSeccion = document.getElementById('despacho-seccion');
    const locationHint = document.getElementById('despacho-location-hint');
    const locationController = (typeof window !== 'undefined' && window.LocationSelector && typeof window.LocationSelector.create === 'function')
      ? window.LocationSelector.create({
          zonaSelect: selectZona,
          seccionSelect: selectSeccion,
          hintElement: locationHint
        })
      : null;
    let selectedZonaId = '';
    let selectedSeccionId = '';

    const toTempInputString = (value) => {
      if(value === undefined || value === null || value === '') return '';
      const num = Number(value);
      if(Number.isFinite(num)) return String(num);
      return String(value).trim();
    };
    const toSensorString = (value) => {
      if(value === undefined || value === null) return '';
      return String(value).trim();
    };
    const hasTempAndSensor = (entry) => {
      if(!entry) return false;
      const tempRaw = entry.tempSalida != null ? String(entry.tempSalida).trim() : '';
      if(!tempRaw) return false;
      const tempNum = Number(tempRaw.replace(',', '.'));
      if(!Number.isFinite(tempNum)) return false;
      const sensorText = entry.sensorId != null ? String(entry.sensorId).trim() : '';
      return sensorText.length > 0;
    };

    let queue = [];
    let selectedCajaId = null;
    const seenRfids = new Set();
    const pendingRfids = new Set();

    function badgeForRol(rol){
      const type = String(rol || '').toLowerCase();
      if(type === 'vip') return 'badge-info text-white';
      if(type === 'cube') return 'badge-accent text-white';
      return 'badge-warning text-black';
    }

    function normalizeComponentes(source){
      if(!Array.isArray(source) || !source.length) return [];
      if(typeof source[0] === 'string'){
        return source.map(code => ({ rfid: code, rol: 'tic' }));
      }
      return source.map(item => ({
        rfid: item.rfid || item.codigo || '',
        rol: item.rol || item.tipo || '',
        litraje: item.litraje ?? item.litros ?? null,
        nombre: item.nombre || item.modelo || item.nombre_modelo || item.descripcion || '',
        estado: item.estado || item.estado_actual || '',
        subEstado: item.sub_estado || item.subEstado || ''
      }));
    }

    function computeDurationSec(){
      if(!hrInput && !minInput) return 0;
      const hrs = Number(hrInput?.value || '0');
      const mins = Number(minInput?.value || '0');
      const totalMin = (Number.isFinite(hrs) ? hrs : 0) * 60 + (Number.isFinite(mins) ? mins : 0);
      return totalMin > 0 ? totalMin * 60 : 0;
    }

    function updateConfirmState(){
      const ready = queue.length > 0 && queue.every(hasTempAndSensor);
      if(confirmBtn){
        confirmBtn.disabled = !ready;
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
      selectedZonaId = '';
      selectedSeccionId = '';
      locationController && locationController.reset();
      updateCount();
      updateConfirmState();
    }

    function formatComponents(entry){
      if(entry.componentes && entry.componentes.length){
        const cards = entry.componentes.map(comp => {
          const cls = badgeForRol(comp.rol);
          const rawRol = String(comp.rol || comp.tipo || '').trim().toUpperCase();
          const label = safeHTML(rawRol || '');
          const code = safeHTML(comp.rfid || comp.codigo || '');
          const nombreRaw = typeof comp.nombre === 'string' ? comp.nombre.trim() : '';
          let litrajeLabel = '';
          if(comp.litraje !== undefined && comp.litraje !== null && comp.litraje !== ''){
            const numeric = Number(comp.litraje);
            if(Number.isFinite(numeric)){
              const normalized = Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1);
              litrajeLabel = normalized + ' L';
            } else {
              const text = String(comp.litraje).trim();
              if(text){
                litrajeLabel = /l$/i.test(text) ? text : text + ' L';
              }
            }
          }
          const metaParts = [];
          if(nombreRaw) metaParts.push(safeHTML(nombreRaw));
          if(litrajeLabel) metaParts.push(safeHTML(litrajeLabel));
          const subState = String(comp.subEstado || '').trim();
          if(subState && subState.toLowerCase() !== 'ensamblado'){ metaParts.push(`<span class="text-warning">${safeHTML(subState)}</span>`); }
          const meta = metaParts.length ? `<div class="text-[10px] opacity-70 leading-tight">${metaParts.join(' · ')}</div>` : '';
          return `<div class="flex flex-col gap-1 px-2 py-2 rounded bg-base-200/60">
            <div class="flex items-center justify-between gap-2">
              <span class="badge ${cls} badge-xs font-semibold">${label}</span>
              <span class="font-mono text-[10px] tracking-tight">${code}</span>
            </div>
            ${meta}
          </div>`;
        }).join('');
        const cardsGrid = `<div class="grid gap-2 grid-cols-1 sm:grid-cols-2">${cards}</div>`;
        const note = entry.componentesOcultos
          ? '<div class="text-[11px] text-warning mt-2">Componentes pendientes: verifica el cronómetro de Ensamblaje.</div>'
          : '';
        return cardsGrid + note;
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
        const orderStrings = ordersPlainStrings(entry);
        const orderLabel = orderStrings.length ? orderStrings.join(' · ') : '-';
        const orderTitle = orderStrings.join('\n');
        const pendLabel = entry.pendientes != null ? entry.pendientes : '?';
        const pendValue = safeHTML(String(pendLabel));
        const badges = [];
        if(!entry.allEnsamblado){ badges.push(`<span class="badge badge-error badge-xs text-white">Pend ${pendValue}</span>`); }
        if(entry.timerActive){ badges.push('<span class="badge badge-info badge-xs text-white">Cronometro activo</span>'); }
        const badgesHtml = badges.length
          ? `<div class="flex flex-wrap items-center justify-start sm:justify-end gap-1 text-[9px] font-semibold">${badges.join('')}</div>`
          : '';
        const warnParts = [];
        if(!entry.allEnsamblado){ warnParts.push('La caja tiene componentes pendientes o en Ensamblaje.'); }
        if(entry.timerActive){ warnParts.push('Cronómetro en progreso, se conservará en Lista para Despacho.'); }
        const warnings = warnParts.length
          ? `<div class="mt-3 text-[11px] text-warning flex flex-wrap items-center gap-2">${warnParts.map(p=>`<span>${safeHTML(p)}</span>`).join('')}</div>`
          : '';
        const tempSalidaText = toTempInputString(entry.tempSalida);
        const sensorText = toSensorString(entry.sensorId);
        const summaryPieces = [];
        if(tempSalidaText){ summaryPieces.push(`<span>Temp salida: <strong>${safeHTML(tempSalidaText)}°C</strong></span>`); }
        if(sensorText){ summaryPieces.push(`<span>Sensor: ${safeHTML(sensorText)}</span>`); }
        const collapsedParts = [];
        if(warnParts.length){ collapsedParts.push(`<div class="px-3 pb-1 text-[10px] text-warning">${warnParts.map(safeHTML).join(' ')}</div>`); }
        if(summaryPieces.length){ collapsedParts.push(`<div class="px-3 pb-3 text-[10px] opacity-70 flex flex-wrap gap-2">${summaryPieces.join('<span class="opacity-40">·</span>')}</div>`); }
        const collapsedNotice = !isSelected ? collapsedParts.join('') : '';
        const componentsMarkup = formatComponents(entry);
        const tempForm = `<div class="mt-3 space-y-2 text-xs">
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="form-control">
              <span class="label-text text-[11px] uppercase opacity-70">Temp salida (°C)</span>
              <input type="number" inputmode="decimal" step="0.1" class="input input-sm input-bordered" data-field="temp_salida" data-caja="${safeHTML(entry.cajaId)}" value="${safeHTML(tempSalidaText)}" placeholder="Ej. 2.5" />
            </label>
            <label class="form-control">
              <span class="label-text text-[11px] uppercase opacity-70">Sensor / Serial</span>
              <input type="text" class="input input-sm input-bordered" data-field="sensor_id" data-caja="${safeHTML(entry.cajaId)}" value="${safeHTML(sensorText)}" placeholder="Ej. S123456" maxlength="120" />
            </label>
          </div>
          <p class="text-[11px] opacity-60">Aplicaremos estos datos a todos los componentes cuando marques la caja como Lista.</p>
        </div>`;
        const details = isSelected
          ? `<div class="px-3 pb-3 space-y-3">${componentsMarkup}${warnings}${tempForm}</div>`
          : collapsedNotice;
        return `<div class="border rounded-lg ${isSelected ? 'border-primary bg-base-200/40' : 'border-base-300/60 bg-base-200/10'} cursor-pointer transition-colors" data-select-caja="${safeHTML(entry.cajaId)}">
          <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 px-3 py-2">
            <div class="flex items-center gap-2 text-xs font-semibold">
              <span class="text-[10px] opacity-60">${idx + 1}</span>
              <span class="break-words leading-tight">${safeHTML(entry.lote || ('Caja ' + entry.cajaId))}</span>
            </div>
            <div class="flex flex-col gap-1 w-full sm:w-auto">
              <div class="flex flex-wrap items-center justify-between sm:justify-end gap-2 text-[10px] uppercase opacity-70">
                <span class="whitespace-nowrap" title="${safeHTML(orderTitle)}">Orden: ${safeHTML(orderLabel)}</span>
                <span class="whitespace-nowrap">${safeHTML(String(entry.total || 0))} items</span>
                <button type="button" class="btn btn-ghost btn-xs shrink-0" data-remove-caja="${safeHTML(entry.cajaId)}">x</button>
              </div>
              ${badgesHtml}
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
        const normalizedOrderInfo = normalizeCajaOrders({
          orders: Array.isArray(data.orders) ? data.orders : [],
          orderId: data.order_id ?? null,
          orderNumero: data.order_num ?? null,
          orderCliente: data.order_client ?? null
        });
        const componentes = (()=>{
          if(Array.isArray(data.componentes) && data.componentes.length){
            return normalizeComponentes(data.componentes);
          }
          if(Array.isArray(data.rfids) && data.rfids.length){
            return normalizeComponentes(data.rfids);
          }
          return [];
        })();
        const incomingTempSalida = toTempInputString(data.temp_salida_c);
        const incomingSensor = toSensorString(data.sensor_id);
        let entry = queue.find(item => String(item.cajaId) === String(cajaId));
        if(!entry){
          entry = {
            cajaId,
            lote: data.lote || `Caja ${cajaId}`,
            orderId: normalizedOrderInfo.orderId,
            orderNum: normalizedOrderInfo.orderNumero,
            orderCliente: normalizedOrderInfo.orderCliente,
            orders: normalizedOrderInfo.orders,
            componentes,
            total: data.total ?? componentes.length,
            pendientes: data.pendientes ?? 0,
            componentesOcultos: data.componentesOcultos === true,
            rfids: [],
            allEnsamblado: isComplete,
            timer: data.timer || null,
            timerActive,
            tempSalida: incomingTempSalida,
            sensorId: incomingSensor
          };
          queue.push(entry);
        } else {
          entry.lote = data.lote || entry.lote;
          entry.orderId = normalizedOrderInfo.orderId ?? entry.orderId;
          entry.orderNum = normalizedOrderInfo.orderNumero ?? entry.orderNum;
          entry.orderCliente = normalizedOrderInfo.orderCliente ?? entry.orderCliente;
          entry.orders = normalizedOrderInfo.orders.length ? normalizedOrderInfo.orders : entry.orders;
          entry.componentes = componentes.length ? componentes : entry.componentes;
          entry.total = data.total ?? entry.total;
          entry.pendientes = data.pendientes ?? entry.pendientes;
          entry.componentesOcultos = data.componentesOcultos === true;
          entry.allEnsamblado = isComplete;
          entry.timer = data.timer || entry.timer;
          entry.timerActive = timerActive;
          if((entry.tempSalida == null || String(entry.tempSalida).trim() === '') && incomingTempSalida){
            entry.tempSalida = incomingTempSalida;
          }
          if((entry.sensorId == null || String(entry.sensorId).trim() === '') && incomingSensor){
            entry.sensorId = incomingSensor;
          }
        }
        if(!entry.rfids.includes(code)) entry.rfids.push(code);
        seenRfids.add(code);
        selectedCajaId = entry.cajaId;
        renderQueue();
        if(msg){
          const notes = [];
          if(!isComplete) notes.push(`${entry.pendientes ?? 'algunos'} pendientes`);
          if(timerActive) notes.push('cronometro activo');
          msg.textContent = notes.length
            ? `Caja ${entry.lote} se moverá con ${notes.join(' y ')}.`
            : `Caja ${entry.lote} lista (${entry.total || 0} items).`;
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
      locationController && locationController.ensure();
      setTimeout(()=> input?.focus(), 40);
    });

    confirmBtn?.addEventListener('click', async ()=>{
      const durationSec = computeDurationSec();
      if(!queue.length){
        if(msg){ msg.textContent = 'No hay cajas escaneadas.'; }
        return;
      }
      if(locationController){
        const value = locationController.getValue();
        selectedZonaId = value.zonaId || '';
        selectedSeccionId = value.seccionId || '';
      } else {
        selectedZonaId = selectZona ? String(selectZona.value || '') : '';
        selectedSeccionId = selectSeccion ? String(selectSeccion.value || '') : '';
      }
      if(queue.some(entry => !hasTempAndSensor(entry))){
        if(msg){ msg.textContent = 'Completa temperatura de salida y sensor para todas las cajas.'; }
        updateConfirmState();
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
        const tempText = entry.tempSalida != null ? String(entry.tempSalida).trim() : '';
        const tempNumber = Number(tempText.replace(',', '.'));
        if(!Number.isFinite(tempNumber)){
          errors.push(`Caja ${entry.lote}: temperatura de salida inválida.`);
          continue;
        }
        const normalizedTemp = Math.round(tempNumber * 100) / 100;
        let sensorValue = entry.sensorId != null ? String(entry.sensorId).trim() : '';
        if(!sensorValue){
          errors.push(`Caja ${entry.lote}: debes ingresar el serial del sensor.`);
          continue;
        }
        if(sensorValue.length > 120){ sensorValue = sensorValue.slice(0, 120); }
        const movePayload = { rfid, zona_id: selectedZonaId, seccion_id: selectedSeccionId, temp_salida_c: normalizedTemp, sensor_id: sensorValue };
        if(durationSec > 0){ movePayload.durationSec = durationSec; }
        const attempt = await postJSONWithSedeTransfer('/operacion/acond/despacho/move', movePayload, {
          promptMessage: (data) => data?.confirm || data?.error || `La caja ${entry.lote} pertenece a otra sede. ¿Deseas trasladarla a tu sede actual?`
        });
        if(attempt.cancelled){
          errors.push(`Caja ${entry.lote}: operación cancelada por el usuario.`);
          continue;
        }
        const attemptPayload = attempt.data || {};
        if(!attempt.httpOk || attemptPayload.ok === false){
          const message = attemptPayload.error || attemptPayload.message || `Error (${attempt.status || 0})`;
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
      if(ev.target.closest('[data-field], input, textarea, select, .form-control label')){
        return;
      }
      const card = ev.target.closest('[data-select-caja]');
      if(card){
        const id = card.getAttribute('data-select-caja');
        if(id) setSelectedCaja(id);
      }
    });

    queueList?.addEventListener('input', ev => {
      const target = ev.target;
      if(!target || typeof target.getAttribute !== 'function') return;
      const fieldName = target.getAttribute('data-field');
      if(!fieldName) return;
      const cajaAttr = target.getAttribute('data-caja');
      if(!cajaAttr) return;
      const entry = queue.find(item => String(item.cajaId) === String(cajaAttr));
      if(!entry) return;
      const value = target.value ?? '';
      if(fieldName === 'temp_salida'){
        entry.tempSalida = value;
      } else if(fieldName === 'sensor_id'){
        entry.sensorId = value;
      }
      updateConfirmState();
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
  async function loadOrdenesForDetalle(selectEl, preselectedIds){
    if(!selectEl) return;
    const preselected = Array.isArray(preselectedIds)
      ? preselectedIds
          .map(v => Number(v))
          .filter(n => Number.isFinite(n) && n > 0)
          .map(n => Math.trunc(n))
      : [];
    const selectedSet = new Set(preselected);
    selectEl.innerHTML = '<option value="" disabled>Cargando órdenes…</option>';
    selectEl.multiple = true;
    selectEl.size = Math.max(3, Math.min(6, selectedSet.size || 3));
    try {
      const r = await fetch('/ordenes/list', { headers:{ 'Accept':'application/json' } });
      const j = await r.json();
      if(!r.ok || j.ok===false) throw new Error(j.error||'Error');
      const items = Array.isArray(j.items)? j.items:[];
      const opts = ['<option value="" disabled>Selecciona una o más órdenes…</option>'].concat(items.map(o=>{
        const num = (o.numero_orden||'').toString();
        const cli = (o.cliente||'').toString();
        const prod = (o.codigo_producto||'').toString();
        const cant = (o.cantidad!=null? o.cantidad: '').toString();
        const label = [num, cli, prod, cant?`x${cant}`:''].filter(Boolean).join(' · ');
        return `<option value="${o.id}">${label}</option>`;
      }));
      selectEl.innerHTML = opts.join('');
      selectEl.multiple = true;
      const visibleCount = Math.min(6, Math.max(3, items.length || 3));
      selectEl.size = visibleCount;
      Array.from(selectEl.options).forEach(opt => {
        const optVal = Number(opt.value);
        if(!Number.isFinite(optVal) || optVal <= 0){ opt.selected = false; return; }
        opt.selected = selectedSet.has(Math.trunc(optVal));
      });
      enableSimpleMultiSelect(selectEl);
    } catch(e){
      selectEl.innerHTML = '<option value="" disabled>No se pudo cargar órdenes</option>';
      selectEl.multiple = true;
      selectEl.size = 3;
      Array.from(selectEl.options).forEach(opt => { opt.selected = false; });
      enableSimpleMultiSelect(selectEl);
    }
  }
  // Extender openCajaDetalle para inyectar UI de orden
  const _origOpenCajaDetalle = openCajaDetalle;
  openCajaDetalle = function(id){
    _origOpenCajaDetalle(id);
    const wrap = document.getElementById('detalle-order-actions');
    const ordenSpan = document.getElementById('detalle-caja-orden');
    if(!wrap || !ordenSpan) return;
    const cajaSource = (() => {
      const direct = cajas.find(c => String(c.id) === String(id));
      if(direct) return normalizeCajaOrders({ ...direct });
      const items = listoDespacho.filter(it => String(it.caja_id) === String(id));
      if(!items.length) return null;
      const mergedOrders = [];
      items.forEach(it => {
        if(Array.isArray(it.orders) && it.orders.length){
          mergedOrders.push(...it.orders);
        } else {
          mergedOrders.push({ orderId: it.order_id ?? null, numeroOrden: it.order_num ?? null, cliente: it.order_client ?? null });
        }
      });
      return normalizeCajaOrders({
        orders: mergedOrders,
        orderId: items[0]?.order_id ?? null,
        orderNumero: items[0]?.order_num ?? null,
        orderCliente: items[0]?.order_client ?? null
      });
    })();
    const normalizedSource = cajaSource ? normalizeCajaOrders({ ...cajaSource }) : null;
    if(normalizedSource){
      renderOrdersDetail(ordenSpan, normalizedSource);
    }
    const initialOrderIds = Array.isArray(normalizedSource?.orders)
      ? normalizedSource.orders
          .map(o => Number(o.orderId))
          .filter(n => Number.isFinite(n) && n > 0)
          .map(n => Math.trunc(n))
      : [];
    let currentSelectedIds = [...initialOrderIds];
    const instructionsText = currentSelectedIds.length
      ? 'Haz clic para activar o desactivar cada orden. Deja sin selección para quitar todas.'
      : 'Haz clic para seleccionar una o más órdenes. Deja sin selección para quitar todas.';
    wrap.innerHTML = `
      <div class='border border-base-300/40 rounded-lg p-3 bg-base-200/30 space-y-3'>
        <div class='flex items-center justify-between'>
          <span class='font-semibold'>Órdenes</span>
          <button class='btn btn-ghost btn-xs' id='detalle-refresh-orden' title='Recargar'>↻</button>
        </div>
        <div class='text-[11px] opacity-70' id='detalle-orden-instructions'>${instructionsText}</div>
        <div class='flex items-start gap-2'>
          <select id='detalle-orden-select' class='select select-bordered select-sm flex-1 min-h-[7.5rem]' multiple>
            <option value='' disabled>Selecciona una o más órdenes…</option>
          </select>
          <button class='btn btn-sm btn-primary mt-[2px]' id='detalle-orden-aplicar'>Guardar</button>
        </div>
        <div id='detalle-orden-msg' class='text-[11px] opacity-70 min-h-[14px]'></div>
      </div>`;
    const sel = document.getElementById('detalle-orden-select');
    const msg = document.getElementById('detalle-orden-msg');
    const applyBtn = document.getElementById('detalle-orden-aplicar');
    const refreshBtn = document.getElementById('detalle-refresh-orden');
    const instructionsEl = document.getElementById('detalle-orden-instructions');
    loadOrdenesForDetalle(sel, currentSelectedIds);
    applyBtn?.addEventListener('click', async ()=>{
      const selectedOptions = sel ? Array.from(sel.options).filter(opt => opt.selected && Number(opt.value)) : [];
      const orderIds = selectedOptions.map(opt => Math.trunc(Number(opt.value))).filter(n => Number.isFinite(n) && n > 0);
      applyBtn.disabled=true;
      if(msg) msg.textContent = orderIds.length ? 'Aplicando...' : 'Quitando órdenes...';
      try {
        const r = await fetch('/operacion/acond/caja/set-order',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ caja_id: id, order_ids: orderIds })});
        const j = await r.json();
        if(!j.ok) throw new Error(j.error||'Error');
        if(msg) msg.textContent = orderIds.length ? 'Órdenes actualizadas' : 'Órdenes removidas';
        // Refrescar data general
        await loadData();
        const normalized = normalizeCajaOrders({
          orders: Array.isArray(j.orders) ? j.orders : [],
          orderId: j.order_id ?? null,
          orderNumero: j.order_num ?? null,
          orderCliente: null
        });
        renderOrdersDetail(ordenSpan, normalized);
        currentSelectedIds = Array.isArray(normalized.orders)
          ? normalized.orders
              .map(o => Number(o.orderId))
              .filter(n => Number.isFinite(n) && n > 0)
              .map(n => Math.trunc(n))
          : [];
        if(sel){
          const set = new Set(currentSelectedIds);
          Array.from(sel.options).forEach(opt => {
            const optVal = Number(opt.value);
            if(!Number.isFinite(optVal) || optVal <= 0){ opt.selected = false; return; }
            opt.selected = set.has(Math.trunc(optVal));
          });
        }
        if(instructionsEl){
          instructionsEl.textContent = currentSelectedIds.length
            ? 'Haz clic para activar o desactivar cada orden. Deja sin selección para quitar todas.'
            : 'Haz clic para seleccionar una o más órdenes. Deja sin selección para quitar todas.';
        }
      } catch(e){ if(msg) msg.textContent=e.message||'Error'; }
      finally { applyBtn.disabled=false; }
    });
    refreshBtn?.addEventListener('click', ()=>{
      const selectedNow = sel
        ? Array.from(sel.options)
            .filter(opt => opt.selected && Number(opt.value))
            .map(opt => Math.trunc(Number(opt.value)))
            .filter(n => Number.isFinite(n) && n > 0)
        : currentSelectedIds;
      loadOrdenesForDetalle(sel, selectedNow.length ? selectedNow : currentSelectedIds);
    });
  };
})();
