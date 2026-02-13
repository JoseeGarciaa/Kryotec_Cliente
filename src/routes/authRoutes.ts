import { Router } from 'express';
import { AuthController } from '../controllers/authController';

const router = Router();

router.get('/login', AuthController.loginView);
router.post('/login', AuthController.login);
router.post('/logout', AuthController.logout);
router.post('/refresh', AuthController.refresh);

export default router;
