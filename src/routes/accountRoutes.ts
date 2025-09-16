import { Router } from 'express';
import { AccountController } from '../controllers/accountController';

const router = Router();

router.get('/', AccountController.index);
router.post('/update-profile', AccountController.updateProfile);
router.post('/change-password', AccountController.changePassword);

export default router;
