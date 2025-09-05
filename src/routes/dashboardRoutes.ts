import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', requireAuth, (_req: Request, res: Response) => {
  res.render('dashboard', { title: 'Dashboard' });
});

export default router;
