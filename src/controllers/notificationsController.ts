import { Request, Response } from 'express';
import { resolveTenant } from '../middleware/tenant';
import { withTenant } from '../db/pool';
import { AlertsModel } from '../models/Alerts';

export const NotificationsController = {
  list: async (req: Request, res: Response) => {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const t = resolveTenant(req);
    if (!t) return res.status(400).send('Tenant no especificado');
    const tenantSchema = t.startsWith('tenant_') ? t : `tenant_${t}`;
    try {
      const page = Number(req.query.page || 1) || 1;
      const limit = Math.min(100, Number(req.query.limit || 25) || 25);
      const role = String(u.rol || '').toLowerCase();
      // Simple role-based visibility: admins see everything; other roles focus on inventory-related alerts
      const likePatterns = role === 'administrador' ? undefined : ['inventario:%'];
      const { items, total } = await withTenant(tenantSchema, async (client) => {
        return AlertsModel.list(client, { page, limit, likePatterns });
      });
      return res.render('notifications/index', { items, total, page, limit, layout: 'layouts/main', title: 'Notificaciones' });
    } catch (e) {
      console.error(e);
      return res.status(500).render('notifications/index', { items: [], total: 0, page: 1, limit: 25, layout: 'layouts/main', title: 'Notificaciones', error: 'Error al cargar notificaciones' });
    }
  },

  // JSON feed for browser notifications polling
  apiUpdates: async (req: Request, res: Response) => {
    const u: any = (res.locals as any).user;
    if (!u) return res.status(401).json({ items: [], lastId: 0 });
  const t = resolveTenant(req);
  if (!t) return res.status(400).json({ items: [], lastId: 0 });
  const tenantSchema = t.startsWith('tenant_') ? t : `tenant_${t}`;
    const afterRaw = Number(req.query.after || 0) || 0;
    try {
      const role = String(u.rol || '').toLowerCase();
      const likePatterns = role === 'administrador' ? undefined : ['inventario:%'];
      const { items, lastId } = await withTenant(tenantSchema, async (client) => {
        // Ensure table exists to avoid relation errors bubbling up
        await AlertsModel.ensureTable(client);
        const whereParts: string[] = ['resuelta = FALSE'];
        const params: any[] = [];
        if (afterRaw > 0) {
          params.push(afterRaw);
          whereParts.push(`id > $${params.length}`);
        }
        if (likePatterns && likePatterns.length > 0) {
          const base = params.length;
          const wh = likePatterns.map((_, i) => `tipo_alerta ILIKE $${base + i + 1}`);
          whereParts.push('(' + wh.join(' OR ') + ')');
          params.push(...likePatterns);
        }
        const whereSQL = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';
        const rows = await client.query(
          `SELECT id, inventario_id, tipo_alerta, descripcion, fecha_creacion
             FROM alertas
             ${whereSQL}
           ORDER BY id ASC
           LIMIT 50`,
          params
        );
        // Compute lastId visible for this role (max id for unresolved matching role filter)
        const lastParams: any[] = [];
        const lastWhere: string[] = ['resuelta = FALSE'];
        if (likePatterns && likePatterns.length > 0) {
          const base2 = lastParams.length;
          const wh2 = likePatterns.map((_, i) => `tipo_alerta ILIKE $${base2 + i + 1}`);
          lastWhere.push('(' + wh2.join(' OR ') + ')');
          lastParams.push(...likePatterns);
        }
        const lastSQL = 'SELECT COALESCE(MAX(id), 0)::int AS max_id FROM alertas ' + (lastWhere.length ? 'WHERE ' + lastWhere.join(' AND ') : '');
        const lastRes = await client.query<{ max_id: number }>(lastSQL, lastParams);
        const maxId = Number(lastRes.rows?.[0]?.max_id || 0);
        return { items: rows.rows, lastId: maxId };
      });
      return res.json({ items, lastId });
    } catch (e:any) {
      // Be tolerant: do not propagate infra errors (like transient db) as 5xx to polling
      console.error('[notificaciones][apiUpdates] error:', e?.message||e);
      return res.json({ items: [], lastId: Number(afterRaw)||0 });
    }
  },

  resolve: async (req: Request, res: Response) => {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const t = resolveTenant(req);
    if (!t) return res.status(400).send('Tenant no especificado');
    const tenantSchema = t.startsWith('tenant_') ? t : `tenant_${t}`;
    const id = Number(req.params.id);
    if (!id) return res.redirect('/notificaciones');
    try {
      await withTenant(tenantSchema, (client) => AlertsModel.resolve(client, id));
      return res.redirect('/notificaciones');
    } catch (e) {
      console.error(e);
      return res.status(500).redirect('/notificaciones');
    }
  }
};
