import { Request, Response } from 'express';
import { withTenant } from '../db/pool';
import { requireAuth } from '../middleware/auth';

export const InventarioController = {
  index: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    // Inputs
    const { q: qRaw, cat: catRaw } = req.query as any;
    const q = (qRaw ? String(qRaw) : '').slice(0, 24);
    const cat = catRaw ? String(catRaw).toLowerCase() : '';

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

    const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // Items
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
           ic.fecha_ingreso AS ultima_actualizacion
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
         ${whereSQL}
         ORDER BY ic.id DESC
         LIMIT 200`,
        params
      )
    );

    // Counts by category (respect search filter, not category filter)
    const whereSearchOnly = q ? 'WHERE (ic.nombre_unidad ILIKE $1 OR ic.rfid ILIKE $1 OR COALESCE(ic.lote, \'\') ILIKE $1 OR ic.estado ILIKE $1)' : '';
    const countParams = q ? [`%${q}%`] : [];
    const countsRes = await withTenant(tenant, (c) =>
      c.query(
        `SELECT categoria, COUNT(*)::int AS cnt FROM (
           SELECT ${catExpr} AS categoria
           FROM inventario_credocubes ic
           JOIN modelos m ON m.modelo_id = ic.modelo_id
           ${whereSearchOnly}
         ) s
         GROUP BY categoria`,
        countParams
      )
    );

    const countsMap: Record<string, number> = { TIC: 0, VIP: 0, Cubes: 0, Otros: 0 };
    for (const r of countsRes.rows as any[]) {
      countsMap[r.categoria] = Number(r.cnt) || 0;
    }
    const totalCount = Object.values(countsMap).reduce((a, b) => a + b, 0);

    res.render('inventario/index', {
      title: 'Inventario',
      items: items.rows,
      q,
      cat,
      counts: { total: totalCount, tics: countsMap['TIC'], vips: countsMap['VIP'], cubes: countsMap['Cubes'] },
    });
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
