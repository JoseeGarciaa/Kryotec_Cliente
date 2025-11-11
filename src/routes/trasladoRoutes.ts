import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { TrasladoController } from '../controllers/trasladoController';

const router = Router();

router.get('/', requireAuth, TrasladoController.index);
router.post('/apply', requireAuth, TrasladoController.apply as any);

export default router;
