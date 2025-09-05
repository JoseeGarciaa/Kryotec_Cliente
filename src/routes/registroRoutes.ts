import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { RegistroController } from '../controllers/registroController';

const router = Router();
router.get('/', requireAuth, RegistroController.index);
router.post('/', requireAuth, RegistroController.create);
router.post('/validate', requireAuth, RegistroController.validate);

export default router;
