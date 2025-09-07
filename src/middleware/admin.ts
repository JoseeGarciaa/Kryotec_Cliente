import { Request, Response, NextFunction } from 'express';

// Requiere autenticación previa (requireAuth) para que req.user exista
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user) return res.redirect('/auth/login');
  if (user.rol !== 'Admin' && user.rol !== 'admin') {
    return res.redirect('/dashboard');
  }
  next();
}
