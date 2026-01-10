import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { withTenant } from '../db/pool';
import { UsersModel } from '../models/User';
import { SedesModel } from '../models/Sede';
import { normalizeRoleName, resolveEffectiveRole } from '../middleware/roles';
import { normalizeSessionTtl, PASSWORD_POLICY_MESSAGE, validatePasswordStrength } from '../utils/passwordPolicy';
import { config } from '../config';
import { findUserInAnyTenant } from '../services/tenantDiscovery';

function coerceSedeId(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined' || trimmed === 'sin sede' || trimmed === 'todas las sedes') {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

const CANONICAL_ROLE_SET = new Set(['super_admin', 'admin', 'acondicionador', 'operador', 'bodeguero', 'inspeccionador']);
const ROLE_PRIORITY_ORDER = ['super_admin', 'admin', 'acondicionador', 'operador', 'bodeguero', 'inspeccionador'] as const;

function normalizeTenantSchema(tenant?: string | null): string | null {
  if (!tenant) return null;
  const trimmed = String(tenant).trim();
  if (!trimmed) return null;
  return trimmed.startsWith('tenant_') ? trimmed : `tenant_${trimmed}`;
}

function parseRolesInput(rawRoles: unknown, fallback?: string | null): string[] {
  const result: string[] = [];
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
    if (!CANONICAL_ROLE_SET.has(canonical)) return;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  };
  if (Array.isArray(rawRoles)) {
    rawRoles.forEach(pushRole);
  } else if (typeof rawRoles === 'string') {
    const trimmed = rawRoles.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          parsed.forEach(pushRole);
        } else {
          pushRole(trimmed);
        }
      } catch {
        pushRole(trimmed);
      }
    } else if (trimmed.includes(',')) {
      trimmed.split(',').forEach(pushRole);
    } else if (trimmed) {
      pushRole(trimmed);
    }
  } else if (rawRoles !== undefined) {
    pushRole(rawRoles);
  }
  if (fallback) pushRole(fallback);
  if (result.includes('super_admin')) {
    return ['super_admin'];
  }
  if (result.includes('admin')) {
    return ['admin'];
  }
  if (!result.length) pushRole('acondicionador');
  const primary = ROLE_PRIORITY_ORDER.find((role) => result.includes(role)) || result[0] || 'acondicionador';
  return [primary, ...result.filter((role) => role !== primary)];
}

export const AdminController = {
  // Render principal
  listView: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant as string;
    const flash = { error: (req.query.error as string) || null, ok: (req.query.ok as string) || null };
    try {
      const users = await withTenant(tenant, (client) => UsersModel.listAll(client));
      const sedes = await withTenant(tenant, (client) => SedesModel.listAll(client));
      const activos = users.filter(u => u.activo).length;
      res.render('administracion/index', {
        title: 'Administración',
        users,
        total: users.length,
        activos,
        inactivos: users.length - activos,
        flash,
        sedes,
        sessionTtlMin: config.security.minSessionMinutes,
        sessionTtlMax: config.security.maxSessionMinutes,
        sessionTtlDefault: config.security.defaultSessionMinutes,
        passwordPolicy: PASSWORD_POLICY_MESSAGE,
      });
    } catch (e) {
      console.error(e);
      res.status(500).render('administracion/index', {
        title: 'Administración',
        users: [],
        total: 0,
        activos: 0,
        inactivos: 0,
        flash: { error: 'Error cargando usuarios', ok: null },
        sedes: [],
        sessionTtlMin: config.security.minSessionMinutes,
        sessionTtlMax: config.security.maxSessionMinutes,
        sessionTtlDefault: config.security.defaultSessionMinutes,
        passwordPolicy: PASSWORD_POLICY_MESSAGE,
      });
    }
  },

  // Crear usuario (form HTML)
  newUser: async (req: Request, res: Response) => {
    const { nombre, correo, telefono, password, rol, sede_id, sesion_ttl_minutos } = req.body as any;
    const tenantRaw = (req as any).user?.tenant as string | undefined;
    const tenant = normalizeTenantSchema(tenantRaw);
    if (!tenant) {
      return res.redirect('/administracion?error=Tenant+no+especificado');
    }
    if (!nombre || !correo || !password) {
      return res.redirect('/administracion?error=Nombre,+correo+y+contraseña+requeridos');
    }
    try {
      // Normalizamos correo para búsqueda (trim + lower). Si la base usa citext o lower() en índice seguirá funcionando.
      const correoInput = String(correo).trim();
      const correoNorm = correoInput.toLowerCase();

      const matches = await findUserInAnyTenant(correoNorm);
      const currentTenantMatches = matches?.filter((match) => normalizeTenantSchema(match.tenant) === tenant) ?? [];
      const otherTenantMatches = matches?.filter((match) => normalizeTenantSchema(match.tenant) !== tenant) ?? [];

      if (otherTenantMatches.length) {
        return res.redirect('/administracion?error=' + encodeURIComponent('usuario ya pertenece a otro esquema, por favor intentar con otro correo'));
      }

      if (currentTenantMatches.length) {
        return res.redirect(`/administracion?error=Correo+ya+existe:+${encodeURIComponent(correoInput)}`);
      }
      const exists = await withTenant(tenant, (client) => UsersModel.findByCorreo(client, correoNorm));
      if (exists) {
        return res.redirect(`/administracion?error=Correo+ya+existe:+${encodeURIComponent(correoInput)}`);
      }
      const globalMatches = await findUserInAnyTenant(correoNorm);
      const crossTenantDuplicate = Boolean(globalMatches?.some((match) => match.tenant !== tenant));
      if (crossTenantDuplicate) {
        return res.redirect('/administracion?error=' + encodeURIComponent('usuario ya pertenece a otro esquema, por favor intentar con otro correo'));
      }
      const sessionTtl = normalizeSessionTtl(sesion_ttl_minutos ?? config.security.defaultSessionMinutes);
      const initialPassword = String(password).trim();
      if (!validatePasswordStrength(initialPassword)) {
        return res.redirect(`/administracion?error=${encodeURIComponent(PASSWORD_POLICY_MESSAGE)}`);
      }
      const hashed = await bcrypt.hash(initialPassword, 10);
      const rolesNormalized = parseRolesInput((req.body as any)?.roles, rol);
      const primaryRole = rolesNormalized[0] || 'acondicionador';
      let normalizedSedeId = coerceSedeId(sede_id);
      if (rolesNormalized.includes('super_admin')) {
        normalizedSedeId = null;
      }
      await withTenant(tenant, (client) => UsersModel.create(client, {
        nombre: nombre.trim(),
        correo: correoInput,
        telefono,
        password: hashed,
        rol: primaryRole,
        roles: rolesNormalized,
        activo: true,
        sede_id: normalizedSedeId,
        sesion_ttl_minutos: sessionTtl,
        debe_cambiar_contrasena: true,
      }));
      res.redirect('/administracion?ok=Usuario+creado');
    } catch (e: any) {
      console.error(e);
      if (e?.code === '23505') {
        // Intentamos extraer el valor duplicado del mensaje de error de PG
        const detail: string | undefined = e?.detail;
        let msg = 'Correo duplicado';
        if (detail) {
          const m = detail.match(/\((correo|email)\)=\(([^)]+)\)/i);
          if (m) msg = `Correo duplicado: ${m[2]}`;
        }
        return res.redirect('/administracion?error=' + encodeURIComponent(msg));
      }
      res.redirect('/administracion?error=Error+creando+usuario');
    }
  },

  createSede: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant as string | undefined;
    const { nombre, codigo, activa } = req.body as any;
    if (!tenant) return res.redirect('/administracion?error=Tenant+no+especificado');
    const nombreNorm = (nombre || '').trim();
    if (!nombreNorm) return res.redirect('/administracion?error=Nombre+de+sede+requerido');
    const codigoNorm = (codigo || '').trim();
    const activaBool = activa === 'false' ? false : true;
    try {
      await withTenant(tenant, (client) =>
        SedesModel.create(client, {
          nombre: nombreNorm,
          codigo: codigoNorm ? codigoNorm : null,
          activa: activaBool,
        })
      );
      return res.redirect('/administracion?ok=Sede+creada');
    } catch (e: any) {
      console.error(e);
      if (e?.code === '23505') {
        return res.redirect('/administracion?error=Nombre+o+codigo+ya+existe');
      }
      return res.redirect('/administracion?error=Error+creando+sede');
    }
  },

  updateSede: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant as string | undefined;
    const sedeId = Number(req.params.sedeId);
    const { nombre, codigo, activa } = req.body as any;
    if (!tenant) return res.redirect('/administracion?error=Tenant+no+especificado');
    if (!Number.isFinite(sedeId) || sedeId <= 0) {
      return res.redirect('/administracion?error=Sede+inválida');
    }
    const nombreNorm = (nombre || '').trim();
    if (!nombreNorm) {
      return res.redirect('/administracion?error=Nombre+de+sede+requerido');
    }
    const codigoNorm = (codigo || '').trim();
    const activaBool = activa === 'false' ? false : true;
    try {
      const exists = await withTenant(tenant, (client) => SedesModel.findById(client, sedeId));
      if (!exists) {
        return res.redirect('/administracion?error=Sede+no+encontrada');
      }
      await withTenant(tenant, (client) =>
        SedesModel.update(client, sedeId, {
          nombre: nombreNorm,
          codigo: codigoNorm ? codigoNorm : null,
          activa: activaBool,
        })
      );
      return res.redirect('/administracion?ok=Sede+actualizada');
    } catch (e: any) {
      console.error(e);
      if (e?.code === '23505') {
        return res.redirect('/administracion?error=Nombre+o+codigo+duplicado');
      }
      return res.redirect('/administracion?error=Error+actualizando+sede');
    }
  },

  deleteSede: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant as string | undefined;
    const sedeId = Number(req.params.sedeId);
    if (!tenant) return res.redirect('/administracion?error=Tenant+no+especificado');
    if (!Number.isFinite(sedeId) || sedeId <= 0) {
      return res.redirect('/administracion?error=Sede+inválida');
    }
    try {
      const exists = await withTenant(tenant, (client) => SedesModel.findById(client, sedeId));
      if (!exists) {
        return res.redirect('/administracion?error=Sede+no+encontrada');
      }
      const deactivated = await withTenant(tenant, (client) => SedesModel.deactivate(client, sedeId));
      if (!deactivated) {
        return res.redirect('/administracion?error=No+se+pudo+inhabilitar+la+sede');
      }
      return res.redirect('/administracion?ok=Sede+inhabilitada');
    } catch (e: any) {
      console.error(e);
      if (e?.code === '23503') {
        return res.redirect('/administracion?error=No+se+puede+inhabilitar,+tiene+relaciones+activas');
      }
      return res.redirect('/administracion?error=Error+inhabilitando+sede');
    }
  },

  // Editar usuario (form HTML)
  editUser: async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const { nombre, correo, telefono, password, rol, roles, activo, sede_id, sesion_ttl_minutos } = req.body as any;
    const tenantRaw = (req as any).user?.tenant as string | undefined;
    const tenant = normalizeTenantSchema(tenantRaw);
    if (!tenant) return res.redirect('/administracion?error=Tenant+no+especificado');
    if (!id || !nombre || !correo) return res.redirect('/administracion?error=Datos+inválidos');
    try {
      const correoInput = String(correo).trim();
      const correoNorm = correoInput.toLowerCase();
      // Verificar duplicidad si el correo cambia
      const existingWithCorreo = await withTenant(tenant, async (client) => UsersModel.findByCorreo(client, correoNorm));
      if (existingWithCorreo && existingWithCorreo.id !== id) {
        return res.redirect('/administracion?error=Correo+ya+usado');
      }
      // Obtener estado actual del usuario para validar reglas de último admin
      const currentUser = await withTenant(tenant, (client) => UsersModel.findById(client, id));
      if (!currentUser) return res.redirect('/administracion?error=Usuario+no+existe');

      const currentCorreoNorm = (currentUser.correo || '').trim().toLowerCase();
      const correoChanged = currentCorreoNorm !== correoNorm;
      if (correoChanged) {
        const matches = await findUserInAnyTenant(correoNorm);
        const conflicts = matches?.filter((match) => normalizeTenantSchema(match.tenant) !== tenant || match.user.id !== id) ?? [];
        const crossTenantConflict = conflicts.some((match) => normalizeTenantSchema(match.tenant) !== tenant);
        if (crossTenantConflict) {
          return res.redirect('/administracion?error=' + encodeURIComponent('usuario ya pertenece a otro esquema, por favor intentar con otro correo'));
        }
      }

      let hashed: string | null = null;
      if (password) {
        if (!validatePasswordStrength(password)) {
          return res.redirect(`/administracion?error=${encodeURIComponent(PASSWORD_POLICY_MESSAGE)}`);
        }
        hashed = await bcrypt.hash(password, 10);
      }
      const rolesNormalized = parseRolesInput(roles, rol);
      const primaryRole = rolesNormalized[0] || 'acondicionador';
      const nuevoActivo = activo === 'true' || activo === true;
      let normalizedSedeId = coerceSedeId(sede_id);
      if (rolesNormalized.includes('super_admin')) {
        normalizedSedeId = null;
      }

      // Validar: no permitir que el último admin quede sin admin (desactivado o cambio de rol)
      const currentRoleNorm = resolveEffectiveRole(currentUser);
      const nextRoleNorm = resolveEffectiveRole({ rol: primaryRole, roles: rolesNormalized, sede_id: normalizedSedeId });
      const isCurrentlyAdmin = ['admin','super_admin'].includes(currentRoleNorm);
      const willBeAdmin = ['admin','super_admin'].includes(nextRoleNorm);
      if (isCurrentlyAdmin && (!willBeAdmin || !nuevoActivo)) {
        const lastAdminCount = await withTenant(tenant, (client) => UsersModel.countActiveAdmins(client));
        // Si solo hay un admin activo y este cambio lo elimina como admin (por rol o activo=false), bloquear
        if (lastAdminCount === 1) {
          return res.redirect('/administracion?error=No+se+puede+quitar+el+último+administrador');
        }
      }

      const sessionTtl = sesion_ttl_minutos !== undefined && sesion_ttl_minutos !== ''
        ? normalizeSessionTtl(sesion_ttl_minutos)
        : null;
      const updated = await withTenant(tenant, async (client) => {
        if (hashed) {
          await UsersModel.markPasswordChange(client, id, hashed, (req as any).user?.sub ?? null);
          await UsersModel.forcePasswordReset(client, id);
        }
        return UsersModel.update(client, id, {
          nombre: nombre.trim(),
          correo: correoInput,
          telefono,
          password: null,
          rol: primaryRole,
          roles: rolesNormalized,
          activo: nuevoActivo,
          sede_id: normalizedSedeId,
          sesion_ttl_minutos: sessionTtl,
          debe_cambiar_contrasena: hashed ? true : undefined,
        });
      });
      if (!updated) return res.redirect('/administracion?error=Usuario+no+existe');
      res.redirect('/administracion?ok=actualizado');
    } catch (e: any) {
      console.error(e);
      if (e?.code === '23505') return res.redirect('/administracion?error=Correo+duplicado');
      res.redirect('/administracion?error=Error+actualizando');
    }
  },

  // Cambiar estado (AJAX)
  toggleActivo: async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const tenant = (req as any).user?.tenant as string;
    const { activo } = req.body as any;
    if (!id) return res.status(400).json({ ok: false, error: 'Id inválido' });
    try {
      const desired = activo === 'true' || activo === true;
      // Si se intenta desactivar, validar que no sea el último admin activo
      if (!desired) {
        const isLastAdmin = await withTenant(tenant, async (client) => {
          const user = await UsersModel.findById(client, id);
          if (!user) return false; // si no existe respondemos luego
          const isAdmin = ['admin','super_admin'].includes(resolveEffectiveRole(user));
          if (!isAdmin) return false; // no es admin, se puede desactivar
          const count = await UsersModel.countActiveAdmins(client);
            return count === 1; // último
        });
        if (isLastAdmin) {
          return res.status(400).json({ ok: false, error: 'No se puede desactivar el último administrador' });
        }
      }
      await withTenant(tenant, (client) => UsersModel.setActivo(client, id, desired));
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Error cambiando estado' });
    }
  },

  // Eliminar (AJAX)
  deleteUser: async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const tenant = (req as any).user?.tenant as string;
    if (!id) return res.status(400).json({ ok: false, error: 'Id inválido' });
    try {
      const canDelete = await withTenant(tenant, async (client) => {
        const user = await UsersModel.findById(client, id);
        if (!user) return { proceed: true };
        const isAdmin = ['admin','super_admin'].includes(resolveEffectiveRole(user));
        if (!isAdmin) return { proceed: true };
        const count = await UsersModel.countActiveAdmins(client);
        if (count === 1 && user.activo) {
          return { proceed: false, reason: 'No se puede eliminar el último administrador activo' };
        }
        return { proceed: true };
      });
      if (!(canDelete as any).proceed) {
        return res.status(400).json({ ok: false, error: (canDelete as any).reason || 'Operación no permitida' });
      }
      await withTenant(tenant, (client) => UsersModel.remove(client, id));
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: 'Error eliminando usuario' });
    }
  },

  // API JSON: listado
  listJSON: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant as string;
    try {
      const users = await withTenant(tenant, (client) => UsersModel.listAll(client));
      res.json({ ok: true, users });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Error listando' });
    }
  },

  // API JSON: detalle
  getUserJSON: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant as string;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'Id inválido' });
    try {
      const user = await withTenant(tenant, (client) => UsersModel.findById(client, id));
      if (!user) return res.status(404).json({ ok: false, error: 'No encontrado' });
      res.json({ ok: true, user });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Error obteniendo usuario' });
    }
  },
};
