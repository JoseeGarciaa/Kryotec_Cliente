import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { OperacionController } from '../controllers/operacionController';

const router = Router();
router.get('/', requireAuth, OperacionController.index);
router.get('/todas', requireAuth, OperacionController.todas);
router.get('/todas/data', requireAuth, OperacionController.kanbanData);
router.get('/preacond', requireAuth, OperacionController.preacond);
router.get('/preacond/data', requireAuth, OperacionController.preacondData);
router.post('/preacond/scan', requireAuth, OperacionController.preacondScan);
router.post('/preacond/validate', requireAuth, OperacionController.preacondValidate);
router.post('/preacond/lote/lookup', requireAuth, OperacionController.preacondLoteLookup);
router.post('/preacond/lote/move', requireAuth, OperacionController.preacondLoteMove);
router.post('/preacond/timer/start', requireAuth, OperacionController.preacondTimerStart);
router.post('/preacond/timer/clear', requireAuth, OperacionController.preacondTimerClear);
router.post('/preacond/item-timer/start', requireAuth, OperacionController.preacondItemTimerStart);
router.post('/preacond/item-timer/clear', requireAuth, OperacionController.preacondItemTimerClear);
router.post('/preacond/timer/complete', requireAuth, OperacionController.preacondTimerComplete);
router.post('/preacond/item-timer/complete', requireAuth, OperacionController.preacondItemTimerComplete);
router.post('/preacond/return-to-bodega', requireAuth, OperacionController.preacondReturnToBodega);
router.get('/acond', requireAuth, OperacionController.acond);
router.get('/acond/data', requireAuth, OperacionController.acondData);
router.post('/acond/ensamblaje/validate', requireAuth, OperacionController.acondEnsamblajeValidate);
router.post('/acond/ensamblaje/create', requireAuth, OperacionController.acondEnsamblajeCreate);
router.post('/acond/caja/timer/start', requireAuth, OperacionController.acondCajaTimerStart);
router.post('/acond/caja/timer/clear', requireAuth, OperacionController.acondCajaTimerClear);
router.post('/acond/caja/timer/complete', requireAuth, OperacionController.acondCajaTimerComplete);
router.post('/acond/despacho/lookup', requireAuth, OperacionController.acondDespachoLookup);
router.post('/acond/despacho/move', requireAuth, OperacionController.acondDespachoMove);
router.post('/acond/despacho/move-caja', requireAuth, OperacionController.acondDespachoMoveCaja);
router.post('/acond/caja/set-order', requireAuth, OperacionController.acondCajaSetOrder as any);
router.get('/operacion', requireAuth, OperacionController.operacion);
// Operación phase caja scan / timers (legacy prefixed paths kept for backward compatibility)
router.get('/operacion/data', requireAuth, OperacionController.operacionData);
router.post('/operacion/add/lookup', requireAuth, OperacionController.operacionAddLookup);
router.post('/operacion/add/move', requireAuth, OperacionController.operacionAddMove);
router.post('/operacion/caja/timer/start-bulk', requireAuth, OperacionController.operacionCajaTimerStartBulk);
router.post('/operacion/caja/timer/start', requireAuth, OperacionController.operacionCajaTimerStart);
router.post('/operacion/caja/timer/clear', requireAuth, OperacionController.operacionCajaTimerClear);
router.post('/operacion/caja/timer/complete', requireAuth, OperacionController.operacionCajaTimerComplete);
router.post('/operacion/scan', requireAuth, OperacionController.operacionScan);
router.post('/operacion/caja/lookup', requireAuth, OperacionController.operacionCajaLookup);

// New concise aliases (so client can call /operacion/data etc.)
router.get('/data', requireAuth, OperacionController.operacionData);
router.post('/add/lookup', requireAuth, OperacionController.operacionAddLookup);
router.post('/add/move', requireAuth, OperacionController.operacionAddMove);
router.post('/caja/timer/start-bulk', requireAuth, OperacionController.operacionCajaTimerStartBulk);
router.post('/caja/timer/start', requireAuth, OperacionController.operacionCajaTimerStart);
router.post('/caja/timer/clear', requireAuth, OperacionController.operacionCajaTimerClear);
router.post('/caja/timer/complete', requireAuth, OperacionController.operacionCajaTimerComplete);
router.post('/scan', requireAuth, OperacionController.operacionScan);
router.post('/caja/lookup', requireAuth, OperacionController.operacionCajaLookup);
router.get('/devolucion', requireAuth, OperacionController.devolucion);
// Devolucion data + confirm
router.get('/devolucion/data', requireAuth, OperacionController.devolucionData as any);
router.post('/devolucion/confirm', requireAuth, OperacionController.devolucionConfirm as any);
router.post('/devolucion/process', requireAuth, OperacionController.devolucionCajaProcess as any);
router.post('/devolucion/evaluate', requireAuth, OperacionController.devolucionCajaEvaluate as any);
router.post('/devolucion/reuse', requireAuth, OperacionController.devolucionCajaReuse as any);
// Nuevo flujo: enviar a "En bodega · Pendiente a Inspección"
router.post('/devolucion/to-inspeccion', requireAuth, OperacionController.devolucionCajaToInspeccion as any); // mantener compatibilidad (ya no se usa)
router.post('/devolucion/to-pend-insp', requireAuth, OperacionController.devolucionCajaToPendInsp as any);
router.post('/devolucion/validate', requireAuth, OperacionController.devolucionValidate as any);
router.post('/devolucion/ret/validate', requireAuth, OperacionController.devolucionRetValidate as any);
router.post('/devolucion/ret/confirm', requireAuth, OperacionController.devolucionRetConfirm as any);
// Devolver caja completa a bodega (reset total)
router.post('/devolucion/caja/return', requireAuth, OperacionController.devolucionCajaReturn as any);
router.get('/inspeccion', requireAuth, OperacionController.inspeccion);
router.get('/inspeccion/data', requireAuth, OperacionController.inspeccionData as any);
router.post('/inspeccion/lookup', requireAuth, OperacionController.inspeccionCajaLookup as any);
router.post('/inspeccion/pull', requireAuth, OperacionController.inspeccionPullFromPending as any);
router.post('/inspeccion/pending/item-info', requireAuth, OperacionController.inspeccionPendingItemInfo as any);
router.post('/inspeccion/pending/preview', requireAuth, OperacionController.inspeccionPendingPreview as any);
router.post('/inspeccion/check', requireAuth, OperacionController.inspeccionTicChecklist as any);
router.post('/inspeccion/complete', requireAuth, OperacionController.inspeccionCajaComplete as any);
router.post('/inspeccion/mass-complete', requireAuth, OperacionController.inspeccionMassComplete as any);
router.post('/inspeccion/novedad/inhabilitar', requireAuth, OperacionController.inspeccionNovedadInhabilitar as any);
// En bodega
router.get('/bodega', requireAuth, OperacionController.bodega);
router.get('/bodega/data', requireAuth, OperacionController.bodegaData);
router.post('/bodega/devolucion', requireAuth, OperacionController.bodegaDevolucion as any);
// En bodega · Pendiente a Inspección (sub vista)
router.get('/bodega-pend-insp/data', requireAuth, OperacionController.bodegaPendInspData as any);
// Bodega no puede modificar el cronómetro de "Pendiente a Inspección"
// router.post('/bodega-pend-insp/timer/start', requireAuth, OperacionController.bodegaPendInspTimerStart as any);
// Restricción: no se permite limpiar cronómetro ni enviar a Inspección desde Bodega pendiente

export default router;
