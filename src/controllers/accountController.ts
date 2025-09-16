import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { withTenant } from '../db/pool';
import { UsersModel } from '../models/User';
import { resolveTenant } from '../middleware/tenant';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export const AccountController = {
  index: async (req: Request, res: Response) => {
    const u: any = (res.locals as any).user;
    if (!u) return res.redirect('/auth/login');
    const t = resolveTenant(req);
    const tenantSchema = t ? (t.startsWith('tenant_') ? t : `tenant_${t}`) : (u.tenant || '');
    try {
      const accountUser = await withTenant(tenantSchema, (client) => UsersModel.findById(client, u.sub));
      return res.render('account/index', { accountUser, layout: 'layouts/main', title: 'Mi cuenta' });
    } catch (e) {
      console.error(e);
      return res.status(500).render('account/index', { accountUser: null, layout: 'layouts/main', title: 'Mi cuenta', error: 'Error al cargar la cuenta' });
    }
  },

  updateProfile: async (req: Request, res: Response) => {
    const u: any = (res.locals as any).user;
    if (!u) return res.redirect('/auth/login');
    const t = resolveTenant(req);
    const tenantSchema = t ? (t.startsWith('tenant_') ? t : `tenant_${t}`) : (u.tenant || '');
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
        });
        if (updated) {
          // Refrescar cookie JWT para reflejar inmediatamente el nuevo nombre/correo
          const token = jwt.sign({ sub: updated.id, tenant: tenantSchema, rol: updated.rol, nombre: updated.nombre, correo: updated.correo }, config.jwtSecret, { expiresIn: '120m' });
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
    const t = resolveTenant(req);
    const tenantSchema = t ? (t.startsWith('tenant_') ? t : `tenant_${t}`) : (u.tenant || '');
    const { current_password, new_password } = req.body as any;
    try {
  const user = await withTenant(tenantSchema, (client) => UsersModel.findById(client, u.sub));
      if (!user) return res.status(404).redirect('/cuenta');
      let match = false;
      if (/^\$2[aby]\$/.test(user.password)) match = await bcrypt.compare(current_password, user.password);
      else match = user.password === current_password;
      if (!match) return res.status(400).redirect('/cuenta');
      const hashed = await bcrypt.hash(new_password, 10);
      await withTenant(tenantSchema, async (client) => {
        const updated = await UsersModel.update(client, u.sub, { nombre: user!.nombre, correo: user!.correo, telefono: user!.telefono || null, password: hashed, rol: user!.rol, activo: user!.activo });
        if (updated) {
          // Refrescar cookie JWT por consistencia
          const token = jwt.sign({ sub: updated.id, tenant: tenantSchema, rol: updated.rol, nombre: updated.nombre, correo: updated.correo }, config.jwtSecret, { expiresIn: '120m' });
          res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 120*60*1000 });
        }
      });
      return res.redirect('/cuenta');
    } catch (e) {
      console.error(e);
      return res.status(500).redirect('/cuenta');
    }
  }
};
