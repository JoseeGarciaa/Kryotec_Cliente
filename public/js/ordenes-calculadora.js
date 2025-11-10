(function () {
  const configEl = document.getElementById('calc-config');
  if (!configEl) return;

  const safeParse = (raw, fallback) => {
    if (typeof raw !== 'string' || !raw.length) return fallback;
    try {
      return JSON.parse(raw);
    } catch (_err) {
      return fallback;
    }
  };

  let catalogoProductos = safeParse(configEl.dataset.productos, []);
  const sedeId = safeParse(configEl.dataset.sede, null);

  const tbody = document.getElementById('calc-items-body');
  const addBtn = document.getElementById('btn-add-item');
  const clearBtn = document.getElementById('btn-clear-items');
  const calcBtn = document.getElementById('btn-calc');
  const statusEl = document.getElementById('calc-status');
  const resultsWrapper = document.getElementById('calc-results-wrapper');
  const resultsContainer = document.getElementById('calc-results');
  const resultsEmpty = document.getElementById('calc-results-empty');
  const resultsCount = document.getElementById('calc-results-count');
  const summaryEl = document.getElementById('calc-summary');
  const modal = document.getElementById('modal-confirm-order');
  const modalForm = document.getElementById('form-confirm-order');
  const modalError = document.getElementById('confirm-order-error');
  const modalDesc = document.getElementById('confirm-order-description');
  const modalSpinner = document.getElementById('confirm-order-spinner');
  const importBtn = document.getElementById('btn-import-productos');
  const importModal = document.getElementById('modal-import-productos');
  const importForm = document.getElementById('form-import-productos');
  const importStatus = document.getElementById('import-productos-status');
  const importErrors = document.getElementById('import-productos-errors');
  const importSubmit = document.getElementById('import-productos-submit');
  const importSubmitText = document.getElementById('import-productos-submit-text');
  const importSpinner = document.getElementById('import-productos-spinner');

  let lastItemsPayload = [];
  let selectedRecommendation = null;

  const STATUS_CLASSES = ['text-error', 'text-success'];

  const setStatus = (message, type) => {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    STATUS_CLASSES.forEach((cls) => statusEl.classList.remove(cls));
    if (type === 'error') {
      statusEl.classList.add('text-error');
    } else if (type === 'success') {
      statusEl.classList.add('text-success');
    }
  };

  const openDialog = (dialog) => {
    if (dialog && typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
  };

  const closeDialog = (dialog) => {
    if (dialog && typeof dialog.close === 'function') {
      dialog.close();
    }
  };

  const buildLocalTimestamp = () => {
    const now = new Date();
    const tzOffset = now.getTimezoneOffset();
    const localIso = new Date(now.getTime() - tzOffset * 60000).toISOString().slice(0, 19);
    return { tzOffset, localIso };
  };

  const resetProductosImport = (resetFile) => {
    if (resetFile && importForm instanceof HTMLFormElement) {
      importForm.reset();
    }
    if (importStatus) {
      importStatus.classList.add('hidden');
      importStatus.classList.remove('text-success', 'text-error');
      importStatus.textContent = '';
    }
    if (importErrors) {
      importErrors.classList.add('hidden');
      importErrors.textContent = '';
    }
    if (importSpinner) {
      importSpinner.classList.add('hidden');
    }
    if (importSubmit instanceof HTMLButtonElement) {
      importSubmit.disabled = false;
    }
    if (importSubmitText) {
      importSubmitText.textContent = 'Procesar';
    }
  };

  const buildPrefillsFromImport = (items) => {
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => {
        if (!item) return null;
        const cantidad = typeof item.cantidad === 'number' && Number.isFinite(item.cantidad)
          ? Math.max(1, Math.round(item.cantidad))
          : 1;
        return {
          nombre: typeof item.nombre === 'string' && item.nombre.trim().length
            ? item.nombre.trim()
            : typeof item.descripcion === 'string' && item.descripcion.trim().length
              ? item.descripcion.trim()
              : '',
          codigo: typeof item.codigo === 'string' ? item.codigo.trim() : '',
          largo_mm: typeof item.largo_mm === 'number' ? Number(item.largo_mm.toFixed(2)) : '',
          ancho_mm: typeof item.ancho_mm === 'number' ? Number(item.ancho_mm.toFixed(2)) : '',
          alto_mm: typeof item.alto_mm === 'number' ? Number(item.alto_mm.toFixed(2)) : '',
          cantidad,
        };
      })
      .filter(Boolean);
  };

  const createInput = (options) => {
    const input = document.createElement('input');
    Object.assign(input, options);
    return input;
  };

  const createFieldWrapper = (labelText, element, colClass) => {
    const wrapper = document.createElement('div');
    wrapper.className = `${colClass} flex flex-col gap-1 md:gap-0`;
    const mobileLabel = document.createElement('span');
    mobileLabel.className = 'text-[11px] uppercase opacity-60 md:hidden';
    mobileLabel.textContent = labelText;
    wrapper.appendChild(mobileLabel);
    wrapper.appendChild(element);
    return wrapper;
  };

  const fillFromCatalog = (row, product) => {
    if (!row || !product) return;
    const nombreInput = row.querySelector('[data-field="nombre"]');
    const codigoInput = row.querySelector('[data-field="codigo"]');
    const largoInput = row.querySelector('[data-field="largo"]');
    const anchoInput = row.querySelector('[data-field="ancho"]');
    const altoInput = row.querySelector('[data-field="alto"]');
    const cantidadInput = row.querySelector('[data-field="cantidad"]');
    if (nombreInput) nombreInput.value = product.nombre || product.descripcion || '';
    if (codigoInput) codigoInput.value = product.codigo || '';
    if (largoInput) largoInput.value = product.largo_mm != null ? product.largo_mm : '';
    if (anchoInput) anchoInput.value = product.ancho_mm != null ? product.ancho_mm : '';
    if (altoInput) altoInput.value = product.alto_mm != null ? product.alto_mm : '';
    if (cantidadInput) cantidadInput.value = product.cantidad != null ? product.cantidad : 1;
  };

  const buildCatalogSelect = (row, prefillId) => {
    const select = document.createElement('select');
    select.className = 'select select-sm select-bordered w-full';
    select.setAttribute('data-field', 'catalogo');
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Catálogo';
    select.appendChild(defaultOpt);
    catalogoProductos.forEach((producto) => {
      const opt = document.createElement('option');
      opt.value = String(producto.id);
      opt.textContent = producto.nombre || producto.codigo || `Producto ${producto.id}`;
      select.appendChild(opt);
    });
    if (prefillId) {
      select.value = String(prefillId);
    }
    select.addEventListener('change', () => {
      const selected = catalogoProductos.find((item) => String(item.id) === select.value);
      if (selected) {
        fillFromCatalog(row, selected);
      }
    });
    return select;
  };

  const addRow = (prefill) => {
    const row = document.createElement('div');
    row.className = 'calc-item grid grid-cols-1 md:grid-cols-12 gap-3 p-3 bg-base-100/80 border border-base-300/40 rounded-lg shadow-sm';

    const catalogSelect = buildCatalogSelect(row, prefill && prefill.catalogoId);
    const catalogWrapper = createFieldWrapper('Catálogo', catalogSelect, 'md:col-span-2');

    const nombreInput = createInput({
      type: 'text',
      className: 'input input-sm input-bordered w-full',
      placeholder: 'Nombre',
    });
    nombreInput.setAttribute('data-field', 'nombre');
    if (prefill && prefill.nombre) nombreInput.value = prefill.nombre;
    const nombreWrapper = createFieldWrapper('Nombre', nombreInput, 'md:col-span-3');

    const codigoInput = createInput({
      type: 'text',
      className: 'input input-sm input-bordered w-full',
      placeholder: 'Código',
    });
    codigoInput.setAttribute('data-field', 'codigo');
    if (prefill && prefill.codigo) codigoInput.value = prefill.codigo;
    const codigoWrapper = createFieldWrapper('Código', codigoInput, 'md:col-span-2');

    const largoInput = createInput({ type: 'number', step: '0.01', min: '0.01', className: 'input input-sm input-bordered w-full text-right' });
    largoInput.setAttribute('data-field', 'largo');
    if (prefill && prefill.largo_mm) largoInput.value = prefill.largo_mm;
    const largoWrapper = createFieldWrapper('Largo (mm)', largoInput, 'md:col-span-1');

    const anchoInput = createInput({ type: 'number', step: '0.01', min: '0.01', className: 'input input-sm input-bordered w-full text-right' });
    anchoInput.setAttribute('data-field', 'ancho');
    if (prefill && prefill.ancho_mm) anchoInput.value = prefill.ancho_mm;
    const anchoWrapper = createFieldWrapper('Ancho (mm)', anchoInput, 'md:col-span-1');

    const altoInput = createInput({ type: 'number', step: '0.01', min: '0.01', className: 'input input-sm input-bordered w-full text-right' });
    altoInput.setAttribute('data-field', 'alto');
    if (prefill && prefill.alto_mm) altoInput.value = prefill.alto_mm;
    const altoWrapper = createFieldWrapper('Alto (mm)', altoInput, 'md:col-span-1');

    const cantidadInput = createInput({ type: 'number', step: '1', min: '1', className: 'input input-sm input-bordered w-full text-right' });
    cantidadInput.setAttribute('data-field', 'cantidad');
    cantidadInput.value = prefill && prefill.cantidad ? prefill.cantidad : 1;
    const cantidadWrapper = createFieldWrapper('Cantidad', cantidadInput, 'md:col-span-1');

    const actionsWrapper = document.createElement('div');
    actionsWrapper.className = 'md:col-span-1 flex flex-col md:flex-row md:items-center md:justify-end gap-1 md:gap-2';
    const actionsLabel = document.createElement('span');
    actionsLabel.className = 'text-[11px] uppercase opacity-60 md:hidden';
    actionsLabel.textContent = 'Acciones';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-ghost btn-sm self-end md:self-auto';
    removeBtn.textContent = 'Quitar';
    removeBtn.addEventListener('click', () => {
      row.remove();
      if (!tbody.querySelector('.calc-item')) {
        addRow();
      }
    });
    actionsWrapper.appendChild(actionsLabel);
    actionsWrapper.appendChild(removeBtn);

    row.appendChild(catalogWrapper);
    row.appendChild(nombreWrapper);
    row.appendChild(codigoWrapper);
    row.appendChild(largoWrapper);
    row.appendChild(anchoWrapper);
    row.appendChild(altoWrapper);
    row.appendChild(cantidadWrapper);
    row.appendChild(actionsWrapper);

    tbody.appendChild(row);

    if (prefill && prefill.catalogoId) {
      const selected = catalogoProductos.find((item) => item.id === prefill.catalogoId);
      if (selected) fillFromCatalog(row, selected);
    }
  };

  const setRows = (prefillList) => {
    tbody.innerHTML = '';
    if (Array.isArray(prefillList) && prefillList.length) {
      prefillList.forEach((prefill) => {
        if (prefill) {
          addRow(prefill);
        } else {
          addRow();
        }
      });
    } else {
      addRow();
    }
  };

  const resetRows = (prefillList) => {
    setRows(prefillList);
    if (statusEl) statusEl.textContent = '';
    resultsWrapper?.classList.add('hidden');
    resultsContainer.innerHTML = '';
    resultsEmpty?.classList.add('hidden');
    if (resultsCount) resultsCount.classList.add('hidden');
  };

  const collectItems = () => {
    const rows = Array.from(tbody.querySelectorAll('.calc-item'));
    const items = [];
    const errors = [];
    rows.forEach((row, index) => {
      const nombreInput = row.querySelector('[data-field="nombre"]');
      const codigoInput = row.querySelector('[data-field="codigo"]');
      const largoInput = row.querySelector('[data-field="largo"]');
      const anchoInput = row.querySelector('[data-field="ancho"]');
      const altoInput = row.querySelector('[data-field="alto"]');
      const cantidadInput = row.querySelector('[data-field="cantidad"]');

      const largo = largoInput ? Number(largoInput.value) : NaN;
      const ancho = anchoInput ? Number(anchoInput.value) : NaN;
      const alto = altoInput ? Number(altoInput.value) : NaN;
      const cantidad = cantidadInput ? Number(cantidadInput.value) : NaN;

      const issues = [];
      if (!Number.isFinite(largo) || largo <= 0) issues.push('largo');
      if (!Number.isFinite(ancho) || ancho <= 0) issues.push('ancho');
      if (!Number.isFinite(alto) || alto <= 0) issues.push('alto');
      if (!Number.isFinite(cantidad) || cantidad <= 0) issues.push('cantidad');

      if (issues.length) {
        errors.push(`Producto ${index + 1}: verifica ${issues.join(', ')}.`);
        return;
      }

      items.push({
        codigo: codigoInput && codigoInput.value ? codigoInput.value.trim() : null,
        nombre: nombreInput && nombreInput.value ? nombreInput.value.trim() : null,
        largo_mm: Number(largo.toFixed(2)),
        ancho_mm: Number(ancho.toFixed(2)),
        alto_mm: Number(alto.toFixed(2)),
        cantidad: Math.max(1, Math.round(cantidad)),
      });
    });

    if (!items.length) {
      throw new Error(errors[0] || 'Agrega al menos un producto con dimensiones válidas.');
    }
    if (errors.length) {
      throw new Error(errors.join(' '));
    }
    if (items.length > 25) {
      throw new Error('El máximo permitido es de 25 productos por cálculo.');
    }
    return items;
  };

  const renderSummary = (items, resumen) => {
    if (!summaryEl) return;
    const totalReferencias = items.length;
    const totalUnidades = resumen && typeof resumen.total_unidades === 'number' ? resumen.total_unidades : items.reduce((acc, item) => acc + item.cantidad, 0);
    const volumenTotal = resumen && typeof resumen.volumen_total_m3 === 'number' ? resumen.volumen_total_m3 : 0;
    const volumenFmt = volumenTotal ? `${volumenTotal.toFixed(3)} m³` : 'N/D';
    summaryEl.innerHTML = `
      <p><span class="font-semibold">Referencias:</span> ${totalReferencias} (${totalUnidades} unidades)</p>
      <p><span class="font-semibold">Volumen total:</span> ${volumenFmt}</p>
      ${sedeId ? `<p class="text-xs opacity-70">Sede actual: ${sedeId}</p>` : ''}
    `;
  };

  const renderRecommendations = (recs, items, resumen) => {
    resultsContainer.innerHTML = '';
    if (!recs || !recs.length) {
      resultsEmpty?.classList.remove('hidden');
      if (resultsCount) resultsCount.classList.add('hidden');
      return;
    }
    resultsEmpty?.classList.add('hidden');
    if (resultsCount) {
      resultsCount.classList.remove('hidden');
      resultsCount.textContent = `${recs.length} opciones`;
    }
    recs.forEach((rec) => {
      const card = document.createElement('div');
      card.className = 'card bg-base-100 shadow-md border border-base-300/40';
      const body = document.createElement('div');
      body.className = 'card-body gap-3';
      const disponibilidad = `${rec.cajas_requeridas} caja(s) · disponible ${rec.cajas_disponibles}`;
      const deficit = typeof rec.deficit_cajas === 'number' ? rec.deficit_cajas : 0;
      const ocupacion = rec.ocupacion_percent != null ? `${rec.ocupacion_percent.toFixed(2)}%` : 'N/D';
      const detalleHtml = (rec.detalles || []).map((det) => {
        const sobrante = det.sobrante_unidades > 0 ? ` · sobrante ${det.sobrante_unidades}` : '';
        const nombre = det.nombre || det.codigo || 'Producto';
        const orientacion = det.orientacion_mm
          ? `${det.orientacion_mm.largo} × ${det.orientacion_mm.ancho} × ${det.orientacion_mm.alto} mm`
          : 'N/D';
        const layout = det.layout
          ? `${det.layout.frente} × ${det.layout.profundo} × ${det.layout.alto}`
          : 'N/D';
        const cajasLabel = det.cajas_requeridas > 0
          ? `${det.cajas_requeridas} caja(s)`
          : 'comparte cajas existentes';
        return `<li>
          <span class="font-medium">${nombre}</span>
          · ${det.cantidad} uds
          · ${cajasLabel}
          · capacidad ${det.capacidad_por_caja}${sobrante}
          <br><span class="opacity-80">Orientación: ${orientacion} · Distribución: ${layout}</span>
        </li>`;
      }).join('');
      body.innerHTML = `
        <div>
          <h3 class="text-lg font-semibold">${rec.modelo_nombre}</h3>
          <p class="text-sm opacity-70">${disponibilidad}</p>
        </div>
        <div class="text-sm">
          <p><span class="font-semibold">Ocupación estimada:</span> ${ocupacion}</p>
          <p><span class="font-semibold">Volumen total productos:</span> ${rec.volumen_total_productos_m3.toFixed(3)} m³</p>
          <p><span class="font-semibold">Volumen cajas:</span> ${rec.volumen_total_cajas_m3 ? rec.volumen_total_cajas_m3.toFixed(3) : 'N/D'} m³</p>
          ${deficit > 0 ? `<p class="text-warning">Faltan ${deficit} caja(s) en inventario.</p>` : ''}
        </div>
        <div class="bg-base-200/70 rounded p-2 text-xs">
          <p class="font-semibold mb-1">Detalle por producto</p>
          <ul class="list-disc list-inside space-y-1">${detalleHtml}</ul>
        </div>
      `;
      const footer = document.createElement('div');
      footer.className = 'card-actions justify-end';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm btn-primary';
      btn.textContent = 'Usar recomendación';
      btn.addEventListener('click', () => {
        selectedRecommendation = rec;
        if (modalDesc) {
          modalDesc.innerHTML = `
            Modelo <strong>${rec.modelo_nombre}</strong> · ${rec.cajas_requeridas} caja(s)
            <br />Ocupación estimada: ${rec.ocupacion_percent != null ? rec.ocupacion_percent.toFixed(2) : 'N/D'}%
          `;
        }
        if (modalForm instanceof HTMLFormElement) {
          const modeloField = modalForm.querySelector('input[name="modelo_id"]');
          const payloadField = modalForm.querySelector('input[name="payload"]');
          if (modeloField) modeloField.value = rec.modelo_id;
          if (payloadField) payloadField.value = JSON.stringify({ items, resumen });
        }
        if (modalError) {
          modalError.classList.add('hidden');
          modalError.textContent = '';
        }
        openDialog(modal);
      });
      footer.appendChild(btn);
      body.appendChild(footer);
      card.appendChild(body);
      resultsContainer.appendChild(card);
    });
  };

  const requestRecommendations = async () => {
    if (!calcBtn) return;
    try {
      calcBtn.disabled = true;
      calcBtn.classList.add('loading');
      setStatus('Calculando recomendaciones...', '');
      const items = collectItems();
      lastItemsPayload = items;
      const response = await fetch('/ordenes/calculadora/recomendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ items }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok !== true) {
        const message = payload && typeof payload.error === 'string' ? payload.error : 'No fue posible calcular recomendaciones.';
        setStatus(message, 'error');
        resultsWrapper?.classList.add('hidden');
        return;
      }
      resultsWrapper?.classList.remove('hidden');
      renderSummary(payload.items || items, payload.resumen || {});
      renderRecommendations(payload.recomendaciones || [], payload.items || items, payload.resumen || {});
      setStatus('Recomendaciones actualizadas.', 'success');
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Error inesperado calculando recomendaciones.';
      setStatus(message, 'error');
    } finally {
      calcBtn.disabled = false;
      calcBtn.classList.remove('loading');
    }
  };

  if (addBtn) addBtn.addEventListener('click', () => addRow());
  if (clearBtn) clearBtn.addEventListener('click', () => resetRows());
  if (calcBtn) calcBtn.addEventListener('click', requestRecommendations);

  if (modalForm instanceof HTMLFormElement) {
    modalForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!selectedRecommendation) {
        if (modalError) {
          modalError.classList.remove('hidden');
          modalError.textContent = 'Selecciona una recomendación válida.';
        }
        return;
      }
      const formData = new FormData(modalForm);
      const numeroOrden = (formData.get('numero_orden') || '').toString().trim();
      if (!numeroOrden) {
        modalForm.reportValidity();
        return;
      }
      if (modalError) {
        modalError.classList.add('hidden');
        modalError.textContent = '';
      }
      const cliente = (formData.get('cliente') || '').toString().trim();
      const ciudad = (formData.get('ciudad_destino') || '').toString().trim();
      const ubicacion = (formData.get('ubicacion_destino') || '').toString().trim();

      try {
        modalForm.querySelectorAll('button, input, select, textarea').forEach((el) => {
          if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
            el.disabled = true;
          }
        });
        if (modalSpinner) modalSpinner.classList.remove('hidden');
        const { tzOffset, localIso } = buildLocalTimestamp();
        const response = await fetch('/ordenes/calculadora/orden', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            numeroOrden,
            cliente,
            ciudadDestino: ciudad,
            ubicacionDestino: ubicacion,
            modeloId: selectedRecommendation.modelo_id,
            items: lastItemsPayload,
            clientTzOffset: tzOffset,
            clientLocalNow: localIso,
          }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload || payload.ok !== true) {
          const message = payload && typeof payload.error === 'string' ? payload.error : 'No fue posible crear la orden recomendada.';
          if (modalError) {
            modalError.classList.remove('hidden');
            modalError.textContent = message;
          }
          return;
        }
        closeDialog(modal);
        setStatus('Orden creada correctamente. Redirigiendo...', 'success');
        setTimeout(() => {
          window.location.href = '/ordenes';
        }, 800);
      } catch (err) {
        if (modalError) {
          modalError.classList.remove('hidden');
          modalError.textContent = 'Error inesperado creando la orden.';
        }
      } finally {
        if (modalSpinner) modalSpinner.classList.add('hidden');
        modalForm.querySelectorAll('button, input, select, textarea').forEach((el) => {
          if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
            el.disabled = false;
          }
        });
      }
    });
  }

  document.querySelectorAll('#modal-confirm-order [data-close]').forEach((el) => {
    el.addEventListener('click', () => closeDialog(modal));
  });
  const modalBackdrop = modal ? modal.querySelector('.modal-backdrop') : null;
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', () => closeDialog(modal));
  }

  if (importBtn && importModal) {
    importBtn.addEventListener('click', () => {
      resetProductosImport(true);
      openDialog(importModal);
    });
  }

  document.querySelectorAll('#modal-import-productos [data-close]').forEach((el) => {
    el.addEventListener('click', () => closeDialog(importModal));
  });
  const importBackdrop = importModal ? importModal.querySelector('.modal-backdrop') : null;
  if (importBackdrop) {
    importBackdrop.addEventListener('click', () => closeDialog(importModal));
  }

  if (importForm instanceof HTMLFormElement) {
    importForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!(importSubmit instanceof HTMLButtonElement)) return;
      if (!importForm.checkValidity()) {
        importForm.reportValidity();
        return;
      }

      importSubmit.disabled = true;
      if (importSpinner) importSpinner.classList.remove('hidden');
      if (importSubmitText) importSubmitText.textContent = 'Procesando...';
      if (importStatus) {
        importStatus.classList.add('hidden');
        importStatus.classList.remove('text-success', 'text-error');
        importStatus.textContent = '';
      }
      if (importErrors) {
        importErrors.classList.add('hidden');
        importErrors.textContent = '';
        importErrors.innerHTML = '';
      }

      const formData = new FormData(importForm);

      try {
        const response = await fetch('/ordenes/calculadora/import-productos', {
          method: 'POST',
          body: formData,
          credentials: 'same-origin',
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload || payload.ok !== true) {
          const message = payload && typeof payload.error === 'string'
            ? payload.error
            : 'No se pudo procesar el archivo.';
          if (importStatus) {
            importStatus.classList.remove('hidden');
            importStatus.classList.add('text-error');
            importStatus.textContent = message;
          }
          if (payload && payload.issues && Array.isArray(payload.issues) && payload.issues.length && importErrors) {
            importErrors.classList.remove('hidden');
            importErrors.innerHTML = `<ul class="list-disc list-inside">${payload.issues.slice(0, 5).map((issue) => {
              const row = Number(issue && issue.row);
              const msg = issue && typeof issue.message === 'string' ? issue.message : 'Fila omitida';
              const prefix = Number.isFinite(row) && row > 0 ? `Fila ${row}: ` : '';
              return `<li>${prefix}${msg}</li>`;
            }).join('')}</ul>${payload.issues.length > 5 ? '<p class="mt-1 text-xs opacity-80">Se muestran las primeras 5 incidencias.</p>' : ''}`;
          }
          return;
        }

        const summary = payload.summary || {};
        const processed = Number(summary.processed ?? 0);

        if (importStatus) {
          importStatus.classList.remove('hidden');
          importStatus.classList.add('text-success');
          importStatus.textContent = processed > 0
            ? `Se cargaron ${processed} producto${processed === 1 ? '' : 's'} en la calculadora.`
            : 'No se encontraron productos válidos en el archivo.';
        }

        if (summary.issues && Array.isArray(summary.issues) && summary.issues.length && importErrors) {
          importErrors.classList.remove('hidden');
          importErrors.innerHTML = `<ul class="list-disc list-inside">${summary.issues.slice(0, 5).map((issue) => {
            const row = Number(issue && issue.row);
            const msg = issue && typeof issue.message === 'string' ? issue.message : 'Fila omitida';
            const prefix = Number.isFinite(row) && row > 0 ? `Fila ${row}: ` : '';
            return `<li>${prefix}${msg}</li>`;
          }).join('')}</ul>${summary.issues.length > 5 ? '<p class="mt-1 text-xs opacity-80">Se muestran las primeras 5 incidencias.</p>' : ''}`;
        }

        const importedItems = Array.isArray(payload.items) ? payload.items : [];
        if (importedItems.length) {
          const prefills = buildPrefillsFromImport(importedItems);
          const timestamp = Date.now();
          const catalogExtras = importedItems.map((item, index) => ({
            id: `import-${timestamp}-${index}`,
            nombre: typeof item.nombre === 'string' && item.nombre.trim().length
              ? item.nombre.trim()
              : typeof item.descripcion === 'string' ? item.descripcion.trim() : null,
            descripcion: typeof item.descripcion === 'string' ? item.descripcion.trim() : null,
            codigo: typeof item.codigo === 'string' ? item.codigo.trim() : null,
            largo_mm: item.largo_mm,
            ancho_mm: item.ancho_mm,
            alto_mm: item.alto_mm,
            cantidad: item.cantidad,
            volumen_total_m3: item.volumen_total_m3,
          }));
          catalogoProductos = [...catalogoProductos, ...catalogExtras];
          resetRows(prefills);
          setStatus('Productos importados desde Excel. Revisa y ajusta antes de calcular.', 'success');
        }
      } catch (_err) {
        if (importStatus) {
          importStatus.classList.remove('hidden');
          importStatus.classList.add('text-error');
          importStatus.textContent = 'Error inesperado procesando el archivo.';
        }
      } finally {
        if (importSpinner) importSpinner.classList.add('hidden');
        if (importSubmit instanceof HTMLButtonElement) {
          importSubmit.disabled = false;
        }
        if (importSubmitText) importSubmitText.textContent = 'Procesar';
      }
    });
  }

  resetRows();
})();
