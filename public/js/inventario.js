(function(){
  const input = document.getElementById('inv-search-input');
  const count = document.getElementById('inv-search-count');
  const tbody = document.getElementById('inv-tbody');
  const modeBadge = document.getElementById('inv-mode-badge');
  const status = document.getElementById('inv-status');
  const tagsBox = document.getElementById('inv-rfid-tags');
  const modal = document.getElementById('inv-edit-modal');
  const formEdit = document.getElementById('inv-edit-form');
  const fModeloId = document.getElementById('inv-edit-modelo_id');
  const fRfid = document.getElementById('inv-edit-rfid');
  const fNombre = document.getElementById('inv-edit-nombre');
  const fLote = document.getElementById('inv-edit-lote');
  const fEstado = document.getElementById('inv-edit-estado');
  const fSub = document.getElementById('inv-edit-sub');
  const fZona = document.getElementById('inv-edit-zona');
  const fSeccion = document.getElementById('inv-edit-seccion');
  const locationHint = document.getElementById('inv-edit-location-hint');
  const limitSelect = document.getElementById('inv-limit-select');
  const fFechaIngreso = document.getElementById('inv-edit-fecha-ingreso');
  const fUltima = document.getElementById('inv-edit-ultima');
  const fActivoToggle = document.getElementById('inv-edit-activo-toggle');
  const fActivoHidden = document.getElementById('inv-edit-activo');
  const fActivoLabel = document.getElementById('inv-edit-activo-label');

  const COLSPAN = 13;
  let rfids = [];
  let remainder = '';
  let debounceTimer = 0;
  let fetchTimer = 0;

  const ubicacionesState = { data: null, promise: null };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value ?? '');
  }

  function formatDateTime(value) {
    if (!value) return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    try {
      return date.toLocaleString('es-CO');
    } catch {
      return date.toLocaleString();
    }
  }

  function setActivoState(isActive) {
    if (fActivoToggle instanceof HTMLInputElement) {
      fActivoToggle.checked = !!isActive;
    }
    if (fActivoHidden instanceof HTMLInputElement) {
      fActivoHidden.value = isActive ? '1' : '0';
    }
    if (fActivoLabel) {
      fActivoLabel.textContent = isActive ? 'Habilitado' : 'Inhabilitado';
      fActivoLabel.classList.toggle('text-success', !!isActive);
      fActivoLabel.classList.toggle('text-error', !isActive);
    }
  }

  function updateCount() {
    if (!input || !count) return;
    count.textContent = `${input.value.length || 0}/24 caracteres`;
  }

  function parseBuffer(buf) {
    const s = String(buf || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const found = [];
    let i = 0;
    while (i + 24 <= s.length) {
      found.push(s.slice(i, i + 24));
      i += 24;
    }
    return { found, rest: s.slice(i) };
  }

  function addCodes(codes) {
    let added = false;
    for (const c of codes) {
      if (!rfids.includes(c)) {
        rfids.push(c);
        added = true;
      }
    }
    if (added) {
      renderTags();
      scheduleFetch();
    }
  }

  function renderTags() {
    if (!tagsBox) return;
    if (!rfids.length) {
      tagsBox.innerHTML = '';
      return;
    }
    tagsBox.innerHTML = rfids
      .map((r) => `<span class="badge badge-primary gap-1" data-rfid-tag="${r}">${r}<button type="button" class="ml-1" data-action="remove-rfid" data-rfid="${r}">✕</button></span>`)
      .join('');
  }

  function updateLocationHint(message) {
    if (locationHint) {
      locationHint.textContent = message || '';
    }
  }

  async function loadUbicaciones() {
    if (ubicacionesState.data) return ubicacionesState.data;
    if (!ubicacionesState.promise) {
      ubicacionesState.promise = fetch('/inventario/ubicaciones', { headers: { Accept: 'application/json' } })
        .then((res) => (res.ok ? res.json() : { zonas: [] }))
        .then((json) => {
          const zonas = Array.isArray(json?.zonas) ? json.zonas : [];
          ubicacionesState.data = zonas.map((z) => ({
            zona_id: z.zona_id,
            nombre: z.nombre,
            activa: z.activa,
            secciones: Array.isArray(z.secciones) ? z.secciones : [],
          }));
          return ubicacionesState.data;
        })
        .catch((err) => {
          console.error('Error cargando ubicaciones', err);
          ubicacionesState.data = [];
          return ubicacionesState.data;
        })
        .finally(() => {
          ubicacionesState.promise = null;
        });
    }
    return ubicacionesState.promise;
  }

  function populateZonaSelect(selected) {
    if (!fZona) return;
    const zonas = ubicacionesState.data || [];
    const opts = ['<option value="">Sin zona</option>'];
    zonas.forEach((z) => {
      const label = `${escapeHtml(z.nombre)}${z.activa === false ? ' (inactiva)' : ''}`;
      opts.push(`<option value="${escapeAttr(z.zona_id)}">${label}</option>`);
    });
    fZona.innerHTML = opts.join('');
    fZona.disabled = zonas.length === 0;
    if (!zonas.length) {
      updateLocationHint('No hay zonas configuradas para tu sede.');
    }
    if (selected !== null && selected !== undefined && selected !== '') {
      const value = String(selected);
      fZona.value = value;
      if (fZona.value !== value) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = `Zona ${value}`;
        fZona.appendChild(opt);
        fZona.value = value;
      }
    } else {
      fZona.value = '';
    }
  }

  function populateSeccionSelect(zonaId, selected) {
    if (!fSeccion) return;
    const zonas = ubicacionesState.data || [];
    const opts = ['<option value="">Sin sección</option>'];
    let message = '';
    let disable = false;

    if (!zonas.length) {
      message = 'No hay zonas configuradas para tu sede.';
      disable = true;
    } else if (!zonaId) {
      message = 'Selecciona una zona para listar las secciones disponibles.';
    } else {
      const zona = zonas.find((z) => String(z.zona_id) === String(zonaId));
      if (!zona) {
        message = 'Zona no disponible para tu sede.';
        disable = true;
      } else {
        const secciones = Array.isArray(zona.secciones) ? zona.secciones : [];
        if (!secciones.length) {
          message = 'Esta zona no tiene secciones registradas.';
        } else {
          secciones.forEach((s) => {
            const label = `${escapeHtml(s.nombre)}${s.activa === false ? ' (inactiva)' : ''}`;
            opts.push(`<option value="${escapeAttr(s.seccion_id)}">${label}</option>`);
          });
        }
      }
    }

    fSeccion.innerHTML = opts.join('');
    fSeccion.disabled = disable;

    if (selected !== null && selected !== undefined && selected !== '') {
      const value = String(selected);
      fSeccion.value = value;
      if (fSeccion.value !== value) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = `Seccion ${value}`;
        fSeccion.appendChild(opt);
        fSeccion.value = value;
      }
    } else {
      fSeccion.value = '';
    }

    updateLocationHint(message);
  }

  function ensureLocationSelectors(zonaId, seccionId) {
    updateLocationHint('Cargando ubicaciones...');
    return loadUbicaciones()
      .then(() => {
        populateZonaSelect(zonaId);
        populateSeccionSelect(zonaId ? zonaId : '', seccionId);
      })
      .catch(() => {
        populateZonaSelect(null);
        populateSeccionSelect(null, null);
      });
  }

  async function fetchData() {
    if (!tbody) return;
    const hasTags = rfids.length >= 1;
    if (modeBadge) modeBadge.textContent = hasTags ? 'Multi' : 'Buscar';
    let url = '/inventario/data?limit=500';
    if (hasTags) {
      url += `&rfids=${encodeURIComponent(rfids.join(','))}`;
    } else {
      const q = (input?.value || '').trim();
      if (q) {
        url += `&q=${encodeURIComponent(q)}`;
      } else {
        tbody.innerHTML = `<tr><td colspan="${COLSPAN}" class="text-center py-6 opacity-60">Escanea o escribe para iniciar</td></tr>`;
        if (status) status.textContent = '';
        return;
      }
    }
    tbody.innerHTML = `<tr><td colspan="${COLSPAN}" class="text-center py-4"><span class="loading loading-spinner loading-xs"></span></td></tr>`;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (!data.ok) {
        tbody.innerHTML = `<tr><td colspan="${COLSPAN}" class="text-center text-error">Error</td></tr>`;
        return;
      }
      const rows = Array.isArray(data.items) ? data.items : [];
      if (hasTags) {
        const exists = new Set(rows.map((x) => String(x.rfid || '').toUpperCase()));
        const before = rfids.length;
        rfids = rfids.filter((x) => exists.has(String(x).toUpperCase()));
        if (rfids.length !== before) {
          renderTags();
        }
      }
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="${COLSPAN}" class="text-center py-4 opacity-60">Sin resultados</td></tr>`;
        if (status) status.textContent = 'Sin resultados';
        return;
      }
      const rendered = rows.map((i) => {
        const fechaIngreso = formatDateTime(i.fecha_ingreso);
        const fechaActual = formatDateTime(i.ultima_actualizacion || i.fecha_ingreso);
        const fechaIngresoIso = i.fecha_ingreso ? new Date(i.fecha_ingreso).toISOString() : '';
        const fechaActualIso = i.ultima_actualizacion ? new Date(i.ultima_actualizacion).toISOString() : (i.fecha_ingreso ? new Date(i.fecha_ingreso).toISOString() : '');
        const sub = i.sub_estado
          ? `<div class="badge badge-outline whitespace-nowrap">${escapeHtml(i.sub_estado)}</div>`
          : '<span class="opacity-60">—</span>';
        const zonaCell = i.zona_nombre ? escapeHtml(i.zona_nombre) : '<span class="opacity-60">—</span>';
        const seccionCell = i.seccion_nombre ? escapeHtml(i.seccion_nombre) : '<span class="opacity-60">—</span>';
        const activo = i.activo === false ? '0' : '1';
        const activoBadge = i.activo === false
          ? '<span class="badge badge-outline badge-error">Inhabilitado</span>'
          : '<span class="badge badge-outline badge-success">Habilitado</span>';
        return `<tr>
          <td>${escapeHtml(i.nombre_unidad || '')}</td>
          <td>${escapeHtml(i.modelo_id || '')}</td>
          <td><code class="font-mono text-xs">${escapeHtml(i.rfid || '')}</code></td>
          <td class="whitespace-nowrap">${escapeHtml(i.lote || '')}</td>
          <td class="whitespace-nowrap"><div class="badge badge-primary badge-outline whitespace-nowrap">${escapeHtml(i.estado || '')}</div></td>
          <td class="whitespace-nowrap">${sub}</td>
          <td class="whitespace-nowrap">${zonaCell}</td>
          <td class="whitespace-nowrap">${seccionCell}</td>
          <td>${escapeHtml(i.categoria || '')}</td>
          <td>${fechaIngreso}</td>
          <td>${fechaActual}</td>
          <td>${activoBadge}</td>
          <td class="whitespace-nowrap"><button type="button" class="btn btn-ghost btn-xs" data-action="inv-edit" data-id="${escapeAttr(i.id)}" data-modelo_id="${escapeAttr(i.modelo_id)}" data-rfid="${escapeAttr(i.rfid)}" data-nombre="${escapeAttr(i.nombre_unidad)}" data-lote="${escapeAttr(i.lote)}" data-estado="${escapeAttr(i.estado)}" data-sub="${escapeAttr(i.sub_estado)}" data-zona-id="${escapeAttr(i.zona_id ?? '')}" data-seccion-id="${escapeAttr(i.seccion_id ?? '')}" data-fecha-ingreso="${escapeAttr(fechaIngresoIso)}" data-ultima-actualizacion="${escapeAttr(fechaActualIso)}" data-activo="${escapeAttr(activo)}">✎</button></td>
        </tr>`;
      }).join('');
      tbody.innerHTML = rendered;
      if (status) status.textContent = `${rows.length} resultado${rows.length !== 1 ? 's' : ''} (${data.mode})`;
    } catch (err) {
      console.error(err);
      tbody.innerHTML = `<tr><td colspan="${COLSPAN}" class="text-center text-error">Error</td></tr>`;
    }
  }

  function scheduleFetch() {
    if (fetchTimer) window.clearTimeout(fetchTimer);
    fetchTimer = window.setTimeout(() => {
      fetchTimer = 0;
      fetchData();
    }, 140);
  }

  function handleInput() {
    if (!input) return;
    const { found, rest } = parseBuffer(remainder + input.value);
    if (found.length) {
      addCodes(found);
      input.value = '';
      remainder = rest;
      updateCount();
    }
  }

  updateCount();

  if (input) {
    input.addEventListener('input', () => {
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        handleInput();
      }, 80);
      updateCount();
    });
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') || '';
      if (text) {
        e.preventDefault();
        const { found, rest } = parseBuffer(remainder + text);
        addCodes(found);
        remainder = rest;
        scheduleFetch();
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleInput();
      }
    });
  }

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.matches('[data-action="remove-rfid"]')) {
      const rfid = target.getAttribute('data-rfid');
      if (rfid) {
        rfids = rfids.filter((x) => x !== rfid);
        renderTags();
        scheduleFetch();
      }
    }

    if (target.id === 'inv-clear-multiscan') {
      e.preventDefault();
      rfids = [];
      remainder = '';
      renderTags();
      scheduleFetch();
    }

    if (target.matches('[data-action="inv-edit"]')) {
      e.preventDefault();
      const id = target.getAttribute('data-id') || '';
      const modeloId = target.getAttribute('data-modelo_id') || '';
      const rfid = target.getAttribute('data-rfid') || '';
      const nombre = target.getAttribute('data-nombre') || '';
      const lote = target.getAttribute('data-lote') || '';
      const estado = target.getAttribute('data-estado') || '';
      const subEstado = target.getAttribute('data-sub') || '';
      const zonaIdAttr = target.getAttribute('data-zona-id') || '';
      const seccionIdAttr = target.getAttribute('data-seccion-id') || '';
      const fechaIngresoAttr = target.getAttribute('data-fecha-ingreso') || '';
      const ultimaAttr = target.getAttribute('data-ultima-actualizacion') || '';
      const activoAttr = target.getAttribute('data-activo') || '1';

      if (formEdit) formEdit.action = `/inventario/${id}/update`;
      if (fModeloId) fModeloId.value = modeloId;
      if (fRfid) fRfid.value = rfid;
      if (fNombre) fNombre.value = nombre;
      if (fLote) fLote.value = lote;
      if (fEstado) fEstado.value = estado;
      if (fSub) fSub.value = subEstado;
      if (fFechaIngreso) fFechaIngreso.value = fechaIngresoAttr ? formatDateTime(fechaIngresoAttr) : '-';
      if (fUltima) fUltima.value = ultimaAttr ? formatDateTime(ultimaAttr) : '-';
      setActivoState(!(activoAttr === '0' || activoAttr === 'false'));

      const zonaValue = zonaIdAttr ? Number(zonaIdAttr) : null;
      const seccionValue = seccionIdAttr ? Number(seccionIdAttr) : null;

      ensureLocationSelectors(zonaValue, seccionValue).finally(() => {
        if (fZona) fZona.value = zonaValue ? String(zonaValue) : '';
        if (fSeccion) fSeccion.value = seccionValue ? String(seccionValue) : '';
      });

      if (modal && typeof modal.showModal === 'function') {
        try { modal.showModal(); } catch { modal.classList.remove('hidden'); }
      }
      if (fNombre) window.setTimeout(() => fNombre.focus(), 100);
    }

    if (target.id === 'inv-edit-cancel') {
      modal?.close?.();
    }
  });

  if (modal) {
    modal.addEventListener('close', () => {
      if (formEdit) formEdit.reset();
      if (fZona) {
        fZona.innerHTML = '<option value="">Sin zona</option>';
        fZona.disabled = false;
      }
      if (fSeccion) {
        fSeccion.innerHTML = '<option value="">Sin sección</option>';
        fSeccion.disabled = false;
      }
      if (fFechaIngreso) fFechaIngreso.value = '';
      if (fUltima) fUltima.value = '';
      setActivoState(true);
      updateLocationHint('');
    });
  }

  if (fZona) {
    fZona.addEventListener('change', () => {
      const value = fZona.value || '';
      populateSeccionSelect(value, null);
    });
  }

  if (fActivoToggle instanceof HTMLInputElement) {
    fActivoToggle.addEventListener('change', () => {
      setActivoState(!!fActivoToggle.checked);
    });
  }

  if (formEdit) {
    formEdit.addEventListener('submit', () => {
      if (fZona && fSeccion && fZona.disabled) {
        fZona.disabled = false;
        fSeccion.disabled = false;
      }
      if (fActivoHidden instanceof HTMLInputElement && fActivoToggle instanceof HTMLInputElement) {
        fActivoHidden.value = fActivoToggle.checked ? '1' : '0';
      }
    });
  }

  if (limitSelect instanceof HTMLSelectElement) {
    limitSelect.addEventListener('change', () => {
      const form = limitSelect.form || document.getElementById('inv-search-form');
      if (form instanceof HTMLFormElement) {
        form.submit();
      }
    });
  }

  document.addEventListener('submit', (e) => {
    const target = e.target;
    if (target instanceof HTMLFormElement && target.classList.contains('inv-delete-form')) {
      if (!window.confirm('¿Eliminar este item?')) {
        e.preventDefault();
      }
    }
  });
})();
