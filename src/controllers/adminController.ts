import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { withTenant } from '../db/pool';
import { UsersModel } from '../models/User';

export const AdminController = {
  // Render principal
  listView: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant as string;
    const flash = { error: (req.query.error as string) || null, ok: (req.query.ok as string) || null };
    try {
      const users = await withTenant(tenant, (client) => UsersModel.listAll(client));
      const activos = users.filter(u => u.activo).length;
      res.render('administracion/index', { title: 'Administración', users, total: users.length, activos, inactivos: users.length - activos, flash });
    } catch (e) {
      console.error(e);
      res.status(500).render('administracion/index', { title: 'Administración', users: [], total: 0, activos: 0, inactivos: 0, flash: { error: 'Error cargando usuarios', ok: null } });
    }
  },

  // Crear usuario (form HTML)
  newUser: async (req: Request, res: Response) => {
    const { nombre, correo, telefono, password, rol } = req.body as any;
    const tenant = (req as any).user?.tenant as string;
    if (!nombre || !correo) return res.redirect('/administracion?error=Nombre+y+correo+requeridos');
    try {
      // Normalizamos correo para búsqueda (trim). Si la base usa citext o lower() en índice seguirá funcionando.
      const correoNorm = (correo as string).trim();
      const exists = await withTenant(tenant, (client) => UsersModel.findByCorreo(client, correoNorm));
      if (exists) {
        return res.redirect(`/administracion?error=Correo+ya+existe:+${encodeURIComponent(correoNorm)}`);
      }
      const hashed = password ? await bcrypt.hash(password, 10) : await bcrypt.hash('Cambio123', 10);
      await withTenant(tenant, (client) => UsersModel.create(client, { nombre: nombre.trim(), correo: correoNorm, telefono, password: hashed, rol: (rol || 'User').trim(), activo: true }));
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

  // Editar usuario (form HTML)
  editUser: async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const { nombre, correo, telefono, password, rol, activo } = req.body as any;
    const tenant = (req as any).user?.tenant as string;
    if (!id || !nombre || !correo) return res.redirect('/administracion?error=Datos+inválidos');
    try {
      const correoNorm = (correo as string).trim();
      // Verificar duplicidad si el correo cambia
      const existingWithCorreo = await withTenant(tenant, async (client) => UsersModel.findByCorreo(client, correoNorm));
      if (existingWithCorreo && existingWithCorreo.id !== id) {
        return res.redirect('/administracion?error=Correo+ya+usado');
      }
      const hashed = password ? await bcrypt.hash(password, 10) : null;
      const updated = await withTenant(tenant, (client) => UsersModel.update(client, id, { nombre: nombre.trim(), correo: correoNorm, telefono, password: hashed, rol: (rol || 'User').trim(), activo: activo === 'true' || activo === true }));
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
      await withTenant(tenant, (client) => UsersModel.setActivo(client, id, activo === 'true' || activo === true));
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
