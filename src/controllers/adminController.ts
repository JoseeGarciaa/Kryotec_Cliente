import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { withTenant } from '../db/pool';
import { UsersModel } from '../models/User';
import { ALLOWED_ROLES } from '../middleware/roles';

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
      const rolFinal = (() => {
        const r = (rol || 'Acondicionador').trim();
        return ALLOWED_ROLES.includes(r) ? r : 'Acondicionador';
      })();
      await withTenant(tenant, (client) => UsersModel.create(client, { nombre: nombre.trim(), correo: correoNorm, telefono, password: hashed, rol: rolFinal, activo: true }));
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
      // Obtener estado actual del usuario para validar reglas de último admin
      const currentUser = await withTenant(tenant, (client) => UsersModel.findById(client, id));
      if (!currentUser) return res.redirect('/administracion?error=Usuario+no+existe');

      const hashed = password ? await bcrypt.hash(password, 10) : null;
      const rolFinal = (() => {
        const r = (rol || 'Acondicionador').trim();
        return ALLOWED_ROLES.includes(r) ? r : 'Acondicionador';
      })();
      const nuevoActivo = activo === 'true' || activo === true;

      // Validar: no permitir que el último admin quede sin admin (desactivado o cambio de rol)
      const isCurrentlyAdmin = ['admin','administrador'].includes((currentUser.rol || '').toLowerCase());
      const willBeAdmin = ['admin','administrador'].includes((rolFinal || '').toLowerCase());
      if (isCurrentlyAdmin && (!willBeAdmin || !nuevoActivo)) {
        const lastAdminCount = await withTenant(tenant, (client) => UsersModel.countActiveAdmins(client));
        // Si solo hay un admin activo y este cambio lo elimina como admin (por rol o activo=false), bloquear
        if (lastAdminCount === 1) {
          return res.redirect('/administracion?error=No+se+puede+quitar+el+último+administrador');
        }
      }

      const updated = await withTenant(tenant, (client) => UsersModel.update(client, id, { nombre: nombre.trim(), correo: correoNorm, telefono, password: hashed, rol: rolFinal, activo: nuevoActivo }));
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
          const isAdmin = ['admin','administrador'].includes((user.rol || '').toLowerCase());
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
        const isAdmin = ['admin','administrador'].includes((user.rol || '').toLowerCase());
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
