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
  const calcMixBtn = document.getElementById('btn-calc-mix');
  const statusEl = document.getElementById('calc-status');
  const resultsWrapper = document.getElementById('calc-results-wrapper');
  const resultsContainer = document.getElementById('calc-results');
  const resultsMode = document.getElementById('calc-results-mode');
  const resultsEmpty = document.getElementById('calc-results-empty');
  const resultsMixContainer = document.getElementById('calc-results-mix');
  const resultsMixEmpty = document.getElementById('calc-results-mix-empty');
  const resultsCount = document.getElementById('calc-results-count');
  const mixSaveWrap = document.getElementById('calc-mix-save-wrap');
  const mixSaveBanner = document.getElementById('calc-mix-banner');
  const mixSaveButton = document.getElementById('btn-save-calc-mix');
  const mixSaveNote = document.getElementById('calc-mix-save-note');

  let activeMixRecommendation = null;
  let lastResumen = null;

  const updateMixSaveButtonState = () => {
    if (!mixSaveButton) return;
    const ready = Boolean(activeMixRecommendation && activeMixRecommendation.total_cajas > 0);
    mixSaveButton.disabled = !ready;
    if (!ready && mixSaveNote) {
      mixSaveNote.classList.add('hidden');
      mixSaveNote.textContent = '';
    }
  };
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

  const setButtonLoading = (button, isLoading) => {
    if (!button) return;
    button.disabled = Boolean(isLoading);
    button.classList.toggle('loading', Boolean(isLoading));
  };

  const formatCajasCount = (value) => {
    if (!Number.isFinite(value) || value <= 0) return '0 caja(s)';
    const rounded = Math.round(value);
    if (Math.abs(value - rounded) < 0.01) {
      return `${rounded} caja(s)`;
    }
    return `${value.toFixed(2)} caja(s)`;
  };

  const setResultsMode = (mode) => {
    if (mode === 'mix') {
      resultsContainer?.classList.add('hidden');
      resultsMixContainer?.classList.remove('hidden');
      resultsMode?.classList.remove('hidden');
      mixSaveWrap?.classList.remove('hidden');
      mixSaveBanner?.classList.remove('hidden');
    } else {
      resultsContainer?.classList.remove('hidden');
      resultsMixContainer?.classList.add('hidden');
      resultsMode?.classList.add('hidden');
      mixSaveWrap?.classList.add('hidden');
      mixSaveBanner?.classList.add('hidden');
      if (mixSaveNote) {
        mixSaveNote.classList.add('hidden');
        mixSaveNote.textContent = '';
      }
      activeMixRecommendation = null;
      updateMixSaveButtonState();
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
    if (nombreInput) nombreInput.value = product.nombre || product.descripcion || '';
    if (codigoInput) codigoInput.value = product.codigo || '';
    if (largoInput) largoInput.value = product.largo_mm != null ? product.largo_mm : '';
    if (anchoInput) anchoInput.value = product.ancho_mm != null ? product.ancho_mm : '';
    if (altoInput) altoInput.value = product.alto_mm != null ? product.alto_mm : '';
  };

  let catalogKeyCounter = 0;
  const normalizeCatalogItem = (item) => {
    if (!item || typeof item !== 'object') return null;
    if (!item.__catalogKey) {
      catalogKeyCounter += 1;
      const fallback = `catalog-${Date.now()}-${catalogKeyCounter}`;
      item.__catalogKey = String(item.id != null ? item.id : fallback);
    } else {
      item.__catalogKey = String(item.__catalogKey);
    }
    return item;
  };

  catalogoProductos = catalogoProductos
    .map((item) => normalizeCatalogItem(item))
    .filter(Boolean);

  const getCatalogKey = (item) => (item ? item.__catalogKey || String(item.id ?? '') : '');

  const findCatalogItem = (key) => {
    if (!key) return null;
    return catalogoProductos.find((item) => getCatalogKey(item) === key || String(item.id ?? '') === key) || null;
  };

  const describeCatalogItem = (item) => {
    if (!item) return 'Catálogo';
    const parts = [];
    if (item.nombre) parts.push(item.nombre);
    else if (item.descripcion) parts.push(item.descripcion);
    if (item.codigo) parts.push(`#${item.codigo}`);
    return parts.length ? parts.join(' · ') : 'Catálogo';
  };

  const catalogModal = document.getElementById('modal-catalogo');
  const catalogSearch = catalogModal ? catalogModal.querySelector('[data-catalog-search]') : null;
  const catalogList = catalogModal ? catalogModal.querySelector('[data-catalog-list]') : null;
  const catalogEmpty = catalogModal ? catalogModal.querySelector('[data-catalog-empty]') : null;
  let activeCatalogRow = null;
  const rowCatalogControls = new WeakMap();

  const clearRowCatalogSelection = (row, skipUpdate) => {
    const controls = rowCatalogControls.get(row);
    if (!controls) return;
    if (controls.hidden) controls.hidden.value = '';
    if (controls.label) {
      controls.label.textContent = 'Catálogo';
      controls.label.title = 'Catálogo';
    }
    if (controls.hint) controls.hint.textContent = 'Usa el catálogo para completar nombre y medidas.';
    if (!skipUpdate) updateAddButtonState();
  };

  const setRowCatalogSelection = (row, product) => {
    if (!row || !product) return;
    const controls = rowCatalogControls.get(row);
    if (!controls) return;
    const key = getCatalogKey(product);
    if (!key) return;
    if (controls.hidden) controls.hidden.value = key;
    if (controls.label) {
      const description = describeCatalogItem(product);
      controls.label.textContent = description;
      controls.label.title = description;
    }
    if (controls.hint) controls.hint.textContent = 'Catálogo aplicado. Puedes cambiarlo cuando quieras.';
    fillFromCatalog(row, product);
    updateAddButtonState();
  };

  const renderCatalogTable = () => {
    if (!catalogList) return;
    const term = (catalogSearch?.value || '').trim().toLowerCase();
    const currentKey = activeCatalogRow ? (rowCatalogControls.get(activeCatalogRow)?.hidden?.value || '') : '';
    const filtered = catalogoProductos.filter((item) => {
      if (!term) return true;
      const pool = [item.nombre, item.descripcion, item.codigo]
        .filter(Boolean)
        .map((value) => value.toString().toLowerCase());
      return pool.some((value) => value.includes(term));
    });
    catalogList.innerHTML = '';
    if (!filtered.length) {
      if (catalogEmpty) catalogEmpty.classList.remove('hidden');
      return;
    }
    if (catalogEmpty) catalogEmpty.classList.add('hidden');
    filtered.forEach((item) => {
      const key = getCatalogKey(item);
      const tr = document.createElement('tr');
      if (currentKey && key === currentKey) {
        tr.classList.add('bg-primary/10');
      }
      const nameCell = document.createElement('td');
      nameCell.innerHTML = `<div class="font-semibold text-sm">${item.nombre || item.descripcion || 'Producto'}</div>`
        + `<div class="text-xs opacity-70">${item.codigo || 'Sin código'}</div>`;
      const dimsCell = document.createElement('td');
      dimsCell.className = 'text-xs';
      dimsCell.innerHTML = `${item.largo_mm ?? '—'} × ${item.ancho_mm ?? '—'} × ${item.alto_mm ?? '—'} mm`;
      const actionsCell = document.createElement('td');
      actionsCell.className = 'flex gap-2 justify-end';
      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'btn btn-xs btn-primary';
      selectBtn.dataset.action = 'pick';
      selectBtn.dataset.id = key;
      selectBtn.textContent = 'Seleccionar';
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-xs btn-error btn-outline';
      deleteBtn.dataset.action = 'delete';
      deleteBtn.dataset.id = key;
      deleteBtn.textContent = 'Eliminar';
      actionsCell.append(selectBtn, deleteBtn);
      tr.append(nameCell, dimsCell, actionsCell);
      catalogList.appendChild(tr);
    });
  };

  const openCatalogModal = (row) => {
    if (!catalogModal) return;
    activeCatalogRow = row;
    if (catalogSearch) catalogSearch.value = '';
    renderCatalogTable();
    openDialog(catalogModal);
    window.setTimeout(() => {
      catalogSearch?.focus();
      catalogSearch?.select?.();
    }, 50);
  };

  const closeCatalogModal = () => {
    if (!catalogModal) return;
    activeCatalogRow = null;
    closeDialog(catalogModal);
  };

  const removeCatalogItem = async (key) => {
    if (!key) return false;
    const target = findCatalogItem(key);
    if (!target) return false;
    const numericId = Number(target.id);
    let removedMessage = 'Referencia eliminada de la sesión.';
    let removedType = '';

    if (Number.isFinite(numericId) && numericId > 0) {
      try {
        const response = await fetch(`/ordenes/calculadora/catalogo/${numericId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload || payload.ok !== true) {
          const message = payload && typeof payload.error === 'string' ? payload.error : 'No se pudo eliminar la referencia.';
          setStatus(message, 'error');
          return false;
        }
        removedMessage = 'Referencia eliminada del catálogo.';
        removedType = 'success';
      } catch (_err) {
        setStatus('Error eliminando la referencia del catálogo.', 'error');
        return false;
      }
    }

    const before = catalogoProductos.length;
    catalogoProductos = catalogoProductos.filter((item) => getCatalogKey(item) !== key);
    if (catalogoProductos.length === before) return false;
    Array.from(tbody.querySelectorAll('.calc-item')).forEach((row) => {
      const controls = rowCatalogControls.get(row);
      if (controls && controls.hidden && controls.hidden.value === key) {
        clearRowCatalogSelection(row, true);
      }
    });
    renderCatalogTable();
    setStatus(removedMessage, removedType);
    updateAddButtonState();
    return true;
  };

  const buildCatalogPicker = (row, prefillId) => {
    const container = document.createElement('div');
    container.className = 'flex flex-col gap-1';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'btn btn-sm btn-outline w-full justify-center text-center';
    trigger.setAttribute('aria-label', 'Abrir catálogo de productos');
    const labelSpan = document.createElement('span');
    labelSpan.setAttribute('data-catalog-label', '');
    labelSpan.className = 'truncate max-w-full';
    labelSpan.textContent = 'Catálogo';
    labelSpan.title = 'Catálogo';
    trigger.append(labelSpan);
    trigger.addEventListener('click', () => openCatalogModal(row));

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn btn-ghost btn-xs px-0 self-start';
    clearBtn.textContent = 'Limpiar';
    clearBtn.addEventListener('click', () => {
      clearRowCatalogSelection(row);
    });

    const hintText = document.createElement('span');
    hintText.className = 'text-xs opacity-70';
    hintText.textContent = 'Usa el catálogo para completar nombre y medidas.';

    const hiddenInput = document.createElement('input');
    hiddenInput.type = 'hidden';
    hiddenInput.setAttribute('data-field', 'catalogo');

    container.append(trigger, clearBtn, hintText, hiddenInput);

    const wrapper = createFieldWrapper('Catálogo', container, 'md:col-span-2');
    rowCatalogControls.set(row, {
      trigger,
      label: labelSpan,
      hint: hintText,
      hidden: hiddenInput,
      clearBtn,
    });

    if (prefillId) {
      const product = findCatalogItem(String(prefillId));
      if (product) {
        setRowCatalogSelection(row, product);
      }
    }

    return wrapper;
  };

  if (catalogSearch) {
    catalogSearch.addEventListener('input', () => renderCatalogTable());
  }

  if (catalogList) {
    catalogList.addEventListener('click', async (event) => {
      const actionBtn = event.target.closest('[data-action]');
      if (!actionBtn) return;
      const { action, id } = actionBtn.dataset;
      if (!id) return;
      if (action === 'pick') {
        const product = findCatalogItem(id);
        if (product && activeCatalogRow) {
          setRowCatalogSelection(activeCatalogRow, product);
          closeCatalogModal();
        }
      } else if (action === 'delete') {
        if (window.confirm('¿Eliminar esta referencia del catálogo?')) {
          await removeCatalogItem(id);
        }
      }
    });
  }

  if (catalogModal) {
    catalogModal.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', () => closeCatalogModal());
    });
    const catalogBackdrop = catalogModal.querySelector('.modal-backdrop');
    if (catalogBackdrop) {
      catalogBackdrop.addEventListener('click', () => closeCatalogModal());
    }
  }

    const isPositiveField = (input) => {
      if (!(input instanceof HTMLInputElement)) return false;
      const raw = input.value;
      if (raw == null || raw.trim() === '') return false;
      const value = Number(raw);
      return Number.isFinite(value) && value > 0;
    };

    const isRowComplete = (row) => {
      if (!row) return false;
      const nombreInput = row.querySelector('[data-field="nombre"]');
      const codigoInput = row.querySelector('[data-field="codigo"]');
      const catalogInput = row.querySelector('[data-field="catalogo"]');
      const largoInput = row.querySelector('[data-field="largo"]');
      const anchoInput = row.querySelector('[data-field="ancho"]');
      const altoInput = row.querySelector('[data-field="alto"]');
      const cantidadInput = row.querySelector('[data-field="cantidad"]');
      const hasDescriptor = Boolean(
        (catalogInput && catalogInput.value) ||
        (nombreInput && nombreInput.value && nombreInput.value.trim()) ||
        (codigoInput && codigoInput.value && codigoInput.value.trim()),
      );
      if (!hasDescriptor) return false;
      return isPositiveField(largoInput)
        && isPositiveField(anchoInput)
        && isPositiveField(altoInput)
        && isPositiveField(cantidadInput);
    };

    const updateAddButtonState = () => {
      if (!addBtn) return;
      const rows = Array.from(tbody.querySelectorAll('.calc-item'));
      const lastRow = rows[rows.length - 1];
      const ready = lastRow ? isRowComplete(lastRow) : true;
      addBtn.disabled = !ready;
      addBtn.title = ready ? '' : 'Completa el producto actual antes de agregar otro.';
    };

    const attachRowListeners = (row) => {
      const fields = row.querySelectorAll('[data-field]');
      fields.forEach((field) => {
        if (field instanceof HTMLInputElement) {
          field.addEventListener('input', updateAddButtonState);
          field.addEventListener('change', updateAddButtonState);
        } else if (field instanceof HTMLSelectElement) {
          field.addEventListener('change', updateAddButtonState);
        }
      });
    };

  const addRow = (prefill) => {
    const row = document.createElement('div');
    row.className = 'calc-item grid grid-cols-1 md:grid-cols-12 gap-3 p-3 bg-base-100/80 border border-base-300/40 rounded-lg shadow-sm';

    const catalogWrapper = buildCatalogPicker(row, prefill && prefill.catalogoId);

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
      } else {
        updateAddButtonState();
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

    attachRowListeners(row);
    updateAddButtonState();
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
    updateAddButtonState();
  };

  const resetRows = (prefillList) => {
    setRows(prefillList);
    if (statusEl) statusEl.textContent = '';
    resultsWrapper?.classList.add('hidden');
    if (resultsContainer) {
      resultsContainer.classList.remove('hidden');
      resultsContainer.innerHTML = '';
    }
    resultsEmpty?.classList.add('hidden');
    resultsMode?.classList.add('hidden');
    if (resultsMixContainer) {
      resultsMixContainer.classList.add('hidden');
      resultsMixContainer.innerHTML = '';
    }
    resultsMixEmpty?.classList.add('hidden');
    if (resultsCount) resultsCount.classList.add('hidden');
    selectedRecommendation = null;
    activeMixRecommendation = null;
    lastResumen = null;
    updateMixSaveButtonState();
    updateAddButtonState();
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

  const renderSummary = (items, resumen, mixSummary) => {
    if (!summaryEl) return;
    const totalReferencias = items.length;
    const totalUnidades = resumen && typeof resumen.total_unidades === 'number' ? resumen.total_unidades : items.reduce((acc, item) => acc + item.cantidad, 0);
    const volumenTotal = resumen && typeof resumen.volumen_total_m3 === 'number' ? resumen.volumen_total_m3 : 0;
    const volumenFmt = volumenTotal ? `${volumenTotal.toFixed(3)} m³` : 'N/D';
    const mixDetails = [];
    if (mixSummary && typeof mixSummary === 'object') {
      if (typeof mixSummary.total_cajas === 'number') {
        mixDetails.push(`<p><span class="font-semibold">Cajas asignadas:</span> ${mixSummary.total_cajas}</p>`);
      }
      const combinacion = Array.isArray(mixSummary.modelos)
        ? mixSummary.modelos
          .filter((modelo) => modelo && modelo.cajas_asignadas > 0)
          .map((modelo) => `${modelo.cajas_asignadas} x ${modelo.modelo_nombre}`)
          .join(', ')
        : '';
      if (combinacion) {
        mixDetails.push(`<p><span class="font-semibold">Combinacion sugerida:</span> ${combinacion}</p>`);
      }
      if (typeof mixSummary.total_unidades_sin_cobertura === 'number' && mixSummary.total_unidades_sin_cobertura > 0) {
        mixDetails.push(`<p class="text-warning"><span class="font-semibold">Unidades sin cobertura:</span> ${mixSummary.total_unidades_sin_cobertura}</p>`);
      } else if (typeof mixSummary.total_unidades_sin_cobertura === 'number') {
        mixDetails.push('<p class="text-success"><span class="font-semibold">Cobertura completa:</span> todas las unidades tienen cajas asignadas.</p>');
      }
    }
    summaryEl.innerHTML = `
      <p><span class="font-semibold">Referencias:</span> ${totalReferencias} (${totalUnidades} unidades)</p>
      <p><span class="font-semibold">Volumen total:</span> ${volumenFmt}</p>
      ${mixDetails.join('')}
      ${sedeId ? `<p class="text-xs opacity-70">Sede actual: ${sedeId}</p>` : ''}
    `;
  };

  const renderRecommendations = (recs, items, resumen) => {
    setResultsMode('standard');
    selectedRecommendation = null;
    activeMixRecommendation = null;
    if (mixSaveWrap) mixSaveWrap.classList.add('hidden');
    if (mixSaveBanner) mixSaveBanner.classList.add('hidden');
    if (resultsContainer) {
      resultsContainer.innerHTML = '';
      resultsContainer.classList.remove('hidden');
    }
    if (resultsMixContainer) resultsMixContainer.innerHTML = '';
    resultsMixEmpty?.classList.add('hidden');
    if (!recs || !recs.length) {
      resultsEmpty?.classList.remove('hidden');
      resultsContainer?.classList.add('hidden');
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

  const renderMixResults = (mix, _items) => {
    setResultsMode('mix');
    selectedRecommendation = null;
    activeMixRecommendation = mix || null;
    resultsEmpty?.classList.add('hidden');
    if (resultsContainer) {
      resultsContainer.innerHTML = '';
      resultsContainer.classList.add('hidden');
    }
    if (!resultsMixContainer) return;
    resultsMixContainer.innerHTML = '';

    const hasAssignments = mix
      && Array.isArray(mix.modelos)
      && mix.modelos.some((modelo) => modelo && modelo.cajas_asignadas > 0);

    if (!mix || !hasAssignments) {
      resultsMixEmpty?.classList.remove('hidden');
      if (resultsCount) resultsCount.classList.add('hidden');
      if (mixSaveWrap) mixSaveWrap.classList.add('hidden');
      activeMixRecommendation = null;
      updateMixSaveButtonState();
      return;
    }

    resultsMixEmpty?.classList.add('hidden');
    mixSaveWrap?.classList.remove('hidden');
    updateMixSaveButtonState();
    if (resultsCount) {
      resultsCount.classList.remove('hidden');
      const totalCajas = typeof mix.total_cajas === 'number' ? mix.total_cajas : 0;
      const modelosCount = Array.isArray(mix.modelos)
        ? mix.modelos.filter((modelo) => modelo && modelo.cajas_asignadas > 0).length
        : 0;
      resultsCount.textContent = totalCajas > 0
        ? `${totalCajas} caja(s)`
        : `${modelosCount} modelo(s)`;
    }

    const modelosListHtml = (Array.isArray(mix.modelos) ? mix.modelos : [])
      .map((modelo) => {
        if (!modelo) return '';
        const restantes = modelo.cajas_restantes > 0 ? ` · quedan ${modelo.cajas_restantes}` : '';
        const deficit = modelo.deficit_cajas > 0
          ? `<span class="badge badge-warning badge-sm ml-1">Faltan ${modelo.deficit_cajas}</span>`
          : '';
        return `<li>
          <span class="font-medium">${modelo.modelo_nombre}</span>
          · ${modelo.cajas_asignadas} caja(s)${restantes}
          ${deficit}
        </li>`;
      })
      .filter(Boolean)
      .join('');
    const modelosContent = modelosListHtml || '<li class="text-sm opacity-70">No se asignaron modelos.</li>';

    const modelosCard = document.createElement('div');
    modelosCard.className = 'card bg-base-100 shadow border border-base-300/40';
    modelosCard.innerHTML = `
      <div class="card-body gap-3">
        <div>
          <h3 class="text-lg font-semibold">Distribución por modelo</h3>
          <p class="text-sm opacity-70">Total asignado: ${mix.total_cajas} caja(s)</p>
        </div>
        <ul class="list-disc list-inside space-y-1 text-sm">
          ${modelosContent}
        </ul>
      </div>
    `;

    const productosCard = document.createElement('div');
    productosCard.className = 'card bg-base-100 shadow border border-base-300/40';
    const productosListHtml = (Array.isArray(mix.productos) ? mix.productos : [])
      .map((detalle) => {
        if (!detalle) return '';
        const nombre = detalle.nombre || detalle.codigo || 'Producto';
        const sinCobertura = detalle.sin_cobertura > 0
          ? `<p class="text-warning text-xs">Sin cobertura: ${detalle.sin_cobertura} unidad(es)</p>`
          : '';
        const asignacionesHtml = (Array.isArray(detalle.asignaciones) ? detalle.asignaciones : [])
          .map((asignacion) => {
            if (!asignacion) return '';
            const orientacion = asignacion.orientacion_mm
              ? `${asignacion.orientacion_mm.largo} × ${asignacion.orientacion_mm.ancho} × ${asignacion.orientacion_mm.alto} mm`
              : 'N/D';
            const layout = asignacion.layout
              ? `${asignacion.layout.frente} × ${asignacion.layout.profundo} × ${asignacion.layout.alto}`
              : 'N/D';
            const sobrante = asignacion.sobrante_unidades > 0 ? ` · sobrante ${asignacion.sobrante_unidades}` : '';
            return `<li>
              <span class="font-medium">${asignacion.modelo_nombre}</span>
              · ${asignacion.unidades_asignadas} uds
              · ${formatCajasCount(asignacion.cajas_usadas)} (equivalente)
              · capacidad ${asignacion.capacidad_por_caja}${sobrante}
              <br><span class="opacity-70 text-xs">Orientacion: ${orientacion} · Distribucion: ${layout}</span>
            </li>`;
          })
          .filter(Boolean)
          .join('');
        const asignacionesBlock = asignacionesHtml
          ? `<ul class="list-disc list-inside space-y-1 text-xs">${asignacionesHtml}</ul>`
          : '<p class="text-xs opacity-70">Sin asignaciones para este producto.</p>';
        return `<li class="border border-base-300/40 rounded-lg p-3 space-y-2">
          <div>
            <p class="text-sm font-semibold">${nombre}</p>
            <p class="text-xs opacity-70">Solicitado: ${detalle.cantidad} uds · Cubierto: ${detalle.cubierto_unidades} uds</p>
          </div>
          ${sinCobertura}
          ${asignacionesBlock}
        </li>`;
      })
      .filter(Boolean)
      .join('');
    const productosContent = productosListHtml || '<li class="text-xs opacity-70">No se encontraron productos en la mezcla.</li>';

    productosCard.innerHTML = `
      <div class="card-body gap-3">
        <div>
          <h3 class="text-lg font-semibold">Cobertura por producto</h3>
          <p class="text-sm opacity-70">Incluye asignaciones según inventario disponible.</p>
        </div>
        <ul class="space-y-2">
          ${productosContent}
        </ul>
      </div>
    `;

    resultsMixContainer.appendChild(modelosCard);
    resultsMixContainer.appendChild(productosCard);
  };

  const buildMixOrdenPayload = (mix, items, resumen) => {
    if (!mix) return null;
    return {
      modelos: Array.isArray(mix.modelos) ? mix.modelos.map((modelo) => ({
        modelo_id: modelo.modelo_id,
        modelo_nombre: modelo.modelo_nombre,
        cajas_asignadas: modelo.cajas_asignadas,
        cajas_disponibles: modelo.cajas_disponibles,
        cajas_restantes: modelo.cajas_restantes,
        deficit_cajas: modelo.deficit_cajas,
        volumen_caja_m3: modelo.volumen_caja_m3,
      })) : [],
      productos: Array.isArray(mix.productos) ? mix.productos.map((producto) => ({
        codigo: producto.codigo,
        nombre: producto.nombre,
        cantidad: producto.cantidad,
        cubierto_unidades: producto.cubierto_unidades,
        sin_cobertura: producto.sin_cobertura,
        asignaciones: Array.isArray(producto.asignaciones) ? producto.asignaciones.map((asignacion) => ({
          modelo_id: asignacion.modelo_id,
          modelo_nombre: asignacion.modelo_nombre,
          cajas_usadas: asignacion.cajas_usadas,
          unidades_asignadas: asignacion.unidades_asignadas,
          capacidad_por_caja: asignacion.capacidad_por_caja,
          sobrante_unidades: asignacion.sobrante_unidades,
          orientacion_mm: asignacion.orientacion_mm,
          layout: asignacion.layout,
        })) : [],
      })) : [],
      total_cajas: mix.total_cajas,
      total_unidades_sin_cobertura: mix.total_unidades_sin_cobertura,
      resumen: resumen || lastResumen || {},
      items,
    };
  };

  const openMixSaveModal = () => {
    if (!modal) return;
    if (!activeMixRecommendation) {
      setStatus('No hay combinación mixta lista para guardar.', 'error');
      return;
    }

    const payload = buildMixOrdenPayload(activeMixRecommendation, lastItemsPayload, lastResumen);
    if (!payload) {
      setStatus('No hay datos válidos de la mezcla para guardar.', 'error');
      return;
    }

    if (modalDesc) {
      modalDesc.innerHTML = `
        Mezcla de modelos seleccionada
        <br />Total cajas asignadas: ${activeMixRecommendation.total_cajas}
      `;
    }
    if (modalForm instanceof HTMLFormElement) {
      const modeloField = modalForm.querySelector('input[name="modelo_id"]');
      const payloadField = modalForm.querySelector('input[name="payload"]');
      if (modeloField) modeloField.value = 'mix';
      if (payloadField) payloadField.value = JSON.stringify(payload);
    }
    if (modalError) {
      modalError.classList.add('hidden');
      modalError.textContent = '';
    }
    openDialog(modal);
  };

  const requestRecommendations = async () => {
    if (!calcBtn) return;
    try {
      setButtonLoading(calcBtn, true);
      if (calcMixBtn) calcMixBtn.disabled = true;
      setStatus('Calculando recomendaciones...', '');
      resultsEmpty?.classList.add('hidden');
      resultsMixEmpty?.classList.add('hidden');
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
      renderSummary(payload.items || items, payload.resumen || {}, null);
      lastResumen = payload.resumen || {};
      renderRecommendations(payload.recomendaciones || [], payload.items || items, payload.resumen || {});
      setStatus('Recomendaciones actualizadas.', 'success');
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Error inesperado calculando recomendaciones.';
      setStatus(message, 'error');
    } finally {
      setButtonLoading(calcBtn, false);
      if (calcMixBtn) calcMixBtn.disabled = false;
    }
  };

  const requestMixedRecommendations = async () => {
    if (!calcMixBtn) return;
    try {
      setButtonLoading(calcMixBtn, true);
      if (calcBtn) calcBtn.disabled = true;
      setStatus('Calculando mezcla de modelos...', '');
      resultsEmpty?.classList.add('hidden');
      resultsMixEmpty?.classList.add('hidden');
      const items = collectItems();
      lastItemsPayload = items;
      const response = await fetch('/ordenes/calculadora/recomendar-mixto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ items }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok !== true) {
        const message = payload && typeof payload.error === 'string' ? payload.error : 'No fue posible generar la combinación mixta.';
        setStatus(message, 'error');
        resultsWrapper?.classList.add('hidden');
        activeMixRecommendation = null;
        return;
      }
      resultsWrapper?.classList.remove('hidden');
      lastResumen = payload.resumen || {};
      renderSummary(payload.items || items, lastResumen, payload.mix || null);
      renderMixResults(payload.mix || null, payload.items || items);
      setStatus('Recomendación mixta lista.', 'success');
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Error inesperado calculando la recomendación mixta.';
      setStatus(message, 'error');
    } finally {
      setButtonLoading(calcMixBtn, false);
      if (calcBtn) calcBtn.disabled = false;
    }
  };

  if (addBtn) addBtn.addEventListener('click', () => {
    if (addBtn.disabled) return;
    addRow();
  });
  if (clearBtn) clearBtn.addEventListener('click', () => resetRows());
  if (calcBtn) calcBtn.addEventListener('click', requestRecommendations);
  if (calcMixBtn) calcMixBtn.addEventListener('click', requestMixedRecommendations);
  if (mixSaveButton) mixSaveButton.addEventListener('click', () => {
    if (mixSaveButton.disabled) return;
    openMixSaveModal();
  });

  if (modalForm instanceof HTMLFormElement) {
    modalForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const isMixMode = activeMixRecommendation && modalForm.querySelector('input[name="modelo_id"]').value === 'mix';
      if (!selectedRecommendation && !isMixMode) {
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
            modeloId: isMixMode ? null : selectedRecommendation.modelo_id,
            mezcla: isMixMode ? buildMixOrdenPayload(activeMixRecommendation, lastItemsPayload, lastResumen) : null,
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
          if (mixSaveNote && isMixMode) {
            mixSaveNote.classList.remove('hidden');
            mixSaveNote.textContent = message;
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
  updateAddButtonState();
  updateMixSaveButtonState();
})();
