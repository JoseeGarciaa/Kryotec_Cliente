  function getCompletedAtMs(entry){
    if(!entry) return null;
    const completedRaw = entry.item_completed_at || entry.completed_at || entry.itemCompletedAt || entry.completedAt;
    const updatedRaw = entry.item_updated_at || entry.updated_at || entry.updatedAt;
    const completedMs = completedRaw ? new Date(completedRaw).getTime() : NaN;
    const updatedMs = updatedRaw ? new Date(updatedRaw).getTime() : NaN;
    const completedValid = Number.isFinite(completedMs);
    const updatedValid = Number.isFinite(updatedMs);
    if(completedValid) return completedMs;
    if(updatedValid) return updatedMs;
    return null;
  }

// Pre Acondicionamiento UX (tipo "registro masivo")
(function(){
  const qs = (sel)=>document.querySelector(sel);
  const tableCongBody = qs('#tabla-cong tbody');
  const tableAtemBody = qs('#tabla-atem tbody');
  const lotesCong = qs('#lotes-cong');
  const lotesAtem = qs('#lotes-atem');
  const countCong = qs('#count-cong');
  const countAtem = qs('#count-atem');
  const qtyCongEl = qs('#qty-cong');
  const qtyAtemEl = qs('#qty-atem');
  const spinCong = qs('#spin-cong');
  const spinAtem = qs('#spin-atem');
  const timerCongEl = qs('#timer-cong');
  const timerAtemEl = qs('#timer-atem');
  const searchCong = qs('#search-cong');
  const searchAtem = qs('#search-atem');
  // search bars are now outside wrappers and should remain visible in any view
  // View toggle controls
  const btnViewGrid = qs('#btn-view-grid');
  const btnViewList = qs('#btn-view-list');
  const wrapGridCong = qs('#wrap-grid-cong');
  const wrapListCong = qs('#wrap-list-cong');
  const wrapGridAtem = qs('#wrap-grid-atem');
  const wrapListAtem = qs('#wrap-list-atem');

  // Modal elements
  const dlg = qs('#dlg-scan');
  const scanInput = qs('#scan-input');
  const chipsBox = qs('#chips');
  const scanCount = qs('#scan-count');
  const msg = qs('#scan-msg');
  const btnConfirm = qs('#btn-confirm');
  const selectZona = qs('#scan-zona');
  const selectSeccion = qs('#scan-seccion');
  const locationHint = qs('#scan-location-hint');
  // Nuevos controles de cronómetro dentro del modal de escaneo
  const scanTimerBox = qs('#scan-timer-box');
  const scanStartTimer = qs('#scan-start-timer');
  const scanTimerHr = qs('#scan-timer-hr');
  const scanTimerMin = qs('#scan-timer-min');
  const scanApplyDefault = qs('#scan-apply-default');
  const scanLoteSummary = qs('#scan-lote-summary');
  let scanMode = 'individual'; // individual | lote
  let loteDetected = null; // string | null
  let loteItemsCache = [];

  // Group timer modal elements
  const gDlg = qs('#dlg-gtimer');
  const gLote = qs('#gtimer-lote');
  const gMin = qs('#gtimer-min');
  const gHr = qs('#gtimer-hr');
  const gMsg = qs('#gtimer-msg');
  const gConfirm = qs('#gtimer-confirm');
  const gSectionLabel = qs('#gtimer-section-label');
  const gCount = qs('#gtimer-count');
  // New mode controls (atemperamiento only)
  const gModesBox = qs('#gtimer-modes');
  const gLoteExist = qs('#gtimer-lote-exist');
  const gRfidInput = qs('#gtimer-rfid-lote');
  const gRfidStatus = qs('#gtimer-rfid-lote-status');
  const gApplyDefault = qs('#gtimer-apply-default');
  const gDefaultHint = qs('#gtimer-default-hint');
  const defaultConfirmDlg = qs('#dlg-default-confirm');
  const defaultConfirmBody = qs('#default-confirm-body');
  const defaultConfirmApply = qs('#default-confirm-apply');
  const defaultConfirmEmpty = qs('#default-confirm-empty');
  const defaultConfirmMixed = qs('#default-confirm-mixed');
  let gMode = 'nuevo'; // nuevo | existente | rfid
  // We'll reuse group timer modal for per-item start
  let pendingItemStart = null; // { section, rfid }
  // Preselección de RFIDs (cuando se mueven a atemperamiento y se quiere iniciar cronómetro de inmediato)
  let preselectedRfids = null; // string[] | null

  let currentSectionForModal = 'congelamiento';
  let target = 'congelamiento';
  let rfids = [];
  let invalid = [];
  let valid = [];
  const validMeta = new Map();
  const ubicacionesState = { data: null, promise: null };
  let selectedZonaId = '';
  let selectedSeccionId = '';

  const scanTimerHint = qs('#scan-timer-hint');
  const defaultScanTimerHint = scanTimerHint ? (scanTimerHint.textContent || '') : '';
  const timerDefaults = new Map();
  const sectionRows = {
    congelamiento: [],
    atemperamiento: [],
  };
  const itemMetaByRfid = new Map();
  let pendingDefaultOptions = [];
  const pendingDefaultSelections = new Set();
  let defaultConfirmMode = 'group';
  let defaultConfirmSection = 'congelamiento';
  let defaultConfirmLote = '';
  let defaultConfirmResolve = null;
  let preserveScanHint = false;
  let pendingScanAutoBuckets = null; // [{ minutes:number, rfids:string[] }]
  let suppressScanTimerChange = false;

  const normalizeModeloId = (value)=>{
    const num = Number(value);
    if(!Number.isFinite(num) || num <= 0) return null;
    return Math.trunc(num);
  };

  const refreshTimerDefaults = (payload)=>{
    timerDefaults.clear();
    if(!Array.isArray(payload)) return;
    payload.forEach((entry)=>{
      const modeloId = normalizeModeloId(entry && (entry.modeloId ?? entry.modelo_id));
      if(!modeloId) return;
      timerDefaults.set(modeloId, {
        minCongelamientoSec: Number(entry.minCongelamientoSec ?? entry.min_congelamiento_sec ?? 0),
        atemperamientoSec: Number(entry.atemperamientoSec ?? entry.atemperamiento_sec ?? 0),
        maxSobreAtemperamientoSec: Number(entry.maxSobreAtemperamientoSec ?? entry.max_sobre_atemperamiento_sec ?? 0),
        vidaCajaSec: Number(entry.vidaCajaSec ?? entry.vida_caja_sec ?? 0),
        minReusoSec: Number(entry.minReusoSec ?? entry.min_reuso_sec ?? 0),
        modeloNombre: entry.modeloNombre ?? entry.modelo_nombre ?? null,
      });
    });
  };

  const getDefaultMinutesFor = (section, modeloId)=>{
    const cfg = modeloId ? timerDefaults.get(modeloId) : null;
    if(!cfg) return null;
    let seconds = 0;
    if(section === 'congelamiento') seconds = cfg.minCongelamientoSec;
    else if(section === 'atemperamiento') seconds = cfg.atemperamientoSec;
    if(!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.max(1, Math.round(seconds / 60));
  };

  const readMinutesFromInputs = (hoursInput, minutesInput)=>{
    const hrs = Number(hoursInput?.value || '0');
    const mins = Number(minutesInput?.value || '0');
    const total = (Number.isFinite(hrs) ? hrs : 0) * 60 + (Number.isFinite(mins) ? mins : 0);
    return total > 0 ? total : 0;
  };

  const setDurationInputs = (hoursInput, minutesInput, totalMinutes)=>{
    if(!hoursInput || !minutesInput) return;
    const shouldSuppress = hoursInput === scanTimerHr && minutesInput === scanTimerMin;
    if(shouldSuppress){ suppressScanTimerChange = true; }
    try {
      if(totalMinutes == null || totalMinutes <= 0){
        hoursInput.value = '';
        minutesInput.value = '';
        return;
      }
      const rounded = Math.max(0, Math.round(totalMinutes));
      const hrs = Math.floor(rounded / 60);
      const mins = rounded - hrs * 60;
      hoursInput.value = hrs > 0 ? String(hrs) : '';
      minutesInput.value = String(mins);
    } finally {
      if(shouldSuppress){ suppressScanTimerChange = false; }
    }
  };

  const updateScanTimerHint = (message, tone = 'default')=>{
    if(!scanTimerHint) return;
    scanTimerHint.textContent = message || '';
    scanTimerHint.classList.remove('text-error','text-info','text-success','opacity-60');
    if(!message || tone === 'default'){
      scanTimerHint.classList.add('opacity-60');
      return;
    }
    if(tone === 'error'){
      scanTimerHint.classList.add('text-error');
    } else if(tone === 'success'){
      scanTimerHint.classList.add('text-success');
    } else {
      scanTimerHint.classList.add('text-info');
    }
  };

  const resetScanTimerHint = ()=>{
    if(!scanTimerHint) return;
    updateScanTimerHint(defaultScanTimerHint, 'default');
  };

  const registerSectionRows = (section, rows)=>{
    sectionRows[section] = rows;
    rows.forEach((row)=>{
      if(!row || !row.rfid) return;
      const key = String(row.rfid).toUpperCase();
      itemMetaByRfid.set(key, {
        section,
        modeloId: normalizeModeloId(row.modelo_id ?? row.modeloId),
        modeloNombre: typeof row.nombre_modelo === 'string' ? row.nombre_modelo : (typeof row.modeloNombre === 'string' ? row.modeloNombre : null),
        nombreUnidad: typeof row.nombre_unidad === 'string' ? row.nombre_unidad : null,
      });
    });
  };

  const findModeloIdForGroup = ()=>{
    const section = currentSectionForModal === 'atemperamiento' ? 'atemperamiento' : 'congelamiento';
    if(pendingItemStart && pendingItemStart.rfid){
      const meta = itemMetaByRfid.get(String(pendingItemStart.rfid).toUpperCase());
      if(meta && meta.modeloId) return meta.modeloId;
    }
    if(gMode === 'existente'){
      const selectedLote = (gLoteExist?.value || '').trim();
      if(selectedLote){
        const match = (sectionRows[section] || []).find((row)=> String(row.lote || '').trim() === selectedLote);
        const modeloId = normalizeModeloId(match && (match.modelo_id ?? match.modeloId));
        if(modeloId) return modeloId;
      }
    }
    if(gMode === 'rfid'){
      const targetRfid = (gRfidInput?.value || '').trim().toUpperCase();
      if(targetRfid){
        const meta = itemMetaByRfid.get(targetRfid);
        if(meta && meta.modeloId) return meta.modeloId;
      }
      const derivedLote = gRfidInput?.getAttribute('data-derived-lote') || '';
      if(derivedLote){
        const match = (sectionRows[section] || []).find((row)=> String(row.lote || '').trim() === derivedLote);
        const modeloId = normalizeModeloId(match && (match.modelo_id ?? match.modeloId));
        if(modeloId) return modeloId;
      }
    }
    const candidates = sectionRows[section] || [];
    for(const row of candidates){
      const modeloId = normalizeModeloId(row && (row.modelo_id ?? row.modeloId));
      if(modeloId) return modeloId;
    }
    return null;
  };

  const clearGroupDefaultHint = ()=>{
    if(!gDefaultHint) return;
    gDefaultHint.textContent = '';
    gDefaultHint.classList.add('hidden');
    gDefaultHint.classList.remove('text-error');
  };

  const showGroupDefaultHint = (text, tone)=>{
    if(!gDefaultHint) return;
    gDefaultHint.textContent = text;
    gDefaultHint.classList.remove('hidden');
    if(tone === 'error'){ gDefaultHint.classList.add('text-error'); }
    else { gDefaultHint.classList.remove('text-error'); }
  };

  const applyGroupTimerDefaults = (force)=>{
    if(!gHr || !gMin) return false;
    clearGroupDefaultHint();
    if(!force){
      const current = readMinutesFromInputs(gHr, gMin);
      if(current > 0) return false;
    }
    const modeloId = findModeloIdForGroup();
    const minutes = modeloId ? getDefaultMinutesFor(currentSectionForModal, modeloId) : null;
    if(minutes != null){
      setDurationInputs(gHr, gMin, minutes);
      const cfg = modeloId ? timerDefaults.get(modeloId) : null;
      const modelName = cfg && cfg.modeloNombre ? ` (${cfg.modeloNombre})` : '';
      showGroupDefaultHint(`Predeterminado${modelName}: ${minutes} min`, 'info');
      return true;
    }
    if(force){
      showGroupDefaultHint('No hay tiempo predeterminado disponible para este grupo.', 'error');
    }
    return false;
  };

  const collectEligibleRfidsForModal = ()=>{
    const section = currentSectionForModal === 'atemperamiento' ? 'atemperamiento' : 'congelamiento';
    if(pendingItemStart && pendingItemStart.rfid){
      const single = String(pendingItemStart.rfid || '').trim();
      return single ? [single] : [];
    }
    const tbody = section === 'congelamiento' ? tableCongBody : tableAtemBody;
    const rows = Array.from(tbody?.querySelectorAll('tr') || []);
    const rfids = [];
    if(preselectedRfids && section === 'atemperamiento'){
      const set = new Set(preselectedRfids.map((c)=>String(c||'').trim()));
      rows.forEach((tr)=>{
        const tds = tr.querySelectorAll('td');
        if(!tds || tds.length === 1) return;
        const code = tds[0].textContent?.trim();
        if(!code || !set.has(code)) return;
        const hasActive = tr.hasAttribute('data-timer-started');
        const completed = tr.getAttribute('data-completed') === '1';
        if(!hasActive && !completed) rfids.push(code);
      });
      return Array.from(new Set(rfids.map((c)=>String(c||'').trim()).filter(Boolean)));
    }
    if(gMode !== 'nuevo'){
      let lote = '';
      if(gMode === 'existente'){
        lote = (gLoteExist?.value || '').trim();
      } else if(gMode === 'rfid'){
        lote = (gRfidInput?.getAttribute('data-derived-lote') || '').trim();
      }
      const directRfid = gMode === 'rfid' ? (gRfidInput?.value || '').trim().toUpperCase() : '';
      rows.forEach((tr)=>{
        const tds = tr.querySelectorAll('td');
        if(!tds || tds.length === 1) return;
        const rfid = tds[0].textContent?.trim();
        const trLote = (tds[2]?.textContent || '').trim();
        const hasActive = tr.hasAttribute('data-timer-started');
        const completed = tr.getAttribute('data-completed') === '1';
        if(!rfid || hasActive || completed) return;
        if(gMode === 'rfid'){
          if(rfid === directRfid || (lote && trLote === lote)) rfids.push(rfid);
        } else if(lote && trLote === lote){
          rfids.push(rfid);
        }
      });
      return Array.from(new Set(rfids.map((c)=>String(c||'').trim()).filter(Boolean)));
    }
    rows.forEach((tr)=>{
      const tds = tr.querySelectorAll('td');
      if(!tds || tds.length === 1) return;
      const rfid = tds[0].textContent?.trim();
      const hasActive = tr.hasAttribute('data-timer-started');
      const hasLote = tr.getAttribute('data-has-lote') === '1';
      const completed = tr.getAttribute('data-completed') === '1';
      if(rfid && !hasActive && !hasLote && !completed){
        rfids.push(rfid);
      }
    });
    return Array.from(new Set(rfids.map((c)=>String(c||'').trim()).filter(Boolean)));
  };

  const resolveCurrentLoteValue = ()=>{
    let loteInput = (gLote?.value||'').trim();
    if(gModesBox && !gModesBox.classList.contains('hidden')){
      if(gMode==='existente'){
        return (gLoteExist?.value||'').trim();
      }
      if(gMode==='rfid'){
        const derived = gRfidInput?.getAttribute('data-derived-lote') || '';
        return derived.trim();
      }
      if(gMode==='nuevo'){
        return '';
      }
    }
    return loteInput;
  };

  const buildDefaultOptions = (rfidList, section)=>{
    const uniqueRfids = Array.from(new Set((rfidList || []).map((c)=>String(c||'').toUpperCase()).filter(Boolean)));
    if(!uniqueRfids.length) return { options: [], hasDefaults: false };
    const map = new Map();
    uniqueRfids.forEach((code)=>{
      const meta = itemMetaByRfid.get(code);
      const modeloId = meta?.modeloId || null;
      const minutesRaw = modeloId ? getDefaultMinutesFor(section, modeloId) : null;
      const minutes = minutesRaw != null && Number.isFinite(minutesRaw) && minutesRaw > 0 ? minutesRaw : null;
      const unidadRaw = typeof meta?.nombreUnidad === 'string' ? meta.nombreUnidad.trim() : '';
      const modeloNombre = typeof meta?.modeloNombre === 'string' ? meta.modeloNombre : '';
      const label = unidadRaw || modeloNombre || code;
      const key = `${modeloId ?? 'none'}::${label.toLowerCase()}`;
      if(!map.has(key)){
        map.set(key, {
          key,
          modeloId,
          modeloNombre,
          unidadLabel: label,
          minutes,
          count: 0,
          rfids: [],
        });
      }
      const bucket = map.get(key);
      bucket.count += 1;
      if(minutes != null){ bucket.minutes = minutes; }
      if(!bucket.rfids.includes(code)) bucket.rfids.push(code);
    });
    const options = Array.from(map.values()).sort((a,b)=> b.count - a.count);
    const hasDefaults = options.some((opt)=> opt.minutes != null);
    return { options, hasDefaults };
  };

  const applyScanTimerDefaults = (force)=>{
    if(target !== 'atemperamiento' || !scanStartTimer || !scanStartTimer.checked) return;
    if(!force){
      const current = readMinutesFromInputs(scanTimerHr, scanTimerMin);
      if(current > 0 && !Array.isArray(pendingScanAutoBuckets)) return;
    }
    const normalizedRfids = Array.from(new Set(valid.map((code)=>String(code||'').toUpperCase()).filter(Boolean)));
    if(!normalizedRfids.length){
      pendingScanAutoBuckets = null;
      preserveScanHint = false;
      resetScanTimerHint();
      return;
    }
    const { options, hasDefaults } = buildDefaultOptions(normalizedRfids, 'atemperamiento');
    if(!hasDefaults){
      pendingScanAutoBuckets = null;
      preserveScanHint = false;
      resetScanTimerHint();
      return;
    }
    const buckets = options
      .filter((opt)=>Number.isFinite(opt.minutes) && opt.minutes > 0 && Array.isArray(opt.rfids) && opt.rfids.length)
      .map((opt)=>({
        minutes: opt.minutes,
        rfids: Array.from(new Set(opt.rfids.map((code)=>String(code||'').toUpperCase()).filter(Boolean))),
        unidadLabel: opt.unidadLabel,
        modeloNombre: opt.modeloNombre,
      }));
    if(!buckets.length){
      pendingScanAutoBuckets = null;
      preserveScanHint = false;
      resetScanTimerHint();
      return;
    }
    pendingScanAutoBuckets = buckets;
    preserveScanHint = true;
    if(buckets.length === 1){
      const chosen = buckets[0];
      setDurationInputs(scanTimerHr, scanTimerMin, chosen.minutes);
      const label = chosen.unidadLabel || chosen.modeloNombre || 'Config';
      updateScanTimerHint(`Aplicado predeterminado: ${chosen.minutes} min (${label})`, 'info');
    } else {
      if(scanTimerHr) scanTimerHr.value = '';
      if(scanTimerMin) scanTimerMin.value = '';
      const totalBuckets = buckets.length;
      updateScanTimerHint(`Se iniciarán ${totalBuckets} cronómetros predeterminados al confirmar.`, 'info');
    }
  };

  if(scanStartTimer){
    scanStartTimer.addEventListener('change', ()=>{
      if(scanStartTimer.checked){
        applyScanTimerDefaults(false);
      } else {
        resetScanTimerHint();
      }
    });
  }

  const handleScanTimerManualInput = ()=>{
    if(suppressScanTimerChange) return;
    pendingScanAutoBuckets = null;
    preserveScanHint = false;
    resetScanTimerHint();
  };
  scanTimerHr?.addEventListener('input', handleScanTimerManualInput);
  scanTimerMin?.addEventListener('input', handleScanTimerManualInput);

  function setLocationMessage(text){ if(locationHint){ locationHint.textContent = text || ''; } }

  function escapeHtml(value){
    return String(value ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  async function loadUbicaciones(){
    if(ubicacionesState.data) return ubicacionesState.data;
    if(!ubicacionesState.promise){
      ubicacionesState.promise = fetch('/inventario/ubicaciones', { headers: { Accept: 'application/json' } })
        .then((res)=> res.ok ? res.json() : null)
        .then((json)=>{
          const zonas = Array.isArray(json?.zonas) ? json.zonas : [];
          ubicacionesState.data = zonas.map((z)=>({
            zona_id: z.zona_id,
            nombre: z.nombre,
            activa: z.activa,
            secciones: Array.isArray(z.secciones) ? z.secciones.map((s)=>({
              seccion_id: s.seccion_id,
              nombre: s.nombre,
              activa: s.activa,
            })) : [],
          }));
          return ubicacionesState.data;
        })
        .catch((err)=>{
          console.error('[Preacond] Error cargando ubicaciones', err);
          ubicacionesState.data = [];
          return ubicacionesState.data;
        })
        .finally(()=>{ ubicacionesState.promise = null; });
    }
    return ubicacionesState.promise;
  }

  function populateZonaSelect(selected){
    if(!selectZona) return;
    const zonas = ubicacionesState.data || [];
    const options = ['<option value="">Sin zona</option>'];
    zonas.forEach((z)=>{
      const label = escapeHtml(z.nombre || `Zona ${z.zona_id}`) + (z.activa === false ? ' (inactiva)' : '');
      options.push(`<option value="${escapeHtml(z.zona_id)}">${label}</option>`);
    });
    selectZona.innerHTML = options.join('');
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
    selectedZonaId = selectZona.value || '';
    if(zonas.length === 0){
      setLocationMessage('No hay zonas configuradas para tu sede.');
    }
  }

  function populateSeccionSelect(zonaId, selected){
    if(!selectSeccion) return;
    const zonas = ubicacionesState.data || [];
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
            const label = escapeHtml(s.nombre || `Sección ${s.seccion_id}`) + (s.activa === false ? ' (inactiva)' : '');
            opts.push(`<option value="${escapeHtml(s.seccion_id)}">${label}</option>`);
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
      selectedSeccionId = selectSeccion.value || '';
    } else {
      selectSeccion.value = '';
      if(disable){ selectedSeccionId = ''; }
    }
    setLocationMessage(message);
  }

  function ensureLocationSelectors(){
    if(!selectZona || !selectSeccion) return Promise.resolve();
    setLocationMessage('Cargando ubicaciones...');
    return loadUbicaciones()
      .then(()=>{
        populateZonaSelect(selectedZonaId);
        populateSeccionSelect(selectedZonaId, selectedSeccionId);
      })
      .catch(()=>{
        setLocationMessage('No se pudieron cargar las ubicaciones.');
        if(selectZona) selectZona.disabled = true;
        if(selectSeccion) selectSeccion.disabled = true;
      });
  }

  function setSpin(which, on){
    const el = which === 'cong' ? spinCong : spinAtem;
    if(!el) return;
    el.classList.toggle('hidden', !on);
  }

  let serverNowOffsetMs = 0; // client_now - server_now to keep sync
  function fmt(ms){
    const s = Math.floor(ms/1000);
    const negative = s < 0;
    const abs = Math.abs(s);
    const hh = String(Math.floor(abs/3600)).padStart(2,'0');
    const mm = String(Math.floor((abs%3600)/60)).padStart(2,'0');
    const ss = String(abs%60).padStart(2,'0');
    return `${negative?'-':''}${hh}:${mm}:${ss}`;
  }

  const NEGATIVE_SYNC_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutos: evita saltos grandes pero sincroniza variaciones pequeñas

  function computeBaselinesByLote(rows){
    const perLote = new Map();
    rows.forEach((row)=>{
      const loteRaw = typeof row.lote === 'string' ? row.lote.trim() : row.lote ? String(row.lote) : '';
      const key = loteRaw || '__sin_lote__';
      const completedAt = getCompletedAtMs(row);
      if(!Number.isFinite(completedAt)) return;
      if(!perLote.has(key)) perLote.set(key, []);
      perLote.get(key).push(completedAt);
    });
    const baselines = new Map();
    perLote.forEach((list, key)=>{
      if(!Array.isArray(list) || !list.length) return;
      if(list.length === 1){ baselines.set(key, list[0]); return; }
      const min = Math.min(...list);
      const max = Math.max(...list);
      if((max - min) <= NEGATIVE_SYNC_THRESHOLD_MS){
        baselines.set(key, max);
      }
    });
    return baselines;
  }

  let firstLoad = true;
  function renderInitialLoading(){
    if(tableCongBody){
      tableCongBody.innerHTML='';
      const tr=document.createElement('tr'); const td=document.createElement('td'); td.colSpan=5; td.className='py-10 text-center opacity-60';
      td.innerHTML=`<div class='flex flex-col items-center gap-3'>
        <span class="loading loading-spinner loading-md"></span>
        <span class='text-sm'>Cargando TICs en congelamiento...</span>
      </div>`; tr.appendChild(td); tableCongBody.appendChild(tr);
    }
    if(tableAtemBody){
      tableAtemBody.innerHTML='';
      const tr=document.createElement('tr'); const td=document.createElement('td'); td.colSpan=5; td.className='py-10 text-center opacity-60';
      td.innerHTML=`<div class='flex flex-col items-center gap-3'>
        <span class="loading loading-spinner loading-md"></span>
        <span class='text-sm'>Cargando TICs en atemperamiento...</span>
      </div>`; tr.appendChild(td); tableAtemBody.appendChild(tr);
    }
    if(lotesCong){ lotesCong.innerHTML = `<div class='flex items-center gap-2 py-6 justify-center opacity-70'><span class="loading loading-spinner loading-sm"></span><span class='text-xs'>Cargando lotes...</span></div>`; }
    if(lotesAtem){ lotesAtem.innerHTML = `<div class='flex items-center gap-2 py-6 justify-center opacity-70'><span class="loading loading-spinner loading-sm"></span><span class='text-xs'>Cargando lotes...</span></div>`; }
  }

  async function loadData(){
    try{
      if(firstLoad){ renderInitialLoading(); }
      setSpin('cong', true); setSpin('atem', true);
      const r = await fetch('/operacion/preacond/data', { headers: { 'Accept':'application/json' } });
      const j = await r.json();
      const serverNow = new Date(j.now).getTime();
  // Offset = serverNow - clientNow; to get current server time later: Date.now() + offset
  serverNowOffsetMs = serverNow - Date.now();
  const normalizeSectionRow = (row)=>{
        const modeloId = normalizeModeloId(row && (row.modelo_id ?? row.modeloId));
        return {
          ...row,
          modelo_id: modeloId,
          nombre_modelo: typeof row?.nombre_modelo === 'string' ? row.nombre_modelo : (typeof row?.modeloNombre === 'string' ? row.modeloNombre : null),
        };
      };
      const congelamientoRows = Array.isArray(j.congelamiento) ? j.congelamiento.map(normalizeSectionRow) : [];
      const atemperamientoRows = Array.isArray(j.atemperamiento) ? j.atemperamiento.map(normalizeSectionRow) : [];
      itemMetaByRfid.clear();
      registerSectionRows('congelamiento', congelamientoRows);
      registerSectionRows('atemperamiento', atemperamientoRows);
      refreshTimerDefaults(j.timerDefaults);
  render(tableCongBody, congelamientoRows, 'No hay TICs en congelamiento', 'congelamiento');
  render(tableAtemBody, atemperamientoRows, 'No hay TICs en atemperamiento', 'atemperamiento');
  renderLotes(lotesCong, congelamientoRows, 'congelamiento');
  renderLotes(lotesAtem, atemperamientoRows, 'atemperamiento');
  const nCong = congelamientoRows.length;
  const nAtem = atemperamientoRows.length;
  countCong.textContent = `(${nCong} de ${nCong})`;
  countAtem.textContent = `(${nAtem} de ${nAtem})`;
  if(qtyCongEl) qtyCongEl.textContent = String(nCong);
  if(qtyAtemEl) qtyAtemEl.textContent = String(nAtem);
  // We keep server timers for compatibility but don't show/control them here
  setupSectionTimer('congelamiento', j.timers?.congelamiento || null);
  setupSectionTimer('atemperamiento', j.timers?.atemperamiento || null);
  if(timerCongEl) timerCongEl.textContent = '';
  if(timerAtemEl) timerAtemEl.textContent = '';
  if(gDlg?.open){ applyGroupTimerDefaults(false); }
  if(dlg?.open){ applyScanTimerDefaults(false); }
  }catch(e){ console.error(e); }
  finally{ setSpin('cong', false); setSpin('atem', false); firstLoad=false; }
  }

  function renderLotes(container, rows, section){
    if(!container) return;
    const groups = new Map();
    for(const r of rows||[]){
      const loteRaw = typeof r.lote === 'string' ? r.lote.trim() : r.lote ? String(r.lote) : '';
      const key = loteRaw || '(sin lote)';
      if(!groups.has(key)) groups.set(key, { items: [], loteKey: loteRaw });
      groups.get(key).items.push(r);
    }
    const cards = [];
    groups.forEach((group, key)=>{
      const items = group.items;
      const loteKey = group.loteKey || '__sin_lote__';
      const baselines = computeBaselinesByLote(items);
      const baselineTs = baselines.get(loteKey);
      const count = items.length;
      const header = `
        <div class="rounded-xl p-3 bg-gradient-to-r ${section==='congelamiento'?'from-sky-500 to-indigo-500':'from-amber-500 to-rose-500'} text-white flex items-center justify-between">
          <div>
            <div class="text-base font-semibold">${key === '(sin lote)' ? 'Sin lote' : 'Lote ' + key}</div>
            <div class="badge badge-outline badge-sm border-white/40 text-white/90 bg-white/10">${count} TIC${count!==1?'s':''}</div>
          </div>
          <div class="opacity-90">
            ${section==='congelamiento'
              ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-6 h-6" fill="currentColor"><path d="M11 2h2v20h-2zM3.8 6.2l1.4-1.4 14 14-1.4 1.4-14-14zM18.8 4.8l1.4 1.4-14 14-1.4-1.4 14-14z"/></svg>'
              : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-6 h-6" fill="currentColor"><path d="M13 5.08V4a1 1 0 10-2 0v1.08A7.002 7.002 0 005 12a7 7 0 1014 0 7.002 7.002 0 00-6-6.92zM12 20a5 5 0 01-5-5c0-2.5 1.824-4.582 4.2-4.93V4h1.6v6.07C15.176 10.418 17 12.5 17 15a5 5 0 01-5 5z"/></svg>'}
          </div>
        </div>`;
      const list = items.map(it=>{
        const isCompleted = /Congelado|Atemperado/i.test(it.sub_estado||'');
        const started = it.started_at ? new Date(it.started_at).getTime() : null;
        const duration = Number(it.duration_sec)||0;
        const active = !!it.item_active && !!started && duration>0;
        const tableId = section==='congelamiento'?'tabla-cong':'tabla-atem';
        const timerId = `tm-card-${tableId}-${it.rfid}`;
        const completedAt = getCompletedAtMs(it);
        const showElapsed = !active && section==='atemperamiento' && /Atemperado/i.test(it.sub_estado||'') && Number.isFinite(completedAt);
        const effectiveCompletedAt = Number.isFinite(baselineTs) ? baselineTs : completedAt;
        const nowServerMs = Date.now() + serverNowOffsetMs;
        let initialTimerText = '';
        if(active){
          initialTimerText = '00:00:00';
        } else if(showElapsed && Number.isFinite(effectiveCompletedAt)){
          const elapsedInitialSec = Math.max(0, Math.floor((nowServerMs - effectiveCompletedAt)/1000));
          initialTimerText = fmt(-elapsedInitialSec * 1000);
        }
        const displayName = (it.nombre_unidad||'').trim() || 'TIC';
        let right = '';
        if(active){
          right = `<span class="flex items-center gap-2">
                     <span class="badge badge-neutral badge-xs"><span id="${timerId}">${initialTimerText}</span></span>
                     <button class="btn btn-ghost btn-xs text-error" data-item-clear="${it.rfid}" data-section="${section}">
                       <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
                     </button>
                   </span>`;
        } else if(!isCompleted){
          right = `<span class="flex items-center gap-2">
                     <button class="btn btn-ghost btn-xs text-success" data-item-start="${it.rfid}" data-section="${section}">
                       <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                     </button>
                   </span>`;
        } else {
          const label = section==='congelamiento' ? 'Congelado' : 'Atemperado';
          const timerBadge = showElapsed ? `<span class="badge badge-warning badge-xs"><span id="${timerId}">${initialTimerText}</span></span>` : '';
          right = `<span class="flex items-center gap-2">${timerBadge}${timerBadge?'<span class="opacity-60">&middot;</span>':''}<span class="text-xs font-semibold ${section==='congelamiento'?'text-info':'text-warning'}">${label}</span></span>`;
        }
        return `<li class="flex items-center justify-between py-1">
                  <span class="truncate text-sm">${displayName}</span>
                  ${right}
                </li>`;
      }).join('');
    cards.push(`<div class="card shadow-lg border border-base-300/60 bg-base-200 rounded-2xl">
        <div class="card-body">
          ${header}
      <ul class="mt-3 divide-y divide-base-300/60 max-h-56 overflow-auto pr-1 rounded-md">${list}</ul>
        </div>
      </div>`);
    });
    container.innerHTML = cards.join('');
    if(!cards.length){
      container.innerHTML = `<div class="py-10 text-center text-sm opacity-60">No hay TICs en ${section==='congelamiento'?'congelamiento':'atemperamiento'}</div>`;
    }
  }

  function render(tbody, rows, emptyText, section){
    tbody.innerHTML = '';
    if(!rows || !rows.length){
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = 5; td.className = 'text-center py-10 opacity-70'; td.textContent = emptyText;
      tr.appendChild(td); tbody.appendChild(tr); return;
    }
    const baselineMap = computeBaselinesByLote(rows);
    const serverNowMs = Date.now() + serverNowOffsetMs;
    for(const r of rows){
      const tr = document.createElement('tr');
      const started = r.started_at ? new Date(r.started_at).getTime() : null;
      const duration = Number(r.duration_sec) || 0;
      const active = !!r.item_active && !!started && duration > 0;
      const tableId = (tbody.closest('table') && tbody.closest('table').id) || 'x';
      const timerId = `tm-${tableId}-${r.rfid}`;
      const subRaw = r.sub_estado || '';
      const sub = subRaw.toLowerCase();
      const isCompleted = /congelado|atemperado/.test(sub);
      const completedAt = getCompletedAtMs(r);
      const showElapsed = !active && section === 'atemperamiento' && /atemperado/.test(sub) && Number.isFinite(completedAt);
      const loteKey = typeof r.lote === 'string' ? r.lote.trim() : r.lote ? String(r.lote) : '';
      const syncBase = baselineMap.get(loteKey || '__sin_lote__');
      const effectiveCompletedAt = Number.isFinite(syncBase) ? syncBase : completedAt;
      if(isCompleted){
        tr.classList.add(section==='atemperamiento' ? 'bg-warning/10' : 'bg-info/10');
        tr.setAttribute('data-completed','1');
      } else {
        tr.removeAttribute('data-completed');
      }
      let controls = '';
      if(active){
        controls = `<button class="btn btn-ghost btn-xs text-error" title="Detener" data-item-clear="${r.rfid}" data-section="${section}">
             <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
           </button>`;
      } else if(!isCompleted) {
        controls = `<button class="btn btn-ghost btn-xs text-success" title="Iniciar" data-item-start="${r.rfid}" data-section="${section}">
             <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-4 h-4" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
           </button>`;
      } else {
        controls = '';
      }
      const loteVal = r.lote || '';
      const lotePill = loteVal ? `<span class="badge badge-ghost badge-xs sm:badge-sm whitespace-nowrap">L: ${loteVal}</span>` : '';
      let badgeClass = 'badge-neutral';
      if(showElapsed){
        badgeClass = 'badge-warning';
      } else if(isCompleted){
        badgeClass = section==='atemperamiento' ? 'badge-warning' : 'badge-info';
      }
      let initialTimerText = '';
      if(active){
        initialTimerText = '00:00:00';
      } else if(showElapsed && Number.isFinite(effectiveCompletedAt)){
        const elapsedInitialSec = Math.max(0, Math.floor((serverNowMs - effectiveCompletedAt)/1000));
        initialTimerText = fmt(-elapsedInitialSec * 1000);
      }
      tr.innerHTML = `<td>${r.rfid}</td><td class="hidden md:table-cell">${r.nombre_unidad||''}</td><td class="hidden lg:table-cell">${r.lote||''}</td><td class="hidden md:table-cell">${r.sub_estado || '-'}</td>
        <td class="flex flex-wrap items-center gap-1 sm:gap-2">
          <span class="badge ${badgeClass} badge-sm" data-threshold="1"><span id="${timerId}">${initialTimerText}</span></span>
          ${lotePill}
          ${controls}
        </td>`;
      tr.setAttribute('data-has-lote', (r.lote && String(r.lote).trim()) ? '1' : '0');
      const modeloAttr = normalizeModeloId(r && (r.modelo_id ?? r.modeloId));
      if(modeloAttr){ tr.setAttribute('data-modelo-id', String(modeloAttr)); }
      else { tr.removeAttribute('data-modelo-id'); }
      const modeloNombre = typeof r?.nombre_modelo === 'string' ? r.nombre_modelo : (typeof r?.modeloNombre === 'string' ? r.modeloNombre : '');
      if(modeloNombre){ tr.setAttribute('data-modelo-nombre', modeloNombre); }
      else { tr.removeAttribute('data-modelo-nombre'); }
      tr.setAttribute('data-timer-id', timerId);
      if(active){
        tr.setAttribute('data-item-duration', String(duration));
        tr.setAttribute('data-timer-started', String(started));
        tr.removeAttribute('data-completed-at');
      } else {
        tr.removeAttribute('data-item-duration');
        tr.removeAttribute('data-timer-started');
        if(showElapsed && Number.isFinite(effectiveCompletedAt)){
          tr.setAttribute('data-completed-at', String(effectiveCompletedAt));
        } else {
          tr.removeAttribute('data-completed-at');
        }
      }
      tr.removeAttribute('data-done');
      tbody.appendChild(tr);
    }
    // ensure ticking is running
    startGlobalTick();
  }

  let ticking = false, rafId = 0;
  function startGlobalTick(){
    if(ticking) return; ticking = true;
    const step = ()=>{
      // Reconstruct approximate server 'now' each frame
      const now = Date.now() + serverNowOffsetMs;
      document.querySelectorAll('tr[data-timer-started]').forEach((tr)=>{
        const started = Number(tr.getAttribute('data-timer-started')||'');
        const duration = Number(tr.getAttribute('data-item-duration')||'0');
        const id = tr.getAttribute('data-timer-id');
        if(!Number.isFinite(started) || !Number.isFinite(duration) || !id) return;
        const el = document.getElementById(id);
        if(!el) return;
        if(duration > 0){
          const elapsedSec = Math.floor((now - started)/1000);
          const remaining = duration - elapsedSec;
          el.textContent = fmt(remaining * 1000);
          const cardId = 'tm-card-' + id.substring(3);
          const cardEl = document.getElementById(cardId);
          if(cardEl){ cardEl.textContent = el.textContent; }
          const badge = el.closest('.badge');
          if(badge){
            const done = remaining <= 0;
            const warn = remaining > 0 && remaining <= 300;
            const danger = remaining > 0 && remaining <= 60;
            if(done){
              badge.classList.add('badge-success');
              badge.classList.remove('badge-warning','badge-error');
            } else {
              badge.classList.remove('badge-success');
            }
            badge.classList.toggle('badge-info', remaining === 0);
            badge.classList.toggle('badge-warning', warn && !danger);
            badge.classList.toggle('badge-error', danger);
            badge.classList.toggle('badge-neutral', remaining > 300 && !done);
          }
          if(cardEl){
            const cBadge = cardEl.closest('.badge');
            if(cBadge){
              const done = remaining <= 0;
              const warn = remaining > 0 && remaining <= 300;
              const danger = remaining > 0 && remaining <= 60;
              if(done){
                cBadge.classList.add('badge-success');
                cBadge.classList.remove('badge-warning','badge-error');
              } else {
                cBadge.classList.remove('badge-success');
              }
              cBadge.classList.toggle('badge-info', remaining === 0);
              cBadge.classList.toggle('badge-warning', warn && !danger);
              cBadge.classList.toggle('badge-error', danger);
              cBadge.classList.toggle('badge-neutral', remaining > 300 && !done);
            }
          }
          if(remaining <= 0 && !tr.getAttribute('data-done')){
            tr.setAttribute('data-done','1');
            const rfid = tr.querySelector('td')?.textContent?.trim();
            const tableId = tr.closest('table')?.id || '';
            const section = tableId==='tabla-cong' ? 'congelamiento' : 'atemperamiento';
            if(rfid){
              fetch('/operacion/preacond/item-timer/complete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ section, rfid }) })
                .then(()=>loadData());
            }
          }
        } else {
          el.textContent = fmt(now - started);
        }
      });
      document.querySelectorAll('tr[data-completed-at]').forEach((tr)=>{
        if(tr.hasAttribute('data-timer-started')) return;
        const completed = Number(tr.getAttribute('data-completed-at')||'');
        const id = tr.getAttribute('data-timer-id');
        if(!Number.isFinite(completed) || !id) return;
        const el = document.getElementById(id);
        if(!el) return;
        const elapsedSec = Math.floor((now - completed)/1000);
        el.textContent = fmt(-elapsedSec * 1000);
        const badge = el.closest('.badge');
        if(badge){
          badge.classList.add('badge-warning');
          badge.classList.remove('badge-neutral','badge-success','badge-error','badge-info');
        }
        const cardId = 'tm-card-' + id.substring(3);
        const cardEl = document.getElementById(cardId);
        if(cardEl){
          cardEl.textContent = el.textContent;
          const cBadge = cardEl.closest('.badge');
          if(cBadge){
            cBadge.classList.add('badge-warning');
            cBadge.classList.remove('badge-neutral','badge-success','badge-error','badge-info');
          }
        }
      });
  // No global section timer countdown or auto-complete
      rafId = requestAnimationFrame(step);
    };
    step();
  }

  // Section Timers (global per section)
  const sectionTimers = {
    congelamiento: { startedAt: null, durationSec: 0, active: false, lote: '' },
    atemperamiento: { startedAt: null, durationSec: 0, active: false, lote: '' }
  };
  function setupSectionTimer(section, data){
    const t = sectionTimers[section];
    t.startedAt = data && data.started_at ? new Date(data.started_at).getTime() : null;
    t.durationSec = data && Number.isFinite(data.duration_sec) ? Number(data.duration_sec) : 0;
    t.active = !!(data && data.active);
    t.lote = data && data.lote ? String(data.lote) : '';
  }
  function sectionEl(section){ return section==='congelamiento' ? timerCongEl : timerAtemEl; }
  function updateSectionTimer(now, section){
  const el = sectionEl(section); if(!el) return; // hide header timer
  el.textContent = '';
  }

  async function startSectionTimer(section, lote, minutes, rfids){
    const durationSec = Math.round(minutes*60);
  const r = await fetch('/operacion/preacond/timer/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ section, durationSec, lote, rfids }) });
  try { const j = await r.json(); if(j?.lote && !lote){ /* optionally notify */ console.log('Lote autogenerado', j.lote); } } catch {}
  await loadData();
  }
  async function clearSectionTimer(section){
    await fetch('/operacion/preacond/timer/clear', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ section }) });
    await loadData();
  }

  function openModal(toTarget){
    target = toTarget;
    rfids = []; invalid = []; valid = [];
    validMeta.clear();
    chipsBox.innerHTML=''; msg.textContent='';
    btnConfirm.disabled = true;
  // If opening for congelamiento, force individual mode and hide lote option
  try {
    const radiosBox = document.querySelector('#dlg-scan');
    const loteRadio = radiosBox?.querySelector('input[name="scan-mode"][value="lote"]');
    const indRadio = radiosBox?.querySelector('input[name="scan-mode"][value="individual"]');
    if(target==='congelamiento'){
      if(loteRadio){
        const wrapper = loteRadio.closest('label');
        wrapper && wrapper.classList.add('hidden');
        loteRadio.checked = false;
      }
      if(indRadio){ indRadio.checked = true; }
      scanMode='individual';
    } else {
      // ensure lote radio visible again for atemperamiento
      const wrapper = loteRadio?.closest('label');
      wrapper && wrapper.classList.remove('hidden');
    }
  }catch{}
  // Mostrar caja de cronómetro si es atemperamiento
  if(scanTimerBox){ scanTimerBox.classList.toggle('hidden', target!=='atemperamiento'); }
  if(scanStartTimer){ scanStartTimer.checked = true; }
  // Cronómetro disponible únicamente al pasar a atemperamiento
  ensureLocationSelectors();
    dlg?.showModal?.();
    setTimeout(()=>scanInput?.focus?.(), 50);
  }

  function renderChips(){
    // Mostrar únicamente los válidos (verdes) y contar
    const uniqueValid = Array.from(new Set(valid));
    const items = uniqueValid.map(code=>{
      const meta = validMeta.get(code);
      const codeHtml = escapeHtml(code);
      const unitRaw = typeof meta?.nombre_unidad === 'string' ? meta.nombre_unidad.trim() : '';
      const modelRaw = typeof meta?.nombre_modelo === 'string' ? meta.nombre_modelo.trim() : '';
      const labelSource = unitRaw || modelRaw;
      const label = labelSource ? escapeHtml(labelSource.length > 40 ? `${labelSource.slice(0, 37)}…` : labelSource) : '';
      return `<div class="inline-flex flex-col items-start gap-1">
                <span class="badge badge-success gap-3 items-center text-left whitespace-normal">
                  <span class="font-mono text-xs tracking-tight">${codeHtml}</span>
                  ${label ? `<span class="text-xs font-medium max-w-[180px] truncate">${label}</span>` : ''}
                  <button type="button" class="btn btn-ghost btn-xs" data-remove="${codeHtml}">✕</button>
                </span>
                <div class="text-[10px] text-success">ok</div>
              </div>`;
    }).join('');
    chipsBox.innerHTML = items || '<div class="opacity-60 text-sm">Sin RFIDs</div>';
    if(scanCount){ scanCount.textContent = String(uniqueValid.length); }
    btnConfirm.disabled = uniqueValid.length === 0;
    if(target === 'atemperamiento'){
      if(uniqueValid.length){
        applyScanTimerDefaults(false);
      } else {
        resetScanTimerHint();
      }
    }
  }

  function addCode(chunk){
    if(!chunk) return;
    const code = String(chunk).toUpperCase();
    if(code.length===24 && !rfids.includes(code)) rfids.push(code);
  }

  function processBuffer(raw){
    let v = (raw||'').replace(/\s+/g,'');
    while(v.length>=24){ const c=v.slice(0,24); addCode(c); v=v.slice(24); }
    return v;
  }

  let validateToken = 0;
  async function validate(){
    if(!rfids.length){ invalid=[]; valid=[]; validMeta.clear(); renderChips(); return; }
    const myToken = ++validateToken;
    try{
      const r = await fetch('/operacion/preacond/validate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ target, rfids }) });
      const j = await r.json();
      if(myToken !== validateToken){ return; }
  const inv = Array.isArray(j.invalid)? j.invalid : [];
  const ok = Array.isArray(j.valid)? j.valid : [];
  // Auto-filtrar: conservar solo válidos y limpiar inválidos (no mostrar rojos)
  invalid = [];
  validMeta.clear();
  const normalizedOk = ok.map((entry)=>{
    if(typeof entry === 'string'){
      return { rfid: entry.toUpperCase(), nombre_unidad: '', nombre_modelo: '', modeloId: null };
    }
    const rfid = typeof entry?.rfid === 'string' ? entry.rfid.toUpperCase() : '';
    return {
      rfid,
      nombre_unidad: typeof entry?.nombre_unidad === 'string' ? entry.nombre_unidad : '',
      nombre_modelo: typeof entry?.nombre_modelo === 'string' ? entry.nombre_modelo : '',
      modeloId: normalizeModeloId(entry?.modelo_id ?? entry?.modeloId)
    };
  }).filter(item=>item.rfid);
  normalizedOk.forEach((item)=>{ validMeta.set(item.rfid, item); });
  valid = normalizedOk.map(item=>item.rfid);
  rfids = rfids.filter(c => validMeta.has(c));
  renderChips();
  msg.textContent = '';
    }catch{ if(myToken === validateToken){ /* keep state */ } }
  }

  // Debounce to avoid hammering the server with the RFID gun rapid input
  let _vTimer = 0;
  function scheduleValidate(){
    if(_vTimer){ clearTimeout(_vTimer); }
    _vTimer = setTimeout(()=>{ _vTimer = 0; validate(); }, 120);
  }

  // Input handlers
  scanInput?.addEventListener('input', ()=>{ if(scanMode==='individual'){ scanInput.value = processBuffer(scanInput.value); scheduleValidate(); } });
  // Modo selector
  document.querySelectorAll('input[name="scan-mode"]').forEach(r=>{
    r.addEventListener('change', (e)=>{
      scanMode = (e.target).value;
      rfids=[]; invalid=[]; valid=[]; validMeta.clear(); loteDetected=null; loteItemsCache=[];
      chipsBox.innerHTML=''; msg.textContent=''; btnConfirm.disabled=true;
      if(scanLoteSummary){ scanLoteSummary.classList.add('hidden'); scanLoteSummary.innerHTML=''; }
      scanInput.value='';
      scanInput.placeholder = scanMode==='lote' ? 'Escanea una sola TIC congelada para identificar el lote...' : 'Listo para escanear...';
      if(scanMode==='lote'){
        msg.textContent = 'Escanee una TIC (24 caracteres). Identificaremos el lote completo.';
      }
    });
  });

  async function handleLoteScan(code){
    if(!code || code.length!==24) return;
  const normalizedCode = code.toUpperCase();
  msg.textContent='Buscando lote y sus TICs...';
    try{
      const r = await fetch('/operacion/preacond/lote/lookup', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rfid: normalizedCode }) });
      const j = await r.json();
      if(!j.ok){ msg.textContent=j.error||'No se pudo obtener lote'; return; }
  loteDetected = j.lote; // backend devuelve 'tics'
  loteItemsCache = j.items || j.tics || [];
  if(!Array.isArray(loteItemsCache) || !loteItemsCache.length){ msg.textContent='No se encontraron TICs en el lote'; return; }
      // Resumen
      if(scanLoteSummary){
  const totalCongelado = loteItemsCache.filter(it=>/Congelado/i.test(it.sub_estado||'')).length;
  const totalCongelamiento = loteItemsCache.filter(it=>/Congelamiento/i.test(it.sub_estado||'')).length;
  const rows = loteItemsCache.map(it=>`<tr><td class='font-mono'>${it.rfid}</td><td>${(it.nombre_unidad||'').slice(0,18)}</td><td>${it.sub_estado}</td></tr>`).join('');
  scanLoteSummary.innerHTML = `<div class='font-semibold mb-2'>Lote ${loteDetected} – ${totalCongelado} TIC${totalCongelado!==1?'s':''} listas (Congelado)${totalCongelamiento?` / ${totalCongelamiento} en Congelamiento`:''}</div><div class='overflow-auto max-h-40'><table class='table table-xs'><thead><tr><th>RFID</th><th>Nombre</th><th>Estado</th></tr></thead><tbody>${rows}</tbody></table></div><div class='mt-2 text-xs opacity-70'>Solo se pasarán las TIC con sub estado <strong>Congelado</strong>. Las que aún estén en <strong>Congelamiento</strong> permanecerán allí.</div>`;
        scanLoteSummary.classList.remove('hidden');
      }
      // Marcar un solo RFID para habilitar botón
      rfids=[normalizedCode];
      valid=[normalizedCode];
      invalid=[];
      validMeta.clear();
      const loteEntry = loteItemsCache.find((it)=> String(it.rfid||'').trim().toUpperCase() === normalizedCode);
      if(loteEntry){
        validMeta.set(normalizedCode, {
          rfid: normalizedCode,
          nombre_unidad: typeof loteEntry.nombre_unidad === 'string' ? loteEntry.nombre_unidad : '',
          nombre_modelo: typeof loteEntry.nombre_modelo === 'string' ? loteEntry.nombre_modelo : '',
          modeloId: normalizeModeloId(loteEntry?.modelo_id ?? loteEntry?.modeloId)
        });
      }
      renderChips(); msg.textContent='';
    }catch{ msg.textContent='Error consultando lote'; }
  }

  // Listener específico para modo lote
  scanInput?.addEventListener('input', ()=>{
    if(scanMode==='lote'){
  let v = scanInput.value.replace(/\s+/g,'');
  if(v.length>24){ v = v.slice(0,24); }
  scanInput.value = v; // limitar siempre a un solo código
  if(v.length===24){ handleLoteScan(v); }
    }
  });
  scanInput?.addEventListener('paste', (e)=>{ const t=e.clipboardData?.getData('text')||''; if(t){ e.preventDefault(); scanInput.value = processBuffer(t); scheduleValidate(); } });
  // Prevent Enter from auto-confirming; require tapping the Confirm button
  scanInput?.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  });

  chipsBox?.addEventListener('click', (e)=>{
    const t = e.target; if(!(t instanceof Element)) return;
    const code = t.getAttribute('data-remove');
    if(code){
      rfids = rfids.filter(x=>x!==code);
      valid = valid.filter(x=>x!==code);
      // invalid list is not shown; keep empty
      renderChips();
      validate();
    }
  });

  selectZona?.addEventListener('change', ()=>{
    selectedZonaId = selectZona.value || '';
    selectedSeccionId = '';
    populateSeccionSelect(selectedZonaId, selectedSeccionId);
  });

  selectSeccion?.addEventListener('change', ()=>{
    selectedSeccionId = selectSeccion.value || '';
  });

  btnConfirm?.addEventListener('click', async ()=>{
    if(scanMode==='lote'){
      if(target!=='atemperamiento'){ msg.textContent='El modo lote solo aplica al paso a Atemperamiento.'; return; }
      if(!loteDetected){ msg.textContent='Escanee una TIC válida para identificar el lote.'; return; }
    }
    if(!valid.length){ msg.textContent = scanMode==='lote' ? 'Escanee la TIC congelada del lote.' : 'No hay RFIDs válidos.'; return; }
    const zonaId = selectZona ? String(selectZona.value || '').trim() : '';
    const seccionId = selectSeccion ? String(selectSeccion.value || '').trim() : '';
    selectedZonaId = zonaId;
    selectedSeccionId = seccionId;

    const sendRequest = async (allowTransfer = false) => {
      const extra = allowTransfer ? { allowSedeTransfer: true } : {};
      try {
        if(scanMode==='lote' && target==='atemperamiento'){
          const payload = { lote: loteDetected, zona_id: zonaId, seccion_id: seccionId, ...extra };
          const r = await fetch('/operacion/preacond/lote/move', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
          const data = await r.json().catch(()=>({ ok:false }));
          if(r.ok && data.ok){ data.moved = data.moved || (loteItemsCache.map(it=>it.rfid)); }
          return { httpOk: r.ok, data };
        }
        const payload = { target, rfids: valid, zona_id: zonaId, seccion_id: seccionId, ...extra };
        const r = await fetch('/operacion/preacond/scan', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        const data = await r.json().catch(()=>({ ok:false }));
        return { httpOk: r.ok, data };
      } catch (err) {
        return { httpOk: false, data: { ok:false, error: err?.message || 'Error de red' } };
      }
    };

    let attempt = await sendRequest(false);
    if(!attempt.httpOk && attempt.data?.code === 'SEDE_MISMATCH'){
      const prompt = attempt.data.confirm || attempt.data.error || 'Las piezas pertenecen a otra sede. ¿Deseas trasladarlas a esta sede?';
      if(!window.confirm(prompt)){
        msg.textContent = 'Operación cancelada.';
        return;
      }
      attempt = await sendRequest(true);
    }

    const manualScanDuration = readMinutesFromInputs(scanTimerHr, scanTimerMin);
    const result = attempt.data || { ok:false };
    if(!result.ok){ msg.textContent = result.error || 'Error al confirmar'; return; }
    dlg?.close?.();
    // Si es atemperamiento y usuario desea iniciar cronómetro aquí mismo
    const wantTimer = target==='atemperamiento' && scanStartTimer && scanStartTimer.checked;
    const movedRfids = Array.isArray(result.moved)? result.moved.slice():[];
    if(wantTimer && movedRfids.length){
      await loadData(); // refrescar antes de calcular sin lote
      const normalizedRfids = Array.from(new Set(movedRfids.map((code)=>String(code||'').toUpperCase()).filter(Boolean)));
      const storedBuckets = Array.isArray(pendingScanAutoBuckets) ? pendingScanAutoBuckets.slice() : [];
      pendingScanAutoBuckets = null;
      if(storedBuckets.length){
        const normalizedSet = new Set(normalizedRfids);
        const bucketsToRun = storedBuckets.map((bucket)=>({
          minutes: bucket.minutes,
          rfids: Array.isArray(bucket.rfids) ? bucket.rfids.filter((code)=>normalizedSet.has(code)) : [],
        })).filter((bucket)=>Number.isFinite(bucket.minutes) && bucket.minutes > 0 && bucket.rfids.length);
        if(bucketsToRun.length){
          try {
            for(const bucket of bucketsToRun){
              await startSectionTimer('atemperamiento', '', bucket.minutes, bucket.rfids);
            }
            preselectedRfids = null;
            preserveScanHint = false;
            resetScanTimerHint();
            return;
          } catch(err){
            console.error('[Preacond] Error iniciando cronómetros desde selección manual', err);
          }
        }
      }
      const manualMinutes = manualScanDuration;
      const { options, hasDefaults } = buildDefaultOptions(normalizedRfids, 'atemperamiento');
      const shouldPromptDefaults = manualMinutes <= 0 && hasDefaults && options.length;
      if(shouldPromptDefaults){
        preselectedRfids = normalizedRfids;
        const opened = openGroupDefaultDialog('scan-auto', { section: 'atemperamiento', rfids: normalizedRfids, options, hasDefaults });
        if(opened){ return; }
      }
      // Duración manual (fallback)
      let totalMinutes = manualMinutes;
      if(totalMinutes<=0){
        totalMinutes = 0;
      }
      if(totalMinutes<=0){ totalMinutes = 30; } // fallback
      await startSectionTimer('atemperamiento', '', totalMinutes, normalizedRfids);
      preselectedRfids = null;
      return;
    }
    await loadData();
  });

  // Openers from dropdowns
  document.querySelectorAll('[data-open-scan]')?.forEach((el)=>{
    el.addEventListener('click', ()=>{ const to=(el).getAttribute('data-open-scan'); openModal(to==='atemperamiento'?'atemperamiento':'congelamiento'); });
  });
  // Old dropdown timer actions removed

  // New Start All / Clear All buttons (clear-all now only cancels item timers visually)
  qs('#btn-startall-cong')?.addEventListener('click', ()=>openGroupTimer('congelamiento'));
  qs('#btn-clearall-cong')?.addEventListener('click', ()=>clearSectionTimer('congelamiento'));
  qs('#btn-startall-atem')?.addEventListener('click', ()=>openGroupTimer('atemperamiento'));
  qs('#btn-clearall-atem')?.addEventListener('click', ()=>clearSectionTimer('atemperamiento'));

  function openGroupTimer(section, opts){
    opts = opts || {};
    currentSectionForModal = section;
    if(gSectionLabel) gSectionLabel.textContent = section === 'congelamiento' ? 'Congelamiento' : 'Atemperamiento';
    const n = section==='congelamiento' ? (qtyCongEl?.textContent||'0') : (qtyAtemEl?.textContent||'0');
    if(gCount) gCount.textContent = n;
    if(gMsg){
      gMsg.textContent = '';
      gMsg.classList.remove('text-warning','text-error','text-success');
    }
  if(gLote) gLote.value = '';
  if(gHr) gHr.value = '';
  if(gMin) gMin.value = '';
    clearGroupDefaultHint();
    if(gModesBox){
      // Always visible for both sections now
      gModesBox.classList.remove('hidden');
      // Reset mode
      gMode = 'nuevo';
      const radios = gModesBox.querySelectorAll('input[name="gtimer-mode"]');
      radios.forEach(r=>{ if(r.value==='nuevo') r.checked=true; else r.checked=false; });
  if(gLoteExist){ gLoteExist.innerHTML = '<option value="">-- Selecciona --</option>'; }
      if(gRfidInput){ gRfidInput.value=''; gRfidInput.removeAttribute('data-derived-lote'); }
      if(gRfidStatus){ gRfidStatus.textContent=''; }
      // Populate existing lotes from current list (section aware)
      if(gLoteExist){
        try {
          const lotesMap = new Map(); // lote -> { hasIncomplete:boolean }
          const tableSel = section==='congelamiento' ? '#tabla-cong tbody tr' : '#tabla-atem tbody tr';
          document.querySelectorAll(tableSel).forEach(tr=>{
            const td = tr.querySelectorAll('td');
            if(td.length>=3){
              const lote = td[2].textContent.trim();
              if(!lote) return;
              const completed = tr.getAttribute('data-completed')==='1';
              if(!lotesMap.has(lote)) lotesMap.set(lote, { hasIncomplete: false });
              if(!completed){ const o = lotesMap.get(lote); o.hasIncomplete = true; lotesMap.set(lote, o); }
            }
          });
          [...lotesMap.entries()].filter(([,v])=>v.hasIncomplete).map(([k])=>k).sort().forEach(l=>{
            const opt=document.createElement('option'); opt.value=l; opt.textContent=l; gLoteExist.appendChild(opt);
          });
        }catch{}
      }
      // Hide dependent boxes initially
      qs('#gtimer-existente-box')?.classList.add('hidden');
      qs('#gtimer-rfid-box')?.classList.add('hidden');
      // Si hay RFIDs preseleccionados (flujo automático), ocultar modos y forzar nuevo lote
      if(preselectedRfids && section==='atemperamiento'){
        gModesBox.classList.add('hidden');
        gMode = 'nuevo';
      }
      // Enable manual lote input by default
  if(gLote){ gLote.disabled = true; gLote.readOnly = true; }
    }
    gDlg?.showModal?.();
    applyGroupTimerDefaults(false);
    setTimeout(()=>{
      gLote?.focus?.();
    }, 50);
  }

  gConfirm?.addEventListener('click', async ()=>{
    // Determine lote based on modo actual
    const lote = resolveCurrentLoteValue();
    const hours = Number(gHr?.value||'0');
    const minutes = Number(gMin?.value||'0');
    const totalMinutes = (isFinite(hours)?Math.max(0,hours):0)*60 + (isFinite(minutes)?Math.max(0,minutes):0);
  if(!Number.isFinite(totalMinutes) || totalMinutes<=0){
    if(gMsg){
      gMsg.textContent='Duración debe ser > 0.';
      gMsg.classList.remove('text-warning','text-success');
      gMsg.classList.add('text-error');
    }
    return;
  }
  // lote puede ir vacío en modo nuevo para autogenerarse en backend
    if(pendingItemStart){
      gDlg?.close?.();
      const durationSec = Math.round(totalMinutes*60);
      const { section, rfid } = pendingItemStart; // bugfix: use stored
      await fetch('/operacion/preacond/item-timer/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ section, rfid, durationSec, lote }) })
        .then(r=>r.json().catch(()=>null))
        .then(j=>{ if(j && j.lote && !lote){ console.log('Lote autogenerado', j.lote); } });
      await loadData();
      return;
    }
    // Collect RFIDs (considerar preseleccionados)
    const sectionLabel = currentSectionForModal==='congelamiento' ? 'Congelamiento' : 'Atemperamiento';
    const rfids = collectEligibleRfidsForModal();
    if(!rfids.length){
      if(gMsg){
        gMsg.textContent = `No hay TICs disponibles en ${sectionLabel} para iniciar este cronómetro.`;
        gMsg.classList.remove('text-success','text-error');
        gMsg.classList.add('text-warning');
      }
      return;
    }
    gDlg?.close?.();
    await startSectionTimer(currentSectionForModal, lote, totalMinutes, rfids);
    preselectedRfids = null; // limpiar después de iniciar
  });

  // Mode radio handling
  if(gModesBox){
    gModesBox.addEventListener('change', (e)=>{
      const t = e.target; if(!(t instanceof HTMLInputElement)) return;
      if(t.name==='gtimer-mode'){
        gMode = t.value;
  qs('#gtimer-existente-box')?.classList.toggle('hidden', gMode!=='existente');
  qs('#gtimer-rfid-box')?.classList.toggle('hidden', gMode!=='rfid');
  if(gLote){ gLote.disabled = true; }
        clearGroupDefaultHint();
        applyGroupTimerDefaults(false);
      }
    });
  }

  gHr?.addEventListener('input', clearGroupDefaultHint);
  gMin?.addEventListener('input', clearGroupDefaultHint);

  const rebuildDefaultConfirmTable = ()=>{
    if(!defaultConfirmBody) return;
    defaultConfirmBody.innerHTML = '';
    pendingDefaultSelections.clear();
    if(defaultConfirmApply){ defaultConfirmApply.disabled = true; }
    let hasSelectable = false;
    pendingDefaultOptions.forEach((opt)=>{
      const hasDefault = Number.isFinite(opt.minutes) && opt.minutes > 0;
      const row = document.createElement('tr');

      const cellToggle = document.createElement('td');
      if(hasDefault){
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'default-option';
        input.value = opt.key;
        input.className = 'checkbox checkbox-xs';
        input.checked = true;
        cellToggle.appendChild(input);
        pendingDefaultSelections.add(opt.key);
        hasSelectable = true;
      } else {
        const span = document.createElement('span');
        span.className = 'text-[10px] opacity-40';
        span.textContent = '—';
        cellToggle.appendChild(span);
      }
      row.appendChild(cellToggle);

      const cellLabel = document.createElement('td');
      const mainLabel = document.createElement('div');
      mainLabel.className = 'font-semibold text-xs';
      mainLabel.textContent = opt.unidadLabel || opt.modeloNombre || 'Sin identificar';
      cellLabel.appendChild(mainLabel);
      if(opt.modeloNombre){
        const sub = document.createElement('div');
        sub.className = 'text-[10px] opacity-60';
        sub.textContent = opt.modeloNombre;
        cellLabel.appendChild(sub);
      }
      row.appendChild(cellLabel);

      const cellCount = document.createElement('td');
      cellCount.className = 'text-right text-xs';
      cellCount.textContent = String(opt.count);
      row.appendChild(cellCount);

      const cellMinutes = document.createElement('td');
      cellMinutes.className = 'text-right text-xs';
      cellMinutes.textContent = hasDefault ? `${opt.minutes} min` : '—';
      row.appendChild(cellMinutes);

      defaultConfirmBody.appendChild(row);
    });
    if(defaultConfirmApply){ defaultConfirmApply.disabled = !hasSelectable; }
  };

  defaultConfirmBody?.addEventListener('change', (e)=>{
    const t = e.target;
    if(!(t instanceof HTMLInputElement) || t.name !== 'default-option') return;
    if(t.checked){
      pendingDefaultSelections.add(t.value);
    } else {
      pendingDefaultSelections.delete(t.value);
    }
    if(defaultConfirmApply){ defaultConfirmApply.disabled = pendingDefaultSelections.size === 0; }
  });

  const openGroupDefaultDialog = (mode = 'group', opts = {})=>{
    const section = typeof opts.section === 'string' ? opts.section : currentSectionForModal;
    currentSectionForModal = section === 'congelamiento' ? 'congelamiento' : 'atemperamiento';
    const sectionLabel = currentSectionForModal === 'congelamiento' ? 'Congelamiento' : 'Atemperamiento';
    preserveScanHint = false;
    pendingScanAutoBuckets = null;
    if(mode === 'group'){
      clearGroupDefaultHint();
    } else if(mode.startsWith('scan')){
      resetScanTimerHint();
    }
    const sourceRfids = Array.isArray(opts.rfids) ? opts.rfids : collectEligibleRfidsForModal();
    const normalizedRfids = Array.from(new Set((sourceRfids || []).map((code)=>String(code||'').toUpperCase()).filter(Boolean)));
    if(!normalizedRfids.length){
      if(mode === 'group'){
        if(gMsg){
          gMsg.textContent = `No hay TICs disponibles en ${sectionLabel} para calcular predeterminados.`;
          gMsg.classList.remove('text-success');
          gMsg.classList.add('text-warning');
        }
        showGroupDefaultHint('Selecciona TICs válidas antes de usar el tiempo predeterminado.', 'error');
      } else {
        updateScanTimerHint('Escanea TICs válidas antes de usar el tiempo predeterminado.', 'error');
      }
      return false;
    }
    let options = Array.isArray(opts.options) ? opts.options : null;
    let hasDefaults = false;
    if(options){
      hasDefaults = typeof opts.hasDefaults === 'boolean' ? opts.hasDefaults : options.some((opt)=>opt && opt.minutes != null);
    } else {
      const built = buildDefaultOptions(normalizedRfids, currentSectionForModal);
      options = built.options;
      hasDefaults = built.hasDefaults;
    }
    if(!options.length){
      if(mode === 'group'){
        showGroupDefaultHint('No se encontraron tiempos predeterminados configurados.', 'error');
      } else {
        updateScanTimerHint('No se encontraron tiempos predeterminados configurados.', 'error');
      }
      return false;
    }
    defaultConfirmMode = mode;
    defaultConfirmSection = currentSectionForModal;
    if(mode === 'group'){
      defaultConfirmLote = resolveCurrentLoteValue();
    } else if(mode === 'scan-auto'){
      defaultConfirmLote = typeof opts.lote === 'string' ? opts.lote : '';
    } else {
      defaultConfirmLote = '';
    }
    pendingDefaultOptions = options;
    if(defaultConfirmEmpty){ defaultConfirmEmpty.classList.toggle('hidden', hasDefaults); }
    if(defaultConfirmMixed){ defaultConfirmMixed.classList.toggle('hidden', options.length <= 1); }
    rebuildDefaultConfirmTable();
    defaultConfirmResolve = null;
    if(!hasDefaults){
      if(mode === 'group'){
        showGroupDefaultHint('Las configuraciones seleccionadas no tienen tiempos predeterminados.', 'error');
      } else {
        updateScanTimerHint('Las configuraciones seleccionadas no tienen tiempos predeterminados.', 'error');
      }
    }
    defaultConfirmDlg?.showModal?.();
    return true;
  };

  gApplyDefault?.addEventListener('click', ()=>openGroupDefaultDialog('group'));

  scanApplyDefault?.addEventListener('click', ()=>{
    if(target !== 'atemperamiento'){ return; }
    if(scanStartTimer && !scanStartTimer.checked){
      scanStartTimer.checked = true;
    }
    const uniqueValid = Array.from(new Set(valid.map((code)=>String(code||'').toUpperCase()).filter(Boolean)));
    if(!uniqueValid.length){
      updateScanTimerHint('Escanea TICs válidas antes de usar el tiempo predeterminado.', 'error');
      return;
    }
    openGroupDefaultDialog('scan-select', { section: 'atemperamiento', rfids: uniqueValid });
  });

  defaultConfirmDlg?.addEventListener('close', ()=>{
    const mode = typeof defaultConfirmMode === 'string' ? defaultConfirmMode : 'group';
    pendingDefaultOptions = [];
    pendingDefaultSelections.clear();
    if(defaultConfirmApply){ defaultConfirmApply.disabled = true; }
    preselectedRfids = null;
    const keepScanBuckets = mode.startsWith('scan') && preserveScanHint && Array.isArray(pendingScanAutoBuckets) && pendingScanAutoBuckets.length;
    if(mode.startsWith('scan')){
      if(!preserveScanHint){ resetScanTimerHint(); }
      if(!keepScanBuckets){ pendingScanAutoBuckets = null; }
    } else {
      pendingScanAutoBuckets = null;
      preserveScanHint = false;
    }
    if(!keepScanBuckets){ preserveScanHint = false; }
    defaultConfirmMode = 'group';
  });

  defaultConfirmApply?.addEventListener('click', async ()=>{
    if(!pendingDefaultSelections.size) return;
    const selected = pendingDefaultOptions.filter(opt=>pendingDefaultSelections.has(opt.key));
    const valid = selected.filter(opt=>opt.minutes != null && Array.isArray(opt.rfids) && opt.rfids.length);
    if(!valid.length){
      if(defaultConfirmMode === 'group'){
        showGroupDefaultHint('Selecciona al menos un tiempo predeterminado válido.', 'error');
      } else {
        updateScanTimerHint('Selecciona al menos un tiempo predeterminado válido.', 'error');
      }
      return;
    }
    const section = defaultConfirmSection || currentSectionForModal;
    if(defaultConfirmMode === 'scan-select'){
      if(scanStartTimer){ scanStartTimer.checked = true; }
      pendingScanAutoBuckets = valid.map((bucket)=>({
        minutes: bucket.minutes,
        rfids: Array.isArray(bucket.rfids)
          ? Array.from(new Set(bucket.rfids.map((code)=>String(code||'').toUpperCase()).filter(Boolean)))
          : [],
        unidadLabel: bucket.unidadLabel,
        modeloNombre: bucket.modeloNombre,
      })).filter((bucket)=>bucket.minutes != null && bucket.rfids.length);
      if(!pendingScanAutoBuckets.length){
        updateScanTimerHint('No se encontraron TICs elegibles para iniciar con tiempos predeterminados.', 'error');
        pendingScanAutoBuckets = null;
        return;
      }
      if(pendingScanAutoBuckets.length === 1){
        setDurationInputs(scanTimerHr, scanTimerMin, pendingScanAutoBuckets[0].minutes);
      }
      const summaryMsg = pendingScanAutoBuckets.length === 1
        ? `Se iniciará el cronómetro (${pendingScanAutoBuckets[0].minutes} min) para ${pendingScanAutoBuckets[0].unidadLabel || pendingScanAutoBuckets[0].modeloNombre || 'Config'} al confirmar.`
        : `Se iniciarán ${pendingScanAutoBuckets.length} cronómetros predeterminados al confirmar.`;
      updateScanTimerHint(summaryMsg, 'info');
      preserveScanHint = true;
      defaultConfirmDlg?.close?.();
      return;
    }
    if(valid.length === 1){
      const chosen = valid[0];
      if(defaultConfirmMode === 'scan-auto'){
        try {
          if(defaultConfirmApply){ defaultConfirmApply.disabled = true; }
          await startSectionTimer(section, defaultConfirmLote || '', chosen.minutes, chosen.rfids);
          pendingDefaultSelections.clear();
          defaultConfirmDlg?.close?.();
          gDlg?.close?.();
        } catch(err){
          console.error('[Preacond] Error aplicando tiempo predeterminado automático', err);
          updateScanTimerHint('No se pudo iniciar el cronómetro predeterminado.', 'error');
        } finally {
          preselectedRfids = null;
          if(defaultConfirmApply){ defaultConfirmApply.disabled = pendingDefaultSelections.size === 0; }
        }
      } else {
        setDurationInputs(gHr, gMin, chosen.minutes);
        showGroupDefaultHint(`Predeterminado (${chosen.unidadLabel || chosen.modeloNombre || 'Config'}): ${chosen.minutes} min`, 'info');
        defaultConfirmDlg?.close?.();
      }
      return;
    }

    if(defaultConfirmApply){ defaultConfirmApply.disabled = true; }
    if(defaultConfirmMode === 'scan-auto'){
      updateScanTimerHint('Iniciando cronómetros predeterminados...', 'info');
    } else {
      showGroupDefaultHint('Iniciando cronómetros predeterminados...', 'info');
    }
    try {
      const loteValue = defaultConfirmMode === 'group' ? resolveCurrentLoteValue() : (defaultConfirmLote || '');
      for(const bucket of valid){
        await startSectionTimer(section, loteValue, bucket.minutes, bucket.rfids);
      }
      defaultConfirmDlg?.close?.();
      if(defaultConfirmMode !== 'scan-select'){ gDlg?.close?.(); }
    } catch(err){
      console.error('[Preacond] Error aplicando tiempos predeterminados múltiples', err);
      if(defaultConfirmMode === 'scan-auto'){
        updateScanTimerHint('No se pudieron iniciar los cronómetros predeterminados seleccionados.', 'error');
      } else {
        showGroupDefaultHint('No se pudieron iniciar los cronómetros predeterminados seleccionados.', 'error');
      }
    } finally {
      preselectedRfids = null;
      const dialogClosed = defaultConfirmDlg instanceof HTMLDialogElement ? !defaultConfirmDlg.open : true;
      if(dialogClosed){
        pendingDefaultSelections.clear();
        if(defaultConfirmApply){ defaultConfirmApply.disabled = true; }
      } else if(defaultConfirmApply){
        defaultConfirmApply.disabled = pendingDefaultSelections.size === 0;
      }
    }
  });

  // RFID derive lote (works for both sections; searches active modal section table)
  gRfidInput?.addEventListener('input', ()=>{
    // Enforce max 24 chars, strip whitespace
    let val = (gRfidInput.value||'').replace(/\s+/g,'');
    if(val.length>24){ val = val.slice(0,24); }
    gRfidInput.value = val;
    if(val.length===24){
      // Look up its lote in current atemperamiento table/grid
      let loteFound = '';
      const tableSel = currentSectionForModal==='congelamiento' ? '#tabla-cong tbody tr' : '#tabla-atem tbody tr';
      document.querySelectorAll(tableSel).forEach(tr=>{
        const tds = tr.querySelectorAll('td');
        if(tds.length>=3){
          const rfid = tds[0].textContent.trim();
          if(rfid===val){ loteFound = tds[2].textContent.trim(); }
        }
      });
      if(loteFound){
        gRfidInput.setAttribute('data-derived-lote', loteFound);
        if(gRfidStatus) gRfidStatus.textContent = 'Lote detectado: '+loteFound;
      } else {
        gRfidInput.removeAttribute('data-derived-lote');
        if(gRfidStatus) gRfidStatus.textContent = 'RFID no encontrada o sin lote.';
      }
    } else {
      gRfidInput.removeAttribute('data-derived-lote');
      if(gRfidStatus) gRfidStatus.textContent = '';
    }
  });

  // Item timer actions (event delegation on both tables)
  function onTableClick(e){
    const t = e.target; if(!(t instanceof Element)) return;
    const startR = t.closest('[data-item-start]');
    const clearR = t.closest('[data-item-clear]');
  const restartR = t.closest('[data-item-restart]');
  // const bodegaR = t.closest('[data-item-bodega]');
    if(startR){
      const rfid = startR.getAttribute('data-item-start');
      const section = startR.getAttribute('data-section');
      // Reuse modal for per-item
      pendingItemStart = { section, rfid };
      currentSectionForModal = section;
      if(gSectionLabel) gSectionLabel.textContent = '1 TIC seleccionado';
      if(gMsg) gMsg.textContent = '';
  if(gLote) gLote.value = '';
  if(gHr) gHr.value = '';
  if(gMin) gMin.value = '';
      clearGroupDefaultHint();
      gDlg?.showModal?.();
      applyGroupTimerDefaults(false);
      setTimeout(()=>gLote?.focus?.(), 50);
    } else if(clearR){
      const rfid = clearR.getAttribute('data-item-clear');
      const section = clearR.getAttribute('data-section');
      fetch('/operacion/preacond/item-timer/clear', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ section, rfid }) })
        .then(()=>loadData());
    } else if(restartR){
      // Clear lote and timer state, then open modal to start again
      const rfid = restartR.getAttribute('data-item-restart');
      const section = restartR.getAttribute('data-section');
      fetch('/operacion/preacond/item-timer/clear', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ section, rfid }) })
        .then(()=>{
          pendingItemStart = { section, rfid };
          currentSectionForModal = section;
          if(gSectionLabel) gSectionLabel.textContent = '1 TIC seleccionado';
          if(gMsg) gMsg.textContent = '';
          if(gLote) gLote.value = '';
          if(gHr) gHr.value = '';
          if(gMin) gMin.value = '';
          clearGroupDefaultHint();
          gDlg?.showModal?.();
          applyGroupTimerDefaults(false);
          setTimeout(()=>gLote?.focus?.(), 50);
        });
    }
  }
  tableCongBody?.addEventListener('click', onTableClick);
  tableAtemBody?.addEventListener('click', onTableClick);
  // Also attach to lot-card containers
  lotesCong?.addEventListener('click', onTableClick);
  lotesAtem?.addEventListener('click', onTableClick);

  // Also primary buttons
  qs('#btn-add-cong')?.addEventListener('click', ()=>openModal('congelamiento'));
  qs('#btn-add-atem')?.addEventListener('click', ()=>openModal('atemperamiento'));
  dlg?.addEventListener?.('close', ()=>{
    resetScanTimerHint();
    if(scanTimerHr) scanTimerHr.value = '';
    if(scanTimerMin) scanTimerMin.value = '';
    pendingScanAutoBuckets = null;
    preserveScanHint = false;
  });
  // Limpiar preselección si usuario cierra modal sin confirmar
  gDlg?.addEventListener?.('close', ()=>{
    preselectedRfids=null;
    gModesBox?.classList.remove('hidden');
    clearGroupDefaultHint();
  });

  // Default: show grid view; allow switching to list and back
  function setView(mode){
    const showGrid = mode==='grid';
    wrapGridCong?.classList.toggle('hidden', !showGrid);
    wrapGridAtem?.classList.toggle('hidden', !showGrid);
    wrapListCong?.classList.toggle('hidden', showGrid);
    wrapListAtem?.classList.toggle('hidden', showGrid);
    btnViewGrid?.classList.toggle('btn-active', showGrid);
    btnViewList?.classList.toggle('btn-active', !showGrid);
    try{ localStorage.setItem('preacondViewMode', mode); }catch{}
  }
  btnViewGrid?.addEventListener('click', ()=>setView('grid'));
  btnViewList?.addEventListener('click', ()=>setView('list'));
  // Initialize view
  let initialMode = 'grid';
  try{ const s = localStorage.getItem('preacondViewMode'); if(s==='grid'||s==='list') initialMode=s; }catch{}
  setView(initialMode);

  renderInitialLoading();
  loadData();

  // Client-side filtering con soporte multi-RFID (24 chars) y debounce
  function parseRfids(raw){
    const s = String(raw||'').toUpperCase().replace(/\s+/g,'');
    const out = [];
    for(let i=0;i+24<=s.length;i+=24){ out.push(s.slice(i,i+24)); }
    // fallback: capturar 24 alfanum continuos si vienen con separadores
    const rx=/[A-Z0-9]{24}/g; let m; while((m=rx.exec(s))){ const c=m[0]; if(!out.includes(c)) out.push(c); }
    return out;
  }
  function applyFilter(inputEl, tbody, countEl){
    const raw = (inputEl?.value||'');
    const rfids = parseRfids(raw);
    const q = raw.trim().toLowerCase();
    const trs = Array.from(tbody?.querySelectorAll('tr')||[]);
    let visible = 0, total = 0;
    const set = new Set(rfids);
    const multi = rfids.length > 1;
    // Si multi, forzar vista de lista para visualizar filtros por RFID
    try{ if(multi && typeof setView==='function'){ setView('list'); } }catch{}
    trs.forEach(tr=>{
      const tds = tr.querySelectorAll('td');
      if(!tds || tds.length===1){
        tr.style.display = (q? 'none' : '');
        return;
      }
      total++;
      let show=false;
      if(multi){
        const code = (tds[0]?.textContent||'').trim().toUpperCase();
        show = set.has(code);
      } else {
        const hay = Array.from(tds).slice(0,4).map(td=>td.textContent||'').join(' ').toLowerCase();
        show = !q || hay.includes(q);
      }
      tr.style.display = show? '' : 'none';
      if(show) visible++;
    });
    if(countEl){
      const text = countEl.textContent||'';
      const m = text.match(/\((\d+) de (\d+)\)/);
      const totalCount = m? Number(m[2]) : total;
      countEl.textContent = `(${visible} de ${totalCount})`;
    }
  }
  let _fltTimer=0;
  function scheduleFilter(inputEl, tbody, countEl){ if(_fltTimer){ clearTimeout(_fltTimer); } _fltTimer=setTimeout(()=>{ _fltTimer=0; applyFilter(inputEl, tbody, countEl); }, 120); }
  searchCong?.addEventListener('input', ()=>scheduleFilter(searchCong, tableCongBody, countCong));
  searchAtem?.addEventListener('input', ()=>scheduleFilter(searchAtem, tableAtemBody, countAtem));
  searchCong?.addEventListener('paste', (e)=>{ const t=e.clipboardData?.getData('text')||''; if(t){ e.preventDefault(); searchCong.value = (searchCong.value||'') + t; scheduleFilter(searchCong, tableCongBody, countCong); } });
  searchAtem?.addEventListener('paste', (e)=>{ const t=e.clipboardData?.getData('text')||''; if(t){ e.preventDefault(); searchAtem.value = (searchAtem.value||'') + t; scheduleFilter(searchAtem, tableAtemBody, countAtem); } });
  const preventEnter = (ev)=>{ const k=ev.key||ev.code; if(k==='Enter'||k==='NumpadEnter'){ ev.preventDefault(); ev.stopPropagation(); scheduleFilter(ev.target===searchCong?searchCong:searchAtem, ev.target===searchCong?tableCongBody:tableAtemBody, ev.target===searchCong?countCong:countAtem); } };
  searchCong?.addEventListener('keydown', preventEnter);
  searchAtem?.addEventListener('keydown', preventEnter);
})();
