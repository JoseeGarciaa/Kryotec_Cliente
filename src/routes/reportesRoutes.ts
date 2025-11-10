import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { ReportesController } from '../controllers/reportesController';

const router = Router();

router.get('/', requireAuth, ReportesController.view);
router.get('/data/:key', requireAuth, ReportesController.data);
router.get('/export/:key.:format', requireAuth, ReportesController.export);

export default router;
