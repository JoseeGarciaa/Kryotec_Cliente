import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { withTenant } from '../db/pool';
import { UsersModel } from '../models/User';
import { config } from '../config';
import { resolveTenant } from '../middleware/tenant';
import { findUserInAnyTenant } from '../services/tenantDiscovery';
import { ensureSecurityArtifacts } from '../services/securityBootstrap';
import { normalizeSessionTtl } from '../utils/passwordPolicy';
import { normalizeRoleName, resolveEffectiveRole } from '../middleware/roles';

export const AuthController = {
  loginView: (req: Request, res: Response) => {
  res.render('auth/login', { error: null, layout: 'layouts/auth', title: 'Acceso al Cliente' });
  },

  login: async (req: Request, res: Response) => {
    const { correo, password } = req.body as { correo: string; password: string };
    let tenantSchema: string | null = null;
    const t = resolveTenant(req);
    console.log('[auth][login] incoming', { correo, defaultTenant: process.env.DEFAULT_TENANT, db: process.env.DB_NAME, resolvedTenant: t });
    if (t) tenantSchema = t.startsWith('tenant_') ? t : `tenant_${t}`;

    try {
      let user = null;
      if (tenantSchema) {
        try {
          await ensureSecurityArtifacts(tenantSchema);
          user = await withTenant(tenantSchema, async (client) => UsersModel.findByCorreo(client, correo));
        } catch (e: any) {
          // If tenant inferred is invalid or missing table, fall back to discovery
          if (e?.code === '3F000' || e?.code === '42P01') {
            tenantSchema = null;
          } else {
            throw e;
          }
        }
      }

      if (!tenantSchema) {
        const matches = await findUserInAnyTenant(correo);
        console.log('[auth][login] discovery matches fallback?', matches?.map(m=>m.tenant));
        if (!matches) return res.status(401).render('auth/login', { error: 'Usuario o contraseña incorrectos', layout: 'layouts/auth', title: 'Acceso al Cliente' });
        const activeMatches = matches.filter((m) => m.user?.activo);
        if (activeMatches.length === 0) {
          return res.status(403).render('auth/login', { error: 'Usuario inactivo', layout: 'layouts/auth', title: 'Acceso al Cliente' });
        }
        if (activeMatches.length > 1) {
          return res.status(409).render('auth/login', { error: 'Correo duplicado en múltiples tenants', layout: 'layouts/auth', title: 'Acceso al Cliente' });
        }
        tenantSchema = activeMatches[0].tenant;
        user = activeMatches[0].user;
      }

      // If we still don't have a user (e.g., DEFAULT_TENANT provided but user belongs to another tenant), try discovery
      if (!user) {
        const matches = await findUserInAnyTenant(correo);
        console.log('[auth][login] discovery matches final?', matches?.map(m=>m.tenant));
        if (!matches) return res.status(401).render('auth/login', { error: 'Usuario o contraseña incorrectos', layout: 'layouts/auth', title: 'Acceso al Cliente' });
        const activeMatches = matches.filter((m) => m.user?.activo);
        if (activeMatches.length === 0) {
          return res.status(403).render('auth/login', { error: 'Usuario inactivo', layout: 'layouts/auth', title: 'Acceso al Cliente' });
        }
        if (activeMatches.length > 1) {
          return res.status(409).render('auth/login', { error: 'Correo duplicado en múltiples tenants', layout: 'layouts/auth', title: 'Acceso al Cliente' });
        }
        tenantSchema = activeMatches[0].tenant;
        user = activeMatches[0].user;
      }

      if (!user || !tenantSchema) {
        return res.status(401).render('auth/login', { error: 'Usuario o contraseña incorrectos', layout: 'layouts/auth', title: 'Acceso al Cliente' });
      }

      await ensureSecurityArtifacts(tenantSchema);

      if (!user.activo) {
        return res.status(403).render('auth/login', { error: 'Usuario inactivo', layout: 'layouts/auth', title: 'Acceso al Cliente' });
      }

      if (user.bloqueado_hasta && new Date(user.bloqueado_hasta).getTime() > Date.now()) {
        const unblockAt = new Date(user.bloqueado_hasta).toLocaleString('es-CO');
        return res.status(423).render('auth/login', { error: `Cuenta bloqueada temporalmente por intentos fallidos. Intenta nuevamente después de ${unblockAt}.`, layout: 'layouts/auth', title: 'Acceso al Cliente' });
      }

      console.log('[auth][login] user found', { tenantSchema, userId: user.id, rol: user.rol, roles: user.roles, activo: user.activo });
      let match = false;
      // Support hashed or legacy plaintext passwords
      if (/^\$2[aby]\$/.test(user.password)) {
        match = await bcrypt.compare(password, user.password);
      } else {
        match = user.password === password;
      }
      console.log('[auth][login] password match?', { match });
      if (!match) {
        const { attempts, lockedUntil } = await withTenant(tenantSchema, (client) =>
          UsersModel.registerFailedLogin(client, user!.id, config.security.maxFailedAttempts, config.security.lockMinutes)
        );
        if (lockedUntil && new Date(lockedUntil).getTime() > Date.now()) {
          const unlock = new Date(lockedUntil).toLocaleString('es-CO');
          return res.status(423).render('auth/login', { error: `Cuenta bloqueada por múltiples intentos fallidos. Intenta nuevamente después de ${unlock}.`, layout: 'layouts/auth', title: 'Acceso al Cliente' });
        }
        const remaining = Math.max(0, config.security.maxFailedAttempts - attempts);
        const warning = remaining > 0
          ? `Usuario o contraseña incorrectos. Intentos restantes: ${remaining}`
          : 'Usuario o contraseña incorrectos.';
        return res.status(401).render('auth/login', { error: warning, layout: 'layouts/auth', title: 'Acceso al Cliente' });
      }

      const expirationSource = user.contrasena_cambiada_en || user.fecha_creacion;
      const maxAgeMs = config.security.passwordMaxAgeDays * 24 * 60 * 60 * 1000;
      const passwordExpired = expirationSource ? (Date.now() - new Date(expirationSource).getTime()) > maxAgeMs : true;
      const isFirstLogin = !user.ultimo_ingreso;
      let mustChangePassword = Boolean(user.debe_cambiar_contrasena || passwordExpired || isFirstLogin);

      const effectiveRole = resolveEffectiveRole(user) || normalizeRoleName(user.rol) || user.rol;

      const sessionMeta = await withTenant(tenantSchema, async (client) => {
        if (passwordExpired && !user.debe_cambiar_contrasena) {
          await UsersModel.forcePasswordReset(client, user.id);
          mustChangePassword = true;
        }
        await UsersModel.resetLoginState(client, user.id);
        await UsersModel.touchUltimoIngreso(client, user.id);
        await UsersModel.logLogin(client, {
          usuarioId: user.id,
          correo: user.correo,
          nombre: user.nombre,
          rol: effectiveRole,
          roles: user.roles,
          tenantSchema,
          sedeId: user.sede_id ?? null,
          sedeNombre: user.sede_nombre ?? null,
        });
        const sessionVersion = await UsersModel.bumpSessionVersion(client, user.id);
        return { sessionVersion };
      });

      const sessionTtlMinutes = normalizeSessionTtl(user.sesion_ttl_minutos ?? config.security.defaultSessionMinutes);
      const token = jwt.sign({
        sub: user.id,
        tenant: tenantSchema,
        rol: user.rol,
        roles: user.roles,
        nombre: user.nombre,
        correo: user.correo,
        sede_id: user.sede_id ?? null,
        sede_nombre: user.sede_nombre ?? null,
        mustChangePassword,
        sessionTtlMinutes,
        sessionVersion: sessionMeta.sessionVersion,
      }, config.jwtSecret, { expiresIn: `${sessionTtlMinutes}m` });
      res.cookie('token', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: sessionTtlMinutes * 60 * 1000,
      });

  // Redirección según rol
  const roleKey = resolveEffectiveRole(user) || normalizeRoleName(user.rol);
  if (mustChangePassword) {
    return res.redirect('/cuenta?mustChange=1');
  }
  if (roleKey === 'super_admin') return res.redirect('/dashboard');
  if (roleKey === 'acondicionador') return res.redirect('/operacion/preacond');
  if (roleKey === 'operador') return res.redirect('/operacion/operacion');
  if (roleKey === 'bodeguero') return res.redirect('/operacion/bodega');
  if (roleKey === 'inspeccionador') return res.redirect('/operacion/inspeccion');
  res.redirect('/inventario');
    } catch (err: any) {
      console.error(err);
      const code = err?.code as string | undefined;
      if (code === '3F000' || code === '42P01') {
        // As final fallback, attempt discovery
        try {
          const matches = await findUserInAnyTenant((req.body as any)?.correo);
          if (matches) {
            const activeMatches = matches.filter((m) => m.user?.activo);
            if (activeMatches.length === 0) {
              return res.status(403).render('auth/login', { error: 'Usuario inactivo', layout: 'layouts/auth', title: 'Acceso al Cliente' });
            }
            if (activeMatches.length > 1) {
              return res.status(409).render('auth/login', { error: 'Correo duplicado en múltiples tenants', layout: 'layouts/auth', title: 'Acceso al Cliente' });
            }
            const tenant = activeMatches[0].tenant;
            const user = activeMatches[0].user;
            await ensureSecurityArtifacts(tenant);
            if (!user.activo) {
              return res.status(403).render('auth/login', { error: 'Usuario inactivo', layout: 'layouts/auth', title: 'Acceso al Cliente' });
            }
            if (user.bloqueado_hasta && new Date(user.bloqueado_hasta).getTime() > Date.now()) {
              const unblockAt = new Date(user.bloqueado_hasta).toLocaleString('es-CO');
              return res.status(423).render('auth/login', { error: `Cuenta bloqueada temporalmente por intentos fallidos. Intenta nuevamente después de ${unblockAt}.`, layout: 'layouts/auth', title: 'Acceso al Cliente' });
            }

            let match = false;
            if (/^\$2[aby]\$/.test(user.password)) {
              match = await bcrypt.compare(password, user.password);
            } else {
              match = user.password === password;
            }
            if (!match) {
              const { attempts, lockedUntil } = await withTenant(tenant, (client) =>
                UsersModel.registerFailedLogin(client, user!.id, config.security.maxFailedAttempts, config.security.lockMinutes)
              );
              if (lockedUntil && new Date(lockedUntil).getTime() > Date.now()) {
                const unlock = new Date(lockedUntil).toLocaleString('es-CO');
                return res.status(423).render('auth/login', { error: `Cuenta bloqueada por múltiples intentos fallidos. Intenta nuevamente después de ${unlock}.`, layout: 'layouts/auth', title: 'Acceso al Cliente' });
              }
              const remaining = Math.max(0, config.security.maxFailedAttempts - attempts);
              const warning = remaining > 0
                ? `Usuario o contraseña incorrectos. Intentos restantes: ${remaining}`
                : 'Usuario o contraseña incorrectos.';
              return res.status(401).render('auth/login', { error: warning, layout: 'layouts/auth', title: 'Acceso al Cliente' });
            }

            const expirationSource = user.contrasena_cambiada_en || user.fecha_creacion;
            const maxAgeMs = config.security.passwordMaxAgeDays * 24 * 60 * 60 * 1000;
            const passwordExpired = expirationSource ? (Date.now() - new Date(expirationSource).getTime()) > maxAgeMs : true;
            const isFirstLogin = !user.ultimo_ingreso;
            let mustChangePassword = Boolean(user.debe_cambiar_contrasena || passwordExpired || isFirstLogin);

            const effectiveRole = resolveEffectiveRole(user) || normalizeRoleName(user.rol) || user.rol;

            const sessionMeta = await withTenant(tenant, async (client) => {
              if (passwordExpired && !user.debe_cambiar_contrasena) {
                await UsersModel.forcePasswordReset(client, user.id);
                mustChangePassword = true;
              }
              await UsersModel.resetLoginState(client, user.id);
              await UsersModel.touchUltimoIngreso(client, user.id);
              await UsersModel.logLogin(client, {
                usuarioId: user.id,
                correo: user.correo,
                nombre: user.nombre,
                rol: effectiveRole,
                roles: user.roles,
                tenantSchema: tenant,
                sedeId: user.sede_id ?? null,
                sedeNombre: user.sede_nombre ?? null,
              });
              const sessionVersion = await UsersModel.bumpSessionVersion(client, user.id);
              return { sessionVersion };
            });

            const sessionTtlMinutes = normalizeSessionTtl(user.sesion_ttl_minutos ?? config.security.defaultSessionMinutes);
            const token = jwt.sign({
              sub: user.id,
              tenant,
              rol: user.rol,
              roles: user.roles,
              nombre: user.nombre,
              correo: user.correo,
              sede_id: user.sede_id ?? null,
              sede_nombre: user.sede_nombre ?? null,
              mustChangePassword,
              sessionVersion: sessionMeta.sessionVersion,
            }, config.jwtSecret, { expiresIn: `${sessionTtlMinutes}m` });
            res.cookie('token', token, {
              httpOnly: true,
              sameSite: 'lax',
              secure: process.env.NODE_ENV === 'production',
              maxAge: sessionTtlMinutes * 60 * 1000,
            });
            const roleKey = resolveEffectiveRole(user) || normalizeRoleName(user.rol);
            if (mustChangePassword) {
              return res.redirect('/cuenta?mustChange=1');
            }
            if (roleKey === 'super_admin') return res.redirect('/dashboard');
            if (roleKey === 'acondicionador') return res.redirect('/operacion/preacond');
            if (roleKey === 'operador') return res.redirect('/operacion/operacion');
            if (roleKey === 'bodeguero') return res.redirect('/operacion/bodega');
            if (roleKey === 'inspeccionador') return res.redirect('/operacion/inspeccion');
            return res.redirect('/inventario');
          }
        } catch {}
        return res.status(400).render('auth/login', { error: 'Tenant inválido o sin tabla de usuarios', layout: 'layouts/auth', title: 'Acceso al Cliente' });
      }
      res.status(500).render('auth/login', { error: 'Error del servidor', layout: 'layouts/auth', title: 'Acceso al Cliente' });
    }
  },

  logout: (_req: Request, res: Response) => {
    res.clearCookie('token');
    res.redirect('/auth/login');
  },
};
