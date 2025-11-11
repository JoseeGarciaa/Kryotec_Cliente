(function () {
	document.addEventListener('DOMContentLoaded', () => {
		const modalAdd = document.getElementById('modal-add-order');
		const modalEdit = document.getElementById('modal-edit-order');
		const modalDelete = document.getElementById('modal-delete-order');
		const modalImport = document.getElementById('modal-import-orders');

		const btnAdd = document.getElementById('btn-add-order');
		const btnImport = document.getElementById('btn-import-orders');

		const successBanner = document.getElementById('orders-success-banner');
		const IMPORT_RESULT_KEY = 'ordersImportResult';
		const LEGACY_SUCCESS_KEY = 'ordersImportSuccess';
		const BANNER_TIMEOUT_MS = 10000;
		const limitForm = document.getElementById('orders-limit-form');
		const limitSelect = document.getElementById('orders-limit-select');
		const ordersTable = document.querySelector('[data-orders-table]');

		const importForm = document.getElementById('form-import-orders');
		const importStatus = document.getElementById('import-status');
		const importErrors = document.getElementById('import-errors');
		const importSubmit = document.getElementById('import-submit');
		const importSubmitText = document.getElementById('import-submit-text');
		const importSpinner = document.getElementById('import-spinner');

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

		const resetImportState = (resetFile) => {
			if (resetFile && importForm instanceof HTMLFormElement) {
				importForm.reset();
			}
			if (importStatus) {
				importStatus.classList.add('hidden');
				importStatus.classList.remove('text-error', 'text-success');
				importStatus.innerHTML = '';
			}
			if (importErrors) {
				importErrors.classList.add('hidden');
				importErrors.innerHTML = '';
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

		const addForm = modalAdd ? modalAdd.querySelector('form') : null;
		if (addForm instanceof HTMLFormElement) {
			addForm.addEventListener('submit', () => {
				const tzField = addForm.querySelector('input[name="clientTzOffset"]');
				const localField = addForm.querySelector('input[name="clientLocalNow"]');
				if (!(tzField instanceof HTMLInputElement) || !(localField instanceof HTMLInputElement)) {
					return;
				}
				const now = new Date();
				const tzOffset = now.getTimezoneOffset();
				const localIso = new Date(now.getTime() - tzOffset * 60000).toISOString().slice(0, 19);
				tzField.value = String(tzOffset);
				localField.value = localIso;
			});
		}

		const legacyMessageRaw = sessionStorage.getItem(LEGACY_SUCCESS_KEY);
		if (legacyMessageRaw) {
			sessionStorage.removeItem(LEGACY_SUCCESS_KEY);
			sessionStorage.setItem(IMPORT_RESULT_KEY, JSON.stringify({ message: legacyMessageRaw }));
		}

		const storedResultRaw = sessionStorage.getItem(IMPORT_RESULT_KEY);
		if (storedResultRaw && successBanner) {
			try {
				const payload = JSON.parse(storedResultRaw);
				successBanner.classList.remove('hidden');
				successBanner.innerHTML = '';
				const mainText = document.createElement('span');
				if (payload && typeof payload.message === 'string' && payload.message.trim().length) {
					mainText.textContent = payload.message.trim();
				} else {
					mainText.textContent = 'Órdenes procesadas.';
				}
				successBanner.appendChild(mainText);
				if (payload && Array.isArray(payload.issues) && payload.issues.length) {
					const list = document.createElement('ul');
					list.className = 'list-disc list-inside mt-2 text-xs';
					payload.issues.slice(0, 5).forEach((issue) => {
						const li = document.createElement('li');
						const rowNumber = Number(issue && issue.row);
						const parts = [];
						if (Number.isFinite(rowNumber) && rowNumber > 0) {
							parts.push(`Fila ${rowNumber}`);
						}
						if (issue && typeof issue.message === 'string' && issue.message.trim().length) {
							parts.push(issue.message.trim());
						}
						li.textContent = parts.length ? parts.join(': ') : 'Fila omitida';
						list.appendChild(li);
					});
					successBanner.appendChild(list);
					if (payload.issues.length > 5) {
						const note = document.createElement('p');
						note.className = 'mt-1 text-xs opacity-80';
						note.textContent = `Se muestran las primeras 5 incidencias (total: ${payload.issues.length}).`;
						successBanner.appendChild(note);
					}
				}
				setTimeout(() => {
					successBanner.classList.add('hidden');
					successBanner.innerHTML = '';
				}, BANNER_TIMEOUT_MS);
			} catch (_err) {
				// ignorar errores de parseo
			} finally {
				sessionStorage.removeItem(IMPORT_RESULT_KEY);
			}
		}

		if (btnAdd && modalAdd) {
			btnAdd.addEventListener('click', () => openDialog(modalAdd));
		}

		document
			.querySelectorAll('#modal-add-order [data-close]')
			.forEach((el) => el.addEventListener('click', () => closeDialog(modalAdd)));
		const addBackdrop = document.querySelector('#modal-add-order .modal-backdrop');
		if (addBackdrop) {
			addBackdrop.addEventListener('click', () => closeDialog(modalAdd));
		}

		if (btnImport && modalImport) {
			btnImport.addEventListener('click', () => {
				resetImportState(true);
				openDialog(modalImport);
			});
		}

		document
			.querySelectorAll('#modal-import-orders [data-close]')
			.forEach((el) => el.addEventListener('click', () => closeDialog(modalImport)));
		const importBackdrop = document.querySelector('#modal-import-orders .modal-backdrop');
		if (importBackdrop) {
			importBackdrop.addEventListener('click', () => closeDialog(modalImport));
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
					importStatus.classList.remove('text-error', 'text-success');
					importStatus.innerHTML = '';
				}
				if (importErrors) {
					importErrors.classList.add('hidden');
					importErrors.innerHTML = '';
				}

				const formData = new FormData(importForm);
						const now = new Date();
						const tzOffset = now.getTimezoneOffset();
						const localIso = new Date(now.getTime() - tzOffset * 60000).toISOString().slice(0, 19);
						formData.set('clientTzOffset', String(tzOffset));
						formData.set('clientLocalNow', localIso);
				try {
					// Use fetch to post the Excel file and surface row-level feedback inline in the modal.
					const response = await fetch('/ordenes/import', {
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
						return;
					}

					const summary = payload.summary || {};
					const processed = typeof summary.processed === 'number' ? summary.processed : 0;
					const inserted = typeof summary.inserted === 'number' ? summary.inserted : 0;
					const updated = typeof summary.updated === 'number' ? summary.updated : 0;
					const issues = Array.isArray(summary.issues) ? summary.issues : [];
					const baseStatus = `Se procesaron ${processed} órdenes. ${inserted} nuevas y ${updated} actualizadas.`;
					if (importStatus) {
						importStatus.classList.remove('hidden');
						importStatus.classList.remove('text-error');
						importStatus.classList.add('text-success');
						const omissionText = issues.length ? ` Se omitieron ${issues.length} filas.` : '';
						importStatus.innerHTML = `${baseStatus}${omissionText}<span class="block mt-1">Actualizando la información...</span>`;
					}
					if (importErrors) {
						if (issues.length) {
							importErrors.classList.remove('hidden');
							const details = issues
								.slice(0, 25)
								.map((item) => `<li>Fila ${item.row}: ${item.message}</li>`)
								.join('');
							const tailNote = issues.length > 25 ? '<p class="mt-1">Se muestran solo las primeras 25 incidencias.</p>' : '';
							importErrors.innerHTML = `Se omitieron ${issues.length} filas:<ul class="list-disc list-inside space-y-1 mt-1">${details}</ul>${tailNote}<p class="mt-2 text-xs">El resumen también aparecerá en la parte superior después de refrescar.</p>`;
						} else {
							importErrors.classList.add('hidden');
							importErrors.innerHTML = '';
						}
					}

					const bannerPayload = {
						message: issues.length
							? `Órdenes procesadas con observaciones. Nuevas: ${inserted}. Actualizadas: ${updated}. Omitidas: ${issues.length}.`
							: `Órdenes importadas correctamente. Nuevas: ${inserted}. Actualizadas: ${updated}.`,
					};
					if (issues.length) {
						bannerPayload.issues = issues.slice(0, 10).map((issue) => ({
							row: issue && issue.row,
							message: issue && issue.message,
						}));
					}
					sessionStorage.setItem(IMPORT_RESULT_KEY, JSON.stringify(bannerPayload));
					setTimeout(() => {
						window.location.reload();
					}, 1200);
				} catch (err) {
					if (importStatus) {
						importStatus.classList.remove('hidden');
						importStatus.classList.add('text-error');
						importStatus.textContent = 'Error inesperado procesando el archivo.';
					}
				} finally {
					if (importSpinner) importSpinner.classList.add('hidden');
					if (importSubmitText) importSubmitText.textContent = 'Procesar';
					if (importSubmit instanceof HTMLButtonElement) {
						importSubmit.disabled = false;
					}
				}
			});
		}

		document
			.querySelectorAll('#modal-edit-order [data-close]')
			.forEach((el) => el.addEventListener('click', () => closeDialog(modalEdit)));
		const editBackdrop = document.querySelector('#modal-edit-order .modal-backdrop');
		if (editBackdrop) {
			editBackdrop.addEventListener('click', () => closeDialog(modalEdit));
		}

		document
			.querySelectorAll('#modal-delete-order [data-close]')
			.forEach((el) => el.addEventListener('click', () => closeDialog(modalDelete)));
		const deleteBackdrop = document.querySelector('#modal-delete-order .modal-backdrop');
		if (deleteBackdrop) {
			deleteBackdrop.addEventListener('click', () => closeDialog(modalDelete));
		}

		document
			.querySelectorAll('[data-edit]')
			.forEach((el) => el.addEventListener('click', () => {
				if (!(modalEdit && typeof modalEdit.showModal === 'function')) return;
				const form = document.getElementById('form-edit-order');
				if (!(form instanceof HTMLFormElement)) return;
				form.querySelector('input[name="id"]').value = el.getAttribute('data-id') || '';
				form.querySelector('input[name="numero_orden"]').value = el.getAttribute('data-numero') || '';
				form.querySelector('input[name="codigo_producto"]').value = el.getAttribute('data-codigo') || '';
				form.querySelector('input[name="cantidad"]').value = el.getAttribute('data-cantidad') || '';
				form.querySelector('input[name="ciudad_destino"]').value = el.getAttribute('data-ciudad') || '';
				form.querySelector('input[name="ubicacion_destino"]').value = el.getAttribute('data-ubicacion') || '';
				form.querySelector('input[name="cliente"]').value = el.getAttribute('data-cliente') || '';
				openDialog(modalEdit);
			}));

		document
			.querySelectorAll('[data-delete]')
			.forEach((el) => el.addEventListener('click', () => {
				if (!(modalDelete && typeof modalDelete.showModal === 'function')) return;
				const form = document.getElementById('form-delete-order');
				if (!(form instanceof HTMLFormElement)) return;
				form.querySelector('input[name="id"]').value = el.getAttribute('data-id') || '';
				const label = document.getElementById('del-order-label');
				if (label) label.textContent = el.getAttribute('data-numero') || '';
				openDialog(modalDelete);
			}));

		const parseEnabledValue = (value) => {
			if (typeof value === 'boolean') return value;
			if (typeof value === 'number') return value !== 0;
			if (typeof value === 'string') {
				const normalized = value.trim().toLowerCase();
				if (['1', 'true', 'si', 'on', 'habilitada', 'habilitado', 'activo', 'activa'].includes(normalized)) {
					return true;
				}
				if (['0', 'false', 'no', 'off', 'inhabilitada', 'inhabilitado', 'inactivo', 'inactiva', 'disabled'].includes(normalized)) {
					return false;
				}
			}
			return null;
		};

		if (ordersTable instanceof HTMLElement) {
			ordersTable.addEventListener('click', async (event) => {
				const target = event.target instanceof HTMLElement ? event.target : null;
				const button = target ? target.closest('[data-toggle-order]') : null;
				if (!(button instanceof HTMLElement)) return;
				event.preventDefault();
				const idRaw = button.getAttribute('data-id');
				const enabledRaw = button.getAttribute('data-enabled');
				const numero = button.getAttribute('data-numero') || '';
				const orderId = Number(idRaw);
				const currentEnabled = parseEnabledValue(enabledRaw);
				if (!Number.isFinite(orderId) || !orderId) {
					window.alert('ID de orden inválido.');
					return;
				}
				if (currentEnabled === null) {
					window.alert('Estado actual desconocido.');
					return;
				}
				const nextEnabled = !currentEnabled;
				const label = numero ? `la orden ${numero}` : 'esta orden';
				const confirmMessage = nextEnabled
					? `Reactivar ${label}?`
					: `Inhabilitar ${label}?`;
				if (!window.confirm(confirmMessage)) return;
				const originalText = button.textContent;
				button.textContent = 'Procesando...';
				button.setAttribute('disabled', 'true');
				try {
					const response = await fetch('/ordenes/toggle', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Accept: 'application/json',
						},
						credentials: 'same-origin',
						body: JSON.stringify({ id: orderId, habilitada: nextEnabled }),
					});
					const payload = await response.json().catch(() => null);
					if (!response.ok || !payload || payload.ok !== true) {
						const message = payload && typeof payload.error === 'string' ? payload.error : 'No se pudo actualizar la orden.';
						window.alert(message);
						button.removeAttribute('disabled');
						button.textContent = originalText;
						return;
					}
					window.location.reload();
				} catch (error) {
					console.error('Error al cambiar el estado de la orden', error);
					window.alert('No se pudo actualizar la orden. Inténtalo de nuevo.');
					button.removeAttribute('disabled');
					button.textContent = originalText;
				}
			});
		}

		if (limitSelect instanceof HTMLSelectElement) {
			limitSelect.addEventListener('change', () => {
				if (limitForm instanceof HTMLFormElement) {
					limitForm.submit();
				}
			});
		}
	});
})();
