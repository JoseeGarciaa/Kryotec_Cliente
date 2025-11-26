import { Request, Response, NextFunction } from 'express';

// Nuevos nombres visibles: Administrador, Acondicionador, Operador, Bodeguero, Inspeccionador
// Aceptamos todavía valores legacy (Admin, Preacond, Operacion, Bodega, Inspeccion)
// Canonizamos ahora 'admin' (minúsculas) como etiqueta principal.
export const ALLOWED_ROLES = [
  'admin', 'super_admin', 'Acondicionador', 'Operador', 'Bodeguero', 'Inspeccionador',
  // legacy / alias aceptados para transición
  'Admin', 'Administrador', 'Preacond', 'Operacion', 'Bodega', 'Inspeccion',
  'SuperAdmin', 'superadmin', 'Super Admin', 'super admin', 'Super-Admin', 'super-admin'
];

// Mapeo legacy -> nuevo
// Mapeos a forma canónica (minúscula). Ambas variantes 'admin'/'administrador' -> 'admin'.
const LEGACY_ALIAS: Record<string,string> = {
  'admin': 'admin',
  'administrador': 'admin',
  'preacond': 'acondicionador',
  'operacion': 'operador',
  'bodega': 'bodeguero',
  'inspeccion': 'inspeccionador',
  'superadmin': 'super_admin',
  'super_admin': 'super_admin',
  'super-admin': 'super_admin',
  'super admin': 'super_admin',
  'super administrador': 'super_admin',
  'super-administrador': 'super_admin'
};

export function normalizeRoleName(role: string | null | undefined): string {
  if (!role) return '';
  const normalized = role.toString().trim().toLowerCase();
  return LEGACY_ALIAS[normalized] || normalized;
}

export function resolveEffectiveRole(user: { rol?: string | null; sede_id?: unknown; sedeId?: unknown } | null | undefined): string {
  if (!user) return '';
  const normalizedRole = normalizeRoleName(user.rol);
  const sedeValue = (user as any).sede_id ?? (user as any).sedeId ?? null;
  const hasAssignedSede = !(sedeValue === null || sedeValue === undefined || sedeValue === '');
  if (!hasAssignedSede) {
    return 'super_admin';
  }
  return normalizedRole;
}

// Definición de permisos por rol (prefijos de URL permitidos)
// NOTA: Se filtra sólo cuando el rol NO es Admin.
const ROLE_ACCESS: Record<string, string[]> = {
  acondicionador: [
    '/operacion/preacond',
    '/operacion/acond',
    '/cuenta', '/notificaciones',
    '/auth', '/ui/theme', '/static', '/health'
  ],
  super_admin: [
    '/dashboard',
    '/operacion/todas/data',
    '/inventario',
    '/administracion',
    '/reportes',
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
  const rolLower = resolveEffectiveRole(user);
  if (rolLower === 'admin') return next();

  const allowed = ROLE_ACCESS[rolLower];
  if (!allowed) return next(); // Rol no reconocido: dejar pasar (o se podría bloquear)
  const p = req.path;
  const ok = allowed.some(pref => p === pref || p.startsWith(pref + '/'));
  if (!ok) {
    const genericPrefixes = ['/auth', '/ui/theme', '/static', '/health', '/notificaciones', '/cuenta'];
    const primary = allowed.find(a => !genericPrefixes.includes(a)) || allowed[0] || '/auth/login';
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
