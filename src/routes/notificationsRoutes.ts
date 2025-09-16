import { Router } from 'express';
import { NotificationsController } from '../controllers/notificationsController';

const router = Router();

router.get('/', NotificationsController.list);
router.get('/api/updates', NotificationsController.apiUpdates);
router.post('/:id/resolver', NotificationsController.resolve);

export default router;
