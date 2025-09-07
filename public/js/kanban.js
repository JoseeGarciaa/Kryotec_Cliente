// Kanban summary loader (CSP compliant)
(function(){
  const spin = document.getElementById('kb-spin');
  const statusEl = document.getElementById('kb-status');
  const btn = document.getElementById('kb-refresh');
  if(!statusEl) return;
  async function load(){
    if(spin) spin.classList.remove('hidden');
    statusEl.textContent = 'Cargando...';
    try {
      const res = await fetch('/operacion/todas/data');
      const j = await res.json();
      if(!j.ok) throw new Error(j.error||'error');
      const d = j.data;
      setNum('kb-bodega-tics', d.enBodega.tics);
      setNum('kb-bodega-vips', d.enBodega.vips);
      setNum('kb-bodega-cubes', d.enBodega.cubes);
      setNum('kb-cong-proc', d.preAcond.congelamiento.en_proceso);
      setNum('kb-cong-done', d.preAcond.congelamiento.completado);
      setNum('kb-atem-proc', d.preAcond.atemperamiento.en_proceso);
      setNum('kb-atem-done', d.preAcond.atemperamiento.completado);
      setNum('kb-ensam-items', d.acond.ensamblaje);
      setNum('kb-ensam-cajas', d.acond.cajas);
  setNum('kb-insp-tic', d.inspeccion.tics);
  setNum('kb-insp-vip', d.inspeccion.vips);
      setNum('kb-op-tic', d.operacion.tic_transito);
      setNum('kb-op-vip', d.operacion.vip_transito);
      setNum('kb-dev-tic', d.devolucion.tic_pendiente);
      setNum('kb-dev-vip', d.devolucion.vip_pendiente);
      statusEl.textContent = 'Actualizado ' + new Date().toLocaleTimeString();
    } catch(e){
      console.error(e);
      statusEl.textContent = 'Error al cargar';
    } finally {
      if(spin) spin.classList.add('hidden');
    }
  }
  function setNum(id, val){ const el=document.getElementById(id); if(el) el.textContent = (val||0).toString(); }
  if(btn) btn.addEventListener('click', load);
  load();
  // auto refresh every 60s
  setInterval(load, 60000);
})();
