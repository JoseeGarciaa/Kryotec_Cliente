(function(){
  const configEl = document.getElementById('reportes-config');
  if (!configEl) return;

  const safeJSON = (value, fallback) => {
    try {
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  };

  const combos = safeJSON(configEl.dataset.combos, { sedes: [], zonas: [], secciones: [], usuarios: [] });
  const initial = safeJSON(configEl.dataset.initial, {});

  const form = document.getElementById('reportes-filtros');
  const applyBtn = document.getElementById('reportes-aplicar');
  const clearBtn = document.getElementById('reportes-limpiar');
  const reportCards = Array.from(document.querySelectorAll('.report-card[data-report]'));
  const toggleInputs = Array.from(document.querySelectorAll('input[name="report-toggle"]'));
  const selectAllBtn = document.getElementById('reportes-select-all');
  const selectNoneBtn = document.getElementById('reportes-select-none');

  const state = {
    filters: {},
    pagination: {},
    meta: {},
    pageSize: {},
  };

  const parseIntOrNull = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const populateZonas = (sedeId, selectedZona) => {
    const select = form?.querySelector('select[name="zonaId"]');
    if (!select) return;
    const value = selectedZona !== undefined ? selectedZona : select.value;
    const zonas = Array.isArray(combos.zonas) ? combos.zonas : [];
    const filtered = sedeId ? zonas.filter((z) => Number(z.sede_id) === Number(sedeId)) : zonas;
    select.innerHTML = '<option value="">Todas</option>' + filtered.map((z) => `<option value="${z.zona_id}">${z.nombre}</option>`).join('');
    if (value) {
      select.value = String(value);
      if (select.value !== String(value)) {
        select.value = '';
      }
    }
  };

  const populateSecciones = (zonaId, selectedSeccion) => {
    const select = form?.querySelector('select[name="seccionId"]');
    if (!select) return;
    const value = selectedSeccion !== undefined ? selectedSeccion : select.value;
    const secciones = Array.isArray(combos.secciones) ? combos.secciones : [];
    const filtered = zonaId ? secciones.filter((s) => Number(s.zona_id) === Number(zonaId)) : secciones;
    select.innerHTML = '<option value="">Todas</option>' + filtered.map((s) => `<option value="${s.seccion_id}">${s.nombre}</option>`).join('');
    if (value) {
      select.value = String(value);
      if (select.value !== String(value)) {
        select.value = '';
      }
    }
  };

  const collectFilters = () => {
    if (!form) return {};
    const data = new FormData(form);
    const filters = {};
    data.forEach((value, key) => {
      const v = String(value).trim();
      if (v) filters[key] = v;
    });
    state.filters = filters;
    return filters;
  };

  const buildQuery = (filters, extra) => {
    const params = new URLSearchParams();
    Object.entries(filters || {}).forEach(([key, value]) => params.set(key, String(value)));
    Object.entries(extra || {}).forEach(([key, value]) => { if (value !== null && value !== undefined) params.set(key, String(value)); });
    return params.toString();
  };

  const setLoading = (code, isLoading) => {
    const loading = document.querySelector(`[data-report-loading="${code}"]`);
    const ready = document.querySelector(`[data-report-ready="${code}"]`);
    if (loading) loading.classList.toggle('hidden', !isLoading);
    if (ready && !isLoading) ready.classList.remove('hidden');
    if (ready && isLoading) ready.classList.add('hidden');
  };

  const renderKpis = (code, kpis) => {
    const container = document.querySelector(`[data-report-kpis="${code}"]`);
    if (!container) return;
    container.innerHTML = '';
    if (!kpis || typeof kpis !== 'object') return;
    Object.entries(kpis).forEach(([label, value]) => {
      const card = document.createElement('div');
      card.className = 'p-3 rounded-lg bg-base-100 border border-base-300/40 flex flex-col gap-1';
      const title = document.createElement('span');
      title.className = 'text-[11px] uppercase opacity-60 tracking-wide';
      title.textContent = label.replace(/_/g, ' ');
      const val = document.createElement('span');
      val.className = 'text-lg font-semibold';
      val.textContent = typeof value === 'number' ? value.toLocaleString('es-ES', { maximumFractionDigits: 2 }) : String(value ?? '');
      card.appendChild(title);
      card.appendChild(val);
      container.appendChild(card);
    });
  };

  const formatCellValue = (value, format) => {
    if (value === null || value === undefined) return '';
    if (format === 'datetime') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
    }
    if (format === 'duration') {
      const num = Number(value);
      if (!Number.isFinite(num)) return String(value);
      if (num >= 60) {
        const hours = num / 60;
        return hours.toFixed(1) + ' h';
      }
      return num.toFixed(1) + ' min';
    }
    if (typeof value === 'number') {
      return value.toLocaleString('es-ES', { maximumFractionDigits: 2 });
    }
    if (Array.isArray(value)) {
      return value.join(', ');
    }
    return String(value);
  };

  const renderTable = (code, columns, rows) => {
    const head = document.querySelector(`[data-report-head="${code}"]`);
    const body = document.querySelector(`[data-report-body="${code}"]`);
    if (!head || !body) return;
    if (!Array.isArray(columns) || !columns.length) {
      head.innerHTML = '<tr><th>Datos</th></tr>';
      body.innerHTML = '<tr><td class="text-xs opacity-70">Reporte sin columnas definidas.</td></tr>';
      return;
    }
    head.innerHTML = '<tr>' + columns.map((col) => `<th>${col.label}</th>`).join('') + '</tr>';
    if (!Array.isArray(rows) || !rows.length) {
      body.innerHTML = '<tr><td colspan="' + columns.length + '" class="text-xs opacity-60">Sin resultados con los filtros aplicados.</td></tr>';
      return;
    }
    body.innerHTML = rows.map((row) => {
      return '<tr>' + columns.map((col) => {
        const val = formatCellValue(row[col.key], col.format);
        return `<td class="whitespace-nowrap">${val || '&nbsp;'}</td>`;
      }).join('') + '</tr>';
    }).join('');
  };

  const updateMeta = (code, meta) => {
    const box = document.querySelector(`[data-report-meta="${code}"]`);
    if (!box) return;
    if (!meta) {
      box.textContent = 'Sin datos';
      return;
    }
    box.textContent = `Página ${meta.page} de ${meta.pages} · ${meta.total} registros`;
  };

  const storeMeta = (code, meta) => {
    state.meta[code] = meta;
    state.pagination[code] = meta ? meta.page : 1;
    state.pageSize[code] = meta ? meta.pageSize : 50;
  };

  const getPageSize = (code) => state.pageSize[code] || 50;

  const fetchReport = (code, page) => {
    const filters = collectFilters();
    const currentPage = page || state.pagination[code] || 1;
    setLoading(code, true);
    const query = buildQuery(filters, { page: currentPage, limit: getPageSize(code) });
    fetch(`/reportes/data/${code}?${query}`, { headers: { Accept: 'application/json' } })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error('Respuesta inválida')))
      .then((json) => {
        if (!json || json.ok !== true) throw new Error(json?.error || 'Error en el reporte');
        renderKpis(code, json.kpis || null);
        renderTable(code, json.columns || [], json.rows || []);
        updateMeta(code, json.meta || null);
        storeMeta(code, json.meta || null);
        setLoading(code, false);
      })
      .catch((err) => {
        console.error('[reportes][fetch]', code, err);
        renderTable(code, [], []);
        updateMeta(code, null);
        setLoading(code, false);
        const body = document.querySelector(`[data-report-body="${code}"]`);
        if (body) {
          body.innerHTML = '<tr><td class="text-error">' + (err?.message || 'Error cargando el reporte') + '</td></tr>';
        }
      });
  };

  const exportReport = (code, format) => {
    const filters = collectFilters();
    const query = buildQuery(filters, {});
    const url = `/reportes/export/${code}.${format}?${query}`;
    window.open(url, '_blank');
  };

  const codeToCard = new Map(reportCards.map((card) => [card.getAttribute('data-report'), card]));

  const isReportActive = (code) => {
    const toggle = toggleInputs.find((input) => input.dataset.report === code);
    return toggle ? Boolean(toggle.checked) : true;
  };

  const setReportVisibility = (code, active, options = {}) => {
    const card = codeToCard.get(code);
    if (!card) return;
    card.classList.toggle('hidden', !active);
    if (active && options.fetch !== false) {
      fetchReport(code, 1);
    }
    if (!active && options.resetPagination) {
      state.pagination[code] = 1;
      state.meta[code] = null;
    }
  };

  const applyAll = () => {
    reportCards.forEach((card) => {
      const code = card.getAttribute('data-report');
      if (!code || !isReportActive(code)) return;
      fetchReport(code, 1);
    });
  };

  if (form) {
    form.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement)) return;
      if (target.name === 'sedeId') {
        const sedeId = parseIntOrNull(target.value);
        populateZonas(sedeId, null);
        populateSecciones(null, null);
      }
      if (target.name === 'zonaId') {
        const zonaId = parseIntOrNull(target.value);
        populateSecciones(zonaId, null);
      }
    });
  }

  if (applyBtn) {
    applyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      applyAll();
    });
  }

  if (clearBtn && form) {
    clearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      form.reset();
      populateZonas(null, null);
      populateSecciones(null, null);
      state.filters = {};
      state.pagination = {};
      state.meta = {};
      toggleInputs.forEach((input) => {
        input.checked = input.defaultChecked;
        const code = input.dataset.report;
        if (code) {
          const active = Boolean(input.checked);
          setReportVisibility(code, active, { fetch: false, resetPagination: true });
        }
      });
    });
  }

  toggleInputs.forEach((input) => {
    input.addEventListener('change', () => {
      const code = input.dataset.report;
      if (!code) return;
      const active = Boolean(input.checked);
      setReportVisibility(code, active, { fetch: active, resetPagination: !active });
    });
  });

  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleInputs.forEach((input) => {
        if (!input.checked) {
          input.checked = true;
          input.dispatchEvent(new Event('change'));
        }
      });
    });
  }

  if (selectNoneBtn) {
    selectNoneBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleInputs.forEach((input) => {
        if (input.checked) {
          input.checked = false;
          input.dispatchEvent(new Event('change'));
        }
      });
    });
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest('[data-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    const code = target.getAttribute('data-report');
    if (!code) return;
    if (action === 'refresh-report') {
      event.preventDefault();
      fetchReport(code, 1);
    }
    if (action === 'export-report') {
      event.preventDefault();
      const format = target.getAttribute('data-format') || 'csv';
      exportReport(code, format);
    }
    if (action === 'prev-page') {
      event.preventDefault();
      const meta = state.meta[code];
      const current = state.pagination[code] || 1;
      if (meta && current > 1) {
        const next = current - 1;
        state.pagination[code] = next;
        fetchReport(code, next);
      }
    }
    if (action === 'next-page') {
      event.preventDefault();
      const meta = state.meta[code];
      const current = state.pagination[code] || 1;
      if (meta && current < meta.pages) {
        const next = current + 1;
        state.pagination[code] = next;
        fetchReport(code, next);
      }
    }
  });

  // Inicializar selects dependientes según valores iniciales
  if (form) {
    const sedeInit = parseIntOrNull(initial.sedeId);
    populateZonas(sedeInit, initial.zonaId ?? null);
    const zonaInit = parseIntOrNull(initial.zonaId);
    populateSecciones(zonaInit, initial.seccionId ?? null);
    if (initial.from) {
      const input = form.querySelector('input[name="from"]');
      if (input) input.value = initial.from;
    }
    if (initial.to) {
      const input = form.querySelector('input[name="to"]');
      if (input) input.value = initial.to;
    }
    if (initial.credocube) {
      const input = form.querySelector('input[name="credocube"]');
      if (input) input.value = initial.credocube;
    }
    if (initial.orderId) {
      const input = form.querySelector('input[name="orderId"]');
      if (input) input.value = initial.orderId;
    }
  }

  // Carga inicial basada en las selecciones activas
  toggleInputs.forEach((input) => {
    const code = input.dataset.report;
    if (!code) return;
    setReportVisibility(code, Boolean(input.checked), { fetch: input.checked });
  });
})();
