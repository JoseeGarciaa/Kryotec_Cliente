import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { withTenant } from '../db/pool';
import { UsersModel } from '../models/User';
import { config } from '../config';
import { resolveTenant } from '../middleware/tenant';
import { findUserInAnyTenant } from '../services/tenantDiscovery';

export const AuthController = {
  loginView: (req: Request, res: Response) => {
  res.render('auth/login', { error: null, layout: 'layouts/auth', title: 'Acceso al Cliente' });
  },

  login: async (req: Request, res: Response) => {
    const { correo, password } = req.body as { correo: string; password: string };
  let tenantSchema: string | null = null;
  const t = resolveTenant(req);
  if (t) tenantSchema = t.startsWith('tenant_') ? t : `tenant_${t}`;

    try {
      let user = null;
      if (tenantSchema) {
        try {
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
        if (!matches) return res.status(401).render('auth/login', { error: 'Usuario o contraseña incorrectos', layout: 'layouts/auth', title: 'Acceso al Cliente' });
        if (matches.length > 1) {
          return res.status(409).render('auth/login', { error: 'Correo duplicado en múltiples tenants', layout: 'layouts/auth', title: 'Acceso al Cliente' });
        }
        tenantSchema = matches[0].tenant;
        user = matches[0].user;
      }

      // If we still don't have a user (e.g., DEFAULT_TENANT provided but user belongs to another tenant), try discovery
      if (!user) {
        const matches = await findUserInAnyTenant(correo);
        if (!matches) return res.status(401).render('auth/login', { error: 'Usuario o contraseña incorrectos', layout: 'layouts/auth', title: 'Acceso al Cliente' });
        if (matches.length > 1) {
          return res.status(409).render('auth/login', { error: 'Correo duplicado en múltiples tenants', layout: 'layouts/auth', title: 'Acceso al Cliente' });
        }
        tenantSchema = matches[0].tenant;
        user = matches[0].user;
      }

  if (!user) return res.status(401).render('auth/login', { error: 'Usuario o contraseña incorrectos', layout: 'layouts/auth', title: 'Acceso al Cliente' });
  if (!user.activo) return res.status(403).render('auth/login', { error: 'Usuario inactivo', layout: 'layouts/auth', title: 'Acceso al Cliente' });

      let match = false;
      // Support hashed or legacy plaintext passwords
      if (/^\$2[aby]\$/.test(user.password)) {
        match = await bcrypt.compare(password, user.password);
      } else {
        match = user.password === password;
      }
  if (!match) return res.status(401).render('auth/login', { error: 'Usuario o contraseña incorrectos', layout: 'layouts/auth', title: 'Acceso al Cliente' });

  await withTenant(tenantSchema!, (client) => UsersModel.touchUltimoIngreso(client, user.id));

  const token = jwt.sign({ sub: user.id, tenant: tenantSchema, rol: user.rol, nombre: user.nombre, correo: user.correo }, config.jwtSecret, { expiresIn: '120m' });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 120 * 60 * 1000, // 120 minutos
  });
  // Redirección según rol
  const rolLower = (user.rol || '').toLowerCase();
  // Normalización a nuevos nombres
  const legacyMap: Record<string,string> = { preacond:'acondicionador', operacion:'operador', bodega:'bodeguero', inspeccion:'inspeccionador', admin:'administrador' };
  const roleKey = legacyMap[rolLower] || rolLower;
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
          if (matches && matches.length === 1) {
            const tenant = matches[0].tenant;
            const user = matches[0].user;
            await withTenant(tenant, (client) => UsersModel.touchUltimoIngreso(client, user.id));
            const token = jwt.sign({ sub: user.id, tenant, rol: user.rol, nombre: user.nombre, correo: user.correo }, config.jwtSecret, { expiresIn: '120m' });
            res.cookie('token', token, {
              httpOnly: true,
              sameSite: 'lax',
              secure: process.env.NODE_ENV === 'production',
              maxAge: 120 * 60 * 1000, // 120 minutos
            });
            const rolLower = (user.rol || '').toLowerCase();
            const legacyMap: Record<string,string> = { preacond:'acondicionador', operacion:'operador', bodega:'bodeguero', inspeccion:'inspeccionador', admin:'administrador' };
            const roleKey = legacyMap[rolLower] || rolLower;
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
