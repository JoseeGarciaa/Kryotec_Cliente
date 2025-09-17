import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { OrdenesController } from '../controllers/ordenesController';

const router = Router();
router.get('/', requireAuth, OrdenesController.index);
router.get('/list', requireAuth, OrdenesController.listJson as any);
router.post('/create', requireAuth, OrdenesController.create as any);

export default router;
