(function(global){
  'use strict';

  const cache = { data: null, promise: null };

  function escapeHtml(value){
    return String(value ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  async function loadUbicaciones(){
    if(cache.data) return cache.data;
    if(cache.promise) return cache.promise;
    cache.promise = fetch('/inventario/ubicaciones', { headers: { Accept: 'application/json' } })
      .then((res)=> res.ok ? res.json() : null)
      .then((json)=>{
        const zonas = Array.isArray(json?.zonas) ? json.zonas : [];
        cache.data = zonas.map((zona)=>({
          zona_id: zona.zona_id,
          nombre: zona.nombre,
          activa: zona.activa,
          secciones: Array.isArray(zona.secciones) ? zona.secciones.map((sec)=>({
            seccion_id: sec.seccion_id,
            nombre: sec.nombre,
            activa: sec.activa,
            zona_id: sec.zona_id ?? zona.zona_id
          })) : []
        }));
        return cache.data;
      })
      .catch((err)=>{
        console.warn('[Ubicaciones] Error cargando ubicaciones', err);
        cache.data = [];
        return cache.data;
      })
      .finally(()=>{ cache.promise = null; });
    return cache.promise;
  }

  function createController(options){
    const opts = options || {};
    const zonaSelect = opts.zonaSelect || null;
    const seccionSelect = opts.seccionSelect || null;
    const hintElement = opts.hintElement || null;
    if(!zonaSelect && !seccionSelect) return null;

    const state = { zonaId: '', seccionId: '' };

    function setHint(message){ if(hintElement) hintElement.textContent = message || ''; }

    function populateZona(selectedId){
      if(!zonaSelect) return;
      const zonas = cache.data || [];
      const selected = selectedId ? String(selectedId) : '';
      const frag = document.createDocumentFragment();
      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = 'Sin zona';
      frag.appendChild(defaultOption);
      zonas.forEach((zona)=>{
        const opt = document.createElement('option');
        opt.value = zona.zona_id != null ? String(zona.zona_id) : '';
        const name = (zona.nombre || `Zona ${zona.zona_id ?? ''}`).toString();
        opt.textContent = zona.activa === false ? `${name} (inactiva)` : name;
        frag.appendChild(opt);
      });
      zonaSelect.innerHTML = '';
      zonaSelect.appendChild(frag);
      zonaSelect.disabled = zonas.length === 0;
      if(selected && zonas.some((z)=> String(z.zona_id) === selected)){
        zonaSelect.value = selected;
      } else {
        zonaSelect.value = '';
      }
      if(selected && zonaSelect.value !== selected){
        const opt = document.createElement('option');
        opt.value = selected;
        opt.textContent = `Zona ${selected}`;
        zonaSelect.appendChild(opt);
        zonaSelect.value = selected;
      }
      state.zonaId = zonaSelect.value || '';
    }

    function populateSeccion(zonaId, selectedId){
      if(!seccionSelect) return;
      const zonas = cache.data || [];
      const selectedZona = zonas.find((z)=> String(z.zona_id) === String(zonaId));
      const secciones = selectedZona ? (selectedZona.secciones || []) : [];
      const selected = selectedId ? String(selectedId) : '';
      const frag = document.createDocumentFragment();
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = 'Sin sección';
      frag.appendChild(defaultOpt);

      let disable = false;
      if(!zonas.length){
        disable = true;
        setHint('No hay zonas configuradas para tu sede.');
      } else if(!zonaId){
        disable = true;
        setHint('Selecciona una zona para listar sus secciones (opcional).');
      } else if(!selectedZona){
        disable = true;
        setHint('Zona no disponible para tu sede.');
      } else if(!secciones.length){
        disable = true;
        setHint('Esta zona no tiene secciones registradas.');
      } else {
        secciones.forEach((sec)=>{
          const opt = document.createElement('option');
          opt.value = sec.seccion_id != null ? String(sec.seccion_id) : '';
          const name = (sec.nombre || `Sección ${sec.seccion_id ?? ''}`).toString();
          opt.textContent = sec.activa === false ? `${name} (inactiva)` : name;
          frag.appendChild(opt);
        });
        setHint('Selecciona una sección (opcional).');
      }

      seccionSelect.innerHTML = '';
      seccionSelect.appendChild(frag);
      seccionSelect.disabled = disable;
      if(!disable && selected && secciones.some((s)=> String(s.seccion_id) === selected)){
        seccionSelect.value = selected;
      } else {
        seccionSelect.value = '';
      }
      if(!disable && selected && seccionSelect.value !== selected){
        const opt = document.createElement('option');
        opt.value = selected;
        opt.textContent = `Sección ${selected}`;
        seccionSelect.appendChild(opt);
        seccionSelect.value = selected;
      }
      state.seccionId = seccionSelect.value || '';
      if(disable && !zonas.length){
        zonaSelect && (zonaSelect.disabled = true);
      }
    }

    function ensure(values){
      if(values){
        state.zonaId = values.zonaId != null ? String(values.zonaId) : '';
        state.seccionId = values.seccionId != null ? String(values.seccionId) : '';
      }
      if(!zonaSelect && !seccionSelect){
        return loadUbicaciones().then(()=>undefined);
      }
      if(zonaSelect) zonaSelect.disabled = true;
      if(seccionSelect){
        seccionSelect.disabled = true;
        seccionSelect.innerHTML = '<option value="">Sin sección</option>';
      }
      setHint('Cargando ubicaciones...');
      return loadUbicaciones()
        .then(()=>{
          if(zonaSelect) populateZona(state.zonaId);
          if(seccionSelect) populateSeccion(state.zonaId, state.seccionId);
          if(!cache.data || !cache.data.length){
            setHint('No hay zonas configuradas para tu sede.');
          } else if(!state.zonaId){
            setHint('Selecciona una zona (opcional).');
          }
        })
        .catch(()=>{
          setHint('No se pudieron cargar las ubicaciones.');
          zonaSelect && (zonaSelect.disabled = true);
          if(seccionSelect){
            seccionSelect.disabled = true;
            seccionSelect.innerHTML = '<option value="">Sin sección</option>';
          }
        });
    }

    function reset(){
      state.zonaId = '';
      state.seccionId = '';
      if(zonaSelect){
        zonaSelect.value = '';
      }
      if(seccionSelect){
        seccionSelect.innerHTML = '<option value="">Sin sección</option>';
        seccionSelect.disabled = true;
      }
      setHint('');
    }

    zonaSelect && zonaSelect.addEventListener('change', ()=>{
      state.zonaId = zonaSelect.value || '';
      state.seccionId = '';
      if(seccionSelect){
        populateSeccion(state.zonaId, state.seccionId);
      }
    });

    seccionSelect && seccionSelect.addEventListener('change', ()=>{
      state.seccionId = seccionSelect.value || '';
    });

    return {
      ensure,
      reset,
      getValue(){
        return {
          zonaId: state.zonaId,
          seccionId: state.seccionId
        };
      },
      setValue(zonaId, seccionId){
        state.zonaId = zonaId != null ? String(zonaId) : '';
        state.seccionId = seccionId != null ? String(seccionId) : '';
        if(cache.data){
          if(zonaSelect) populateZona(state.zonaId);
          if(seccionSelect) populateSeccion(state.zonaId, state.seccionId);
        } else {
          ensure({ zonaId: state.zonaId, seccionId: state.seccionId });
        }
      }
    };
  }

  global.LocationSelector = {
    load: loadUbicaciones,
    create: createController
  };
})(typeof window !== 'undefined' ? window : this);
