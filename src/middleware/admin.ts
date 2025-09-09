import { Request, Response, NextFunction } from 'express';

// Requiere autenticación previa (requireAuth) para que req.user exista
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user) return res.redirect('/auth/login');
  const r = (user.rol || '').toLowerCase();
  if (!['admin','administrador'].includes(r)) {
    return res.redirect('/dashboard');
  }
  next();
}
