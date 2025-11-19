// Dashboard visual (solo lectura) - reutiliza endpoint /operacion/todas/data
(function(){
  const spin = document.getElementById('dash-spin');
  const statusEl = document.getElementById('dash-status');
  const lastEl = document.getElementById('dash-last');
  const clockEl = document.getElementById('dash-clock');
  const btn = document.getElementById('dash-refresh');
  const flowChart = document.getElementById('flow-chart');
  if(!statusEl) return;

  const el = (id)=> document.getElementById(id);
  function fmt(sec){ if(sec==null) return '--:--:--'; const s=Math.max(0,sec); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const ss=s%60; return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`; }

  let autoReload=null; let reloadMs=15000;
  function schedule(ms){ if(reloadMs===ms) return; reloadMs=ms; if(autoReload) clearInterval(autoReload); autoReload=setInterval(load, reloadMs); }

  function kpi(id,val){ const e=el(id); if(e) e.textContent=(val==null?'–':val); }

  async function load(){
    if(spin) spin.classList.remove('hidden');
    statusEl.textContent='Cargando';
    try {
      const res = await fetch('/operacion/todas/data', { cache:'no-store' });
      if(!res.ok) throw new Error('HTTP '+res.status);
      const j = await res.json(); if(!j.ok) throw new Error(j.error||'Resp inválida');
      const d = j.data;
      // KPIs
      const stockTotal = (d.enBodega.tics||0)+(d.enBodega.vips||0)+(d.enBodega.cubes||0);
      kpi('k-stock', stockTotal);
      const stockBreak = `TIC ${d.enBodega.tics||0} / VIP ${d.enBodega.vips||0} / CUBE ${d.enBodega.cubes||0}`; const br=el('k-stock-break'); if(br) br.textContent=stockBreak;
      const preProc = (d.preAcond.congelamiento.en_proceso||0)+(d.preAcond.atemperamiento.en_proceso||0);
      const preDone = (d.preAcond.congelamiento.completado||0)+(d.preAcond.atemperamiento.completado||0);
      const preTotal = preProc + preDone;
      kpi('k-pre-proc', preProc); kpi('k-pre-ready', preDone); const pct = preTotal? Math.round(preDone/preTotal*100):0; const pctEl=el('k-pre-pct'); if(pctEl) pctEl.textContent=pct+'%';
      kpi('k-ensam-items', d.acond.ensamblaje); kpi('k-cajas', d.acond.cajas); kpi('k-op-cajas', d.operacion.cajas_op);

  renderFlow(d, pct);
  buildFlow(d);
  schedule(15000);
      const now=new Date(); if(lastEl) lastEl.textContent=now.toLocaleTimeString(); statusEl.textContent='Listo';
    } catch(e){ console.error('[dash] load', e); statusEl.textContent='Error'; }
    finally { if(spin) spin.classList.add('hidden'); }
  }

  function renderFlow(d){ buildFlow(d); }
  
    function buildFlow(data){
      if(!flowChart) return;
      // Derivar valores reales del objeto nested devuelto por /operacion/todas/data
      const preProc = (data.preAcond?.congelamiento?.en_proceso||0)+(data.preAcond?.atemperamiento?.en_proceso||0);
      const preListas = (data.preAcond?.congelamiento?.completado||0)+(data.preAcond?.atemperamiento?.completado||0);
      const ensam = data.acond?.ensamblaje||0;
      const cajas = data.acond?.cajas||0;
      const opCajas = data.operacion?.cajas_op||0;
      const cajasPendBodega = data.acond?.pendientes_bodega||0;
      const groups = [
        { id:'pre-proc', label:'PreAcond (Proc)', val: preProc, colors:['#4f46e5','#6366f1','#818cf8'] },
        { id:'pre-ready', label:'PreAcond (Listas)', val: preListas, colors:['#0ea5e9','#38bdf8','#7dd3fc'] },
        { id:'ensam', label:'Ensamblaje', val: ensam, colors:['#9333ea','#a855f7','#c084fc'] },
        { id:'cajas', label:'Cajas', val: cajas, colors:['#2563eb','#3b82f6','#60a5fa'] },
        { id:'op-cajas', label:'Operación', val: opCajas, colors:['#059669','#10b981','#34d399'] },
        { id:'pend-inspeccion', label:'Pend. inspección', val: cajasPendBodega, colors:['#dc2626','#ef4444','#f87171'] }
      ];
      const total = groups.reduce((s,g)=> s + g.val,0) || 1;
      flowChart.innerHTML='';
      groups.forEach((g,i)=>{
        const val = g.val;
        const perc = total ? (val/total)*100 : 0;
        const state = val===0? 'crit': perc < 6 ? 'warn':'ok';
        const chip = document.createElement('div');
        chip.className='k-chip';
        chip.dataset.id = g.id;
        chip.dataset.state = state;
        chip.style.setProperty('--c1',g.colors[0]);
        chip.style.setProperty('--c2',g.colors[1]);
        chip.style.setProperty('--c3',g.colors[2]);
        const circlePerc = Math.min(100, Math.round(perc));
        const dash = 2 * Math.PI * 16; // r=16
        const dashOffset = dash - (circlePerc/100)*dash;
        chip.innerHTML = `
          <small>${g.label}</small>
          <strong>${val}</strong>
          <span class="meta"><span>${circlePerc.toString().padStart(2,'0')}%</span> del total</span>
          <div class="ring">
            <svg viewBox="0 0 40 40">
              <circle cx="20" cy="20" r="16" stroke="rgba(255,255,255,.15)" stroke-width="4" fill="none" />
              <circle cx="20" cy="20" r="16" stroke="white" stroke-width="4" fill="none" stroke-linecap="round"
                stroke-dasharray="${dash}" stroke-dashoffset="${dashOffset}" />
            </svg>
          </div>`;
        flowChart.appendChild(chip);
        if(i < groups.length -1){
          const divi = document.createElement('div');
          divi.className='k-flow-divider';
          flowChart.appendChild(divi);
        }
      });
  }

  // Clock
  setInterval(()=>{ if(clockEl) clockEl.textContent = new Date().toLocaleTimeString(); },1000);
  btn?.addEventListener('click', load);
  load();
})();
