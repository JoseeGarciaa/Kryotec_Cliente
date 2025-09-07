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
router.get('/operacion', requireAuth, OperacionController.operacion);
// Operación phase caja scan / timers
// Nueva data consolidada de Operación
router.get('/operacion/data', requireAuth, OperacionController.operacionData);
router.post('/operacion/add/lookup', requireAuth, OperacionController.operacionAddLookup);
router.post('/operacion/add/move', requireAuth, OperacionController.operacionAddMove);
router.get('/devolucion', requireAuth, OperacionController.devolucion);
router.get('/inspeccion', requireAuth, OperacionController.inspeccion);
// En bodega
router.get('/bodega', requireAuth, OperacionController.bodega);
router.get('/bodega/data', requireAuth, OperacionController.bodegaData);

export default router;
