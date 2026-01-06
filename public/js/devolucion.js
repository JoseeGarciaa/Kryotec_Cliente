// Devolución: mostrar cajas en Operación con mismos cronómetros que Operación y botón para devolver a Bodega
(function(){
  'use strict';
  const qs = (s)=> document.querySelector(s);
  const grid = qs('#dev-caja-grid');
  const spin = qs('#dev-spin');
  // Scan UI elements
  const scanInput = qs('#dev-scan');
  const scanBtn = qs('#dev-scan-btn');
  const scanClear = qs('#dev-scan-clear');
  const scanMsg = qs('#dev-scan-msg');
  const scanResult = qs('#dev-scan-result');
  const scanCardBox = qs('#dev-scan-card');
  const scanExtra = qs('#dev-scan-extra');
  const modal = document.getElementById('dev-modal');
  const modalBody = qs('#dev-modal-body');
  const modalTitle = qs('#dev-modal-title');
  const modalReturn = qs('#dev-modal-return');
  const modalClose = qs('#dev-modal-close');
  // Decide dialog
  const decideDlg = qs('#dev-decide');
  const decideMsg = qs('#dev-decide-msg');
  const decideActions = qs('#dev-decide-actions');
  const decideClose = qs('#dev-decide-close');
  const decideZona = qs('#dev-zona');
  const decideSeccion = qs('#dev-seccion');
  const decideLocationHint = qs('#dev-location-hint');
  const decideThresholdWrap = qs('#dev-decide-threshold');
  const decideThresholdSelect = qs('#dev-decide-threshold-select');
  const decideThresholdInfo = qs('#dev-decide-threshold-info');
  // Confirm dialog
  const confirmDlg = qs('#dev-confirm');
  const confirmYes = qs('#dev-confirm-yes');
  const confirmNo = qs('#dev-confirm-no');
  const confirmMsg = qs('#dev-confirm-msg');
  let confirmCajaId = null; let confirmFromModal = false;
  let modalCajaId = null;
  // PI timer modal (Pendiente a Inspección)
  const piDlg = qs('#dev-pi-timer');
  const piHours = qs('#dev-pi-hours');
  const piMins = qs('#dev-pi-mins');
  const piAccept = qs('#dev-pi-accept');
  const piCancel = qs('#dev-pi-cancel');
  const piZona = qs('#dev-pi-zona');
  const piSeccion = qs('#dev-pi-seccion');
  const piLocationHint = qs('#dev-pi-location-hint');
  const piTemp = qs('#dev-pi-temp');
  const piSensor = qs('#dev-pi-sensor');
  const piSalidaWrap = qs('#dev-pi-salida-wrap');
  const piSalidaValue = qs('#dev-pi-salida');
  let piCajaId = null;
  let data = { cajas: [], serverNow: null, ordenes: {} };
  let serverOffset = 0; // serverNow - Date.now()
  let tick = null; let poll = null;
  let decisionState = { cajaId: null, evaluation: null, thresholdSec: null };

  let selectedZonaId = '';
  let selectedSeccionId = '';
  const decideLocationController = (typeof window !== 'undefined' && window.LocationSelector && typeof window.LocationSelector.create === 'function')
    ? window.LocationSelector.create({
        zonaSelect: decideZona,
        seccionSelect: decideSeccion,
        hintElement: decideLocationHint
      })
    : null;
  const piLocationController = (typeof window !== 'undefined' && window.LocationSelector && typeof window.LocationSelector.create === 'function')
    ? window.LocationSelector.create({
        zonaSelect: piZona,
        seccionSelect: piSeccion,
        hintElement: piLocationHint
      })
    : null;

  function escapeHtml(str){
    return String(str == null ? '' : str)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function normalizeOrders(raw){
    if(!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    raw.forEach((entry)=>{
      if(!entry || typeof entry !== 'object') return;
      const orderIdRaw = entry.orderId ?? entry.order_id;
      const orderIdNum = Number(orderIdRaw);
      const orderId = Number.isFinite(orderIdNum) && orderIdNum > 0 ? Math.trunc(orderIdNum) : null;
      const numeroRaw = entry.numeroOrden ?? entry.numero_orden ?? entry.numero;
      const numeroOrden = numeroRaw != null ? String(numeroRaw) : null;
      const clienteRaw = entry.cliente ?? entry.clienteNombre ?? entry.customer;
      const cliente = clienteRaw != null ? String(clienteRaw) : null;
      const key = orderId != null ? `id:${orderId}` : `n:${numeroOrden||''}|c:${cliente||''}`;
      if(seen.has(key)) return;
      seen.add(key);
      out.push({ orderId, numeroOrden, cliente });
    });
    return out;
  }

  function buildOrderSearch(orders, fallbackNumero, fallbackCliente){
    const tokens = new Set();
    const push = (value)=>{
      const clean = String(value || '').trim();
      if(clean) tokens.add(clean.toLowerCase());
    };
    orders.forEach((o)=>{
      push(o.numeroOrden);
      push(o.cliente);
      if(o.orderId){ push(`#${o.orderId}`); push(o.orderId); }
    });
    push(fallbackNumero);
    push(fallbackCliente);
    return Array.from(tokens).join(' ');
  }

  function normalizeCajaOrders(entry){
    if(!entry || typeof entry !== 'object') return entry;
    const cleanedOrders = normalizeOrders(entry.orders);
    const fallbackIdRaw = entry.orderId ?? entry.order_id;
    const fallbackIdNum = Number(fallbackIdRaw);
    const fallbackId = Number.isFinite(fallbackIdNum) && fallbackIdNum > 0 ? Math.trunc(fallbackIdNum) : null;
    const fallbackNumero = entry.orderNumero ?? entry.order_num ?? null;
    const fallbackCliente = entry.orderCliente ?? entry.order_client ?? null;
    const ensureOrderPresent = (orderId, numero, cliente)=>{
      if(orderId == null && !numero && !cliente) return;
      if(orderId != null && cleanedOrders.some((o)=> o.orderId === orderId)) return;
      if(orderId == null && cleanedOrders.some((o)=> o.numeroOrden === numero && o.cliente === cliente)) return;
      cleanedOrders.push({ orderId, numeroOrden: numero || null, cliente: cliente || null });
    };
    if(fallbackId != null){ ensureOrderPresent(fallbackId, fallbackNumero, fallbackCliente); }
    else if(fallbackNumero || fallbackCliente){ ensureOrderPresent(null, fallbackNumero, fallbackCliente); }
    const primary = cleanedOrders[0] || null;
    const orderId = primary?.orderId ?? fallbackId;
    const orderNumero = primary?.numeroOrden ?? (fallbackNumero != null ? String(fallbackNumero) : null);
    const orderCliente = primary?.cliente ?? (fallbackCliente != null ? String(fallbackCliente) : null);
    const normalized = {
      ...entry,
      orders: cleanedOrders,
      orderId,
      orderNumero,
      orderCliente
    };
    normalized.orderSearch = buildOrderSearch(cleanedOrders, orderNumero, orderCliente);
    return normalized;
  }

  function ordersSummaryHTML(source, opts){
    const options = opts || {};
    const normalized = normalizeCajaOrders(source || {});
    const orders = Array.isArray(normalized.orders) ? normalized.orders : [];
    if(!orders.length) return '';
    const limitRaw = Number(options.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : orders.length;
    const rows = orders.slice(0, limit).map((o)=>{
      const numero = o.numeroOrden || (o.orderId ? `#${o.orderId}` : null);
      const numeroHtml = numero ? `<span class="font-mono">${escapeHtml(numero)}</span>` : '<span class="font-mono opacity-40">—</span>';
      const cliente = o.cliente ? `<span class="opacity-70">${escapeHtml(o.cliente)}</span>` : '';
      const separator = cliente ? '<span class="opacity-40">·</span>' : '';
      const justify = options.align === 'end' ? 'end' : 'start';
      return `<div class="flex items-center gap-1 flex-wrap justify-${justify}">${numeroHtml}${cliente ? `${separator}${cliente}` : ''}</div>`;
    }).join('');
    const extra = orders.length > limit ? `<div class="text-[10px] opacity-60 leading-snug">+${orders.length - limit} más</div>` : '';
    const title = options.showTitle ? '<div class="uppercase tracking-wide text-[9px] opacity-60">Órdenes</div>' : '';
    const cls = options.className || 'text-[10px] opacity-70 leading-snug space-y-1';
    return `<div class="${cls}">${title}${rows}${extra}</div>`;
  }

  function ordersPlainStrings(source){
    const normalized = normalizeCajaOrders(source || {});
    const list = Array.isArray(normalized.orders) ? normalized.orders : [];
    if(list.length){
      return list.map((o)=>{
        const numero = o.numeroOrden || (o.orderId ? `#${o.orderId}` : null);
        const cliente = o.cliente ? ` (${o.cliente})` : '';
        return (numero || '#?') + cliente;
      });
    }
    const fallbackNumero = normalized.orderNumero || (normalized.orderId ? `#${normalized.orderId}` : null);
    if(!fallbackNumero) return [];
    const fallbackCliente = normalized.orderCliente ? ` (${normalized.orderCliente})` : '';
    return [String(fallbackNumero) + fallbackCliente];
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
    const rendered = orders.map((o)=>{
      const numero = o.numeroOrden || (o.orderId ? `#${o.orderId}` : '—');
      const cliente = o.cliente ? `<span class="opacity-70">${escapeHtml(o.cliente)}</span>` : '';
      const separator = cliente ? '<span class="opacity-40">·</span>' : '';
      return `<div class="flex flex-wrap items-center gap-1"><span class="font-mono">${escapeHtml(numero)}</span>${cliente ? `${separator}${cliente}` : ''}</div>`;
    }).join('');
    container.innerHTML = rendered;
    container.title = orders.map((o)=>{
      const numero = o.numeroOrden || (o.orderId ? `#${o.orderId}` : '—');
      return o.cliente ? `${numero} · ${o.cliente}` : numero;
    }).join('\n');
  }

  function renderOrderCountLabel(source, opts){
    const options = opts || {};
    const normalized = options.normalized ? (source || {}) : normalizeCajaOrders(source || {});
    const countRaw = normalized.orderCajaCount ?? normalized.order_caja_count;
    const expectedRaw = normalized.orderCajaExpected ?? normalized.order_caja_expected;
    const totalRaw = normalized.orderCajaTotal ?? normalized.order_caja_total;
    const count = Number(countRaw);
    if(!Number.isFinite(count) || count < 0) return '';
    const expected = Number(expectedRaw);
    const total = Number(totalRaw);
    const denom = Number.isFinite(total) && total > 0 ? total : (Number.isFinite(expected) && expected > 0 ? expected : null);
    const label = denom != null ? `${count}/${denom}` : `${count}`;
    const cls = options.className || 'text-[9px] opacity-60';
    return `<div class="${cls}">Cajas asociadas: <span class="font-mono">${escapeHtml(String(label))}</span></div>`;
  }

  function formatTempValue(value){
    if(value === null || value === undefined || value === '') return '';
    const num = Number(value);
    if(Number.isFinite(num)){
      const rounded = Math.round(num * 100) / 100;
      return Number.isInteger(rounded) ? String(rounded) : String(rounded);
    }
    return String(value).trim();
  }

  function ensureDecideLocation(){
    if(!decideLocationController) return Promise.resolve();
    return decideLocationController.ensure({ zonaId: selectedZonaId, seccionId: selectedSeccionId })
      .then(()=>{
        const current = decideLocationController.getValue();
        selectedZonaId = current.zonaId || '';
        selectedSeccionId = current.seccionId || '';
      });
  }

  function ensurePiLocation(){
    if(!piLocationController) return Promise.resolve();
    return piLocationController.ensure({ zonaId: selectedZonaId, seccionId: selectedSeccionId })
      .then(()=>{
        const current = piLocationController.getValue();
        selectedZonaId = current.zonaId || selectedZonaId;
        selectedSeccionId = current.seccionId || selectedSeccionId;
      });
  }

  function captureDecideLocation(){
    if(decideLocationController){
      const value = decideLocationController.getValue();
      selectedZonaId = value.zonaId || '';
      selectedSeccionId = value.seccionId || '';
    } else {
      selectedZonaId = decideZona ? String(decideZona.value || '') : '';
      selectedSeccionId = decideSeccion ? String(decideSeccion.value || '') : '';
    }
    return { zona_id: selectedZonaId, seccion_id: selectedSeccionId };
  }

  function capturePiLocation(){
    if(piLocationController){
      const value = piLocationController.getValue();
      selectedZonaId = value.zonaId || '';
      selectedSeccionId = value.seccionId || '';
    } else {
      selectedZonaId = piZona ? String(piZona.value || '') : '';
      selectedSeccionId = piSeccion ? String(piSeccion.value || '') : '';
    }
    return { zona_id: selectedZonaId, seccion_id: selectedSeccionId };
  }

  function syncPiLocationFromDecide(){
    if(piLocationController){
      piLocationController.setValue(selectedZonaId, selectedSeccionId);
    } else {
      if(piZona) piZona.value = selectedZonaId;
      if(piSeccion) piSeccion.value = selectedSeccionId;
    }
  }
  function formatRemainingLabel(totalSeconds){
    const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const pieces = [];
    if(days){ pieces.push(`${days} día${days!==1?'s':''}`); }
    if(hours){ pieces.push(`${hours} h`); }
    if(!pieces.length || minutes){ pieces.push(`${minutes} min`); }
    return pieces.join(' ');
  }

  function formatThresholdOptionLabel(seconds, candidate){
    const base = formatRemainingLabel(seconds);
    const parts = [];
    if(candidate?.source === 'config'){ parts.push('configuración'); }
    if(candidate?.source === 'fallback'){ parts.push('predeterminado'); }
    const totalModelos = Array.isArray(candidate?.modelos)
      ? candidate.modelos.reduce((acc, item)=> acc + (Number(item?.count) || 0), 0)
      : 0;
    if(totalModelos){ parts.push(`${totalModelos} modelo${totalModelos===1?'':'s'}`); }
    const suffix = parts.length ? ` (${parts.join(', ')})` : '';
    return `${base}${suffix}`;
  }

  function populateThresholdOptions(policy, selectedSec){
    if(!decideThresholdWrap || !decideThresholdSelect) return;
    const candidatesRaw = Array.isArray(policy?.candidates) ? policy.candidates : [];
    const normalized = [];
    const seen = new Set();
    candidatesRaw.forEach((candidate)=>{
      const seconds = Math.max(1, Math.floor(Number(candidate?.seconds) || 0));
      if(seen.has(seconds)) return;
      seen.add(seconds);
      normalized.push({ seconds, source: candidate?.source || 'fallback', modelos: Array.isArray(candidate?.modelos) ? candidate.modelos : [] });
    });
    normalized.sort((a,b)=> a.seconds - b.seconds);
    const shouldShow = normalized.length > 1 || !!policy?.mismatched || !!policy?.reuse_blocked;
    if(!shouldShow){
      decideThresholdWrap.classList.add('hidden');
      decideThresholdSelect.innerHTML = '';
      if(decideThresholdInfo) decideThresholdInfo.textContent = '';
      return;
    }
    const optionsHtml = normalized.map((candidate)=>{
      const sec = candidate.seconds;
      const selected = selectedSec != null && Math.trunc(selectedSec) === sec ? ' selected' : '';
      const label = formatThresholdOptionLabel(sec, candidate);
      return `<option value="${sec}"${selected}>${label}</option>`;
    }).join('');
    decideThresholdSelect.innerHTML = optionsHtml;
    if(selectedSec != null){
      decideThresholdSelect.value = String(Math.trunc(selectedSec));
    } else if(normalized.length){
      decideThresholdSelect.value = String(normalized[normalized.length - 1].seconds);
    }
    decideThresholdWrap.classList.remove('hidden');
    if(decideThresholdInfo){
      if(policy?.reuse_blocked && policy?.reason){
        decideThresholdInfo.textContent = policy.reason;
      } else if(policy?.mismatched){
        decideThresholdInfo.textContent = 'Selecciona el umbral preferido para reutilizar. Los modelos tienen tiempos distintos.';
      } else {
        decideThresholdInfo.textContent = '';
      }
    }
  }

  function buildDefaultSedePrompt(payload){
    if(payload && typeof payload.confirm === 'string' && payload.confirm.trim()) return payload.confirm;
    if(payload && typeof payload.error === 'string' && payload.error.trim()) return payload.error;
    return 'Las piezas seleccionadas pertenecen a otra sede. ¿Deseas trasladarlas a esta sede?';
  }

  const postJSONWithSedeTransfer = (()=>{
    if(typeof window !== 'undefined' && typeof window.postJSONWithSedeTransfer === 'function'){
      return window.postJSONWithSedeTransfer;
    }

    const helper = async function postJSONWithSedeTransfer(url, body, options){
      const opts = options || {};
      const headers = Object.assign({ 'Content-Type':'application/json' }, opts.headers || {});
      const confirmFn = typeof opts.confirmFn === 'function' ? opts.confirmFn : (message) => (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(message) : true);
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
    };

    if(typeof window !== 'undefined'){
      window.postJSONWithSedeTransfer = helper;
    }
    return helper;
  })();

  function msRemaining(timer){ if(!timer||!timer.endsAt) return 0; return new Date(timer.endsAt).getTime() - (Date.now()+serverOffset); }
  function timerDisplay(rem){ if(rem<=0) return 'Finalizado'; const s=Math.max(0,Math.floor(rem/1000)); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const sec=s%60; return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }
  function progressPct(timer){ if(!timer||!timer.startsAt||!timer.endsAt) return 0; const start=new Date(timer.startsAt).getTime(); const end=new Date(timer.endsAt).getTime(); const now=Date.now()+serverOffset; if(now<=start) return 0; if(now>=end) return 100; return ((now-start)/(end-start))*100; }
  function cardHTML(caja){
    const info = normalizeCajaOrders(caja);
    const comps = info.componentes||[];
    const vip = comps.filter(x=>x.tipo==='vip');
    const tics = comps.filter(x=>x.tipo==='tic');
    const cubes = comps.filter(x=>x.tipo==='cube');
    const compBadges = [
      ...vip.map(()=>`<span class='badge badge-info badge-xs font-semibold'>VIP</span>`),
      ...tics.map(()=>`<span class='badge badge-warning badge-xs font-semibold'>TIC</span>`),
      ...cubes.map(()=>`<span class='badge badge-accent badge-xs font-semibold'>CUBE</span>`)
    ].join(' ');
    const rem = info.timer? msRemaining(info.timer):0;
    const pct = progressPct(info.timer);
    const timerTxt = info.timer? (info.timer.completedAt? 'Listo' : timerDisplay(rem)) : '';
    let timerBadge='';
    if(info.timer && info.timer.startsAt && info.timer.endsAt && !info.timer.completedAt){
      timerBadge = `<span class='badge badge-neutral badge-xs flex items-center gap-1' data-dev-caja-timer data-caja='${info.id}'>
        <span id='dev-timer-${info.id}' class='font-mono whitespace-nowrap tabular-nums'>${timerTxt}</span>
      </span>`;
    } else if(info.timer && info.timer.completedAt){
      timerBadge = `<span class='badge badge-success badge-xs'>Listo</span>`;
    } else {
      timerBadge = `<span class='badge badge-outline badge-xs opacity-60'>Sin cronómetro</span>`;
    }
    const progress = Math.min(100, Math.max(0, pct));
    const code = info.codigoCaja||'';
    const displayName = info.nombreCaja || code || '';
    const titleBase = displayName && code && displayName !== code ? `${displayName} · ${code}` : displayName || code || 'Caja';
    const tooltipOrders = ordersPlainStrings(info);
    const tooltipText = tooltipOrders.length ? `${titleBase} · ${tooltipOrders.join(' · ')}` : titleBase;
    const ordersBlock = ordersSummaryHTML(info, { className: 'text-[10px] opacity-70 leading-snug space-y-0.5', limit: 3, showTitle: true });
    const ordersSection = ordersBlock || "<div class='text-[10px] opacity-60 font-mono'>Sin órdenes asociadas</div>";
    const countLine = renderOrderCountLabel(info, { normalized: true, className: 'text-[9px] opacity-60' });
    return `<div class='caja-card rounded-lg border border-base-300/40 bg-base-200/10 p-3 flex flex-col gap-2 hover-border-primary/60 transition cursor-pointer' data-caja-id='${info.id}' title='${escapeHtml(tooltipText)}'>
      <div class='text-[10px] uppercase opacity-60 tracking-wide'>Caja</div>
      <div class='font-semibold text-xs leading-tight break-all pr-2'>${escapeHtml(displayName)}</div>
      ${ordersSection}
      ${countLine}
      <div class='flex flex-wrap gap-1 text-[9px] flex-1'>${compBadges || "<span class='badge badge-ghost badge-xs'>Sin items</span>"}</div>
      <div class='h-1.5 w-full bg-base-300/30 rounded-full overflow-hidden'>
        <div class='h-full bg-gradient-to-r from-primary via-primary to-primary/70' style='width:${progress.toFixed(1)}%' data-dev-caja-bar='${info.id}'></div>
      </div>
      <div class='flex items-center justify-between text-[10px] font-mono opacity-70'>
        <span class='inline-flex items-center gap-1'>${timerBadge}</span>
        <button class='btn btn-ghost btn-[6px] btn-xs text-primary' data-process-caja='${info.id}' title='Procesar devolución'>➜</button>
      </div>
    </div>`;
  }
  function render(){
    if(!grid) return; const cajas = data.cajas||[];
    if(!cajas.length){ grid.innerHTML = `<div class='col-span-full py-10 text-center text-xs opacity-60'>Sin cajas elegibles (Operación · Tránsito)</div>`; return; }
    grid.innerHTML = cajas.map(c=> cardHTML(c)).join('');
    // Render resumen por orden
    const resumenBox = document.getElementById('dev-orden-resumen');
    if(resumenBox){
      const ordenes = data.ordenes||{};
      const entries = Object.values(ordenes);
      if(!entries.length){ resumenBox.innerHTML = `<span class='opacity-50'>Sin órdenes asociadas</span>`; }
      else {
        resumenBox.innerHTML = entries.map(o=>{
          const a = o.cajas;
          const haveExpected = (o.expected!=null && o.expected>0);
          const haveTotal = (o.totalCajas!=null && o.totalCajas>0);
          const denom = haveTotal ? o.totalCajas : (haveExpected ? o.expected : null);
          const match = denom!=null ? (a>=denom) : (haveExpected && a>=o.expected);
          const countStr = denom!=null ? `${a}/${denom}` : `${a}`;
          return `<span class='px-2 py-1 rounded border ${match?'border-success/60 text-success':'border-base-300/50'} bg-base-300/10 font-mono'>${o.numero_orden||('#'+o.order_id)}: ${countStr}</span>`;
        }).join('');
      }
    }
  }

  function openModal(id){
    if(!modal) return;
    const cajaId = String(id);
    const source = (data.cajas||[]).find((c)=> String(c.id) === cajaId) || scannedCajas.get(cajaId);
    if(!source){
      modalCajaId = null;
      return;
    }
    const info = normalizeCajaOrders(source);
    modalCajaId = info.id || source.id || cajaId;
    const displayName = info.nombreCaja || info.codigoCaja || info.lote || `Caja ${modalCajaId}`;
    const codigo = info.codigoCaja || info.lote || '-';
    const ordersBlock = ordersSummaryHTML(info, { className: 'text-[11px] opacity-80 space-y-1', showTitle: true, limit: 6 });
    const countLine = renderOrderCountLabel(info, { normalized: true, className: 'text-[10px] opacity-60' });
    const componentes = componentesBadges(info.componentes || []);
    const timer = info.timer;
    let timerSection = `<div class='text-[10px] opacity-60'>Sin cronómetro</div>`;
    if(timer && timer.startsAt && timer.endsAt){
      const rem = msRemaining(timer);
      const pct = progressPct(timer);
      const label = timer.completedAt ? 'Listo' : timerDisplay(rem);
      timerSection = `
        <div class='space-y-2'>
          <div class='text-[10px] uppercase opacity-60 tracking-wide'>Cronómetro</div>
          <div class='font-mono text-xs' id='dev-modal-timer'>${label}</div>
          <div class='h-1.5 w-full bg-base-300/30 rounded-full overflow-hidden'>
            <div class='h-full bg-primary/80' style='width:${Math.min(100, Math.max(0, pct)).toFixed(1)}%' id='dev-modal-bar'></div>
          </div>
        </div>`;
    }

    if(modalTitle){
      modalTitle.textContent = displayName;
    }
    if(modalBody){
      modalBody.innerHTML = `
        <div class='space-y-3 text-xs'>
          <div class='flex justify-between items-center text-[11px] opacity-70 font-mono'><span>Código</span><span>${escapeHtml(codigo)}</span></div>
          ${ordersBlock || "<div class='text-[10px] opacity-60'>Sin órdenes asociadas</div>"}
          ${countLine}
          <div class='space-y-1'>
            <div class='text-[10px] uppercase opacity-60 tracking-wide'>Componentes</div>
            <div class='flex flex-wrap gap-1'>${componentes}</div>
          </div>
          ${timerSection}
        </div>`;
    }
    try{ modal.showModal(); }catch{ modal.classList.remove('hidden'); }
  }
  async function load(){
    try { spin?.classList.remove('hidden');
      const r = await fetch('/operacion/devolucion/data');
      const j = await r.json();
      if(j.ok){
        const normalizedCajas = Array.isArray(j.cajas) ? j.cajas.map((c)=> normalizeCajaOrders(c)) : [];
        const normalizedPendientes = Array.isArray(j.pendientes) ? j.pendientes.map((c)=> normalizeCajaOrders(c)) : [];
        data = { ...j, cajas: normalizedCajas, pendientes: normalizedPendientes };
        if(j.serverNow){ serverOffset = new Date(j.serverNow).getTime() - Date.now(); }
        syncScannedFromData({ cajas: normalizedCajas });
      }
      else { data = { cajas:[], serverNow:null, pendientes:[], ordenes:{} }; syncScannedFromData({ cajas: [] }); }
      render(); renderScannedList(); ensureTick();
    } catch(e){ console.error('[Devolución] load error', e); }
    finally { spin?.classList.add('hidden'); }
  }
  function ensureTick(){ if(tick) return; tick = setInterval(()=>{
    (data.cajas||[]).forEach(c=>{
      if(!c.timer) return; const el=document.getElementById('dev-timer-'+c.id); if(!el) return; const rem=msRemaining(c.timer); el.textContent = c.timer.completedAt? 'Listo' : timerDisplay(rem);
      const bar = document.querySelector(`[data-dev-caja-bar='${c.id}']`); if(bar && c.timer.startsAt && c.timer.endsAt){ const pct = progressPct(c.timer); bar.style.width = Math.min(100,Math.max(0,pct)).toFixed(1)+'%'; }
    });
  },1000); }
  function startPolling(){ if(poll) clearInterval(poll); poll = setInterval(load, 15000); }

  document.addEventListener('click', e=>{
    const target = e.target instanceof HTMLElement ? e.target : null;
    if(!target) return;
    const removeBtn = target.closest('[data-scan-remove]');
    if(removeBtn){ const id = removeBtn.getAttribute('data-scan-remove'); if(id){ removeScanned(id); } return; }
    const scanProcessBtn = target.closest('[data-scan-process]');
    if(scanProcessBtn){ const id = scanProcessBtn.getAttribute('data-scan-process'); if(id){ processCaja(id); } return; }
    const btn = target.closest('[data-process-caja]');
    if(btn){ const id = btn.getAttribute('data-process-caja'); if(id){ processCaja(id); } return; }
    const card = target.closest('.caja-card');
    if(card && card.getAttribute('data-caja-id')){ openModal(card.getAttribute('data-caja-id')); }
  });

  // ---- Scan / Identificar Caja ----
  const multiWrap = qs('#dev-multi');
  const multiList = qs('#dev-multi-list');
  const multiCount = qs('#dev-multi-count');
  const multiClear = qs('#dev-multi-clear');

  const scannedCajas = new Map();
  const scannedCodes = new Set();
  const scanningCodes = new Set();
  const lookupQueue = [];
  let lookupBusy = false;
  let scanBuffer = '';

  function cajaLabelById(rawId){
    const key = String(rawId);
    const scanned = scannedCajas.get(key);
    if(scanned && (scanned.nombreCaja || scanned.codigoCaja)) return scanned.nombreCaja || scanned.codigoCaja;
    const listed = (data.cajas||[]).find(c=> String(c.id) === key);
    if(listed && (listed.nombreCaja || listed.codigoCaja || listed.lote)) return listed.nombreCaja || listed.codigoCaja || listed.lote;
    return key;
  }

  function inferTipo(nombre){ const n=(nombre||'').toLowerCase(); if(n.includes('vip')) return 'vip'; if(n.includes('tic')) return 'tic'; if(n.includes('cube')||n.includes('cubo')) return 'cube'; return 'otro'; }
  function miniCardHTML(c){
    const info = normalizeCajaOrders(c);
    const code = info.codigoCaja || info.lote || '';
    const displayName = info.nombreCaja || code;
    const titleBase = displayName && code && displayName !== code ? `${displayName} · ${code}` : displayName || code;
    const tooltipOrders = ordersPlainStrings(info);
    const tooltipText = tooltipOrders.length ? `${titleBase} · ${tooltipOrders.join(' · ')}` : titleBase;
    const ordersBlock = ordersSummaryHTML(info, { className: 'text-[10px] opacity-70 leading-snug space-y-0.5', showTitle: true, limit: 4 });
    const ordersSection = ordersBlock || "<div class='text-[10px] opacity-60 font-mono'>Sin órdenes asociadas</div>";
    const countLine = renderOrderCountLabel(info, { normalized: true, className: 'text-[9px] opacity-60' });
    return `<div class='text-xs'>
      <div class='flex items-center justify-between text-[10px] uppercase opacity-60 mb-1'><span>Caja</span><span class='font-mono'>${escapeHtml(code)}</span></div>
      <div class='font-semibold text-[11px] break-all mb-2' title='${escapeHtml(tooltipText)}'>${escapeHtml(displayName)}</div>
      ${ordersSection}
      ${countLine}
      <div class='flex flex-wrap gap-1 mb-2'>${(info.componentes||[]).map(it=>{ let cls='badge-ghost'; if(it.tipo==='vip') cls='badge-info'; else if(it.tipo==='tic') cls='badge-warning'; else if(it.tipo==='cube') cls='badge-accent'; return `<span class='badge ${cls} badge-xs'>${(it.tipo||'').toUpperCase()}</span>`; }).join('') || "<span class='badge badge-ghost badge-xs'>Sin items</span>"}</div>
      <div class='text-[10px] font-mono opacity-70'>${info.timer? (info.timer.completedAt? 'Listo' : 'Cronómetro activo') : 'Sin cronómetro'}</div>
      <div class='mt-2'><button class='btn btn-xs btn-primary btn-outline w-full' data-process-caja='${info.id}'>➜ Procesar devolución</button></div>
    </div>`;
  }

  function componentesBadges(lista){
    if(!Array.isArray(lista) || !lista.length){ return "<span class='badge badge-ghost badge-xs'>Sin items</span>"; }
    return lista.map(it=>{
      const tipo = (it.tipo||'').toLowerCase();
      let cls = 'badge-ghost';
      if(tipo === 'vip') cls = 'badge-info';
      else if(tipo === 'tic') cls = 'badge-warning';
      else if(tipo === 'cube') cls = 'badge-accent';
      return `<span class='badge ${cls} badge-xs'>${(tipo||'').toUpperCase()}</span>`;
    }).join('');
  }

  function syncScannedFromData(payload){
    const latest = new Map((payload.cajas||[]).map(c=>{
      const normalized = normalizeCajaOrders(c);
      const key = normalized && normalized.id != null ? normalized.id : c?.id;
      return [String(key), normalized];
    }));
    const toRemove = [];
    scannedCajas.forEach((entry, key)=>{
      const next = latest.get(key);
      if(!next){
        toRemove.push(key);
        return;
      }
      scannedCajas.set(key, {
        ...entry,
        ...next,
        id: next.id ?? entry.id,
        codigoCaja: next.codigoCaja || next.caja || entry.codigoCaja,
        nombreCaja: next.nombreCaja || entry.nombreCaja || null,
        orderId: next.orderId ?? entry.orderId ?? null,
        orderNumero: next.orderNumero ?? entry.orderNumero ?? null,
        orderCliente: next.orderCliente ?? entry.orderCliente ?? null,
        orders: Array.isArray(next.orders) ? next.orders : (Array.isArray(entry.orders) ? entry.orders : []),
        orderSearch: next.orderSearch || entry.orderSearch || '',
        timer: next.timer || entry.timer || null,
        componentes: Array.isArray(next.componentes) ? next.componentes : entry.componentes,
        code: entry.code,
        tempSalida: entry.tempSalida,
        tempLlegada: entry.tempLlegada,
        sensorId: entry.sensorId
      });
    });
    toRemove.forEach(key=>{
      const entry = scannedCajas.get(key);
      if(entry && entry.code) scannedCodes.delete(entry.code);
      scannedCajas.delete(key);
    });
    renderScannedList();
  }

  function renderScannedList(){
    if(!multiList) return;
    const entries = Array.from(scannedCajas.values());
    if(!entries.length){
      multiWrap?.classList.add('hidden');
      multiList.innerHTML='';
      if(multiCount) multiCount.textContent = '0';
      return;
    }
    multiWrap?.classList.remove('hidden');
    if(multiCount) multiCount.textContent = String(entries.length);
    multiList.innerHTML = entries.map(entry=>{
      const info = normalizeCajaOrders(entry);
      const code = info.codigoCaja || '';
      const displayName = info.nombreCaja || code;
      const titleBase = displayName && code && displayName !== code ? `${displayName} · ${code}` : displayName || code;
      const tooltipOrders = ordersPlainStrings(info);
      const tooltipText = tooltipOrders.length ? `${titleBase} · ${tooltipOrders.join(' · ')}` : titleBase;
      const ordersBlock = ordersSummaryHTML(info, { className: 'text-[10px] opacity-70 leading-snug space-y-0.5', showTitle: true, limit: 4 });
      const ordersSection = ordersBlock || "<div class='text-[10px] opacity-60 font-mono'>Sin órdenes asociadas</div>";
      const countLine = renderOrderCountLabel(info, { normalized: true, className: 'text-[9px] opacity-60' });
      return `<div class='border border-base-300/40 rounded-lg p-3 space-y-2' data-scan-entry='${info.id}'>
        <div class='flex items-center justify-between gap-2'>
          <span class='font-mono text-xs break-all'>${escapeHtml(code)}</span>
          <button class='btn btn-ghost btn-xs' data-scan-remove='${info.id}' title='Quitar'>✕</button>
        </div>
        <div class='text-xs font-semibold leading-tight break-all' title='${escapeHtml(tooltipText)}'>${escapeHtml(displayName)}</div>
        ${ordersSection}
        ${countLine}
        <div class='flex flex-wrap gap-1 text-[9px]'>${componentesBadges(info.componentes)}</div>
        <button class='btn btn-xs btn-primary w-full' data-scan-process='${info.id}'>Procesar</button>
      </div>`;
    }).join('');
  }

  function removeScanned(id){
    const key = String(id);
    const entry = scannedCajas.get(key);
    if(entry){
      scannedCajas.delete(key);
      if(entry.code) scannedCodes.delete(entry.code);
    }
    renderScannedList();
  }

  function addScannedCaja(caja, code){
    const key = String(caja.id);
    if(scannedCajas.has(key)){
      const existing = scannedCajas.get(key);
      if(existing){
        existing.tempSalida = caja.tempSalida ?? caja.temp_salida_c ?? existing.tempSalida ?? null;
        existing.tempLlegada = caja.tempLlegada ?? caja.temp_llegada_c ?? existing.tempLlegada ?? null;
        existing.sensorId = caja.sensorId ?? caja.sensor_id ?? existing.sensorId ?? '';
        scannedCajas.set(key, existing);
      }
      if(scanMsg) scanMsg.textContent = 'Caja ya escaneada';
      return false;
    }
    const info = normalizeCajaOrders(caja);
    scannedCajas.set(key, {
      ...info,
      id: info.id ?? caja.id,
      codigoCaja: info.codigoCaja || info.caja || caja.codigoCaja || caja.lote || '',
      nombreCaja: info.nombreCaja || null,
      orderId: info.orderId ?? null,
      orderNumero: info.orderNumero ?? null,
      orderCliente: info.orderCliente ?? null,
      orders: Array.isArray(info.orders) ? info.orders : [],
      orderSearch: info.orderSearch || '',
      timer: info.timer || caja.timer || null,
      componentes: Array.isArray(info.componentes) ? info.componentes : (Array.isArray(caja.componentes) ? caja.componentes : []),
      code,
      tempSalida: caja.tempSalida ?? caja.temp_salida_c ?? null,
      tempLlegada: caja.tempLlegada ?? caja.temp_llegada_c ?? null,
      sensorId: caja.sensorId ?? caja.sensor_id ?? ''
    });
    scannedCodes.add(code);
    renderScannedList();
    return true;
  }

  function enqueueLookup(code){
    if(!code || code.length!==24) return;
    const upper = code.toUpperCase();
    if(scannedCodes.has(upper)){
      if(scanMsg) scanMsg.textContent = 'Caja ya escaneada';
      return;
    }
    if(scanningCodes.has(upper)) return;
    scanningCodes.add(upper);
    lookupQueue.push(upper);
    if(!lookupBusy) runLookupQueue();
  }

  async function runLookupQueue(){
    if(lookupBusy) return;
    lookupBusy = true;
    while(lookupQueue.length){
      const code = lookupQueue.shift();
      try {
        await lookupCaja(code);
      } finally {
        scanningCodes.delete(code);
      }
    }
    lookupBusy = false;
  }

  function clearScanUI(msg){
    scanBuffer = '';
    if(scanInput) scanInput.value='';
    if(scanCardBox) scanCardBox.innerHTML='';
    if(scanExtra) scanExtra.textContent='';
    if(scanResult) scanResult.classList.add('hidden');
    if(scanMsg) scanMsg.textContent = typeof msg === 'string' ? msg : '';
  }

  async function lookupCaja(code){
    if(scanMsg) scanMsg.textContent = `Buscando ${code}...`;
    if(scanResult) scanResult.classList.add('hidden');
    try {
      const r = await fetch('/operacion/caja/lookup',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code })});
      const j = await r.json();
      if(!j.ok){ if(scanMsg) scanMsg.textContent = j.error || 'No encontrado'; return false; }
      const cajaId = j.caja.id;
      let caja = (data.cajas||[]).find(c=> String(c.id)===String(cajaId));
      const parseTemp = (value) => {
        if(value === null || value === undefined || value === '') return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      };
      const tempSalidaVal = parseTemp(j.caja.temp_salida_c);
      const tempLlegadaVal = parseTemp(j.caja.temp_llegada_c);
      const sensorText = j.caja.sensor_id != null ? String(j.caja.sensor_id).trim() : '';
      const items = Array.isArray(j.caja.items) ? j.caja.items : [];
      const cubeItem = items.find(it=> inferTipo(it.nombre_modelo||it.nombre||'') === 'cube');
      const cajaOrders = Array.isArray(j.caja.orders) ? j.caja.orders : [];
      let cajaPayload;
      if(!caja){
        const nombreCaja = j.caja.nombre_caja || j.caja.nombreCaja || cubeItem?.nombre_modelo || null;
        cajaPayload = {
          id: cajaId,
          codigoCaja: j.caja.lote,
          nombreCaja: nombreCaja || null,
          componentes: items.map(it=> ({ codigo: it.rfid, tipo: inferTipo(it.nombre_modelo||it.nombre||'') })),
          timer: j.caja.timer ? { startsAt: j.caja.timer.startsAt, endsAt: j.caja.timer.endsAt, completedAt: j.caja.timer.active===false? j.caja.timer.endsAt:null } : null
        };
      } else {
        cajaPayload = { ...caja };
        if(!Array.isArray(cajaPayload.componentes)){
          cajaPayload.componentes = items.map(it=> ({ codigo: it.rfid, tipo: inferTipo(it.nombre_modelo||it.nombre||'') }));
        }
        if(!cajaPayload.timer && j.caja.timer){
          cajaPayload.timer = { startsAt: j.caja.timer.startsAt, endsAt: j.caja.timer.endsAt, completedAt: j.caja.timer.active===false? j.caja.timer.endsAt:null };
        }
      }
      if(!cajaPayload.nombreCaja && (j.caja.nombre_caja || j.caja.nombreCaja || cubeItem?.nombre_modelo)){
        cajaPayload.nombreCaja = j.caja.nombre_caja || j.caja.nombreCaja || cubeItem?.nombre_modelo || cajaPayload.nombreCaja;
      }
      cajaPayload.orderId = j.caja.order_id ?? cajaPayload.orderId ?? null;
      cajaPayload.orderNumero = j.caja.order_num ?? cajaPayload.orderNumero ?? null;
      cajaPayload.orderCliente = j.caja.orderCliente ?? j.caja.order_client ?? cajaPayload.orderCliente ?? null;
      cajaPayload.orders = cajaOrders.length ? cajaOrders : (Array.isArray(cajaPayload.orders) ? cajaPayload.orders : []);
      cajaPayload.orderCajaCount = j.caja.orderCajaCount ?? j.caja.order_caja_count ?? cajaPayload.orderCajaCount ?? null;
      cajaPayload.orderCajaExpected = j.caja.orderCajaExpected ?? j.caja.order_caja_expected ?? cajaPayload.orderCajaExpected ?? null;
      cajaPayload.orderCajaTotal = j.caja.orderCajaTotal ?? j.caja.order_caja_total ?? cajaPayload.orderCajaTotal ?? null;
      cajaPayload.tempSalida = tempSalidaVal;
      cajaPayload.tempLlegada = tempLlegadaVal;
      cajaPayload.sensorId = sensorText;
      const normalizedCaja = normalizeCajaOrders(cajaPayload);
      const eligible = items.length>0 && items.every(it=> it.estado==='Operación' && it.sub_estado==='Transito');
      if(!eligible){
        if(scanMsg) scanMsg.textContent='Caja no elegible: requiere Operación · Tránsito';
        return false;
      }
      const added = addScannedCaja(normalizedCaja, code);
      if(scanCardBox) scanCardBox.innerHTML = miniCardHTML(normalizedCaja);
      if(scanExtra) scanExtra.textContent = `Items: ${(normalizedCaja.componentes||[]).length} · ID ${normalizedCaja.id}`;
      if(scanResult) scanResult.classList.remove('hidden');
      if(scanMsg) scanMsg.textContent = added ? 'Caja agregada' : 'Caja ya escaneada';
      return added;
    } catch(e){
      if(scanMsg) scanMsg.textContent='Error';
      return false;
    } finally {
      scanBuffer='';
      if(scanInput) scanInput.value='';
    }
  }
  function triggerLookup(){
    if(!scanInput) return;
    const val = (scanInput.value||'').replace(/[^A-Z0-9]/g,'').toUpperCase();
    if(!val){ if(scanMsg) scanMsg.textContent='Ingresa RFID'; return; }
    if(val.length!==24){ if(scanMsg) scanMsg.textContent='Debe tener 24 caracteres'; return; }
    scanInput.value='';
    scanBuffer='';
    enqueueLookup(val);
  }
  scanBtn?.addEventListener('click', triggerLookup);
  scanClear?.addEventListener('click', ()=>{
    scanBuffer='';
    if(scanInput) scanInput.value='';
    if(scanMsg) scanMsg.textContent='';
    if(scanResult) scanResult.classList.add('hidden');
    if(scanCardBox) scanCardBox.innerHTML='';
    if(scanExtra) scanExtra.textContent='';
  });
  scanInput?.addEventListener('keydown', e=>{
    if(e.key==='Enter'){
      e.preventDefault();
      triggerLookup();
    }
  });
  scanInput?.addEventListener('input', ()=>{
    if(!scanInput) return;
    let raw = (scanInput.value||'').toUpperCase();
    raw = raw.replace(/[^A-Z0-9]/g,'');
    scanBuffer = raw;
    while(scanBuffer.length >= 24){
      const chunk = scanBuffer.slice(0,24);
      scanBuffer = scanBuffer.slice(24);
      enqueueLookup(chunk);
    }
    scanInput.value = scanBuffer;
    if(scanBuffer.length && scanMsg){
      const remaining = 24 - scanBuffer.length;
      scanMsg.textContent = `Faltan ${remaining} caract.`;
    } else if(scanMsg && !lookupBusy && !lookupQueue.length){
      scanMsg.textContent = '';
    }
  });
  scanInput && setTimeout(()=> scanInput.focus(), 500);
  multiClear?.addEventListener('click', ()=>{
    scannedCajas.clear();
    scannedCodes.clear();
    renderScannedList();
    if(scanMsg) scanMsg.textContent='';
  });
  function updateModalTimer(){ if(!modalCajaId) return; const caja = (data.cajas||[]).find(c=> String(c.id)===String(modalCajaId)); if(!caja||!caja.timer) return; const span=document.getElementById('dev-modal-timer'); const bar=document.getElementById('dev-modal-bar'); if(span){ span.textContent = caja.timer.completedAt? 'Listo' : timerDisplay(msRemaining(caja.timer)); } if(bar && caja.timer.startsAt && caja.timer.endsAt){ bar.style.width = progressPct(caja.timer).toFixed(1)+'%'; } }
  modalReturn?.addEventListener('click', ()=>{ if(!modalCajaId) return; processCaja(modalCajaId); });

  function resetDecisionState(){
    decisionState = { cajaId: null, evaluation: null, thresholdSec: null };
    if(decideThresholdWrap) decideThresholdWrap.classList.add('hidden');
    if(decideThresholdSelect) decideThresholdSelect.innerHTML = '';
    if(decideThresholdInfo) decideThresholdInfo.textContent = '';
  }

  async function processCaja(id, options){
    const opts = options || {};
    const cajaId = Number(id);
    if(!Number.isFinite(cajaId)) return;
    const payload = { caja_id: cajaId };
    const override = opts.reuseThresholdSec != null ? Number(opts.reuseThresholdSec) : null;
    if(override != null && Number.isFinite(override) && override > 0){
      payload.reuse_threshold_sec = Math.max(1, Math.trunc(override));
    } else if(decisionState.cajaId === cajaId && decisionState.thresholdSec != null){
      const prev = Number(decisionState.thresholdSec);
      if(Number.isFinite(prev) && prev > 0){
        payload.reuse_threshold_sec = Math.max(1, Math.trunc(prev));
      }
    }
    try {
      if(!opts.silent && scanMsg) scanMsg.textContent = 'Evaluando...';
      const response = await fetch('/operacion/devolucion/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if(!result.ok){
        if(scanMsg) scanMsg.textContent = result.error || 'No elegible';
        if(decideDlg && typeof decideDlg.open === 'boolean' && decideDlg.open){
          if(decideMsg) decideMsg.textContent = result.error || 'No elegible';
          if(decideActions) decideActions.innerHTML = '';
          if(decideThresholdWrap) decideThresholdWrap.classList.add('hidden');
        }
        return;
      }
      const thresholdSec = Number(result.reuse_threshold_sec);
      decisionState = {
        cajaId,
        evaluation: result,
        thresholdSec: Number.isFinite(thresholdSec) && thresholdSec > 0
          ? Math.trunc(thresholdSec)
          : (payload.reuse_threshold_sec || null)
      };
      renderDecisionDialog(cajaId, result, { openModal: opts.openModal !== false });
      if(scanMsg) scanMsg.textContent = '';
    } catch(err){
      if(scanMsg) scanMsg.textContent = 'Error';
    }
  }

  function renderDecisionDialog(cajaId, evaluation, options){
    const openModal = options?.openModal !== false;
    const policy = evaluation?.reuse_policy || {};
    const hasTimer = evaluation?.has_timer !== false && evaluation?.timer_status !== 'missing';
    const remainingSeconds = Math.max(0, Math.floor(Number(evaluation?.seconds_remaining) || 0));
    const thresholdBase = decisionState.thresholdSec != null
      ? decisionState.thresholdSec
      : Number(evaluation?.reuse_threshold_sec) || null;
    const thresholdSec = Number.isFinite(thresholdBase) && thresholdBase > 0 ? Math.trunc(thresholdBase) : null;
    decisionState.thresholdSec = thresholdSec;
    populateThresholdOptions(policy, thresholdSec);

    const thresholdLabel = thresholdSec ? formatRemainingLabel(thresholdSec) : null;
    const remainingLabel = formatRemainingLabel(remainingSeconds);
    const reuseAllowed = !!evaluation?.reusable && !policy?.reuse_blocked;
    let message = '';
    if(!hasTimer){
      message = 'La caja no registra un cronómetro activo. Solo se puede enviar a Bodega · Pendiente a Inspección.';
    } else if(policy?.reuse_blocked){
      message = policy.reason || 'El umbral seleccionado no cumple con el mínimo requerido.';
    } else if(reuseAllowed){
      message = `Restan ${remainingLabel} del cronómetro${thresholdLabel ? ` (umbral ${thresholdLabel})` : ''}. ¿Deseas reutilizar la caja o enviarla a Bodega · Pendiente a Inspección?`;
    } else {
      if(thresholdLabel){
        message = `Restan ${remainingLabel} del cronómetro (umbral ${thresholdLabel}). No es posible reutilizar con este umbral. ¿Deseas enviarla a Bodega · Pendiente a Inspección?`;
      } else {
        message = `Restan ${remainingLabel} del cronómetro. No es posible reutilizar. ¿Deseas enviarla a Bodega · Pendiente a Inspección?`;
      }
      if(policy?.reason && !policy?.reuse_blocked){
        message = `${message} ${policy.reason}`.trim();
      }
    }
    if(decideMsg) decideMsg.textContent = message;

    if(decideActions){
      let html = '';
      if(reuseAllowed){
        html = `<button class='btn btn-primary btn-sm flex-1' data-act='reuse' data-id='${cajaId}'>Reutilizar</button>
    <button class='btn btn-outline btn-sm flex-1' data-act='insp' data-id='${cajaId}'>Pendiente a Inspección</button>`;
      } else {
        html = `<button class='btn btn-error btn-sm flex-1' data-act='insp' data-id='${cajaId}'>Enviar a Pendiente a Inspección</button>`;
      }
      decideActions.innerHTML = html;
    }

    ensureDecideLocation();
    if(openModal){
      try { decideDlg.showModal(); } catch { decideDlg.classList.remove('hidden'); }
    }
  }

  // Manejar acciones de decisión
  document.addEventListener('click', async (e)=>{
    const t = e.target instanceof HTMLElement ? e.target : null;
    if(!t) return;
    if(t.closest('#dev-decide-actions [data-act]')){
      const btn = t.closest('[data-act]');
      const act = btn.getAttribute('data-act');
      const id = btn.getAttribute('data-id');
      if(!id) return;
      try {
        if(scanMsg) scanMsg.textContent='Aplicando...';
        const locationPayload = captureDecideLocation();
        const thresholdPayload = decisionState.thresholdSec != null && Number.isFinite(Number(decisionState.thresholdSec))
          ? Math.max(1, Math.trunc(Number(decisionState.thresholdSec)))
          : null;
        if(act==='reuse'){
          const cajaLabel = cajaLabelById(id);
          const attempt = await postJSONWithSedeTransfer('/operacion/devolucion/reuse', {
            caja_id: id,
            zona_id: locationPayload.zona_id,
            seccion_id: locationPayload.seccion_id,
            ...(thresholdPayload ? { reuse_threshold_sec: thresholdPayload } : {})
          }, {
            promptMessage: (payload) => payload?.confirm || payload?.error || `La caja ${cajaLabel} pertenece a otra sede. ¿Deseas trasladarla a tu sede actual?`
          });
          if(attempt.cancelled){
            if(scanMsg) scanMsg.textContent = 'Operación cancelada.';
            return;
          }
          const payload = attempt.data || {};
          if(!attempt.httpOk || payload.ok === false){
            const message = payload.error || payload.message || `Error (${attempt.status || 0})`;
            throw new Error(message);
          }
          if(scanMsg) scanMsg.textContent='Caja enviada a Acondicionamiento · Ensamblaje';
          await load();
          removeScanned(id);
          clearScanUI('');
        } else if(act==='insp'){
          // Abrir modal para horas/minutos; solo se envía tras Aceptar
          piCajaId = id;
          syncPiLocationFromDecide();
          ensurePiLocation();
          const entry = scannedCajas.get(String(id));
          const sensorDisplay = entry && entry.sensorId ? entry.sensorId : '';
          if(piSensor){ piSensor.textContent = sensorDisplay || '-'; }
          const salidaDisplay = entry ? formatTempValue(entry.tempSalida) : '';
          if(piSalidaValue){
            if(salidaDisplay){
              piSalidaValue.textContent = salidaDisplay;
              piSalidaWrap && piSalidaWrap.classList.remove('hidden');
            } else {
              piSalidaValue.textContent = '-';
              piSalidaWrap && piSalidaWrap.classList.add('hidden');
            }
          }
          if(piTemp){
            const llegadaDisplay = entry ? formatTempValue(entry.tempLlegada) : '';
            piTemp.value = llegadaDisplay;
          }
          try { piDlg.showModal(); } catch { piDlg.classList.remove('hidden'); }
        }
        try{ modal.close(); }catch{ modal.classList.add('hidden'); }
        try{ decideDlg.close(); }catch{ decideDlg.classList.add('hidden'); }
        // load() se invocará tras aceptar en el modal
      } catch(err){ if(scanMsg) scanMsg.textContent = err.message || 'Error'; }
    }
  });

  // Manejar PI modal
  piAccept?.addEventListener('click', async ()=>{
    const h = parseInt(piHours?.value||'0',10)||0; const m = parseInt(piMins?.value||'0',10)||0; const sec = h*3600 + m*60;
    if(!piCajaId || sec<=0){ // exigir cronómetro positivo
      try{ piDlg.close(); }catch{ piDlg.classList.add('hidden'); }
      if(scanMsg) scanMsg.textContent = 'Debes asignar horas o minutos antes de enviar';
      return;
    }
    const currentId = piCajaId;
    let shouldReset = true;
    try {
      const cajaLabel = cajaLabelById(currentId);
      const locationPayload = capturePiLocation();
      const thresholdPayload = decisionState.thresholdSec != null && Number.isFinite(Number(decisionState.thresholdSec))
        ? Math.max(1, Math.trunc(Number(decisionState.thresholdSec)))
        : null;
      const tempInput = piTemp ? String(piTemp.value || '').trim() : '';
      const tempNumber = tempInput ? Number(tempInput.replace(',', '.')) : NaN;
      if(!Number.isFinite(tempNumber)){
        shouldReset = false;
        if(scanMsg) scanMsg.textContent = 'Ingresa una temperatura de llegada válida.';
        piTemp && piTemp.focus();
        return;
      }
      const tempNormalized = Math.round(tempNumber * 100) / 100;
      const attempt = await postJSONWithSedeTransfer('/operacion/devolucion/to-pend-insp', {
        caja_id: currentId,
        durationSec: sec,
        zona_id: locationPayload.zona_id,
        seccion_id: locationPayload.seccion_id,
        temp_llegada_c: tempNormalized,
        ...(thresholdPayload ? { reuse_threshold_sec: thresholdPayload } : {})
      }, {
        promptMessage: (payload) => payload?.confirm || payload?.error || `La caja ${cajaLabel} pertenece a otra sede. ¿Deseas trasladarla a tu sede actual?`
      });
      if(attempt.cancelled){
        shouldReset = false;
        if(scanMsg) scanMsg.textContent = 'Operación cancelada.';
        return;
      }
      const payload = attempt.data || {};
      if(!attempt.httpOk || payload.ok === false){
        const message = payload.error || payload.message || `Error (${attempt.status || 0})`;
        throw new Error(message);
      }
      if(scanMsg) scanMsg.textContent='Caja enviada a Bodega · Pendiente a Inspección';
      // refrescar inmediatamente la lista para que desaparezca y limpiar panel derecho
      await load();
      removeScanned(currentId);
      clearScanUI('');
    } catch(e){ if(scanMsg) scanMsg.textContent = e.message || 'Error'; }
    finally {
      if(shouldReset){
        piCajaId=null;
        piHours && (piHours.value='');
        piMins && (piMins.value='');
        piTemp && (piTemp.value='');
        if(piSensor) piSensor.textContent = '-';
        if(piSalidaWrap) piSalidaWrap.classList.add('hidden');
        try{ piDlg.close(); }catch{ piDlg.classList.add('hidden'); }
      }
    }
  });

  decideThresholdSelect?.addEventListener('change', ()=>{
    if(!decisionState.cajaId) return;
    const raw = Number(decideThresholdSelect.value);
    if(!Number.isFinite(raw) || raw <= 0) return;
    const normalized = Math.max(1, Math.trunc(raw));
    if(decisionState.thresholdSec != null && Math.trunc(decisionState.thresholdSec) === normalized) return;
    processCaja(decisionState.cajaId, { reuseThresholdSec: normalized, openModal: false, updateOnly: true, silent: true });
  });
  piCancel?.addEventListener('click', ()=>{
    piCajaId=null;
    piHours && (piHours.value='');
    piMins && (piMins.value='');
    piTemp && (piTemp.value='');
    if(piSensor) piSensor.textContent='-';
    if(piSalidaWrap) piSalidaWrap.classList.add('hidden');
    try{ piDlg.close(); }catch{ piDlg.classList.add('hidden'); }
  });

  // Cerrar con X
  decideClose?.addEventListener('click', (e)=>{
    e.preventDefault();
    try{ decideDlg.close(); }catch{ decideDlg.classList.add('hidden'); }
    resetDecisionState();
  });
  decideDlg?.addEventListener('close', ()=> resetDecisionState());
  decideDlg?.addEventListener('cancel', (event)=>{
    event.preventDefault();
    resetDecisionState();
    try{ decideDlg.close(); }catch{ decideDlg.classList.add('hidden'); }
  });
  modalClose?.addEventListener('click', ()=>{ modalCajaId=null; try{ modal.close(); }catch{ modal.classList.add('hidden'); } });
  // también cerrar al backdrop form (native dialog auto cierra)

  load(); startPolling();
  // Hook modal timer refresh
  setInterval(updateModalTimer, 1000);
})();
