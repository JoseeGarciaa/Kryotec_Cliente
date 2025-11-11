// Traslado manual de piezas entre sedes
(function(){
  'use strict';

  function parseRfids(raw){
    const original = String(raw || '').toUpperCase();
    const s = original.replace(/\s+/g, '');
    const out = [];
    for(let i=0;i+24<=s.length;i+=24){ out.push(s.slice(i, i+24)); }
    const rx = /[A-Z0-9]{24}/g;
    let m;
    while((m = rx.exec(s))){ const code = m[0]; if(!out.includes(code)) out.push(code); }
    return out;
  }

  function buildDefaultSedePrompt(payload){
    if(payload && typeof payload.confirm === 'string' && payload.confirm.trim()) return payload.confirm;
    if(payload && typeof payload.error === 'string' && payload.error.trim()) return payload.error;
    return 'Las piezas seleccionadas pertenecen a otra sede. ¿Deseas trasladarlas a tu sede actual?';
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

  const scanInput = document.getElementById('tras-scan');
  const listEl = document.getElementById('tras-list');
  const msgEl = document.getElementById('tras-msg');
  const processBtn = document.getElementById('tras-process');
  const clearBtn = document.getElementById('tras-clear');
  const clearDoneBtn = document.getElementById('tras-clear-done');
  const countEl = document.getElementById('tras-count');
  const hintEl = document.getElementById('tras-hint');

  const queue = [];
  let buffer = '';

  function updateCount(){ if(countEl){ countEl.textContent = queue.length ? `(${queue.length})` : ''; } }

  function renderQueue(){
    if(!listEl) return;
    if(!queue.length){
      listEl.innerHTML = '<div class="border border-dashed border-base-300/60 rounded-lg p-4 text-center text-[11px] opacity-60">Sin RFIDs en cola.</div>';
      updateCount();
      return;
    }
    listEl.innerHTML = queue.map((entry)=>{
      let badgeClass = 'badge-neutral';
      let badgeText = 'Pendiente';
      if(entry.status === 'processing'){ badgeClass = 'badge-info'; badgeText = 'Procesando'; }
      else if(entry.status === 'done'){ badgeClass = 'badge-success'; badgeText = 'Trasladada'; }
      else if(entry.status === 'error'){ badgeClass = 'badge-error'; badgeText = 'Error'; }
      const message = entry.message ? `<div class="text-[10px] opacity-70">${entry.message}</div>` : '';
      return `<div class="border border-base-300/50 rounded-lg p-3 bg-base-200/10 flex flex-col gap-1" data-code="${entry.code}">
        <div class="flex items-center justify-between gap-2">
          <span class="font-mono text-xs break-all">${entry.code}</span>
          <div class="flex items-center gap-2">
            <span class="badge badge-xs ${badgeClass}">${badgeText}</span>
            <button type="button" class="btn btn-ghost btn-xs" data-remove="${entry.code}" title="Quitar">✕</button>
          </div>
        </div>
        ${message}
      </div>`;
    }).join('');
    updateCount();
  }

  function addCodes(codes){
    if(!Array.isArray(codes) || !codes.length) return;
    let added = 0;
    let duplicates = 0;
    codes.forEach(code => {
      const normalized = String(code || '').toUpperCase();
      if(!/^[A-Z0-9]{24}$/.test(normalized)) return;
      if(queue.some(entry => entry.code === normalized)){
        duplicates++;
        return;
      }
      queue.push({ code: normalized, status: 'pending', message: '' });
      added++;
    });
    if(msgEl){
      const parts = [];
      if(added){ parts.push(`Añadidos ${added}`); }
      if(duplicates){ parts.push(`Duplicados ${duplicates}`); }
      msgEl.textContent = parts.join('. ');
    }
    renderQueue();
  }

  function setHint(text){ if(hintEl){ hintEl.textContent = text; } }

  function resetHint(){ if(hintEl){ hintEl.textContent = 'Los RFIDs válidos se detectan automáticamente. El campo muestra cuántos caracteres faltan cuando quedan códigos incompletos.'; } }

  function clearQueue(){ queue.length = 0; renderQueue(); if(msgEl) msgEl.textContent = ''; buffer = ''; if(scanInput) scanInput.value = ''; resetHint(); }

  scanInput?.addEventListener('input', () => {
    if (!scanInput) return;
    let raw = String(scanInput.value || '').toUpperCase();
    raw = raw.replace(/[^A-Z0-9]/g, '');
    buffer = raw;
    const tokens = [];
    while (buffer.length >= 24) {
      tokens.push(buffer.slice(0, 24));
      buffer = buffer.slice(24);
    }
    if (tokens.length) addCodes(tokens);
    scanInput.value = buffer;
    if (buffer.length) {
      setHint(`Código incompleto: faltan ${24 - buffer.length} caracteres.`);
    } else {
      resetHint();
    }
  });

  scanInput?.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){
      e.preventDefault();
      if (buffer.length === 24) {
        addCodes([buffer]);
        buffer = '';
        if (scanInput) scanInput.value = '';
        resetHint();
      }
    } else if(e.key === 'Escape'){
      buffer=''; if(scanInput) scanInput.value=''; resetHint();
    }
  });

  scanInput?.addEventListener('paste', (e)=>{
    const text = e.clipboardData?.getData('text') || '';
    if(!text) return;
    e.preventDefault();
    const tokens = parseRfids(text);
    if(tokens.length){ addCodes(tokens); }
    buffer=''; if(scanInput) scanInput.value=''; resetHint();
  });

  document.addEventListener('click', (e)=>{
    const target = e.target instanceof HTMLElement ? e.target : null;
    if(!target) return;
    const removeBtn = target.closest('[data-remove]');
    if(removeBtn){
      const code = removeBtn.getAttribute('data-remove');
      if(code){
        const idx = queue.findIndex(entry => entry.code === code);
        if(idx>=0){ queue.splice(idx,1); renderQueue(); if(msgEl) msgEl.textContent = ''; }
      }
    }
  });

  clearBtn?.addEventListener('click', ()=> clearQueue());
  clearDoneBtn?.addEventListener('click', ()=>{
    const before = queue.length;
    for(let i=queue.length-1;i>=0;i--){ if(queue[i].status === 'done'){ queue.splice(i,1); } }
    if(queue.length !== before){ renderQueue(); if(msgEl) msgEl.textContent = 'Se limpiaron los registros completados.'; }
  });

  processBtn?.addEventListener('click', async ()=>{
    if(!queue.length){ if(msgEl) msgEl.textContent = 'No hay RFIDs en la cola.'; return; }
    const candidates = queue.filter(entry => entry.status === 'pending' || entry.status === 'error');
    if(!candidates.length){ if(msgEl) msgEl.textContent = 'Todos los RFIDs ya fueron procesados.'; return; }
    processBtn.disabled = true;
    candidates.forEach(entry => { entry.status = 'processing'; entry.message = ''; });
    renderQueue();
    if(msgEl) msgEl.textContent = 'Trasladando piezas...';
    try {
      const rfids = candidates.map(entry => entry.code);
  const attempt = await postJSONWithSedeTransfer('/traslado/apply', { rfids }, {
        promptMessage: (payload) => payload?.confirm || payload?.error || 'Las piezas seleccionadas pertenecen a otra sede. ¿Deseas trasladarlas a tu sede actual?'
      });
      if(attempt.cancelled){
        candidates.forEach(entry => { entry.status = 'pending'; entry.message = 'Operación cancelada.'; });
        if(msgEl) msgEl.textContent = 'Operación cancelada por el usuario.';
        renderQueue();
        return;
      }
      const payload = attempt.data || {};
      if(!attempt.httpOk || payload.ok === false){
        const message = payload.error || payload.message || `Error (${attempt.status || 0})`;
        candidates.forEach(entry => { entry.status = 'error'; entry.message = message; });
        if(msgEl) msgEl.textContent = message;
        renderQueue();
        return;
      }
      const movedMap = new Map((payload.moved || []).map(item => [String(item.rfid || '').toUpperCase(), item]));
      const alreadyMap = new Map((payload.already || []).map(item => [String(item.rfid || '').toUpperCase(), item]));
      const missingSet = new Set((payload.not_found || []).map(r => String(r || '').toUpperCase()));
      const errorMap = new Map((payload.errors || []).map(err => [String(err.rfid || '').toUpperCase(), err.message || err.error || 'Error']));
      queue.forEach(entry => {
        const key = entry.code;
        if(movedMap.has(key)){
          entry.status = 'done';
          const info = movedMap.get(key) || {};
          const details = [];
          if(info.prev_sede_id !== undefined && info.prev_sede_id !== null){ details.push(`de sede ${info.prev_sede_id}`); }
          if(info.prev_estado){ details.push(`estado ${info.prev_estado}`); }
          entry.message = details.length ? `Trasladada ${details.join(', ')}` : 'Trasladada';
        } else if(alreadyMap.has(key)){
          entry.status = 'done';
          entry.message = 'Ya estaba en tu sede en &quot;En bodega&quot;.';
        } else if(missingSet.has(key)){
          entry.status = 'error';
          entry.message = 'RFID no encontrado';
        } else if(errorMap.has(key)){
          entry.status = 'error';
          entry.message = errorMap.get(key);
        } else if(entry.status === 'processing'){
          entry.status = 'error';
          entry.message = 'Sin respuesta del servidor';
        }
      });
      const movedCount = Array.isArray(payload.moved) ? payload.moved.length : 0;
      const alreadyCount = Array.isArray(payload.already) ? payload.already.length : 0;
      const missingCount = Array.isArray(payload.not_found) ? payload.not_found.length : 0;
      const errorCount = Array.isArray(payload.errors) ? payload.errors.length : 0;
      if(msgEl){
        msgEl.textContent = `Trasladadas ${movedCount}. Sin cambios ${alreadyCount}. No encontradas ${missingCount}. Errores ${errorCount}.`;
      }
      renderQueue();
    } catch(err){
      const message = err?.message || 'Error inesperado al trasladar';
      candidates.forEach(entry => { entry.status = 'error'; entry.message = message; });
      if(msgEl) msgEl.textContent = message;
      renderQueue();
    } finally {
      processBtn.disabled = false;
    }
  });

  renderQueue();
})();
