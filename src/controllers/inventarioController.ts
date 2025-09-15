import { Request, Response } from 'express';
import { withTenant } from '../db/pool';
import { requireAuth } from '../middleware/auth';

export const InventarioController = {
  index: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    // Inputs
    const { q: qRaw, cat: catRaw, state: stateRaw, page: pageRaw, limit: limitRaw, rfids: rfidsRaw } = req.query as any;
    const q = (qRaw ? String(qRaw) : '').slice(0, 24);
    const cat = catRaw ? String(catRaw).toLowerCase() : '';
    const state = stateRaw ? String(stateRaw).toLowerCase() : '';
    const page = Math.max(1, parseInt(String(pageRaw||'1'), 10) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(String(limitRaw||'20'), 10) || 20));

    // Multi-scan: lista de RFIDs (param rfids=rfid1,rfid2,...)
    // Normalizamos: solo tokens alfanum de 24 chars, sin duplicados.
    let scannedRfids: string[] = [];
    if (rfidsRaw) {
      const tokens = String(rfidsRaw).split(/[\s,;+]+/).map(s => s.trim()).filter(Boolean);
      const set = new Set<string>();
      for (const t of tokens) { if (/^[A-Za-z0-9]{24}$/.test(t)) set.add(t); }
      scannedRfids = Array.from(set);
    }

    // Modo caja (cuando hay un único RFID por q y NO hay multi-scan)
    const isRfidQuery = /^[A-Za-z0-9]{24}$/.test(q || '');
    let cajaMode = false; // cuando es RFID y no multi-scan, mostrar toda la caja
    let cajaJoin = false; // si true, usamos JOIN con acond_caja_items
    let cajaWhereSQL = '';
    let cajaParams: any[] = [];
    let cajaInfo: { by: 'caja_id'|'lote'; value: string|number } | null = null;

    if (isRfidQuery && scannedRfids.length === 0) {
      try {
        // 1) Intentar encontrar caja_id por mapping
        const byCaja = await withTenant(tenant, (c) => c.query(`
          SELECT aci.caja_id, c.lote
            FROM acond_caja_items aci
            JOIN acond_cajas c ON c.caja_id = aci.caja_id
           WHERE aci.rfid = $1
           LIMIT 1`, [q]));
        if (byCaja.rowCount) {
          const id = byCaja.rows[0].caja_id as number;
          cajaMode = true; cajaJoin = true; cajaWhereSQL = 'WHERE aci.caja_id = $1'; cajaParams = [id];
          cajaInfo = { by: 'caja_id', value: id };
        } else {
          // 2) Fallback por lote del RFID
          const byLote = await withTenant(tenant, (c) => c.query(
            `SELECT lote FROM inventario_credocubes WHERE rfid=$1 LIMIT 1`, [q]
          ));
          const lote = (byLote.rows?.[0]?.lote || '').toString().trim();
          if (lote) {
            cajaMode = true; cajaJoin = false; cajaWhereSQL = 'WHERE ic.lote = $1'; cajaParams = [lote];
            cajaInfo = { by: 'lote', value: lote };
          }
        }
      } catch {
        // Si algo falla, seguimos con flujo normal de búsqueda
      }
    }

    // Build filters (modo normal)
    const where: string[] = [];
    const params: any[] = [];
    if (q && !cajaMode && scannedRfids.length === 0) {
      params.push(`%${q}%`);
      where.push('(' +
        'ic.nombre_unidad ILIKE $' + params.length +
        ' OR ic.rfid ILIKE $' + params.length +
        ' OR COALESCE(ic.lote, \'\') ILIKE $' + params.length +
        ' OR ic.estado ILIKE $' + params.length +
      ')');
    }
    // Filtro multi-scan: solo los RFIDs escaneados
    if (scannedRfids.length > 0) {
      // Generamos placeholders dinámicos
      const base = params.length;
      const ph = scannedRfids.map((_, i) => '$' + (base + i + 1));
      where.push('ic.rfid IN (' + ph.join(',') + ')');
      for (const r of scannedRfids) params.push(r);
    }

    const catExpr = `CASE
      WHEN m.nombre_modelo ILIKE '%tic%' THEN 'TIC'
      WHEN m.nombre_modelo ILIKE '%vip%' THEN 'VIP'
      WHEN m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%' THEN 'Cubes'
      ELSE 'Otros' END`;

    // En modo caja, ignoramos cat/state para mostrar la caja completa
    if (!cajaMode && scannedRfids.length === 0) {
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
    }

    // Ejecutar consultas según el modo
    let total = 0; let pages = 1; const offset = (page - 1) * limit;
    let items: any; let countsMap: Record<string, number> = { TIC: 0, VIP: 0, Cubes: 0, Otros: 0 };
    if (cajaMode) {
      // COUNT
      const countSQL = `SELECT COUNT(*)::int AS total
          FROM inventario_credocubes ic
          JOIN modelos m ON m.modelo_id = ic.modelo_id
          ${cajaJoin ? 'JOIN acond_caja_items aci ON aci.rfid = ic.rfid' : ''}
          ${cajaWhereSQL}`;
      const countRes = await withTenant(tenant, (c) => c.query(countSQL, cajaParams));
      total = countRes.rows[0]?.total || 0;
      pages = Math.max(1, Math.ceil(total / limit));
      // ITEMS
      const itemsSQL = `SELECT 
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
         ${cajaJoin ? 'JOIN acond_caja_items aci ON aci.rfid = ic.rfid' : ''}
         ${cajaWhereSQL}
         ORDER BY ic.id DESC
         LIMIT $${cajaParams.length+1} OFFSET $${cajaParams.length+2}`;
      items = await withTenant(tenant, (c) => c.query(itemsSQL, [...cajaParams, limit, offset]));
      // COUNTS por categoría (sobre el mismo conjunto)
      const countsSQL = `SELECT categoria, COUNT(*)::int AS cnt FROM (
           SELECT ${catExpr} AS categoria
             FROM inventario_credocubes ic
             JOIN modelos m ON m.modelo_id = ic.modelo_id
             ${cajaJoin ? 'JOIN acond_caja_items aci ON aci.rfid = ic.rfid' : ''}
             ${cajaWhereSQL}
         ) s GROUP BY categoria`;
      const countsRes = await withTenant(tenant, (c) => c.query(countsSQL, cajaParams));
      for (const r of countsRes.rows as any[]) { countsMap[r.categoria] = Number(r.cnt) || 0; }
    } else if (scannedRfids.length > 0) {
      const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const countRes = await withTenant(tenant, (c) => c.query(
        `SELECT COUNT(*)::int AS total
           FROM inventario_credocubes ic
           JOIN modelos m ON m.modelo_id = ic.modelo_id
           ${whereSQL}`,
        params
      ));
      total = countRes.rows[0]?.total || 0;
      pages = Math.max(1, Math.ceil(total / limit));
      items = await withTenant(tenant, (c) => c.query(
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
      ));
      // Counts sólo sobre los RFIDs (sin filtros de categoría/estado adicionales para no confundir)
      const countsRes = await withTenant(tenant, (c) => c.query(
        `SELECT categoria, COUNT(*)::int AS cnt FROM (
           SELECT ${catExpr} AS categoria
             FROM inventario_credocubes ic
             JOIN modelos m ON m.modelo_id = ic.modelo_id
             ${whereSQL}
         ) s GROUP BY categoria`, params));
      for (const r of countsRes.rows as any[]) { countsMap[r.categoria] = Number(r.cnt) || 0; }
    } else {
      const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
      // COUNT
      const countRes = await withTenant(tenant, (c) =>
        c.query(
          `SELECT COUNT(*)::int AS total
             FROM inventario_credocubes ic
             JOIN modelos m ON m.modelo_id = ic.modelo_id
             ${whereSQL}`,
          params
        )
      );
      total = countRes.rows[0]?.total || 0;
      pages = Math.max(1, Math.ceil(total / limit));
      // ITEMS
      items = await withTenant(tenant, (c) =>
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
      // COUNTS
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
      for (const r of countsRes.rows as any[]) { countsMap[r.categoria] = Number(r.cnt) || 0; }
    }

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
      counts: { total, tics: countsMap['TIC'], vips: countsMap['VIP'], cubes: countsMap['Cubes'] },
      scannedRfids,
      multiScan: scannedRfids.length > 0,
      cajaMode,
    });
  },
  data: async (req: Request, res: Response) => {
    // Versión JSON simplificada para live-scan (sin paginación avanzada por ahora)
    const tenant = (req as any).user?.tenant;
    const { q: qRaw, rfids: rfidsRaw, limit: limitRaw } = req.query as any;
    const q = (qRaw ? String(qRaw) : '').slice(0, 24);
    const limit = Math.min(500, Math.max(10, parseInt(String(limitRaw||'100'), 10) || 100));
    let scanned: string[] = [];
    if(rfidsRaw){
      const toks = String(rfidsRaw).split(/[\s,;+]+/).map(s=>s.trim()).filter(Boolean);
      const set = new Set<string>();
      for(const t of toks){ if(/^[A-Za-z0-9]{24}$/.test(t)) set.add(t.toUpperCase()); }
      scanned = Array.from(set);
    }
    const isSingleRfid = scanned.length===0 && /^[A-Za-z0-9]{24}$/.test(q||'');
    try {
      if(isSingleRfid){
        // Regla: con un solo RFID se devuelve solo ese item si existe (no expandir a caja)
        const rows = await withTenant(tenant, c=>c.query(
          `SELECT ic.id, ic.nombre_unidad, ic.modelo_id, ic.rfid, ic.lote, ic.estado, ic.sub_estado, ic.fecha_ingreso
             FROM inventario_credocubes ic
            WHERE ic.rfid=$1`, [q]
        ));
        return res.json({ ok:true, mode:'single', count: rows.rowCount, items: rows.rows });
      }
      if(scanned.length>0){
        // Multi: traer todos esos RFIDs
        const placeholders = scanned.map((_,i)=>'$'+(i+1));
        const sql = `SELECT ic.id, ic.nombre_unidad, ic.modelo_id, ic.rfid, ic.lote, ic.estado, ic.sub_estado, ic.fecha_ingreso
                     FROM inventario_credocubes ic
                     WHERE ic.rfid IN (${placeholders.join(',')})
                     ORDER BY ic.id DESC`;
        const rows = await withTenant(tenant, c=>c.query(sql, scanned));
        return res.json({ ok:true, mode:'multi', count: rows.rowCount, items: rows.rows });
      }
      // Búsqueda normal limitada
      if(q){
        const sql = `SELECT ic.id, ic.nombre_unidad, ic.modelo_id, ic.rfid, ic.lote, ic.estado, ic.sub_estado, ic.fecha_ingreso
                     FROM inventario_credocubes ic
                     WHERE ic.nombre_unidad ILIKE $1 OR ic.rfid ILIKE $1 OR COALESCE(ic.lote,'') ILIKE $1 OR ic.estado ILIKE $1
                     ORDER BY ic.id DESC LIMIT $2`;
        const rows = await withTenant(tenant, c=>c.query(sql, ['%'+q+'%', limit]));
        return res.json({ ok:true, mode:'search', count: rows.rowCount, items: rows.rows });
      }
      return res.json({ ok:true, mode:'empty', count:0, items:[] });
    } catch(e:any){
      return res.status(500).json({ ok:false, error:'error fetching inventario'});
    }
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
      // Hard delete: elimina el registro de la base de datos
      await withTenant(tenant, (c)=> c.query(
        `DELETE FROM inventario_credocubes WHERE id=$1`, [id]
      ));
      return res.redirect('/inventario');
    } catch(e:any){
      // Redirige con mensaje de error en vez de enviar error crudo
      return res.redirect('/inventario?error=eliminar');
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
