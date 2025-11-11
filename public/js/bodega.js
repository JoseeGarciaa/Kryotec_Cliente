// Lógica de la vista Bodega (externo para cumplir CSP)
(function(){
  const tbody = document.querySelector('#tabla-bodega tbody');
  const cardsWrap = document.getElementById('bodega-cards');
  if(!tbody) return; // vista no presente
  const infoTotal = document.getElementById('info-total');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');
  const pageIndicator = document.getElementById('page-indicator');
  const limitSelect = document.getElementById('bodega-limit');
  const form = document.getElementById('form-filtros');
  const LIMIT_OPTIONS = [5, 10, 15, 20];
  let page = 1;
  let limit = limitSelect ? Number(limitSelect.value) : 10;
  if(!Number.isFinite(limit) || limit <= 0){ limit = 10; }
  let _loadTimer = 0;

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
    // También captura posibles separadores variados (fallback)
    const rx = /[A-Z0-9]{24}/g; let m;
    while((m = rx.exec(s))){ const c=m[0]; if(!out.includes(c)) out.push(c); }
    return out;
  }
  function scheduleLoad(){ if(_loadTimer){ clearTimeout(_loadTimer); } _loadTimer = setTimeout(()=>{ _loadTimer=0; page=1; load(); }, 140); }
  function renderCards(items){
    if(!cardsWrap) return;
    if(!items.length){
      cardsWrap.innerHTML = '<div class="col-span-full text-center text-xs opacity-60 py-6">Sin items en bodega</div>';
      return;
    }
    cardsWrap.innerHTML = items.map(r=>{
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

  async function load(){
    const qEl = document.getElementById('f-q');
    const catEl = document.getElementById('f-cat');
    const q = qEl ? qEl.value.trim() : '';
    const cat = catEl ? catEl.value : '';
    const rfids = parseRfids(q);
    const multiMode = rfids.length > 1; // modo multi escaneo activo
  const params = new URLSearchParams({ page:String(page), limit:String(limit) });
    if(!multiMode && q) params.set('q', q);
    if(cat) params.set('cat', cat);
  tbody.innerHTML = '<tr><td colspan="6" class="text-center"><span class="loading loading-spinner loading-xs"></span> Cargando...</td></tr>';
    if(cardsWrap) cardsWrap.innerHTML = '<div class="col-span-full text-center py-6"><span class="loading loading-spinner loading-xs"></span></div>';
    try {
      if(multiMode){
        // Buscar por cada RFID de forma individual y consolidar resultados únicos
        const catParam = cat ? `&cat=${encodeURIComponent(cat)}` : '';
        const promises = rfids.map(code => fetch(`/operacion/bodega/data?q=${encodeURIComponent(code)}&page=1&limit=1${catParam}`)
          .then(r=>r.json()).catch(()=>({ ok:false, items:[] })));
        const results = await Promise.all(promises);
        const mergedMap = new Map();
        results.forEach(d => {
          if(d && d.ok && Array.isArray(d.items)){
            d.items.forEach(it => { if(rfids.includes(String(it.rfid||'').toUpperCase())) mergedMap.set(it.rfid, it); });
          }
        });
        const items = Array.from(mergedMap.values());
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
      } else {
        const res = await fetch('/operacion/bodega/data?'+params.toString());
        const data = await res.json();
        if(!data.ok){
          tbody.innerHTML='<tr><td colspan="6" class="text-center text-error">Error</td></tr>';
          return;
        }
        if(data.meta && data.meta.debug){
          console.debug('[bodega] debug', data.meta.debug);
        }
        if(!data.items.length){
          const msg = data.warning ? 'Sin items ('+data.warning+')' : 'Sin items en bodega (estado exacto "En bodega").';
          tbody.innerHTML = '<tr><td colspan="6" class="text-center text-xs opacity-70">'+msg+'</td></tr>';
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
      }
    } catch(e){
      console.error(e);
  tbody.innerHTML='<tr><td colspan="6" class="text-center text-error">Error</td></tr>';
    }
  }
  if(btnPrev) btnPrev.addEventListener('click', ()=>{
    if(btnPrev.disabled) return;
    if(page>1){ page--; load(); }
  });
  if(btnNext) btnNext.addEventListener('click', ()=>{
    if(btnNext.disabled) return;
    page++; load();
  });
  if(form) form.addEventListener('submit', (e)=>{ e.preventDefault(); page=1; load(); });
  // Auto-búsqueda en ráfagas: input/paste con chunking 24
  const qEl = document.getElementById('f-q');
  if(qEl){
    qEl.addEventListener('input', ()=>{ scheduleLoad(); });
    qEl.addEventListener('paste', (e)=>{ const t=e.clipboardData?.getData('text')||''; if(t){ e.preventDefault(); qEl.value = (qEl.value||'') + t; scheduleLoad(); } });
    // Evitar Enter de la pistola que envía submit directo
    qEl.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); scheduleLoad(); } });
  }
  const btnClear = document.getElementById('btn-clear');
  if(btnClear){
    btnClear.addEventListener('click', ()=>{
      const qEl = document.getElementById('f-q');
      const catEl = document.getElementById('f-cat');
      if(qEl) qEl.value='';
      if(catEl) catEl.value='';
      page=1; load();
      if(qEl) qEl.focus();
    });
  }
  if(limitSelect){
    limitSelect.addEventListener('change', ()=>{
      const value = Number(limitSelect.value);
      if(Number.isFinite(value) && value > 0){
        limit = value;
        page = 1;
        load();
      }
    });
  }
  syncLimitSelect(limit);
  load();
  window.bodegaDiag = () => console.table((window).__bodegaEstados || []);
})();
