import { Request, Response, NextFunction } from 'express';

// Nuevos nombres visibles: Administrador, Acondicionador, Operador, Bodeguero, Inspeccionador
// Aceptamos todavía valores legacy (Admin, Preacond, Operacion, Bodega, Inspeccion)
// Canonizamos ahora 'Admin' como etiqueta principal para administradores.
export const ALLOWED_ROLES = [
  'Admin', 'Acondicionador', 'Operador', 'Bodeguero', 'Inspeccionador',
  // legacy / alias aceptados para transición
  'Administrador', 'Preacond', 'Operacion', 'Bodega', 'Inspeccion'
];

// Mapeo legacy -> nuevo
// Mapeos a forma canónica (minúscula). Ambas variantes 'admin'/'administrador' -> 'admin'.
const LEGACY_ALIAS: Record<string,string> = {
  'admin': 'admin',
  'administrador': 'admin',
  'preacond': 'acondicionador',
  'operacion': 'operador',
  'bodega': 'bodeguero',
  'inspeccion': 'inspeccionador'
};

// Definición de permisos por rol (prefijos de URL permitidos)
// NOTA: Se filtra sólo cuando el rol NO es Admin.
const ROLE_ACCESS: Record<string, string[]> = {
  acondicionador: [
    '/operacion/preacond',
    '/operacion/acond',
    '/cuenta', '/notificaciones',
    '/auth', '/ui/theme', '/static', '/health'
  ],
  operador: [
    '/operacion/operacion',
    '/operacion/data',
    '/operacion/add',
    '/operacion/caja',
    '/operacion/scan',
    '/operacion/devolucion',
    '/cuenta', '/notificaciones',
    '/auth', '/ui/theme', '/static', '/health'
  ],
  bodeguero: [
    '/operacion/bodega',
  '/operacion/bodega-pend-insp',
    '/registro',
    '/cuenta', '/notificaciones',
    '/auth', '/ui/theme', '/static', '/health'
  ],
  inspeccionador: [
    '/operacion/inspeccion',
    '/cuenta', '/notificaciones',
    '/auth', '/ui/theme', '/static', '/health'
  ],
};

export function restrictByRole(req: Request, res: Response, next: NextFunction) {
  const user: any = (req as any).user || (res.locals as any).user;
  if (!user) return next();
  const raw = (user.rol || '').toLowerCase();
  const rolLower = LEGACY_ALIAS[raw] || raw; // normalizado a nuevo naming
  if (rolLower === 'admin') return next();

  const allowed = ROLE_ACCESS[rolLower];
  if (!allowed) return next(); // Rol no reconocido: dejar pasar (o se podría bloquear)
  const p = req.path;
  const ok = allowed.some(pref => p === pref || p.startsWith(pref + '/'));
  if (!ok) {
    // Redirección a la primera ruta permitida específica del rol (omitimos genéricas como /auth)
    const primary = allowed.find(a => a.startsWith('/operacion')) || '/auth/login';
    return res.redirect(primary);
  }
  return next();
}

// (Opcional futuro) Helper para exigir un conjunto de roles en rutas específicas
export function requireRoles(roles: string[]) {
  const normalized = roles.map(r => r.toLowerCase());
  return (req: Request, res: Response, next: NextFunction) => {
    const user: any = (req as any).user || (res.locals as any).user;
    if (!user) return res.redirect('/auth/login');
    const rol = (user.rol || '').toLowerCase();
    if (!normalized.includes(rol)) return res.redirect('/dashboard');
    return next();
  };
}
