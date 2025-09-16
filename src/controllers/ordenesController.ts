import { Request, Response } from 'express';
import { withTenant } from '../db/pool';
import { resolveTenant } from '../middleware/tenant';

export const OrdenesController = {
  index: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).send('Tenant no especificado');
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;

    // Ensure table exists per provided schema and then fetch recent orders
    try {
      await withTenant(tenant, async (c) => {
        await c.query(`CREATE TABLE IF NOT EXISTS ordenes (
          id serial PRIMARY KEY,
          numero_orden text,
          codigo_producto text,
          cantidad integer,
          ciudad_destino text,
          ubicacion_destino text,
          cliente text,
          fecha_generacion timestamptz
        )`);
      });
      const q = await withTenant(tenant, (c) => c.query(
        `SELECT id, numero_orden, codigo_producto, cantidad, ciudad_destino, ubicacion_destino, cliente, fecha_generacion
           FROM ordenes
          ORDER BY id DESC
          LIMIT 200`
      ));
      res.render('ordenes/index', {
        title: 'Órdenes',
        items: q.rows || [],
      });
    } catch (e: any) {
      res.render('ordenes/index', {
        title: 'Órdenes',
        items: [],
        error: e?.message || 'Error cargando órdenes',
      });
    }
  },
};
