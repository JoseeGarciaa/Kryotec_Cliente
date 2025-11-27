import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { withTenant } from '../db/pool';
import { UsersModel } from '../models/User';
import { resolveTenant } from '../middleware/tenant';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { validatePasswordStrength, PASSWORD_POLICY_MESSAGE, normalizeSessionTtl } from '../utils/passwordPolicy';

const normalizeTenantSchema = (tenant?: string | null): string | null => {
  if (!tenant) return null;
  const trimmed = String(tenant).trim();
  if (!trimmed) return null;
  return trimmed.startsWith('tenant_') ? trimmed : `tenant_${trimmed}`;
};

const determineTenantSchema = (req: Request, user: any): string | null => {
  const userTenant = normalizeTenantSchema(user?.tenant);
  const requestTenant = normalizeTenantSchema(resolveTenant(req));
  if (userTenant && requestTenant && userTenant !== requestTenant) {
    console.warn('[account] tenant mismatch', {
      userTenant,
      requestTenant,
      userId: user?.sub,
      path: req.originalUrl,
    });
  }
  return userTenant || requestTenant;
};

export const AccountController = {
  index: async (req: Request, res: Response) => {
    const u: any = (res.locals as any).user;
    if (!u) return res.redirect('/auth/login');
    const tenantSchema = determineTenantSchema(req, u);
    if (!tenantSchema) {
      console.error('[account] unable to determine tenant for account view', { userId: u?.sub, path: req.originalUrl });
      res.clearCookie('token');
      return res.redirect('/auth/login');
    }
    try {
      const accountUser = await withTenant(tenantSchema, (client) => UsersModel.findById(client, u.sub));
      const mustChange = req.query.mustChange === '1'
        || req.query.mustChange === 'true'
        || Boolean((res.locals as any)?.user?.mustChangePassword);
      const flash = {
        ok: typeof req.query.ok === 'string' ? req.query.ok : null,
        error: typeof req.query.error === 'string' ? req.query.error : null,
      };
      const latestChange = accountUser?.contrasena_cambiada_en || accountUser?.fecha_creacion;
      const maxAgeMs = config.security.passwordMaxAgeDays * 24 * 60 * 60 * 1000;
      const expiresAt = latestChange ? new Date(latestChange).getTime() + maxAgeMs : null;
      const secondsRemaining = expiresAt ? Math.round((expiresAt - Date.now()) / 1000) : null;
      const daysRemaining = secondsRemaining !== null ? Math.ceil(secondsRemaining / 86400) : null;
      return res.render('account/index', {
        accountUser,
        layout: 'layouts/main',
        title: 'Mi cuenta',
        mustChange,
        flash,
        passwordPolicy: PASSWORD_POLICY_MESSAGE,
        passwordExpiresAt: expiresAt ? new Date(expiresAt) : null,
        passwordDaysRemaining: daysRemaining,
        sessionTtlMin: config.security.minSessionMinutes,
        sessionTtlMax: config.security.maxSessionMinutes,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).render('account/index', {
        accountUser: null,
        layout: 'layouts/main',
        title: 'Mi cuenta',
        error: 'Error al cargar la cuenta',
        mustChange: false,
        flash: { ok: null, error: 'Error al cargar la cuenta' },
        passwordPolicy: PASSWORD_POLICY_MESSAGE,
      });
    }
  },

  updateProfile: async (req: Request, res: Response) => {
    const u: any = (res.locals as any).user;
    if (!u) return res.redirect('/auth/login');
    const tenantSchema = determineTenantSchema(req, u);
    if (!tenantSchema) {
      console.error('[account] unable to determine tenant for profile update', { userId: u?.sub, path: req.originalUrl });
      res.clearCookie('token');
      return res.redirect('/auth/login');
    }
    const { nombre, telefono, correo } = req.body as any;
    try {
      await withTenant(tenantSchema, async (client) => {
        const current = await UsersModel.findById(client, u.sub);
        if (!current) return;
        const updated = await UsersModel.update(client, u.sub, {
          nombre,
          correo,
          telefono,
          rol: current.rol,
          activo: current.activo,
          sede_id: current.sede_id ?? null,
        });
        if (updated) {
          // Refrescar cookie JWT para reflejar inmediatamente el nuevo nombre/correo
          const token = jwt.sign({
            sub: updated.id,
            tenant: tenantSchema,
            rol: updated.rol,
            roles: updated.roles,
            nombre: updated.nombre,
            correo: updated.correo,
            sede_id: updated.sede_id ?? null,
            sede_nombre: updated.sede_nombre ?? null,
          }, config.jwtSecret, { expiresIn: '120m' });
          res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 120*60*1000 });
        }
      });
      return res.redirect('/cuenta');
    } catch (e) {
      console.error(e);
      return res.status(500).redirect('/cuenta');
    }
  },

  changePassword: async (req: Request, res: Response) => {
    const u: any = (res.locals as any).user;
    if (!u) return res.redirect('/auth/login');
    const tenantSchema = determineTenantSchema(req, u);
    if (!tenantSchema) {
      console.error('[account] unable to determine tenant for password change', { userId: u?.sub, path: req.originalUrl });
      res.clearCookie('token');
      return res.redirect('/auth/login');
    }
    const { current_password, new_password, confirm_password } = req.body as any;
    try {
      const user = await withTenant(tenantSchema, (client) => UsersModel.findById(client, u.sub));
      if (!user) return res.status(404).redirect('/cuenta?error=Usuario+no+encontrado');
      if (!new_password || !confirm_password) {
        return res.redirect('/cuenta?error=Debe+ingresar+y+confirmar+la+nueva+contraseña');
      }
      if (new_password !== confirm_password) {
        return res.redirect('/cuenta?error=Las+contraseñas+no+coinciden');
      }
      if (!validatePasswordStrength(new_password)) {
        return res.redirect(`/cuenta?error=${encodeURIComponent(PASSWORD_POLICY_MESSAGE)}`);
      }
      let match = false;
      if (/^\$2[aby]\$/.test(user.password)) match = await bcrypt.compare(current_password, user.password);
      else match = user.password === current_password;
      if (!match) return res.status(400).redirect('/cuenta?error=Contraseña+actual+incorrecta');
      if (/^\$2[aby]\$/.test(user.password)) {
        const samePassword = await bcrypt.compare(new_password, user.password);
        if (samePassword) return res.redirect('/cuenta?error=La+nueva+contraseña+no+puede+ser+igual+a+la+actual');
      } else if (user.password === new_password) {
        return res.redirect('/cuenta?error=La+nueva+contraseña+no+puede+ser+igual+a+la+actual');
      }

      const reused = await withTenant(tenantSchema, async (client) => {
        const hashes = await UsersModel.getRecentPasswordHashes(client, u.sub, 5);
        for (const h of hashes) {
          if (await bcrypt.compare(new_password, h)) {
            return true;
          }
        }
        return false;
      });
      if (reused) {
        return res.redirect('/cuenta?error=No+puede+reutilizar+contraseñas+recientes');
      }

      const hashed = await bcrypt.hash(new_password, 10);
      const result = await withTenant(tenantSchema, async (client) => {
        const sessionVersion = await UsersModel.markPasswordChange(client, u.sub, hashed, u.sub);
        const refreshed = await UsersModel.findById(client, u.sub);
        return { sessionVersion, refreshed };
      });

      if (result?.refreshed) {
        const ttlMinutes = normalizeSessionTtl(result.refreshed.sesion_ttl_minutos ?? config.security.defaultSessionMinutes);
        const token = jwt.sign({
          sub: result.refreshed.id,
          tenant: tenantSchema,
          rol: result.refreshed.rol,
          roles: result.refreshed.roles,
          nombre: result.refreshed.nombre,
          correo: result.refreshed.correo,
          sede_id: result.refreshed.sede_id ?? null,
          sede_nombre: result.refreshed.sede_nombre ?? null,
          mustChangePassword: false,
          sessionVersion: result.sessionVersion,
        }, config.jwtSecret, { expiresIn: `${ttlMinutes}m` });
        res.cookie('token', token, {
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          maxAge: ttlMinutes * 60 * 1000,
        });
      }

      return res.redirect('/cuenta?ok=Contraseña+actualizada');
    } catch (e) {
      console.error(e);
      return res.status(500).redirect('/cuenta?error=No+se+pudo+actualizar+la+contraseña');
    }
  }
};
