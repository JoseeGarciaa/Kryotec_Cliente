(function(){
  const state = window.__CONFIG_TIEMPOS__ || { configs: [], modelos: [], sedes: [], selectedSedeId: null };
  const configs = Array.isArray(state.configs) ? state.configs.slice() : [];
  const modelos = Array.isArray(state.modelos) ? state.modelos.slice() : [];
  const sedes = Array.isArray(state.sedes) ? state.sedes.slice() : [];
  const data = { configs, modelos, sedes, selectedSedeId: state.selectedSedeId };

  const qs = (sel) => document.querySelector(sel);
  const sedeSelect = qs('#cfg-sede');
  const modeloSelect = qs('#cfg-modelo');
  const inputMinCongH = qs('#cfg-min-cong-h');
  const inputMinCongM = qs('#cfg-min-cong-m');
  const inputAtemH = qs('#cfg-atem-h');
  const inputAtemM = qs('#cfg-atem-m');
  const inputMaxAtemH = qs('#cfg-max-atem-h');
  const inputMaxAtemM = qs('#cfg-max-atem-m');
  const inputVidaH = qs('#cfg-vida-h');
  const inputVidaM = qs('#cfg-vida-m');
  const inputReusoH = qs('#cfg-reuso-h');
  const inputReusoM = qs('#cfg-reuso-m');
  const alertBox = qs('#cfg-alert');
  const statusLabel = qs('#cfg-status');
  const saveBtn = qs('#cfg-save');
  const toggleBtn = qs('#cfg-toggle');
  const resetBtn = qs('#cfg-reset');
  const tableBody = qs('#cfg-table tbody');

  const minutesFromSeconds = (sec) => {
    const value = Number(sec);
    if (!Number.isFinite(value) || value <= 0) return '';
    const minutes = Math.round(value / 60);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}`;
    return String(minutes);
  };

  const splitDuration = (sec) => {
    const total = Number(sec);
    if (!Number.isFinite(total) || total <= 0) return { h: '', m: '' };
    const minutes = Math.round(total / 60);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return { h: String(h), m: String(m) };
  };

  const parseFieldsToSeconds = (hInput, mInput, label) => {
    const hVal = hInput ? Number(hInput.value || 0) : 0;
    const mVal = mInput ? Number(mInput.value || 0) : 0;
    if ((!Number.isFinite(hVal) || hVal < 0) || (!Number.isFinite(mVal) || mVal < 0 || mVal > 59)) {
      return { ok: false, error: `${label}: horas o minutos inválidos (minutos 0-59)` };
    }
    const totalSec = Math.round(hVal * 3600 + mVal * 60);
    if (totalSec <= 0) return { ok: false, error: `${label}: debe ser mayor a 0` };
    return { ok: true, seconds: totalSec };
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
    const cong = splitDuration(cfg?.minCongelamientoSec);
    if (inputMinCongH) inputMinCongH.value = cong.h;
    if (inputMinCongM) inputMinCongM.value = cong.m;
    const atem = splitDuration(cfg?.atemperamientoSec);
    if (inputAtemH) inputAtemH.value = atem.h;
    if (inputAtemM) inputAtemM.value = atem.m;
    const maxAtem = splitDuration(cfg?.maxSobreAtemperamientoSec);
    if (inputMaxAtemH) inputMaxAtemH.value = maxAtem.h;
    if (inputMaxAtemM) inputMaxAtemM.value = maxAtem.m;
    const vida = splitDuration(cfg?.vidaCajaSec);
    if (inputVidaH) inputVidaH.value = vida.h;
    if (inputVidaM) inputVidaM.value = vida.m;
    const reuso = splitDuration(cfg?.minReusoSec);
    if (inputReusoH) inputReusoH.value = reuso.h;
    if (inputReusoM) inputReusoM.value = reuso.m;
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

  const durationFromInputs = (hInput, mInput, label) => {
    const parsed = parseFieldsToSeconds(hInput, mInput, label);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, value: parsed.seconds };
  };

  const collectPayload = () => {
    const sedeId = getSelectedSedeId();
    const modeloId = getSelectedModeloId();
    if (!modeloId) {
      return { ok: false, error: 'Selecciona un modelo.' };
    }
    const parts = [
      { h: inputMinCongH, m: inputMinCongM, label: 'Congelamiento' },
      { h: inputAtemH, m: inputAtemM, label: 'Atemperamiento' },
      { h: inputMaxAtemH, m: inputMaxAtemM, label: 'Máximo sobre atemperamiento' },
      { h: inputVidaH, m: inputVidaM, label: 'Vida útil de la caja' },
      { h: inputReusoH, m: inputReusoM, label: 'Tiempo mínimo para reutilización' },
    ];
    const values = {};
    for (const part of parts) {
      const result = durationFromInputs(part.h, part.m, part.label);
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
      const res = await fetch('/administracion/config-tiempos/data', { headers: { Accept: 'application/json' } });
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
      const res = await fetch('/administracion/config-tiempos/save', {
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
      const res = await fetch(`/administracion/config-tiempos/${configId}/toggle`, {
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
    [inputMinCongH, inputMinCongM, inputAtemH, inputAtemM, inputMaxAtemH, inputMaxAtemM, inputVidaH, inputVidaM, inputReusoH, inputReusoM]
      .forEach((inp) => { if (inp) inp.value = ''; });
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

  // Clamp minutes to 0-59 on blur
  const clampMinutes = (input) => {
    if (!input) return;
    input.addEventListener('blur', () => {
      const val = Number(input.value || 0);
      if (!Number.isFinite(val) || val < 0) { input.value = ''; return; }
      const clamped = Math.min(59, Math.max(0, Math.trunc(val)));
      input.value = String(clamped);
    });
  };
  [inputMinCongM, inputAtemM, inputMaxAtemM, inputVidaM, inputReusoM].forEach(clampMinutes);
})();
