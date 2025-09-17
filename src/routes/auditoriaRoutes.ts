import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/admin';
import { AuditoriaController } from '../controllers/auditoriaController';

const router = Router();

router.get('/', requireAuth, requireAdmin, AuditoriaController.listView);
router.post('/:id/auditar', requireAuth, requireAdmin, AuditoriaController.markAudited);

export default router;
