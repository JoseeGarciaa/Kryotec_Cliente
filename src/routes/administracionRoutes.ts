import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/admin';
import { AdminController } from '../controllers/adminController';
import { ZonasController } from '../controllers/zonasController';
import { OperacionController } from '../controllers/operacionController';

const router = Router();

router.get('/', requireAuth, requireAdmin, AdminController.listView);
router.post('/nuevo', requireAuth, requireAdmin, AdminController.newUser);
router.post('/sedes', requireAuth, requireAdmin, AdminController.createSede);
router.post('/sedes/:sedeId', requireAuth, requireAdmin, AdminController.updateSede);
router.post('/sedes/:sedeId/eliminar', requireAuth, requireAdmin, AdminController.deleteSede);
router.get('/zonas', requireAuth, requireAdmin, ZonasController.view);
router.post('/zonas', requireAuth, requireAdmin, ZonasController.createZona);
router.post('/zonas/:zonaId', requireAuth, requireAdmin, ZonasController.updateZona);
router.post('/zonas/:zonaId/eliminar', requireAuth, requireAdmin, ZonasController.deleteZona);
router.post('/zonas/:zonaId/secciones', requireAuth, requireAdmin, ZonasController.createSeccion);
router.post('/zonas/secciones/:seccionId', requireAuth, requireAdmin, ZonasController.updateSeccion);
router.post('/zonas/secciones/:seccionId/eliminar', requireAuth, requireAdmin, ZonasController.deleteSeccion);
// Configuración de cronómetros (solo admin)
router.get('/config-tiempos', requireAuth, requireAdmin, OperacionController.configTimersView as any);
router.get('/config-tiempos/data', requireAuth, requireAdmin, OperacionController.configTimersData as any);
router.post('/config-tiempos/save', requireAuth, requireAdmin, OperacionController.configTimersSave as any);
router.post('/config-tiempos/:id/toggle', requireAuth, requireAdmin, OperacionController.configTimersToggle as any);
router.post('/:id/editar', requireAuth, requireAdmin, AdminController.editUser);
router.post('/:id/estado', requireAuth, requireAdmin, AdminController.toggleActivo);
router.delete('/:id', requireAuth, requireAdmin, AdminController.deleteUser);
// API JSON
router.get('/api/list', requireAuth, requireAdmin, AdminController.listJSON);
router.get('/api/:id', requireAuth, requireAdmin, AdminController.getUserJSON);

export default router;
