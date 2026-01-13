import { Request, Response } from 'express';
import { withTenant } from '../db/pool';
import { AlertsModel } from '../models/Alerts';
import { resolveTenant } from '../middleware/tenant';
import { getRequestSedeId } from '../utils/sede';
import { ZonasModel } from '../models/Zona';

const PAGE_SIZE_OPTIONS = [5, 10, 15, 20] as const;
const DEFAULT_PAGE_SIZE = 20;

const pushSedeFilter = (where: string[], params: any[], sedeId: number | null, alias = 'ic') => {
  if (sedeId === null) return;
  params.push(sedeId);
  where.push(`${alias}.sede_id = $${params.length}`);
};

export const InventarioController = {
  index: async (req: Request, res: Response) => {
  // Prefer authenticated tenant; fallback to resolver only if missing
  const t0 = (req as any).user?.tenant || resolveTenant(req);
  if (!t0) return res.status(400).send('Tenant no especificado');
  const tenant = String(t0).startsWith('tenant_') ? String(t0) : `tenant_${t0}`;
    // Inputs
    const sedeId = getRequestSedeId(req);
  const { q: qRaw, cat: catRaw, state: stateRaw, page: pageRaw, limit: limitRaw, rfids: rfidsRaw } = req.query as any;
    const q = (qRaw ? String(qRaw) : '').slice(0, 24);
    const cat = catRaw ? String(catRaw).toLowerCase() : '';
    const state = stateRaw ? String(stateRaw).toLowerCase() : '';
    const page = Math.max(1, parseInt(String(pageRaw||'1'), 10) || 1);
    const parsedLimit = parseInt(String(limitRaw ?? DEFAULT_PAGE_SIZE), 10);
    const normalizedLimit = Number.isFinite(parsedLimit) ? parsedLimit : DEFAULT_PAGE_SIZE;
    const limit = Math.min(100, Math.max(5, normalizedLimit));
    const effectiveLimit = limit;

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
  pushSedeFilter(where, params, sedeId);
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

    const selectClause = `
     ic.id,
     ic.nombre_unidad,
     ic.modelo_id,
     ic.rfid,
     ic.lote,
     ic.estado,
     ic.sub_estado,
     ic.zona_id,
     ic.seccion_id,
     ic.fecha_ingreso,
     ic.ultima_actualizacion,
     ic.activo,
     z.nombre AS zona_nombre,
     sc.nombre AS seccion_nombre,
     ${catExpr} AS categoria`;

    const baseFromClause = `
      FROM inventario_credocubes ic
      JOIN modelos m ON m.modelo_id = ic.modelo_id
      LEFT JOIN zonas z ON z.zona_id = ic.zona_id
      LEFT JOIN secciones sc ON sc.seccion_id = ic.seccion_id`;

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
  let total = 0; let pages = 1; const offset = (page - 1) * effectiveLimit;
    let items: any; let countsMap: Record<string, number> = { TIC: 0, VIP: 0, Cubes: 0, Otros: 0 };
    if (cajaMode) {
      if (sedeId !== null && !/ic\.sede_id/.test(cajaWhereSQL)) {
        const glue = /\bwhere\b/i.test(cajaWhereSQL) ? ' AND ' : ' WHERE ';
        cajaWhereSQL = `${cajaWhereSQL}${glue}ic.sede_id = $${cajaParams.length + 1}`;
        cajaParams.push(sedeId);
      }
      // COUNT
      const countSQL = `SELECT COUNT(*)::int AS total
          FROM inventario_credocubes ic
          JOIN modelos m ON m.modelo_id = ic.modelo_id
          ${cajaJoin ? 'JOIN acond_caja_items aci ON aci.rfid = ic.rfid' : ''}
          ${cajaWhereSQL}`;
      const countRes = await withTenant(tenant, (c) => c.query(countSQL, cajaParams));
      total = countRes.rows[0]?.total || 0;
  pages = Math.max(1, Math.ceil(total / effectiveLimit));
      // ITEMS
  const itemsSQL = `SELECT 
${selectClause}
    ${baseFromClause}
    ${cajaJoin ? 'JOIN acond_caja_items aci ON aci.rfid = ic.rfid' : ''}
    ${cajaWhereSQL}
    ORDER BY ic.id DESC
    LIMIT $${cajaParams.length+1} OFFSET $${cajaParams.length+2}`;
      items = await withTenant(tenant, (c) => c.query(itemsSQL, [...cajaParams, effectiveLimit, offset]));
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
  pages = Math.max(1, Math.ceil(total / effectiveLimit));
      items = await withTenant(tenant, (c) => c.query(
  `SELECT 
${selectClause}
    ${baseFromClause}
    ${whereSQL}
      ORDER BY ic.id DESC
      LIMIT $${params.length+1} OFFSET $${params.length+2}`,
        [...params, effectiveLimit, offset]
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
  pages = Math.max(1, Math.ceil(total / effectiveLimit));
      // ITEMS
      items = await withTenant(tenant, (c) =>
        c.query(
          `SELECT 
${selectClause}
            ${baseFromClause}
            ${whereSQL}
                        ORDER BY ic.id DESC
                        LIMIT $${params.length+1} OFFSET $${params.length+2}`,
                      [...params, effectiveLimit, offset]
        )
      );
      // COUNTS
      const whereCounts: string[] = [];
      const paramsCounts: any[] = [];
      pushSedeFilter(whereCounts, paramsCounts, sedeId);
      if (q) {
        paramsCounts.push(`%${q}%`);
        const idx = paramsCounts.length;
        const ph = `$${idx}`;
        whereCounts.push(`(ic.nombre_unidad ILIKE ${ph} OR ic.rfid ILIKE ${ph} OR COALESCE(ic.lote, '') ILIKE ${ph} OR ic.estado ILIKE ${ph})`);
      }
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
      limit: effectiveLimit,
      total,
      counts: { total, tics: countsMap['TIC'], vips: countsMap['VIP'], cubes: countsMap['Cubes'] },
      scannedRfids,
      multiScan: scannedRfids.length > 0,
      cajaMode,
      pageSizeOptions: PAGE_SIZE_OPTIONS,
    });
  },
  data: async (req: Request, res: Response) => {
    // Versión JSON simplificada para live-scan (sin paginación avanzada por ahora)
  const t1 = (req as any).user?.tenant || resolveTenant(req);
  if (!t1) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
  const tenant = String(t1).startsWith('tenant_') ? String(t1) : `tenant_${t1}`;
    const sedeId = getRequestSedeId(req);
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
        const params: any[] = [q];
    let sql = `SELECT ic.id, ic.nombre_unidad, ic.modelo_id, ic.rfid, ic.lote, ic.estado, ic.sub_estado, ic.fecha_ingreso, ic.ultima_actualizacion,
      ic.activo, ic.zona_id, ic.seccion_id, z.nombre AS zona_nombre, sc.nombre AS seccion_nombre
         FROM inventario_credocubes ic
         LEFT JOIN zonas z ON z.zona_id = ic.zona_id
         LEFT JOIN secciones sc ON sc.seccion_id = ic.seccion_id
        WHERE ic.rfid = $1`;
        if (sedeId !== null) {
          params.push(sedeId);
          sql += ` AND ic.sede_id = $${params.length}`;
        }
        const rows = await withTenant(tenant, c=>c.query(sql, params));
        return res.json({ ok:true, mode:'single', count: rows.rowCount, items: rows.rows });
      }
      if(scanned.length>0){
        // Multi: traer todos esos RFIDs
        const placeholders = scanned.map((_,i)=>'$'+(i+1));
    let sql = `SELECT ic.id, ic.nombre_unidad, ic.modelo_id, ic.rfid, ic.lote, ic.estado, ic.sub_estado, ic.fecha_ingreso, ic.ultima_actualizacion,
      ic.activo, ic.zona_id, ic.seccion_id, z.nombre AS zona_nombre, sc.nombre AS seccion_nombre
         FROM inventario_credocubes ic
         LEFT JOIN zonas z ON z.zona_id = ic.zona_id
         LEFT JOIN secciones sc ON sc.seccion_id = ic.seccion_id
        WHERE ic.rfid IN (${placeholders.join(',')})`;
        const params: any[] = [...scanned];
        if (sedeId !== null) {
          params.push(sedeId);
          sql += ` AND ic.sede_id = $${params.length}`;
        }
        sql += ' ORDER BY ic.id DESC';
        const rows = await withTenant(tenant, c=>c.query(sql, params));
        return res.json({ ok:true, mode:'multi', count: rows.rowCount, items: rows.rows });
      }
      // Búsqueda normal limitada
      if(q){
        const params: any[] = ['%'+q+'%'];
        const whereParts = [`(ic.nombre_unidad ILIKE $1 OR ic.rfid ILIKE $1 OR COALESCE(ic.lote,'') ILIKE $1 OR ic.estado ILIKE $1)`];
        if (sedeId !== null) {
          params.push(sedeId);
          whereParts.push(`ic.sede_id = $${params.length}`);
        }
        params.push(limit);
        const limitIndex = params.length;
    const sql = `SELECT ic.id, ic.nombre_unidad, ic.modelo_id, ic.rfid, ic.lote, ic.estado, ic.sub_estado, ic.fecha_ingreso, ic.ultima_actualizacion,
      ic.activo, ic.zona_id, ic.seccion_id, z.nombre AS zona_nombre, sc.nombre AS seccion_nombre
         FROM inventario_credocubes ic
         LEFT JOIN zonas z ON z.zona_id = ic.zona_id
         LEFT JOIN secciones sc ON sc.seccion_id = ic.seccion_id
         WHERE ${whereParts.join(' AND ')}
         ORDER BY ic.id DESC LIMIT $${limitIndex}`;
        const rows = await withTenant(tenant, c=>c.query(sql, params));
        return res.json({ ok:true, mode:'search', count: rows.rowCount, items: rows.rows });
      }
      if (sedeId !== null) {
        const rows = await withTenant(tenant, c=>c.query(
            `SELECT ic.id, ic.nombre_unidad, ic.modelo_id, ic.rfid, ic.lote, ic.estado, ic.sub_estado, ic.fecha_ingreso, ic.ultima_actualizacion,
              ic.activo, ic.zona_id, ic.seccion_id, z.nombre AS zona_nombre, sc.nombre AS seccion_nombre
             FROM inventario_credocubes ic
             LEFT JOIN zonas z ON z.zona_id = ic.zona_id
             LEFT JOIN secciones sc ON sc.seccion_id = ic.seccion_id
            WHERE ic.sede_id = $1
            ORDER BY ic.id DESC
            LIMIT $2`, [sedeId, limit]
        ));
        return res.json({ ok:true, mode:'empty', count: rows.rowCount, items: rows.rows });
      }
      return res.json({ ok:true, mode:'empty', count:0, items:[] });
    } catch(e:any){
      return res.status(500).json({ ok:false, error:'error fetching inventario'});
    }
  },

  update: async (req: Request, res: Response) => {
  const t2 = (req as any).user?.tenant || resolveTenant(req);
  if (!t2) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
  const tenant = String(t2).startsWith('tenant_') ? String(t2) : `tenant_${t2}`;
    const sedeId = getRequestSedeId(req);
    const id = Number((req.params as any).id);
    if(!Number.isFinite(id) || id<=0) return res.status(400).json({ ok:false, error:'id inválido' });
    const { nombre_unidad, lote, zona_id, seccion_id, activo: activoRaw } = req.body as any;

    const parseOptionalNumber = (value: unknown): number | null => {
      if (value === undefined || value === null || value === '') return null;
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };

    const parseOptionalBoolean = (value: unknown): boolean | null => {
      if (value === undefined || value === null || value === '') return null;
      const normalized = String(value).trim().toLowerCase();
      if (['1', 'true', 'on', 'yes', 'habilitado', 'activo'].includes(normalized)) return true;
      if (['0', 'false', 'off', 'no', 'inhabilitado', 'inactivo'].includes(normalized)) return false;
      return null;
    };

    let zonaId = parseOptionalNumber(zona_id);
    let seccionId = parseOptionalNumber(seccion_id);
    const activoFlag = parseOptionalBoolean(activoRaw);

    try {
      const validation = await withTenant(tenant, async (client) => {
        let zonaRecord: Awaited<ReturnType<typeof ZonasModel.findZonaById>> | null = null;
        let seccionRecord: Awaited<ReturnType<typeof ZonasModel.findSeccionById>> | null = null;
        let zonaFinal = zonaId;
        let seccionFinal = seccionId;

        if (seccionFinal !== null) {
          const found = await ZonasModel.findSeccionById(client, seccionFinal);
          if (!found) {
            const err: any = new Error('Seccion no encontrada');
            err.code = 'INVALID_SECCION';
            throw err;
          }
          seccionRecord = found;
          zonaFinal = found.zona_id;
        }

        if (zonaFinal !== null) {
          const foundZona = await ZonasModel.findZonaById(client, zonaFinal);
          if (!foundZona) {
            const err: any = new Error('Zona no encontrada');
            err.code = 'INVALID_ZONA';
            throw err;
          }
          zonaRecord = foundZona;
        }

        if (seccionRecord && zonaRecord && seccionRecord.zona_id !== zonaRecord.zona_id) {
          const err: any = new Error('La seccion no pertenece a la zona seleccionada');
          err.code = 'SECTION_MISMATCH';
          throw err;
        }

        if (sedeId !== null) {
          if (zonaRecord && zonaRecord.sede_id !== sedeId) {
            const err: any = new Error('Zona no pertenece a la sede del usuario');
            err.code = 'ZONE_SEDE_MISMATCH';
            throw err;
          }
          if (seccionRecord && seccionRecord.sede_id !== sedeId) {
            const err: any = new Error('Seccion no pertenece a la sede del usuario');
            err.code = 'SECTION_SEDE_MISMATCH';
            throw err;
          }
        }

        return {
          zona: zonaRecord,
          seccion: seccionRecord,
          zonaId: zonaFinal,
          seccionId: seccionFinal,
        };
      });

      zonaId = validation.zonaId;
      seccionId = validation.seccionId;

      const params: any[] = [
        nombre_unidad || null,
        (lote || '') ? lote : null,
        sedeId ?? null,
        zonaId,
        seccionId,
        activoFlag,
        id,
      ];
      let sql = `UPDATE inventario_credocubes ic SET 
           nombre_unidad = COALESCE($1, ic.nombre_unidad),
           lote = $2,
           sede_id = COALESCE($3, ic.sede_id),
           zona_id = $4,
           seccion_id = $5,
           activo = COALESCE($6, ic.activo),
           estado = CASE
             WHEN $6 IS TRUE THEN 'En bodega'
             WHEN $6 IS FALSE THEN 'Inhabilitado'
             ELSE ic.estado
           END,
           sub_estado = CASE
             WHEN $6 IS NOT NULL THEN NULL
             ELSE ic.sub_estado
           END
         WHERE ic.id = $7`;
      if (sedeId !== null) {
        params.push(sedeId);
        sql += ' AND (ic.sede_id = $8 OR ic.sede_id IS NULL)';
      }
      const updated = await withTenant(tenant, (c) => c.query(sql, params));
      if ((updated as any).rowCount === 0) {
        return res.status(404).json({ ok: false, error: 'Item no encontrado para la sede' });
      }

      const locationBits: string[] = [];
      if (validation.zona) {
        locationBits.push(`zona ${validation.zona.nombre}`);
      } else if (zonaId !== null) {
        locationBits.push(`zona ${zonaId}`);
      }
      if (validation.seccion) {
        locationBits.push(`seccion ${validation.seccion.nombre}`);
      } else if (seccionId !== null) {
        locationBits.push(`seccion ${seccionId}`);
      }
      const locationText = locationBits.length ? locationBits.join(' - ') : '';
      const changeParts: string[] = [];
      if (typeof activoFlag === 'boolean') {
        changeParts.push(activoFlag ? 'habilitado' : 'inhabilitado');
      }
      if (locationText) {
        changeParts.push(locationText);
      }
      const changeText = changeParts.join(' / ');

      await withTenant(tenant, (c) =>
        AlertsModel.create(c, {
          inventario_id: id,
          tipo_alerta: 'inventario:actualizado',
          descripcion: `Item ${id} actualizado${changeText ? ' - ' + changeText : ''}`,
        })
      );
      return res.redirect('/inventario');
    } catch (e: any) {
      const code = typeof e?.code === 'string' ? e.code as string : null;
      if (
        (code && code.startsWith('INVALID_')) ||
        code === 'SECTION_MISMATCH' ||
        code === 'ZONE_SEDE_MISMATCH' ||
        code === 'SECTION_SEDE_MISMATCH'
      ) {
        return res.redirect('/inventario?error=ubicacion');
      }
      return res.status(500).send('Error actualizando');
    }
  },

  remove: async (req: Request, res: Response) => {
  const t3 = (req as any).user?.tenant || resolveTenant(req);
  if (!t3) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
  const tenant = String(t3).startsWith('tenant_') ? String(t3) : `tenant_${t3}`;
    const sedeId = getRequestSedeId(req);
    const id = Number((req.params as any).id);
    if(!Number.isFinite(id) || id<=0) return res.status(400).json({ ok:false, error:'id inválido' });
    try {
      // Soft delete: inhabilita el item para mantener trazabilidad
      const params: any[] = [id];
      let sql = `UPDATE inventario_credocubes
                    SET activo = FALSE,
                        estado = 'Inhabilitado',
                        sub_estado = NULL,
                        ultima_actualizacion = NOW()
                  WHERE id = $1`;
      if (sedeId !== null) {
        params.push(sedeId);
        sql += ' AND (sede_id = $2 OR sede_id IS NULL)';
      }
      const result = await withTenant(tenant, (c)=> c.query(sql, params));
      if ((result as any).rowCount === 0) {
        return res.redirect('/inventario?error=inhabilitar');
      }
      await withTenant(tenant, (c) =>
        AlertsModel.create(c, {
          inventario_id: id,
          tipo_alerta: 'inventario:inhabilitado',
          descripcion: `Item ${id} inhabilitado`,
        })
      );
      return res.redirect('/inventario');
    } catch(e:any){
      // Redirige con mensaje de error en vez de enviar error crudo
      return res.redirect('/inventario?error=inhabilitar');
    }
  },

  create: async (req: Request, res: Response) => {
  const t4 = (req as any).user?.tenant || resolveTenant(req);
  if (!t4) return res.status(400).render('inventario/index', { title: 'Inventario', modelos: [], items: [], error: 'Tenant no especificado' });
  const tenant = String(t4).startsWith('tenant_') ? String(t4) : `tenant_${t4}`;
    const sedeId = getRequestSedeId(req);
    const { modelo_id, nombre_unidad, rfid, lote, estado, sub_estado } = req.body;
    try {
      const inserted = await withTenant(tenant, (c) =>
        c.query(
          `INSERT INTO inventario_credocubes (modelo_id, nombre_unidad, rfid, lote, estado, sub_estado, sede_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, rfid`,
          [modelo_id, nombre_unidad, rfid, lote || null, estado, sub_estado || null, sedeId ?? null]
        )
      );
      const newId = inserted.rows?.[0]?.id as number | undefined;
      const newRfid = inserted.rows?.[0]?.rfid as string | undefined;
      // Crear alerta de creación
      await withTenant(tenant, (c) =>
        AlertsModel.create(c, {
          inventario_id: newId ?? null,
          tipo_alerta: 'inventario:creado',
          descripcion: `Item${newId ? ' '+newId : ''}${newRfid ? ' (RFID '+newRfid+')' : ''} creado`,
        })
      );
      return res.redirect('/inventario');
    } catch (e: any) {
      console.error(e);
      const modelos = await withTenant(tenant, (c) => c.query('SELECT modelo_id, nombre_modelo FROM modelos ORDER BY nombre_modelo'));
      const itemsSql = sedeId !== null
        ? 'SELECT * FROM inventario_credocubes WHERE sede_id = $1 ORDER BY id DESC LIMIT 100'
        : 'SELECT * FROM inventario_credocubes ORDER BY id DESC LIMIT 100';
      const itemsParams = sedeId !== null ? [sedeId] : [];
      const items = await withTenant(tenant, (c) => c.query(itemsSql, itemsParams));
      return res.status(400).render('inventario/index', { title: 'Inventario', modelos: modelos.rows, items: items.rows, error: 'Error creando item (RFID duplicado u otro)' });
    }
  },
};
