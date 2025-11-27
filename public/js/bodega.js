// Lógica de la vista Bodega (externo para cumplir CSP)
(function(){
  const tbody = document.querySelector('#tabla-bodega tbody');
  if(!tbody) return; // vista no presente

  const cardsWrap = document.getElementById('bodega-cards');
  const infoTotal = document.getElementById('info-total');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');
  const pageIndicator = document.getElementById('page-indicator');
  const limitSelect = document.getElementById('bodega-limit');
  const form = document.getElementById('form-filtros');

  const openModalBtn = document.getElementById('btn-open-devolucion');
  const devolDialog = document.getElementById('modal-bodega-devolucion');
  const devolScanInput = document.getElementById('devolucion-scan');
  const devolCloseBtn = document.getElementById('devolucion-close');
  const devolClearBtn = document.getElementById('devolucion-clear');
  const devolSubmitBtn = document.getElementById('devolucion-submit');
  const devolQueueEl = document.getElementById('devolucion-queue');
  const devolEmptyEl = document.getElementById('devolucion-empty');
  const devolCountEl = document.getElementById('devolucion-count');
  const devolSummaryEl = document.getElementById('devolucion-summary');
  const devolResultEl = document.getElementById('devolucion-result');

  const LIMIT_OPTIONS = [5, 10, 15, 20];
  const MAX_DEVOL_CODES = 400;
  const SUMMARY_TONES = ['text-success','text-error','text-warning','text-info'];

  let page = 1;
  let limit = limitSelect ? Number(limitSelect.value) : 10;
  if(!Number.isFinite(limit) || limit <= 0){ limit = 10; }
  let _loadTimer = 0;

  const devolQueue = [];
  const devolQueueSet = new Set();
  const devolQueueInfo = new Map();

  function setDevolucionSummary(message, tone){
    if(!devolSummaryEl) return;
    devolSummaryEl.textContent = message || '';
    SUMMARY_TONES.forEach(cls => devolSummaryEl.classList.remove(cls));
    if(!tone) return;
    if(tone === 'success'){ devolSummaryEl.classList.add('text-success'); }
    else if(tone === 'error'){ devolSummaryEl.classList.add('text-error'); }
    else if(tone === 'warning'){ devolSummaryEl.classList.add('text-warning'); }
    else if(tone === 'info'){ devolSummaryEl.classList.add('text-info'); }
  }

  function renderDevolucionResult(payload){
    if(!devolResultEl) return;
    if(!payload){
      devolResultEl.innerHTML = '';
      return;
    }
    const { devolved = [], invalid = [], not_found = [], duplicates = [] } = payload;
    const blocks = [];
    if(devolved.length){
      const list = devolved.slice(0, 40).map(item => {
        const prevEstado = typeof item.prev_estado === 'string' && item.prev_estado.trim() ? item.prev_estado.trim() : '-';
        const prevSub = typeof item.prev_sub_estado === 'string' && item.prev_sub_estado.trim() ? ` · ${item.prev_sub_estado.trim()}` : '';
        return `<div class="flex items-center justify-between gap-2"><code class="font-mono text-[11px]">${item.rfid}</code><span class="text-[10px] opacity-70">${prevEstado}${prevSub}</span></div>`;
      }).join('');
      const remaining = devolved.length > 40 ? `<div class="text-[10px] opacity-60">${devolved.length - 40} adicionales...</div>` : '';
      blocks.push(`<div class="rounded-lg border border-base-300/70 bg-base-200/40 p-3 space-y-1"><div class="text-xs font-semibold text-success">Devueltas (${devolved.length})</div>${list}${remaining}</div>`);
    }
    if(invalid.length){
      const list = invalid.slice(0, 40).map(item => {
        const msg = typeof item.message === 'string' && item.message.trim() ? item.message.trim() : 'Estado no permitido.';
        return `<div class="flex flex-col gap-0.5"><code class="font-mono text-[11px]">${item.rfid}</code><span class="text-[10px] opacity-70">${msg}</span></div>`;
      }).join('');
      const remaining = invalid.length > 40 ? `<div class="text-[10px] opacity-60">${invalid.length - 40} adicionales...</div>` : '';
      blocks.push(`<div class="rounded-lg border border-base-300/70 bg-base-200/20 p-3 space-y-1"><div class="text-xs font-semibold text-error">Omitidas (${invalid.length})</div>${list}${remaining}</div>`);
    }
    if(not_found.length){
      const list = not_found.slice(0, 40).map(code => `<code class="font-mono text-[11px]">${code}</code>`).join(' ');
      const remaining = not_found.length > 40 ? ` <span class="text-[10px] opacity-60">+${not_found.length - 40}</span>` : '';
      blocks.push(`<div class="rounded-lg border border-base-300/70 bg-base-200/10 p-3 space-y-1"><div class="text-xs font-semibold text-warning">No encontrados (${not_found.length})</div><div class="flex flex-wrap gap-1">${list}</div>${remaining}</div>`);
    }
    if(duplicates.length){
      const list = duplicates.slice(0, 40).map(code => `<code class="font-mono text-[11px]">${code}</code>`).join(' ');
      const remaining = duplicates.length > 40 ? ` <span class="text-[10px] opacity-60">+${duplicates.length - 40}</span>` : '';
      blocks.push(`<div class="rounded-lg border border-base-300/70 bg-base-200/10 p-3 space-y-1"><div class="text-xs font-semibold text-info">Duplicados (${duplicates.length})</div><div class="flex flex-wrap gap-1">${list}</div>${remaining}</div>`);
    }
    devolResultEl.innerHTML = blocks.length ? blocks.join('') : '<div class="text-[11px] opacity-60">Sin resultados para mostrar.</div>';
  }

  function syncLimitSelect(value){
    if(!(limitSelect instanceof HTMLSelectElement)) return;
    if(!LIMIT_OPTIONS.includes(value)){
      const opt = document.createElement('option');
      opt.value = String(value);
      opt.textContent = String(value);
      limitSelect.appendChild(opt);
    }
    limitSelect.value = String(value);
  }

  function setButtonState(btn, disabled){
    if(!(btn instanceof HTMLButtonElement)) return;
    btn.disabled = disabled;
    btn.classList.toggle('btn-disabled', disabled);
  }

  // Extrae RFIDs de 24 chars del texto (soporta ráfagas pegadas por la pistola)
  function parseRfids(raw){
    const s = String(raw||'').toUpperCase().replace(/\s+/g,'');
    const out = [];
    for(let i=0;i+24<=s.length;i+=24){ out.push(s.slice(i,i+24)); }
    const rx = /[A-Z0-9]{24}/g; let m;
    while((m = rx.exec(s))){ const c=m[0]; if(!out.includes(c)) out.push(c); }
    return out;
  }

  function scheduleLoad(){
    if(_loadTimer){ clearTimeout(_loadTimer); }
    _loadTimer = setTimeout(()=>{ _loadTimer = 0; page = 1; load(); }, 140);
  }

  function renderCards(items){
    if(!cardsWrap) return;
    if(!items.length){
      cardsWrap.innerHTML = '<div class="col-span-full text-center text-xs opacity-60 py-6">Sin items en bodega</div>';
      return;
    }
    cardsWrap.innerHTML = items.map(r => {
      const fecha = r.fecha_ingreso ? new Date(r.fecha_ingreso).toLocaleDateString('es-CO',{ day:'2-digit', month:'2-digit', year:'2-digit'}) : '-';
      return `<div class="rounded-lg border border-base-300/50 bg-base-100/70 p-3 flex flex-col gap-2 shadow-sm">
        <div class="flex items-center justify-between text-[10px] uppercase tracking-wide opacity-60">
          <span>${r.categoria}</span><span class="font-mono">${fecha}</span>
        </div>
        <code class="block text-[11px] break-all font-mono">${r.rfid}</code>
        <div class="text-xs font-semibold truncate">${r.nombre_unidad||'-'}</div>
        <div class="flex items-center justify-between text-[10px] opacity-70">
          <span>${r.lote||'-'}</span>
          <span class="badge badge-outline badge-xs">${r.sub_estado||'-'}</span>
        </div>
      </div>`;
    }).join('');
  }

  function renderDevolucionQueue(){
    if(!devolQueueEl) return;
    if(!devolQueue.length){
      devolQueueEl.innerHTML = '';
      if(devolEmptyEl) devolEmptyEl.classList.remove('hidden');
    } else {
      devolQueueEl.innerHTML = devolQueue.map(code => {
        const info = devolQueueInfo.has(code) ? devolQueueInfo.get(code) : undefined;
        const name = info === undefined
          ? 'Cargando nombre…'
          : info === null
            ? 'No encontrado'
            : (info.nombre_unidad && info.nombre_unidad.trim())
              ? info.nombre_unidad.trim()
              : (info.nombre_modelo && info.nombre_modelo.trim())
                ? info.nombre_modelo.trim()
                : 'Sin nombre';
        const lote = info && info !== null && info.lote ? info.lote : '';
        const meta = lote ? `<span class="text-[10px] opacity-60">${lote}</span>` : '';
        return `
          <div class="flex items-center justify-between gap-3 rounded-lg border border-base-300/60 bg-base-100/70 px-3 py-2" data-code="${code}">
            <div class="flex flex-col leading-tight">
              <span class="text-xs font-semibold truncate">${name}</span>
              <code class="font-mono text-[11px]">${code}</code>
              ${meta}
            </div>
            <button type="button" class="btn btn-ghost btn-xs" data-remove="${code}" title="Quitar">✕</button>
          </div>
        `;
      }).join('');
      if(devolEmptyEl) devolEmptyEl.classList.add('hidden');
    }
    if(devolCountEl) devolCountEl.textContent = String(devolQueue.length);
  }

  function clearDevolucionQueue(){
    devolQueue.length = 0;
    devolQueueSet.clear();
    devolQueueInfo.clear();
    renderDevolucionQueue();
  }

  function removeFromDevolucionQueue(code){
    if(!code) return;
    const normalized = String(code).toUpperCase();
    if(!devolQueueSet.has(normalized)) return;
    devolQueueSet.delete(normalized);
    const idx = devolQueue.indexOf(normalized);
    if(idx >= 0) devolQueue.splice(idx, 1);
    devolQueueInfo.delete(normalized);
    renderDevolucionQueue();
  }

  function addCodes(codes){
    let added = 0;
    let duplicates = 0;
    let overflow = false;
    const addedCodes = [];
    for(const code of codes){
      if(devolQueueSet.has(code)){
        duplicates++;
        continue;
      }
      if(devolQueue.length >= MAX_DEVOL_CODES){
        overflow = true;
        break;
      }
      devolQueue.push(code);
      devolQueueSet.add(code);
      added++;
      addedCodes.push(code);
    }
    return { added, duplicates, overflow, addedCodes };
  }

  async function hydrateQueueInfo(codes){
    if(!codes || !codes.length) return;
    const pending = codes.filter(code => !devolQueueInfo.has(code));
    if(!pending.length) return;
    try {
      const requests = pending.map(code => fetch(`/operacion/bodega/data?lookup=1&q=${encodeURIComponent(code)}&page=1&limit=1`)
        .then(res => res.ok ? res.json() : null)
        .then(payload => {
          if(payload && payload.ok && Array.isArray(payload.items) && payload.items.length){
            devolQueueInfo.set(code, payload.items[0]);
          } else {
            devolQueueInfo.set(code, null);
          }
        })
        .catch(err => {
          console.error('[bodega][hydrate]', code, err);
          devolQueueInfo.set(code, null);
        }));
      await Promise.all(requests);
    } finally {
      renderDevolucionQueue();
    }
  }

  function handleScan(raw){
    const codes = parseRfids(raw);
    if(!codes.length){
      setDevolucionSummary('No se detectaron RFIDs válidos.', 'warning');
      return;
    }
    const { added, duplicates, overflow, addedCodes } = addCodes(codes);
    const parts = [];
    let tone = 'info';
    if(added){
      parts.push(`${added} RFID${added === 1 ? '' : 's'} agregado${added === 1 ? '' : 's'}`);
      tone = 'success';
    }
    if(duplicates){
      parts.push(`${duplicates} duplicado${duplicates === 1 ? '' : 's'} omitido${duplicates === 1 ? '' : 's'}`);
      if(!added) tone = 'warning';
    }
    if(!added && !duplicates){
      parts.push('Sin cambios.');
      tone = 'info';
    }
    if(overflow){
      parts.push('Límite de 400 piezas alcanzado.');
      tone = 'warning';
    }
    setDevolucionSummary(parts.join(' · '), tone);
    renderDevolucionQueue();
    if(addedCodes && addedCodes.length){
      hydrateQueueInfo(addedCodes);
    }
  }

  function consumeScanInput(){
    if(!devolScanInput) return;
    const value = devolScanInput.value;
    if(!value) return;
    handleScan(value);
    devolScanInput.value = '';
  }

  function openDevolucionModal(){
    if(!devolDialog || typeof devolDialog.showModal !== 'function') return;
    setDevolucionSummary('', null);
    devolDialog.showModal();
    if(devolScanInput){
      devolScanInput.value = '';
      setTimeout(() => devolScanInput.focus(), 60);
    }
  }

  function closeDevolucionModal(){
    if(devolDialog && typeof devolDialog.close === 'function'){
      devolDialog.close();
    }
  }

  async function submitDevolucion(){
    if(!(devolSubmitBtn instanceof HTMLButtonElement)) return;
    if(!devolQueue.length){
      setDevolucionSummary('Agrega al menos un RFID antes de devolver.', 'error');
      return;
    }
    setButtonState(devolSubmitBtn, true);
    setDevolucionSummary(`Procesando ${devolQueue.length} pieza${devolQueue.length === 1 ? '' : 's'}...`, 'info');
    renderDevolucionResult(null);
    try {
      const res = await fetch('/operacion/bodega/devolucion', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ rfids: devolQueue.slice(0, MAX_DEVOL_CODES) })
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if(!res.ok || !data || data.ok === false){
        const message = (data && (data.error || data.message)) ? (data.error || data.message) : `Error (${res.status})`;
        setDevolucionSummary(message, 'error');
        if(data) renderDevolucionResult(data);
        return;
      }
      const { devolved = [], invalid = [], not_found = [], duplicates = [] } = data;
      const parts = [];
      if(devolved.length) parts.push(`${devolved.length} devueltas`);
      if(invalid.length) parts.push(`${invalid.length} omitidas`);
      if(not_found.length) parts.push(`${not_found.length} sin coincidencia`);
      if(duplicates.length) parts.push(`${duplicates.length} duplicadas`);
      setDevolucionSummary(parts.length ? parts.join(' · ') : 'Sin cambios.', devolved.length ? 'success' : (invalid.length || not_found.length ? 'warning' : 'info'));
      renderDevolucionResult(data);
      if(devolved.length){
        clearDevolucionQueue();
      }
      await load();
    } catch(err){
      console.error(err);
      setDevolucionSummary(err?.message || 'Error de red.', 'error');
    } finally {
      setButtonState(devolSubmitBtn, false);
    }
  }

  async function load(){
    const qEl = document.getElementById('f-q');
    const catEl = document.getElementById('f-cat');
    const q = qEl ? qEl.value.trim() : '';
    const cat = catEl ? catEl.value : '';
    const rfids = parseRfids(q);
    const multiMode = rfids.length > 1;
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if(!multiMode && q) params.set('q', q);
    if(cat) params.set('cat', cat);

    tbody.innerHTML = '<tr><td colspan="6" class="text-center"><span class="loading loading-spinner loading-xs"></span> Cargando...</td></tr>';
    if(cardsWrap) cardsWrap.innerHTML = '<div class="col-span-full text-center py-6"><span class="loading loading-spinner loading-xs"></span></div>';

    try {
      if(multiMode){
        const catParam = cat ? `&cat=${encodeURIComponent(cat)}` : '';
        const requests = rfids.map(code => fetch(`/operacion/bodega/data?lookup=1&q=${encodeURIComponent(code)}&page=1&limit=1${catParam}`)
          .then(r => r.json()).catch(() => ({ ok:false, items:[] })));
        const responses = await Promise.all(requests);
        const merged = new Map();
        responses.forEach(payload => {
          if(payload && payload.ok && Array.isArray(payload.items)){
            payload.items.forEach(item => {
              const key = String(item.rfid || '').toUpperCase();
              if(rfids.includes(key)) merged.set(key, item);
            });
          }
        });
        const items = Array.from(merged.values());
        if(!items.length){
          tbody.innerHTML = '<tr><td colspan="6" class="text-center text-xs opacity-70">Sin coincidencias para los RFIDs escaneados.</td></tr>';
        } else {
          tbody.innerHTML = items.map(r => `
            <tr>
              <td><code class="text-[10px]">${r.rfid}</code></td>
              <td class="text-xs">${r.nombre_unidad||'-'}</td>
              <td class="text-xs hidden lg:table-cell">${r.lote||'-'}</td>
              <td><span class="badge badge-outline badge-xs">${r.categoria}</span></td>
              <td class="text-xs hidden md:table-cell">${r.sub_estado||'-'}</td>
              <td class="text-[10px] hidden xl:table-cell">${r.fecha_ingreso ? new Date(r.fecha_ingreso).toLocaleString('es-CO') : '-'}</td>
            </tr>`).join('');
        }
        renderCards(items);
        if(infoTotal) infoTotal.textContent = items.length ? `Mostrando 1-${items.length} de ${items.length} resultados` : 'Sin resultados';
        if(pageIndicator) pageIndicator.textContent = 'Página 1 de 1';
        setButtonState(btnPrev, true);
        setButtonState(btnNext, true);
        page = 1;
        return;
      }

      const res = await fetch('/operacion/bodega/data?' + params.toString());
      const data = await res.json();
      if(!data.ok){
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-error">Error</td></tr>';
        return;
      }
      if(data.meta && data.meta.debug){
        console.debug('[bodega] debug', data.meta.debug);
      }
      if(!data.items.length){
        const msg = data.warning ? 'Sin items (' + data.warning + ')' : 'Sin items en bodega (estado exacto "En bodega").';
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-xs opacity-70">${msg}</td></tr>`;
      } else {
        tbody.innerHTML = data.items.map(r => `
          <tr>
            <td><code class="text-[10px]">${r.rfid}</code></td>
            <td class="text-xs">${r.nombre_unidad||'-'}</td>
            <td class="text-xs hidden lg:table-cell">${r.lote||'-'}</td>
            <td><span class="badge badge-outline badge-xs">${r.categoria}</span></td>
            <td class="text-xs hidden md:table-cell">${r.sub_estado||'-'}</td>
            <td class="text-[10px] hidden xl:table-cell">${r.fecha_ingreso ? new Date(r.fecha_ingreso).toLocaleString('es-CO') : '-'}</td>
          </tr>`).join('');
      }
      renderCards(data.items);
      const safeLimit = Number(data.limit) > 0 ? Number(data.limit) : limit;
      const safeTotal = Number.isFinite(Number(data.total)) ? Number(data.total) : 0;
      limit = safeLimit;
      syncLimitSelect(limit);
      const safePage = Math.max(1, Number(data.page) || page);
      const totalPages = safeTotal > 0 ? Math.ceil(safeTotal / safeLimit) : 1;
      const start = safeTotal === 0 || !(data.items||[]).length ? 0 : (safePage - 1) * safeLimit + 1;
      const end = safeTotal === 0 || !(data.items||[]).length ? 0 : Math.min(safeTotal, start + data.items.length - 1);
      if(infoTotal){
        infoTotal.textContent = (safeTotal === 0 || !(data.items||[]).length)
          ? 'Sin resultados'
          : `Mostrando ${start}-${end} de ${safeTotal} resultados`;
      }
      if(pageIndicator){
        pageIndicator.textContent = `Página ${Math.min(safePage, totalPages)} de ${totalPages}`;
      }
      setButtonState(btnPrev, safePage <= 1 || safeTotal === 0);
      setButtonState(btnNext, safePage >= totalPages || safeTotal === 0);
      page = safePage;
    } catch(err){
      console.error(err);
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-error">Error</td></tr>';
    }
  }

  if(btnPrev) btnPrev.addEventListener('click', () => {
    if(btnPrev.disabled) return;
    if(page > 1){ page--; load(); }
  });
  if(btnNext) btnNext.addEventListener('click', () => {
    if(btnNext.disabled) return;
    page++;
    load();
  });
  if(form) form.addEventListener('submit', (e) => { e.preventDefault(); page = 1; load(); });

  const qEl = document.getElementById('f-q');
  if(qEl){
    qEl.addEventListener('input', () => { scheduleLoad(); });
    qEl.addEventListener('paste', (e) => {
      const t = e.clipboardData?.getData('text') || '';
      if(t){
        e.preventDefault();
        qEl.value = (qEl.value || '') + t;
        scheduleLoad();
      }
    });
    qEl.addEventListener('keydown', (e) => {
      if(e.key === 'Enter'){
        e.preventDefault();
        scheduleLoad();
      }
    });
  }

  const btnClear = document.getElementById('btn-clear');
  if(btnClear){
    btnClear.addEventListener('click', () => {
      const queryEl = document.getElementById('f-q');
      const catEl = document.getElementById('f-cat');
      if(queryEl) queryEl.value = '';
      if(catEl) catEl.value = '';
      page = 1;
      load();
      if(queryEl) queryEl.focus();
    });
  }

  if(limitSelect){
    limitSelect.addEventListener('change', () => {
      const value = Number(limitSelect.value);
      if(Number.isFinite(value) && value > 0){
        limit = value;
        page = 1;
        load();
      }
    });
  }

  if(openModalBtn){
    openModalBtn.addEventListener('click', openDevolucionModal);
  }
  if(devolCloseBtn){
    devolCloseBtn.addEventListener('click', (event) => {
      event.preventDefault();
      closeDevolucionModal();
    });
  }
  if(devolDialog){
    devolDialog.addEventListener('close', () => {
      if(devolScanInput) devolScanInput.value = '';
    });
  }
  if(devolClearBtn){
    devolClearBtn.addEventListener('click', () => {
      clearDevolucionQueue();
      setDevolucionSummary('Lista vacía.', 'info');
    });
  }
  if(devolSubmitBtn){
    devolSubmitBtn.addEventListener('click', submitDevolucion);
  }
  if(devolQueueEl){
    devolQueueEl.addEventListener('click', (event) => {
      const target = event.target instanceof HTMLElement ? event.target.closest('button[data-remove]') : null;
      if(!target) return;
      const code = target.getAttribute('data-remove');
      if(code){
        removeFromDevolucionQueue(code);
        setDevolucionSummary('Elemento eliminado de la lista.', 'info');
      }
    });
  }
  if(devolScanInput){
    devolScanInput.addEventListener('input', () => {
      const raw = devolScanInput.value.replace(/\s+/g, '');
      if(raw.length >= 24){
        consumeScanInput();
      }
    });
    devolScanInput.addEventListener('keydown', (event) => {
      if(event.key === 'Enter'){
        event.preventDefault();
        consumeScanInput();
      }
    });
    devolScanInput.addEventListener('paste', () => {
      setTimeout(consumeScanInput, 0);
    });
  }

  syncLimitSelect(limit);
  renderDevolucionQueue();
  load();

  window.bodegaDiag = () => console.table((window).__bodegaEstados || []);
})();
