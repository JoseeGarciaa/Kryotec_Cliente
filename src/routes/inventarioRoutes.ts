import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { InventarioController } from '../controllers/inventarioController';

const router = Router();
router.get('/', requireAuth, InventarioController.index);
router.post('/', requireAuth, InventarioController.create);

export default router;
