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
  let validationDone = dupRfids.length > 0; // server-provided dups imply validated; will update on live checks

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

  let rfids = Array.isArray(initialRfids) ? initialRfids : [];

  function resetRFIDs(){ rfids = []; renderRFIDs(); }

  function renderRFIDs(){
    // Update count and submit button
    countEl.textContent = String(rfids.length);
    submitBtn.textContent = `+ Registrar ${rfids.length} Item(s)`;
    const hasDups = rfids.some(r => dupRfids.includes(r));
    submitBtn.disabled = !(modeloIdEl.value && rfids.length > 0) || hasDups;
    if(dupMsg){ dupMsg.textContent = hasDups ? 'Elimine los RFIDs marcados como repetidos para poder registrar.' : ''; }

    // Hidden inputs for POST
    rfidContainer.innerHTML = rfids
      .map((r,i)=>`<input type="hidden" name="rfids[${i}]" value="${r}">`)
      .join('');

    // Visual chips list with remove buttons
    if(rfidList){
      rfidList.innerHTML = rfids.map((r,i)=>{
        const isDup = dupRfids.includes(r);
        const chipCls = isDup ? 'badge badge-error gap-2' : 'badge badge-outline gap-2';
        const status = isDup ? '<span class="text-[10px] text-error mt-1">repetido</span>' : (validationDone ? '<span class="text-[10px] text-success mt-1">ok</span>' : '');
        return `<div class="inline-flex flex-col items-center">
                  <span class="${chipCls}">${r}<button type="button" class="btn btn-ghost btn-xs" data-remove="${i}">✕</button></span>
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
      validationDone = true;
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

  function addRFIDIfValid(code){
    if(code && code.length === 24 && !rfids.includes(code)){
      rfids.push(code);
      renderRFIDs();
  // validate in background
  validateRfids();
      return true;
    }
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
      const added = addRFIDIfValid(chunk);
      if(added){ /* validated later */ }
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

  // Submit guard
  form.addEventListener('submit', (e)=>{
    const hasDups = rfids.some(r => dupRfids.includes(r));
    if(!(modeloIdEl.value && rfids.length > 0) || hasDups){
      e.preventDefault();
      if(dupMsg && hasDups){ dupMsg.textContent = 'Elimine los RFIDs marcados como repetidos para poder registrar.'; }
    }
  });

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

  renderRFIDs();
  if(rfids.length){ validateRfids(); }
    tipoEl.focus();
  }
})();
