import { Router } from 'express';
import { AccountController } from '../controllers/accountController';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', requireAuth, AccountController.index);
router.post('/update-profile', requireAuth, AccountController.updateProfile);
router.post('/change-password', requireAuth, AccountController.changePassword);

export default router;
