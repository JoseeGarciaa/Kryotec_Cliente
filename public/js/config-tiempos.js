(function(){
  const state = window.__CONFIG_TIEMPOS__ || { configs: [], modelos: [], sedes: [], selectedSedeId: null };
  const configs = Array.isArray(state.configs) ? state.configs.slice() : [];
  const modelos = Array.isArray(state.modelos) ? state.modelos.slice() : [];
  const sedes = Array.isArray(state.sedes) ? state.sedes.slice() : [];
  const data = { configs, modelos, sedes, selectedSedeId: state.selectedSedeId };

  const qs = (sel) => document.querySelector(sel);
  const sedeSelect = qs('#cfg-sede');
  const modeloSelect = qs('#cfg-modelo');
  const inputMinCong = qs('#cfg-min-cong');
  const inputAtem = qs('#cfg-atem');
  const inputMaxAtem = qs('#cfg-max-atem');
  const inputVida = qs('#cfg-vida');
  const inputReuso = qs('#cfg-reuso');
  const alertBox = qs('#cfg-alert');
  const statusLabel = qs('#cfg-status');
  const saveBtn = qs('#cfg-save');
  const toggleBtn = qs('#cfg-toggle');
  const resetBtn = qs('#cfg-reset');
  const tableBody = qs('#cfg-table tbody');

  const minutesFromSeconds = (sec) => {
    const value = Number(sec);
    if (!Number.isFinite(value) || value <= 0) return '';
    return Math.max(1, Math.round(value / 60));
  };

  const secondsFromMinutes = (min) => {
    const value = Number(min);
    if (!Number.isFinite(value) || value <= 0) return NaN;
    return Math.round(value * 60);
  };

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const getSelectedSedeId = () => {
    const raw = sedeSelect ? sedeSelect.value : '';
    if (!raw || raw === 'global') return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const getSelectedModeloId = () => {
    const raw = modeloSelect ? modeloSelect.value : '';
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const findConfig = (sedeId, modeloId) => {
    if (modeloId === null || modeloId === undefined) return null;
    return data.configs.find((cfg) => {
      const cfgSede = cfg.sedeId === undefined ? null : cfg.sedeId;
      const targetSede = sedeId === undefined ? null : sedeId;
      return (cfgSede === targetSede)
        && Number(cfg.modeloId ?? null) === Number(modeloId)
        && String(cfg.nombreConfig || 'default') === 'default';
    }) || null;
  };

  const formatFecha = (value) => {
    if (!value) return '-';
    try {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return '-';
      return date.toLocaleString('es-CO');
    } catch {
      return '-';
    }
  };

  const clearAlert = () => {
    if (!alertBox) return;
    alertBox.classList.add('hidden');
    alertBox.textContent = '';
    alertBox.className = 'alert hidden';
  };

  const showAlert = (type, message) => {
    if (!alertBox) return;
    alertBox.classList.remove('hidden');
    alertBox.classList.remove('alert-success', 'alert-error', 'alert-warning', 'alert-info');
    const variant = type === 'error' ? 'alert-error' : type === 'warning' ? 'alert-warning' : type === 'info' ? 'alert-info' : 'alert-success';
    alertBox.classList.add('alert', variant);
    alertBox.textContent = message;
  };

  const updateStatus = (text, variant) => {
    if (!statusLabel) return;
    statusLabel.textContent = text || '';
    statusLabel.classList.remove('text-success', 'text-error', 'text-warning', 'text-info', 'hidden');
    if (!text) {
      statusLabel.classList.add('hidden');
      return;
    }
    const cls = variant === 'error' ? 'text-error' : variant === 'warning' ? 'text-warning' : variant === 'info' ? 'text-info' : 'text-success';
    statusLabel.classList.add(cls);
  };

  const fillInputs = (cfg) => {
    if (inputMinCong) inputMinCong.value = cfg ? minutesFromSeconds(cfg.minCongelamientoSec) : '';
    if (inputAtem) inputAtem.value = cfg ? minutesFromSeconds(cfg.atemperamientoSec) : '';
    if (inputMaxAtem) inputMaxAtem.value = cfg ? minutesFromSeconds(cfg.maxSobreAtemperamientoSec) : '';
    if (inputVida) inputVida.value = cfg ? minutesFromSeconds(cfg.vidaCajaSec) : '';
    if (inputReuso) inputReuso.value = cfg ? minutesFromSeconds(cfg.minReusoSec) : '';
  };

  const syncForm = () => {
    clearAlert();
    const sedeId = getSelectedSedeId();
    const modeloId = getSelectedModeloId();
    if (!modeloId) {
      fillInputs(null);
      if (toggleBtn) {
        toggleBtn.classList.add('hidden');
        toggleBtn.removeAttribute('data-config-id');
      }
      updateStatus('Selecciona un modelo para editar los valores.', 'info');
      return;
    }
    const currentCfg = findConfig(sedeId, modeloId);
    if (currentCfg) {
      fillInputs(currentCfg);
      if (toggleBtn) {
        toggleBtn.classList.remove('hidden');
        toggleBtn.dataset.configId = String(currentCfg.id);
        toggleBtn.textContent = currentCfg.activo ? 'Desactivar' : 'Activar';
        toggleBtn.classList.toggle('btn-outline', true);
        toggleBtn.classList.toggle('btn-error', currentCfg.activo === true);
        toggleBtn.classList.toggle('btn-success', currentCfg.activo !== true);
      }
      updateStatus(currentCfg.activo ? 'Configuración activa.' : 'Configuración inactiva.', currentCfg.activo ? 'success' : 'warning');
      return;
    }
    const fallback = sedeId !== null ? findConfig(null, modeloId) : null;
    fillInputs(fallback);
    if (toggleBtn) {
      toggleBtn.classList.add('hidden');
      toggleBtn.removeAttribute('data-config-id');
    }
    if (fallback) {
      updateStatus('Sin configuración propia. Se muestran los valores globales como referencia.', 'info');
    } else {
      updateStatus('Aún no hay configuración para esta combinación.', 'info');
    }
  };

  const minutesFromInput = (input, label) => {
    if (!input) return { ok: false, error: `${label} es obligatorio` };
    const value = Number(input.value);
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, error: `${label} debe ser mayor a 0` };
    }
    return { ok: true, value: secondsFromMinutes(value) };
  };

  const collectPayload = () => {
    const sedeId = getSelectedSedeId();
    const modeloId = getSelectedModeloId();
    if (!modeloId) {
      return { ok: false, error: 'Selecciona un modelo.' };
    }
    const parts = [
      { input: inputMinCong, label: 'Congelamiento' },
      { input: inputAtem, label: 'Atemperamiento' },
      { input: inputMaxAtem, label: 'Máximo sobre atemperamiento' },
      { input: inputVida, label: 'Vida útil de la caja' },
      { input: inputReuso, label: 'Tiempo mínimo para reutilización' },
    ];
    const values = {};
    for (const part of parts) {
      const result = minutesFromInput(part.input, part.label);
      if (!result.ok) return { ok: false, error: result.error };
      const key = part.label;
      if (key === 'Congelamiento') values.min_congelamiento_sec = result.value;
      else if (key === 'Atemperamiento') values.atemperamiento_sec = result.value;
      else if (key === 'Máximo sobre atemperamiento') values.max_sobre_atemperamiento_sec = result.value;
      else if (key === 'Vida útil de la caja') values.vida_caja_sec = result.value;
      else values.min_reuso_sec = result.value;
    }
    return {
      ok: true,
      payload: {
        sedeId,
        modeloId,
        nombreConfig: 'default',
        minCongelamientoSec: values.min_congelamiento_sec,
        atemperamientoSec: values.atemperamiento_sec,
        maxSobreAtemperamientoSec: values.max_sobre_atemperamiento_sec,
        vidaCajaSec: values.vida_caja_sec,
        minReusoSec: values.min_reuso_sec,
      },
    };
  };

  const renderTable = () => {
    if (!tableBody) return;
    if (!Array.isArray(data.configs) || !data.configs.length) {
      tableBody.innerHTML = '<tr><td colspan="9" class="text-center text-sm opacity-70 py-6">No hay configuraciones registradas todavía.</td></tr>';
      return;
    }
    const rows = data.configs.map((cfg) => {
      const modelo = escapeHtml(cfg.modeloNombre || (cfg.modeloId != null ? `Modelo ${cfg.modeloId}` : 'Sin modelo'));
      const sede = escapeHtml(cfg.sedeNombre || 'Global');
      const cong = escapeHtml(`${minutesFromSeconds(cfg.minCongelamientoSec)} min`);
      const atem = escapeHtml(`${minutesFromSeconds(cfg.atemperamientoSec)} min`);
      const maxAtem = escapeHtml(`${minutesFromSeconds(cfg.maxSobreAtemperamientoSec)} min`);
      const vida = escapeHtml(`${minutesFromSeconds(cfg.vidaCajaSec)} min`);
      const reuso = escapeHtml(`${minutesFromSeconds(cfg.minReusoSec)} min`);
      const badge = cfg.activo ? '<span class="badge badge-success badge-sm">Activo</span>' : '<span class="badge badge-error badge-sm">Inactivo</span>';
      const updated = escapeHtml(formatFecha(cfg.updatedAt));
      return `<tr data-config-id="${escapeHtml(cfg.id)}"><td>${modelo}</td><td>${sede}</td><td>${cong}</td><td>${atem}</td><td>${maxAtem}</td><td>${vida}</td><td>${reuso}</td><td>${badge}</td><td>${updated}</td></tr>`;
    });
    tableBody.innerHTML = rows.join('');
  };

  const refreshData = async () => {
    try {
      const res = await fetch('/operacion/config-tiempos/data', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('No se pudo actualizar la lista');
      const json = await res.json().catch(() => null);
      if (!json || json.ok !== true || !Array.isArray(json.configs)) throw new Error(json?.error || 'Respuesta inesperada');
      data.configs = json.configs;
      renderTable();
      syncForm();
    } catch (err) {
      console.error('[config-tiempos] refresh error', err);
      showAlert('warning', err?.message || 'No fue posible actualizar los datos.');
    }
  };

  const saveConfig = async () => {
    clearAlert();
    const { ok, error, payload } = collectPayload();
    if (!ok) {
      showAlert('error', error);
      return;
    }
    if (!saveBtn) return;
    const body = {
      sedeId: payload.sedeId,
      modeloId: payload.modeloId,
      nombreConfig: payload.nombreConfig,
      min_congelamiento_sec: payload.minCongelamientoSec,
      atemperamiento_sec: payload.atemperamientoSec,
      max_sobre_atemperamiento_sec: payload.maxSobreAtemperamientoSec,
      vida_caja_sec: payload.vidaCajaSec,
      min_reuso_sec: payload.minReusoSec,
    };
    saveBtn.setAttribute('disabled', 'true');
    saveBtn.classList.add('loading');
    try {
      const res = await fetch('/operacion/config-tiempos/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.ok !== true) {
        throw new Error(json?.error || 'No se pudo guardar la configuración');
      }
      showAlert('success', 'Configuración guardada correctamente.');
      await refreshData();
    } catch (err) {
      showAlert('error', err?.message || 'No fue posible guardar la configuración.');
    } finally {
      saveBtn.removeAttribute('disabled');
      saveBtn.classList.remove('loading');
    }
  };

  const toggleConfig = async () => {
    if (!toggleBtn) return;
    const configId = Number(toggleBtn.dataset.configId || 0);
    if (!configId) return;
    const current = data.configs.find((cfg) => Number(cfg.id) === configId);
    const desired = !(current && current.activo === true);
    toggleBtn.setAttribute('disabled', 'true');
    toggleBtn.classList.add('loading');
    try {
      const res = await fetch(`/operacion/config-tiempos/${configId}/toggle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ activo: desired }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.ok !== true) {
        throw new Error(json?.error || 'No se pudo actualizar el estado');
      }
      showAlert('success', desired ? 'Configuración activada.' : 'Configuración desactivada.');
      await refreshData();
    } catch (err) {
      showAlert('error', err?.message || 'No fue posible cambiar el estado.');
    } finally {
      toggleBtn.removeAttribute('disabled');
      toggleBtn.classList.remove('loading');
    }
  };

  const resetForm = () => {
    if (inputMinCong) inputMinCong.value = '';
    if (inputAtem) inputAtem.value = '';
    if (inputMaxAtem) inputMaxAtem.value = '';
    if (inputVida) inputVida.value = '';
    if (inputReuso) inputReuso.value = '';
    clearAlert();
    updateStatus('', 'info');
    if (toggleBtn) {
      toggleBtn.classList.add('hidden');
      toggleBtn.removeAttribute('data-config-id');
    }
  };

  if (sedeSelect && data.selectedSedeId !== undefined && data.selectedSedeId !== null) {
    const desired = String(data.selectedSedeId);
    if (sedeSelect.value !== desired) {
      const option = Array.from(sedeSelect.options).find((opt) => opt.value === desired);
      if (option) sedeSelect.value = desired;
    }
  }

  renderTable();
  syncForm();

  sedeSelect?.addEventListener('change', syncForm);
  modeloSelect?.addEventListener('change', syncForm);
  saveBtn?.addEventListener('click', saveConfig);
  toggleBtn?.addEventListener('click', toggleConfig);
  resetBtn?.addEventListener('click', () => {
    resetForm();
    syncForm();
  });
})();
