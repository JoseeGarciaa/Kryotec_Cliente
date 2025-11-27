import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', requireAuth, (req: Request, res: Response) => {
  const user = (req as any).user || {};
  const rawRoles = Array.isArray(user.roles)
    ? user.roles
    : (user.role ? [user.role] : []);
  const isSuperAdmin = rawRoles.some((role: any) => String(role || '').toLowerCase() === 'super_admin');
  const rawSedeId = user?.sede_id;
  const parsedSedeId = Number(rawSedeId);
  const hasSede = rawSedeId !== null && rawSedeId !== undefined && rawSedeId !== '' && Number.isFinite(parsedSedeId);
  const sedeLabel = typeof user?.sede_nombre === 'string' && user.sede_nombre.trim().length
    ? user.sede_nombre.trim()
    : (hasSede ? `Sede ${parsedSedeId}` : 'Sin sede asignada');
  const inventoryScopeLabel = isSuperAdmin
    ? 'Inventario global · Todas las sedes'
    : `Inventario sede · ${sedeLabel}`;

  res.render('dashboard', {
    title: 'Dashboard',
    inventoryScopeLabel,
    inventoryScopeSedeName: sedeLabel,
    inventoryScopeSedeId: hasSede ? parsedSedeId : null,
    inventoryScopeHasSede: hasSede,
    inventoryScopeIsSuperAdmin: isSuperAdmin,
  });
});

export default router;
