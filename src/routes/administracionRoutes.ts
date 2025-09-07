import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/admin';
import { AdminController } from '../controllers/adminController';

const router = Router();

router.get('/', requireAuth, requireAdmin, AdminController.listView);
router.post('/nuevo', requireAuth, requireAdmin, AdminController.newUser);
router.post('/:id/editar', requireAuth, requireAdmin, AdminController.editUser);
router.post('/:id/estado', requireAuth, requireAdmin, AdminController.toggleActivo);
router.delete('/:id', requireAuth, requireAdmin, AdminController.deleteUser);
// API JSON
router.get('/api/list', requireAuth, requireAdmin, AdminController.listJSON);
router.get('/api/:id', requireAuth, requireAdmin, AdminController.getUserJSON);

export default router;
