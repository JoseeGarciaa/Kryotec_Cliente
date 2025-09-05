(function(){
  // Runs after DOM is parsed thanks to defer
  const dataEl = document.getElementById('registro-data');
  if(!dataEl) return;

  let modelosByTipo = {};
  try { modelosByTipo = JSON.parse(dataEl.dataset.modelos || '{}'); } catch { modelosByTipo = {}; }

  const tipoEl = document.getElementById('tipo');
  const litrajeEl = document.getElementById('litraje');
  const scanEl = document.getElementById('scan');
  const modeloIdEl = document.getElementById('modelo_id');
  const form = document.getElementById('registro-form');
  const rfidContainer = document.getElementById('rfid-container');
  const rfidList = document.getElementById('rfid-list');
  const submitBtn = document.getElementById('submit-btn');
  const countEl = document.getElementById('count');

  let rfids = [];

  function resetRFIDs(){ rfids = []; renderRFIDs(); }

  function renderRFIDs(){
    // Update count and submit button
    countEl.textContent = String(rfids.length);
    submitBtn.textContent = `+ Registrar ${rfids.length} Item(s)`;
    submitBtn.disabled = !(modeloIdEl.value && rfids.length > 0);

    // Hidden inputs for POST
    rfidContainer.innerHTML = rfids
      .map((r,i)=>`<input type="hidden" name="rfids[${i}]" value="${r}">`)
      .join('');

    // Visual chips list with remove buttons
    if(rfidList){
      rfidList.innerHTML = rfids.map((r,i)=>
        `<span class="badge badge-outline gap-2">${r}<button type="button" class="btn btn-ghost btn-xs" data-remove="${i}">✕</button></span>`
      ).join('');
    }
  }

  function fillLitrajePorTipo(tipo){
    litrajeEl.innerHTML = '<option value="" selected>Seleccione el litraje</option>';
    const list = (modelosByTipo && modelosByTipo[tipo]) || [];
    for(const m of list){
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
  });

  // Handle scanner input: process every 24-char chunk; support paste and fast scans
  function processBuffer(raw){
    let v = (raw || '').replace(/\s+/g,'');
    // Some scanners add CR/LF or TAB; already removed by \s
    while(v.length >= 24){
      const chunk = v.slice(0,24);
      addRFIDIfValid(chunk);
      v = v.slice(24);
    }
    // Return remaining buffer to keep in the input
    return v;
  }

  scanEl.addEventListener('input', ()=>{
    const rest = processBuffer(scanEl.value);
    scanEl.value = rest;
  });

  scanEl.addEventListener('paste', (e)=>{
    const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if(text){
      e.preventDefault();
      const rest = processBuffer(text);
      scanEl.value = rest;
    }
  });

  // Submit guard
  form.addEventListener('submit', (e)=>{
    if(!(modeloIdEl.value && rfids.length > 0)){
      e.preventDefault();
    }
  });

  // Autofocus to Tipo initially
  if(tipoEl){
    // If there is already a selected tipo (e.g., user selected before reload), initialize UI
    if(tipoEl.value){
      litrajeEl.disabled = false;
      fillLitrajePorTipo(tipoEl.value);
    }
    tipoEl.focus();
  }
})();
