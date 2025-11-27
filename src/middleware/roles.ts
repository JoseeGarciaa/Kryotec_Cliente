import { Request, Response, NextFunction } from 'express';

// Nuevos nombres visibles: Administrador, Acondicionador, Operador, Bodeguero, Inspeccionador
// Aceptamos todavía valores legacy (Admin, Preacond, Operacion, Bodega, Inspeccion)
// Canonizamos ahora 'admin' (minúsculas) como etiqueta principal.
export const ALLOWED_ROLES = [
  'admin', 'super_admin',
  'acondicionador', 'operador', 'bodeguero', 'inspeccionador',
  'Acondicionador', 'Operador', 'Bodeguero', 'Inspeccionador',
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

export function collectNormalizedRoles(user: { rol?: string | null; roles?: unknown } | null | undefined): string[] {
  if (!user) return [];
  const list: string[] = [];
  const seen = new Set<string>();
  const pushRole = (value: unknown) => {
    if (value === null || value === undefined) return;
    const normalized = normalizeRoleName(String(value));
    if (!normalized) return;
    let canonical = normalized;
    if (canonical === 'administrador') canonical = 'admin';
    if (canonical === 'preacond') canonical = 'acondicionador';
    if (canonical === 'operacion') canonical = 'operador';
    if (canonical === 'bodega') canonical = 'bodeguero';
    if (canonical === 'inspeccion') canonical = 'inspeccionador';
    if (!['admin','super_admin','acondicionador','operador','bodeguero','inspeccionador'].includes(canonical)) return;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      list.push(canonical);
    }
  };
  const rawRoles: any = (user as any).roles;
  if (Array.isArray(rawRoles)) {
    rawRoles.forEach(pushRole);
  } else if (typeof rawRoles === 'string') {
    const trimmed = rawRoles.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) parsed.forEach(pushRole);
        else pushRole(trimmed);
      } catch {
        pushRole(trimmed);
      }
    } else {
      pushRole(trimmed);
    }
  } else if (rawRoles !== undefined) {
    pushRole(rawRoles);
  }
  pushRole(user?.rol);
  return list;
}

export function resolveEffectiveRole(user: { rol?: string | null; roles?: unknown; sede_id?: unknown; sedeId?: unknown } | null | undefined): string {
  if (!user) return '';
  const sedeValue = (user as any).sede_id ?? (user as any).sedeId ?? null;
  const hasAssignedSede = !(sedeValue === null || sedeValue === undefined || sedeValue === '');
  if (!hasAssignedSede) {
    return 'super_admin';
  }
  const roles = collectNormalizedRoles(user);
  if (roles.includes('super_admin')) return 'super_admin';
  if (roles.includes('admin')) return 'admin';
  if (roles.length) return roles[0];
  return normalizeRoleName(user.rol);
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
  const normalizedRoles = collectNormalizedRoles(user);
  const hasGlobalAccess = rolLower === 'admin' || rolLower === 'super_admin';
  if (hasGlobalAccess) return next();
  const allowedSet = new Set<string>();
  normalizedRoles.forEach((role) => {
    const list = ROLE_ACCESS[role];
    if (Array.isArray(list)) {
      list.forEach((prefix) => allowedSet.add(prefix));
    }
  });
  if (!allowedSet.size) return next(); // Rol no reconocido: dejar pasar (o se podría bloquear)
  const p = req.path;
  const allowed = Array.from(allowedSet);
  const ok = allowed.some(pref => p === pref || p.startsWith(pref + '/'));
  if (!ok) {
    const genericPrefixes = ['/auth', '/ui/theme', '/static', '/health', '/notificaciones', '/cuenta'];
    const candidateRole = rolLower || normalizedRoles[0] || '';
    const primaryList = ROLE_ACCESS[candidateRole] || allowed;
    const primary = primaryList.find(a => !genericPrefixes.includes(a)) || primaryList[0] || '/auth/login';
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
    const userRoles = collectNormalizedRoles(user).map(r => r.toLowerCase());
    const hasRole = normalized.some(r => userRoles.includes(r));
    if (!hasRole) return res.redirect('/dashboard');
    return next();
  };
}
