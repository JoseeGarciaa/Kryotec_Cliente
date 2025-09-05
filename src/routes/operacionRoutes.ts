import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { OperacionController } from '../controllers/operacionController';

const router = Router();
router.get('/', requireAuth, OperacionController.index);
router.get('/todas', requireAuth, OperacionController.todas);
router.get('/bodega', requireAuth, OperacionController.bodega);
router.get('/preacond', requireAuth, OperacionController.preacond);
router.get('/preacond/data', requireAuth, OperacionController.preacondData);
router.post('/preacond/scan', requireAuth, OperacionController.preacondScan);
router.post('/preacond/validate', requireAuth, OperacionController.preacondValidate);
router.get('/acond', requireAuth, OperacionController.acond);
router.get('/operacion', requireAuth, OperacionController.operacion);
router.get('/devolucion', requireAuth, OperacionController.devolucion);
router.get('/inspeccion', requireAuth, OperacionController.inspeccion);

export default router;
