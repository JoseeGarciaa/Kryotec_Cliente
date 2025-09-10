import { Request, Response } from 'express';
import { withTenant } from '../db/pool';
import { requireAuth } from '../middleware/auth';

export const InventarioController = {
  index: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    // Inputs
  const { q: qRaw, cat: catRaw, state: stateRaw, page: pageRaw, limit: limitRaw } = req.query as any;
    const q = (qRaw ? String(qRaw) : '').slice(0, 24);
    const cat = catRaw ? String(catRaw).toLowerCase() : '';
  const state = stateRaw ? String(stateRaw).toLowerCase() : '';
  const page = Math.max(1, parseInt(String(pageRaw||'1'), 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(String(limitRaw||'20'), 10) || 20));

    // Build filters
    const where: string[] = [];
    const params: any[] = [];
    if (q) {
      params.push(`%${q}%`);
      where.push('(' +
        'ic.nombre_unidad ILIKE $' + params.length +
        ' OR ic.rfid ILIKE $' + params.length +
        ' OR COALESCE(ic.lote, \'\') ILIKE $' + params.length +
        ' OR ic.estado ILIKE $' + params.length +
      ')');
    }

    const catExpr = `CASE
      WHEN m.nombre_modelo ILIKE '%tic%' THEN 'TIC'
      WHEN m.nombre_modelo ILIKE '%vip%' THEN 'VIP'
      WHEN m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%' THEN 'Cubes'
      ELSE 'Otros' END`;

    if (cat === 'tics') {
      where.push(`${catExpr} = 'TIC'`);
    } else if (cat === 'vips') {
      where.push(`${catExpr} = 'VIP'`);
    } else if (cat === 'cubes') {
      where.push(`${catExpr} = 'Cubes'`);
    }

    if (state === 'inhabilitado') {
      where.push(`TRIM(LOWER(ic.estado)) = TRIM(LOWER('Inhabilitado'))`);
    }

    const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // Total count for pagination (respect all filters built above)
    const countRes = await withTenant(tenant, (c) =>
      c.query(
        `SELECT COUNT(*)::int AS total
           FROM inventario_credocubes ic
           JOIN modelos m ON m.modelo_id = ic.modelo_id
           ${whereSQL}`,
        params
      )
    );
    const total = countRes.rows[0]?.total || 0;
    const pages = Math.max(1, Math.ceil(total / limit));
    const offset = (page - 1) * limit;

    // Items (paged)
    const items = await withTenant(tenant, (c) =>
      c.query(
  `SELECT 
           ic.id,
           ic.nombre_unidad,
           ic.modelo_id,
           ic.rfid,
           ic.lote,
           ic.estado,
           ic.sub_estado,
           ${catExpr} AS categoria,
     COALESCE(ic.fecha_ingreso, NOW()) AS ultima_actualizacion
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
         ${whereSQL}
         ORDER BY ic.id DESC
         LIMIT $${params.length+1} OFFSET $${params.length+2}`,
        [...params, limit, offset]
      )
    );

    // Counts by category (respect q and state filters, not category)
    const whereCounts: string[] = [];
    const paramsCounts: any[] = [];
    if (q) { paramsCounts.push(`%${q}%`); whereCounts.push('(ic.nombre_unidad ILIKE $1 OR ic.rfid ILIKE $1 OR COALESCE(ic.lote, \'\') ILIKE $1 OR ic.estado ILIKE $1)'); }
    if (state === 'inhabilitado') { whereCounts.push(`TRIM(LOWER(ic.estado)) = TRIM(LOWER('Inhabilitado'))`); }
    const whereCountsSQL = whereCounts.length ? 'WHERE ' + whereCounts.join(' AND ') : '';
    const countsRes = await withTenant(tenant, (c) => c.query(
      `SELECT categoria, COUNT(*)::int AS cnt FROM (
         SELECT ${catExpr} AS categoria
           FROM inventario_credocubes ic
           JOIN modelos m ON m.modelo_id = ic.modelo_id
           ${whereCountsSQL}
       ) s
       GROUP BY categoria`, paramsCounts));

    const countsMap: Record<string, number> = { TIC: 0, VIP: 0, Cubes: 0, Otros: 0 };
    for (const r of countsRes.rows as any[]) {
      countsMap[r.categoria] = Number(r.cnt) || 0;
    }
    const totalCount = total;

    res.render('inventario/index', {
      title: 'Inventario',
      items: items.rows,
      q,
      cat,
      state,
      page,
      pages,
      limit,
      total,
      counts: { total: totalCount, tics: countsMap['TIC'], vips: countsMap['VIP'], cubes: countsMap['Cubes'] },
    });
  },

  update: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const id = Number((req.params as any).id);
    if(!Number.isFinite(id) || id<=0) return res.status(400).json({ ok:false, error:'id inválido' });
    const { nombre_unidad, lote, estado, sub_estado } = req.body as any;
    try {
      await withTenant(tenant, (c)=> c.query(
        `UPDATE inventario_credocubes SET 
           nombre_unidad = COALESCE($1, nombre_unidad),
           lote = $2,
           estado = COALESCE($3, estado),
           sub_estado = $4
         WHERE id=$5`,
        [nombre_unidad || null, (lote||'')? lote : null, estado || null, (sub_estado||'')? sub_estado : null, id]
      ));
      return res.redirect('/inventario');
    } catch(e:any){
      return res.status(500).send('Error actualizando');
    }
  },

  remove: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const id = Number((req.params as any).id);
    if(!Number.isFinite(id) || id<=0) return res.status(400).json({ ok:false, error:'id inválido' });
    try {
      // Soft delete: mark as Eliminado, deactivate, clear lote/sub_estado
      await withTenant(tenant, (c)=> c.query(
        `UPDATE inventario_credocubes
            SET estado='Eliminado', sub_estado=NULL, activo=false, lote=NULL
          WHERE id=$1`, [id]
      ));
      return res.redirect('/inventario');
    } catch(e:any){
      return res.status(500).send('Error eliminando');
    }
  },

  create: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { modelo_id, nombre_unidad, rfid, lote, estado, sub_estado } = req.body;
    try {
      await withTenant(tenant, (c) =>
        c.query(
          `INSERT INTO inventario_credocubes (modelo_id, nombre_unidad, rfid, lote, estado, sub_estado)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [modelo_id, nombre_unidad, rfid, lote || null, estado, sub_estado || null]
        )
      );
      return res.redirect('/inventario');
    } catch (e: any) {
      console.error(e);
      const modelos = await withTenant(tenant, (c) => c.query('SELECT modelo_id, nombre_modelo FROM modelos ORDER BY nombre_modelo'));
      const items = await withTenant(tenant, (c) => c.query('SELECT * FROM inventario_credocubes ORDER BY id DESC LIMIT 100'));
      return res.status(400).render('inventario/index', { title: 'Inventario', modelos: modelos.rows, items: items.rows, error: 'Error creando item (RFID duplicado u otro)' });
    }
  },
};
