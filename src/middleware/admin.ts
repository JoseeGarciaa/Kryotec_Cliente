import { Request, Response, NextFunction } from 'express';
import { resolveEffectiveRole } from './roles';

// Requiere autenticación previa (requireAuth) para que req.user exista
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user) return res.redirect('/auth/login');
  const effectiveRole = resolveEffectiveRole(user);
  if (!['admin','super_admin'].includes(effectiveRole)) {
    return res.redirect('/dashboard');
  }
  next();
}
