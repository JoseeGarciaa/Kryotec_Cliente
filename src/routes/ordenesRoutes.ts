import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth';
import { OrdenesController } from '../controllers/ordenesController';

const router = Router();
const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: 5 * 1024 * 1024, // 5MB
	},
});

router.get('/', requireAuth, OrdenesController.index);
router.get('/calculadora', requireAuth, OrdenesController.calculadoraView as any);
router.get('/list', requireAuth, OrdenesController.listJson as any);
router.get('/template', requireAuth, OrdenesController.downloadTemplate as any);
router.get('/calculadora/plantilla-productos', requireAuth, OrdenesController.downloadProductosTemplate as any);
router.post('/import', requireAuth, upload.single('file'), OrdenesController.importExcel as any);
router.post('/calculadora/import-productos', requireAuth, upload.single('file'), OrdenesController.importProductosExcel as any);
router.post('/calculadora/recomendar', requireAuth, OrdenesController.calculadoraRecomendar as any);
router.post('/calculadora/orden', requireAuth, OrdenesController.calculadoraCrearOrden as any);
router.post('/create', requireAuth, OrdenesController.create as any);
router.post('/update', requireAuth, OrdenesController.update as any);
router.post('/toggle', requireAuth, OrdenesController.toggleState as any);
router.post('/delete', requireAuth, OrdenesController.remove as any);

export default router;
