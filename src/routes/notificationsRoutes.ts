import { Router } from 'express';
import { NotificationsController } from '../controllers/notificationsController';

const router = Router();

router.get('/', NotificationsController.list);
router.get('/api/updates', NotificationsController.apiUpdates);
router.post('/:id/resolver', NotificationsController.resolve);
router.post('/bulk/resolve', NotificationsController.bulkResolve);
router.post('/bulk/delete', NotificationsController.bulkDelete);

export default router;
