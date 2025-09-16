import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { OrdenesController } from '../controllers/ordenesController';

const router = Router();
router.get('/', requireAuth, OrdenesController.index);

export default router;
