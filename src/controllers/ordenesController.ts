import { Request, Response } from 'express';
import { withTenant } from '../db/pool';
import { resolveTenant } from '../middleware/tenant';

export const OrdenesController = {
  index: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).send('Tenant no especificado');
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;

    // Ensure table exists per provided schema and then fetch recent orders
    let stateFilter: 'all' | 'active' | 'inactive' = 'all';
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
          fecha_generacion timestamptz,
          estado_orden boolean DEFAULT true
        )`);
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS estado_orden boolean DEFAULT true`);
      });
      const rawState = (req.query.state || '').toString().toLowerCase();
      let whereClause = '';
      if(['activa','activas','active','true'].includes(rawState)) {
        stateFilter = 'active';
        whereClause = 'WHERE COALESCE(estado_orden, true) = true';
      } else if(['inhabilitada','inhabilitadas','inactive','false','inhabilitado','inhabilitados'].includes(rawState)) {
        stateFilter = 'inactive';
        whereClause = 'WHERE estado_orden = false';
      }
      const whereSql = whereClause ? `${whereClause}
` : '';
      const queryText = `
        SELECT id, numero_orden, codigo_producto, cantidad, ciudad_destino, ubicacion_destino, cliente, fecha_generacion, estado_orden
          FROM ordenes
        ${whereSql}ORDER BY id DESC
         LIMIT 200
      `;
      const q = await withTenant(tenant, (c) => c.query(queryText));
      res.render('ordenes/index', {
        title: 'Órdenes',
        items: q.rows || [],
        stateFilter,
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
          fecha_generacion timestamptz,
          estado_orden boolean DEFAULT true
        )`);
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS estado_orden boolean DEFAULT true`);
      });
      const q = await withTenant(tenant, (c) => c.query(
        `SELECT id, numero_orden, codigo_producto, cantidad, ciudad_destino, ubicacion_destino, cliente, fecha_generacion
           FROM ordenes
          WHERE COALESCE(estado_orden, true)
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
    let cant: number | null = null;
    if (cantidad !== undefined && cantidad !== null && String(cantidad).trim() !== '') {
      const n = Number(cantidad);
      if (Number.isFinite(n) && n > 0) cant = n; // allow only positive values, else keep null
    }
    const cdd = typeof ciudad_destino === 'string' && ciudad_destino.trim() ? ciudad_destino.trim() : null;
    const ubc = typeof ubicacion_destino === 'string' && ubicacion_destino.trim() ? ubicacion_destino.trim() : null;
    const cli = typeof cliente === 'string' && cliente.trim() ? cliente.trim() : null;
    const fgen = fecha_generacion ? new Date(fecha_generacion) : null;
    if(!num){ return res.status(400).json({ ok:false, error:'El número de orden es requerido' }); }

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
          fecha_generacion timestamptz,
          estado_orden boolean DEFAULT true
        )`);
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS estado_orden boolean DEFAULT true`);
        await c.query(
          `INSERT INTO ordenes (numero_orden, codigo_producto, cantidad, ciudad_destino, ubicacion_destino, cliente, fecha_generacion, estado_orden)
           VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, NOW()), true)`,
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
  ,
  update: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok:false, error:'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const {
      id,
      numero_orden,
      codigo_producto,
      cantidad,
      ciudad_destino,
      ubicacion_destino,
      cliente,
      fecha_generacion
    } = (req.body || {}) as any;
    const orderId = Number(id);
    if(!Number.isFinite(orderId) || orderId<=0){ return res.status(400).json({ ok:false, error:'ID inválido' }); }
    const num = typeof numero_orden === 'string' && numero_orden.trim() ? numero_orden.trim() : null;
    const cod = typeof codigo_producto === 'string' && codigo_producto.trim() ? codigo_producto.trim() : null;
    let cant: number | null = null;
    if (cantidad !== undefined && cantidad !== null && String(cantidad).trim() !== '') {
      const n = Number(cantidad);
      if (Number.isFinite(n) && n > 0) cant = n; // allow only positive values
    }
    const cdd = typeof ciudad_destino === 'string' && ciudad_destino.trim() ? ciudad_destino.trim() : null;
    const ubc = typeof ubicacion_destino === 'string' && ubicacion_destino.trim() ? ubicacion_destino.trim() : null;
    const cli = typeof cliente === 'string' && cliente.trim() ? cliente.trim() : null;
    const fgen = fecha_generacion ? new Date(fecha_generacion) : null;
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
          fecha_generacion timestamptz,
          estado_orden boolean DEFAULT true
        )`);
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS estado_orden boolean DEFAULT true`);
        await c.query(
          `UPDATE ordenes SET
             numero_orden = COALESCE($2, numero_orden),
             codigo_producto = $3,
             cantidad = $4,
             ciudad_destino = $5,
             ubicacion_destino = $6,
             cliente = $7,
             fecha_generacion = COALESCE($8, fecha_generacion)
           WHERE id = $1`,
          [orderId, num, cod, cant, cdd, ubc, cli, fgen && !isNaN(fgen.getTime()) ? fgen.toISOString() : null]
        );
      });
      if((req.headers['content-type']||'').includes('application/json')){
        return res.json({ ok:true });
      }
      return res.redirect('/ordenes');
    } catch(e:any){
      if((req.headers['content-type']||'').includes('application/json')){
        return res.status(500).json({ ok:false, error: e?.message||'Error actualizando orden' });
      }
      return res.status(500).send(e?.message||'Error actualizando orden');
    }
  }
  ,
  remove: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok:false, error:'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const { id } = (req.body || {}) as any;
    const orderId = Number(id);
    if(!Number.isFinite(orderId) || orderId<=0){ return res.status(400).json({ ok:false, error:'ID inválido' }); }
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
          fecha_generacion timestamptz,
          estado_orden boolean DEFAULT true
        )`);
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS estado_orden boolean DEFAULT true`);
        // If an order is linked to cajas, we should not violate FK: order_id in acond_cajas is ON DELETE SET NULL
        await c.query(`ALTER TABLE acond_cajas ADD COLUMN IF NOT EXISTS order_id integer`);
        await c.query(`DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = 'acond_cajas'::regclass
               AND conname = 'acond_cajas_order_id_fkey'
          ) THEN
            BEGIN
              ALTER TABLE acond_cajas
                ADD CONSTRAINT acond_cajas_order_id_fkey
                FOREIGN KEY (order_id) REFERENCES ordenes(id) ON DELETE SET NULL;
            EXCEPTION WHEN others THEN
            END;
          END IF;
        END $$;`);
        await c.query(`DELETE FROM ordenes WHERE id=$1`, [orderId]);
      });
      if((req.headers['content-type']||'').includes('application/json')){
        return res.json({ ok:true });
      }
      return res.redirect('/ordenes');
    } catch(e:any){
      if((req.headers['content-type']||'').includes('application/json')){
        return res.status(500).json({ ok:false, error: e?.message||'Error eliminando orden' });
      }
      return res.status(500).send(e?.message||'Error eliminando orden');
    }
  }
};

