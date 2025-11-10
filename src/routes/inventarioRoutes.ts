import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { InventarioController } from '../controllers/inventarioController';
import { ZonasController } from '../controllers/zonasController';

const router = Router();
router.get('/', requireAuth, InventarioController.index);
router.get('/data', requireAuth, InventarioController.data);
router.get('/ubicaciones', requireAuth, ZonasController.apiListCurrentSede);
router.post('/', requireAuth, InventarioController.create);
router.post('/:id/update', requireAuth, InventarioController.update);
router.post('/:id/delete', requireAuth, InventarioController.remove);

export default router;
