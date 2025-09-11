(function(){
  // Runs after DOM is parsed thanks to defer
  const dataEl = document.getElementById('registro-data');
  if(!dataEl) return;

  let modelosByTipo = {};
  let initialRfids = [];
  let initialTipo = '';
  let initialModelo = '';
  try { modelosByTipo = JSON.parse(dataEl.dataset.modelos || '{}'); } catch { modelosByTipo = {}; }
  try { initialRfids = JSON.parse(dataEl.dataset.rfids || '[]'); } catch { initialRfids = []; }
  initialTipo = dataEl.dataset.selectedTipo || '';
  initialModelo = dataEl.dataset.selectedModelo || '';
  let dupRfids = [];
  try { dupRfids = JSON.parse(dataEl.dataset.dups || '[]'); } catch { dupRfids = []; }
  let validationDone = dupRfids.length > 0; // legacy: but los vamos a filtrar

  const tipoEl = document.getElementById('tipo');
  const litrajeEl = document.getElementById('litraje');
  const scanEl = document.getElementById('scan');
  const modeloIdEl = document.getElementById('modelo_id');
  const form = document.getElementById('registro-form');
  const rfidContainer = document.getElementById('rfid-container');
  const rfidList = document.getElementById('rfid-list');
  const dupMsg = document.getElementById('dup-msg');
  const submitBtn = document.getElementById('submit-btn');
  const countEl = document.getElementById('count');
  // Only allow submit when user taps the button explicitly
  let allowExplicitSubmit = false;

  let rfids = Array.isArray(initialRfids) ? initialRfids : [];

  function resetRFIDs(){ rfids = []; renderRFIDs(); }

  function renderRFIDs(){
    // Update count and submit button
    countEl.textContent = String(rfids.length);
    submitBtn.textContent = `+ Registrar ${rfids.length} Item(s)`;
    submitBtn.disabled = !(modeloIdEl.value && rfids.length > 0);
    if(dupMsg){ dupMsg.textContent = ''; }

    // Hidden inputs for POST
    rfidContainer.innerHTML = rfids
      .map((r,i)=>`<input type="hidden" name="rfids[${i}]" value="${r}">`)
      .join('');

    // Visual chips list with remove buttons
    if(rfidList){
      rfidList.innerHTML = rfids.map((r,i)=>{
        const status = validationDone ? '<span class="text-[10px] text-success mt-1">ok</span>' : '';
        return `<div class="inline-flex flex-col items-center">
                  <span class="badge badge-outline gap-2">${r}<button type="button" class="btn btn-ghost btn-xs" data-remove="${i}">✕</button></span>
                  ${status}
                </div>`;
      }).join('');
    }
  }

  // Live validation against server: checks duplicates and updates UI
  async function validateRfids(){
    if(rfids.length === 0){
      dupRfids = [];
      validationDone = false;
      renderRFIDs();
      return;
    }
    try{
      const res = await fetch('/registro/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rfids })
      });
      const data = await res.json();
      dupRfids = Array.isArray(data.dups) ? data.dups : [];
      if(dupRfids.length){
        // Filtrar repetidos automáticamente
        rfids = rfids.filter(r => !dupRfids.includes(r));
      }
      validationDone = true;
      // limpiar estado de dups (ya removidos)
      dupRfids = [];
      renderRFIDs();
    }catch{
      // keep previous state on error
    }
  }

  function fillLitrajePorTipo(tipo){
    litrajeEl.innerHTML = '<option value="" selected>Seleccione el litraje</option>';
    const list = (modelosByTipo && modelosByTipo[tipo]) || [];
    // Sort by numeric liters if present in name (e.g., "Credo Cube 10L")
    const parseLitros = (name)=>{
      const m = (name||'').match(/(\d+(?:[\.,]\d+)?)\s*[lL]/);
      if(!m) return Number.POSITIVE_INFINITY; // push unknowns to the end
      return Number(String(m[1]).replace(',','.'));
    };
    const sorted = [...list].sort((a,b)=>parseLitros(a.name)-parseLitros(b.name));
    for(const m of sorted){
      const opt = document.createElement('option');
      opt.value = String(m.id);
      opt.textContent = m.name;
      litrajeEl.appendChild(opt);
    }
  }

  // Valida contra servidor y solo agrega si NO existe
  async function handleScannedCode(rawCode){
    const code = String(rawCode || '').toUpperCase();
    if(!(code && code.length === 24)) return false;
    if(rfids.includes(code)) return false;
    try{
      const res = await fetch('/registro/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rfids: [code] })
      });
      const data = await res.json();
      const isDup = Array.isArray(data.dups) && data.dups.map(String).map(s=>s.toUpperCase()).includes(code);
      if(!isDup){
        rfids.push(code);
        renderRFIDs();
        return true;
      }
    }catch{}
    return false;
  }

  // Delegated remove
  if(rfidList){
    rfidList.addEventListener('click', (e)=>{
      const t = e.target;
      if(!(t instanceof Element)) return;
      const idxStr = t.getAttribute('data-remove');
      if(idxStr !== null){
        const idx = Number(idxStr);
        if(!Number.isNaN(idx)){
          rfids.splice(idx,1);
          renderRFIDs();
          validateRfids();
        }
      }
    });
  }

  tipoEl.addEventListener('change', ()=>{
    const tipo = tipoEl.value;
    litrajeEl.disabled = !tipo;
    scanEl.value = '';
    scanEl.disabled = true;
    modeloIdEl.value = '';
    resetRFIDs();

    if(!tipo) return;
    fillLitrajePorTipo(tipo);
  });

  litrajeEl.addEventListener('change', ()=>{
    const selectedId = litrajeEl.value;
    modeloIdEl.value = selectedId || '';
    scanEl.disabled = !selectedId;
    scanEl.placeholder = selectedId ? 'Listo para escanear...' : 'Complete tipo y litraje primero...';
    if(selectedId){ scanEl.focus(); }
    resetRFIDs();
  // reset validation state
  dupRfids = [];
  validationDone = false;
  });

  // Handle scanner input: process every 24-char chunk; support paste and fast scans
  function processBuffer(raw){
    let v = (raw || '').replace(/\s+/g,'');
    // Some scanners add CR/LF or TAB; already removed by \s
    while(v.length >= 24){
      const chunk = v.slice(0,24);
      // validar en background y agregar solo si procede
      handleScannedCode(chunk);
      v = v.slice(24);
    }
    // Return remaining buffer to keep in the input
    return v;
  }

  scanEl.addEventListener('input', ()=>{
    const rest = processBuffer(scanEl.value);
    scanEl.value = rest;
    // Validate after user/scan input changes the list
    validateRfids();
  });

  scanEl.addEventListener('paste', (e)=>{
    const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if(text){
      e.preventDefault();
      const rest = processBuffer(text);
      scanEl.value = rest;
      validateRfids();
    }
  });

  // Submit guard (requires explicit button click and passes validations)
  form.addEventListener('submit', (e)=>{
    if(!allowExplicitSubmit){ e.preventDefault(); return; }
    if(!(modeloIdEl.value && rfids.length > 0)){
      e.preventDefault();
    }
    // Reset flag immediately after handling to avoid unintended resubmits
    allowExplicitSubmit = false;
  });

  if(submitBtn){
    submitBtn.addEventListener('click', ()=>{
      // Allow exactly one submit triggered by this click
      allowExplicitSubmit = true;
      // Trigger programmatic submit; submit listener will validate and reset the flag
      form.requestSubmit ? form.requestSubmit() : form.submit();
    });
  }

  // Block Enter-based submission: require explicit tap on the button (mobile & desktop)
  const preventEnter = (ev) => {
    const k = ev.key || ev.code;
    if(k === 'Enter' || k === 'NumpadEnter'){ ev.preventDefault(); ev.stopPropagation(); }
  };
  // Capture at form level to intercept before default submit
  form.addEventListener('keydown', preventEnter, true);
  // Extra safety on the scanner input (many scanners send CR/Enter)
  if(scanEl){ scanEl.addEventListener('keydown', preventEnter); }

  // Autofocus to Tipo initially
  if(tipoEl){
    // Initialize from server-provided selection if present
    if(initialTipo){
      tipoEl.value = initialTipo;
      litrajeEl.disabled = false;
      fillLitrajePorTipo(initialTipo);
    } else if (tipoEl.value){
      litrajeEl.disabled = false;
      fillLitrajePorTipo(tipoEl.value);
    }

    // If there is a selected modelo, set it and enable scanner
    if(initialModelo){
      litrajeEl.value = initialModelo;
      modeloIdEl.value = initialModelo;
      scanEl.disabled = false;
      scanEl.placeholder = 'Listo para escanear...';
    }

  // Si el servidor envió duplicados detectados, filtrarlos desde el inicio
  if(dupRfids.length){
    rfids = rfids.filter(r => !dupRfids.includes(r));
    dupRfids = [];
  }
  renderRFIDs();
  if(rfids.length){ validateRfids(); }
    tipoEl.focus();
  }
})();
