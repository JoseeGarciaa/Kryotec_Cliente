// Lógica de la vista Bodega (externo para cumplir CSP)
(function(){
  const tbody = document.querySelector('#tabla-bodega tbody');
  if(!tbody) return; // vista no presente
  const infoTotal = document.getElementById('info-total');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');
  const form = document.getElementById('form-filtros');
  let page = 1; let limit = 50;
  async function load(){
    const qEl = document.getElementById('f-q');
    const catEl = document.getElementById('f-cat');
    const q = qEl ? qEl.value.trim() : '';
    const cat = catEl ? catEl.value : '';
    const params = new URLSearchParams({ page:String(page), limit:String(limit) });
    if(q) params.set('q', q); if(cat) params.set('cat', cat);
    tbody.innerHTML = '<tr><td colspan="7" class="text-center"><span class="loading loading-spinner loading-xs"></span> Cargando...</td></tr>';
    try {
      const res = await fetch('/operacion/bodega/data?'+params.toString());
      const data = await res.json();
      if(!data.ok){ tbody.innerHTML='<tr><td colspan="7" class="text-center text-error">Error</td></tr>'; return; }
      if(!data.items.length){
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-xs opacity-70">Sin items en bodega (estado exacto \"En bodega\").</td></tr>';
      } else {
        tbody.innerHTML = data.items.map(r => `
          <tr>
            <td class="text-xs opacity-60">${r.id}</td>
            <td><code class="text-[10px]">${r.rfid}</code></td>
            <td class="text-xs">${r.nombre_unidad||'-'}</td>
            <td class="text-xs">${r.lote||'-'}</td>
            <td><span class="badge badge-outline badge-xs">${r.categoria}</span></td>
            <td class="text-xs">${r.sub_estado||'-'}</td>
            <td class="text-[10px]">${r.fecha_ingreso ? new Date(r.fecha_ingreso).toLocaleString('es-CO') : '-'}</td>
          </tr>`).join('');
      }
      window.__bodegaEstados = data.estados;
      const start = (data.page-1)*data.limit + 1;
      const end = Math.min(data.page*data.limit, data.total);
      if(infoTotal) infoTotal.textContent = data.total ? `${start}-${end} de ${data.total}` : 'Sin resultados';
      if(btnPrev) btnPrev.disabled = page<=1;
      if(btnNext) btnNext.disabled = end >= data.total;
    } catch (e) {
      console.error(e); tbody.innerHTML='<tr><td colspan="7" class="text-center text-error">Error</td></tr>';
    }
  }
  if(btnPrev) btnPrev.addEventListener('click', ()=>{ if(page>1){ page--; load(); }});
  if(btnNext) btnNext.addEventListener('click', ()=>{ page++; load(); });
  if(form) form.addEventListener('submit', (e)=>{ e.preventDefault(); page=1; load(); });
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
  load();
  window.bodegaDiag = () => console.table((window).__bodegaEstados || []);
})();
