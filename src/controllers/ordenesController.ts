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
  // JSON list for dropdowns/selects
  listJson: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok:false, error:'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
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
      return res.json({ ok:true, items: q.rows||[] });
    } catch(e:any){
      return res.status(500).json({ ok:false, error: e?.message||'Error listando órdenes' });
    }
  },
  create: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok:false, error:'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const {
      numero_orden,
      codigo_producto,
      cantidad,
      ciudad_destino,
      ubicacion_destino,
      cliente,
      fecha_generacion
    } = (req.body || {}) as any;

    // Validación mínima
    const num = typeof numero_orden === 'string' && numero_orden.trim() ? numero_orden.trim() : null;
    const cod = typeof codigo_producto === 'string' && codigo_producto.trim() ? codigo_producto.trim() : null;
    const cant = Number(cantidad);
    const cdd = typeof ciudad_destino === 'string' && ciudad_destino.trim() ? ciudad_destino.trim() : null;
    const ubc = typeof ubicacion_destino === 'string' && ubicacion_destino.trim() ? ubicacion_destino.trim() : null;
    const cli = typeof cliente === 'string' && cliente.trim() ? cliente.trim() : null;
    const fgen = fecha_generacion ? new Date(fecha_generacion) : null;
    if(!num || !cod || !Number.isFinite(cant) || cant<=0 || !cli){
      return res.status(400).json({ ok:false, error:'Datos inválidos: numero_orden, codigo_producto, cantidad>0 y cliente son requeridos' });
    }

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
        await c.query(
          `INSERT INTO ordenes (numero_orden, codigo_producto, cantidad, ciudad_destino, ubicacion_destino, cliente, fecha_generacion)
           VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, NOW()))`,
          [num, cod, cant, cdd, ubc, cli, fgen && !isNaN(fgen.getTime()) ? fgen.toISOString() : null]
        );
      });
      // Si acepta HTML, redirigimos a lista; si es JSON (fetch), devolvemos ok
      if((req.headers['content-type']||'').includes('application/json')){
        return res.json({ ok:true });
      }
      return res.redirect('/ordenes');
    } catch (e:any) {
      if((req.headers['content-type']||'').includes('application/json')){
        return res.status(500).json({ ok:false, error: e?.message||'Error creando orden' });
      }
      return res.status(500).send(e?.message||'Error creando orden');
    }
  }
};
