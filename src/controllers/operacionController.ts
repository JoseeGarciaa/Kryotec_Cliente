import { Request, Response } from 'express';
import { withTenant } from '../db/pool';

// Helper: generate next lote code for current day (ddMMyyyy-XXX)
async function generateNextLote(tenant: string): Promise<string> {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2,'0');
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const yyyy = String(now.getFullYear());
  const prefix = `${dd}${mm}${yyyy}`; // e.g. 05092025
  let nextNum = 1;
  await withTenant(tenant, async (c) => {
    const r = await c.query<{ lote: string }>(`SELECT lote FROM inventario_credocubes WHERE lote LIKE $1`, [prefix+'-%']);
    let max = 0;
    for(const row of r.rows){
      const lote = row.lote || '';
      const parts = lote.split('-');
      if(parts.length===2 && parts[0]===prefix){
        const n = parseInt(parts[1], 10);
        if(!isNaN(n) && n>max) max = n;
      }
    }
    nextNum = max + 1;
  });
  const suffix = String(nextNum).padStart(3,'0');
  return `${prefix}-${suffix}`;
}
// Helper: generate next caja lote code: CAJA###-ddMMyyyy (sequence per day)
async function generateNextCajaLote(tenant: string): Promise<string> {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2,'0');
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const yyyy = String(now.getFullYear());
  const datePart = `${dd}${mm}${yyyy}`;
  let next = 1;
  await withTenant(tenant, async (c) => {
    await c.query(`CREATE TABLE IF NOT EXISTS acond_cajas (
       caja_id serial PRIMARY KEY,
       lote text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT NOW()
    )`);
    const r = await c.query<{ lote: string }>(`SELECT lote FROM acond_cajas WHERE lote LIKE $1`, ['CAJA%-'+datePart]);
    let max = 0;
    for(const row of r.rows){
      const m = /^CAJA(\d+)-/.exec(row.lote||'');
      if(m){ const n = parseInt(m[1],10); if(!isNaN(n) && n>max) max = n; }
    }
    next = max + 1;
  });
  return `CAJA${String(next).padStart(3,'0')}-${datePart}`;
}
export const OperacionController = {
  index: (_req: Request, res: Response) => res.redirect('/operacion/todas'),
  todas: (_req: Request, res: Response) => res.render('operacion/todas', { title: 'Operación · Todas las fases' }),
  // Kanban data summary for all phases
  kanbanData: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
  try {
      // Ensure optional tables exist (cajas)
      await withTenant(tenant, async (c) => {
        await c.query(`CREATE TABLE IF NOT EXISTS acond_cajas (
           caja_id serial PRIMARY KEY,
           lote text NOT NULL,
           created_at timestamptz NOT NULL DEFAULT NOW()
        )`);
      });
      // En bodega counts
      const enBodega = await withTenant(tenant, (c) => c.query(
        `SELECT
            SUM(CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 1 ELSE 0 END)::int AS tics,
            SUM(CASE WHEN m.nombre_modelo ILIKE '%vip%' THEN 1 ELSE 0 END)::int AS vips,
            SUM(CASE WHEN (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%') THEN 1 ELSE 0 END)::int AS cubes
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE LOWER(ic.estado)=LOWER('En bodega')`
      ));
      // Pre-acond (congelamiento / atemperamiento) only TICs
      const preAcondCong = await withTenant(tenant, (c) => c.query(
        `SELECT
            SUM(CASE WHEN ic.sub_estado='Congelamiento' THEN 1 ELSE 0 END)::int AS en_proceso,
            SUM(CASE WHEN ic.sub_estado='Congelado' THEN 1 ELSE 0 END)::int AS completado
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE ic.estado='Pre Acondicionamiento' AND (m.nombre_modelo ILIKE '%tic%')`
      ));
      const preAcondAtemp = await withTenant(tenant, (c) => c.query(
        `SELECT
            SUM(CASE WHEN ic.sub_estado='Atemperamiento' THEN 1 ELSE 0 END)::int AS en_proceso,
            SUM(CASE WHEN ic.sub_estado='Atemperado' THEN 1 ELSE 0 END)::int AS completado
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE ic.estado='Pre Acondicionamiento' AND (m.nombre_modelo ILIKE '%tic%')`
      ));
      // Acondicionamiento (ensamblaje items y cajas construidas)
      const ensamblaje = await withTenant(tenant, (c) => c.query(
        `SELECT COUNT(*)::int AS items
           FROM inventario_credocubes ic
           WHERE ic.estado='Acondicionamiento' AND ic.sub_estado='Ensamblaje'`
      ));
      const cajas = await withTenant(tenant, (c) => c.query(
        `SELECT COUNT(*)::int AS total FROM acond_cajas`
      ));
      // Inspección (items cuyo estado es 'Inspección' o 'Inspeccion')
      const inspeccionQ = await withTenant(tenant, (c) => c.query(
        `SELECT
            SUM(CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 1 ELSE 0 END)::int AS tics,
            SUM(CASE WHEN m.nombre_modelo ILIKE '%vip%' THEN 1 ELSE 0 END)::int AS vips
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE LOWER(ic.estado) IN ('inspeccion','inspección')`
      ));
      const inspeccion = inspeccionQ.rows[0] || { tics:0, vips:0 };
      // Placeholders for future phases (Operación / Devolución) – se implementarán luego
      const operacion = { tic_transito: 0, vip_transito: 0 };
      const devolucion = { tic_pendiente: 0, vip_pendiente: 0 };
      res.json({ ok: true, data: {
        enBodega: enBodega.rows[0] || { tics:0, vips:0, cubes:0 },
        preAcond: {
          congelamiento: preAcondCong.rows[0] || { en_proceso:0, completado:0 },
          atemperamiento: preAcondAtemp.rows[0] || { en_proceso:0, completado:0 }
        },
        acond: {
          ensamblaje: ensamblaje.rows[0]?.items || 0,
          cajas: cajas.rows[0]?.total || 0
        },
        inspeccion,
        operacion,
        devolucion
      }});
    } catch (e:any) {
      res.status(500).json({ ok:false, error: e.message || 'Error resumen kanban' });
    }
  },
  preacond: (_req: Request, res: Response) => res.render('operacion/preacond', { title: 'Operación · Registrar pre-acondicionamiento' }),
  acond: (_req: Request, res: Response) => res.render('operacion/acond', { title: 'Operación · Acondicionamiento' }),
  operacion: (_req: Request, res: Response) => res.render('operacion/operacion', { title: 'Operación · Operación' }),
  devolucion: (_req: Request, res: Response) => res.render('operacion/devolucion', { title: 'Operación · Devolución' }),
  inspeccion: (_req: Request, res: Response) => res.render('operacion/inspeccion', { title: 'Operación · Inspección' }),
  // Vista: En bodega
  bodega: (_req: Request, res: Response) => res.render('operacion/bodega', { title: 'Operación · En bodega' }),
  // Datos para la vista En bodega
  bodegaData: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    try {
      const page = Math.max(1, parseInt(String(req.query.page||'1'),10)||1);
      const limit = Math.min(200, Math.max(10, parseInt(String(req.query.limit||'50'),10)||50));
      const offset = (page-1)*limit;
      const q = (req.query.q||'').toString().trim();
      const cat = (req.query.cat||'').toString(); // tics | vips | cubes
  const filters: string[] = ["TRIM(LOWER(ic.estado))=TRIM(LOWER('En bodega'))"]; const params: any[] = [];
      if(q){
        params.push('%'+q.toLowerCase()+'%');
        const idx = params.length;
        // Correct empty string quoting inside COALESCE
        filters.push(`(LOWER(ic.rfid) LIKE $${idx} OR LOWER(ic.nombre_unidad) LIKE $${idx} OR LOWER(COALESCE(ic.lote,'')) LIKE $${idx})`);
      }
      if(cat){
        if(cat==='tics'){ params.push('%tic%'); filters.push('m.nombre_modelo ILIKE $'+params.length); }
        else if(cat==='vips'){ params.push('%vip%'); filters.push('m.nombre_modelo ILIKE $'+params.length); }
  else if(cat==='cubes'){ params.push('%cube%'); filters.push('(m.nombre_modelo ILIKE $'+params.length+" OR m.nombre_modelo ILIKE '%cubo%')"); }
      }
      const where = filters.length? ('WHERE '+filters.join(' AND ')) : '';
      const baseSel = `FROM inventario_credocubes ic JOIN modelos m ON m.modelo_id = ic.modelo_id ${where}`;
   // Use parameterized limit/offset via appended params to avoid string concat issues (even if safe here)
   params.push(limit); const limitIdx = params.length;
   params.push(offset); const offsetIdx = params.length;
      let rows; let usedUpdatedAt=true;
      try {
        rows = await withTenant(tenant, (c) => c.query(
          `SELECT ic.id AS id, ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado, m.nombre_modelo,
         CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 'TIC'
           WHEN m.nombre_modelo ILIKE '%vip%' THEN 'VIP'
           WHEN (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%') THEN 'CUBE'
           ELSE 'OTRO' END AS categoria,
         ic.updated_at AS fecha_ingreso
       ${baseSel}
       ORDER BY ic.updated_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`, params));
      } catch(e:any){
        // Si la columna updated_at no existe (bases antiguas), reintentar usando id
        if(e?.code==='42703'){
          usedUpdatedAt=false;
          rows = await withTenant(tenant, (c) => c.query(
            `SELECT ic.id AS id, ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado, m.nombre_modelo,
             CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 'TIC'
               WHEN m.nombre_modelo ILIKE '%vip%' THEN 'VIP'
               WHEN (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%') THEN 'CUBE'
               ELSE 'OTRO' END AS categoria,
             NOW() AS fecha_ingreso
             ${baseSel}
             ORDER BY ic.id DESC
             LIMIT $${limitIdx} OFFSET $${offsetIdx}`, params));
        } else { throw e; }
      }
  const totalQ = await withTenant(tenant, (c) => c.query(`SELECT COUNT(*)::int AS total ${baseSel}`, params.slice(0, params.length-2))); // exclude limit & offset
  res.json({ ok:true, page, limit, total: totalQ.rows[0]?.total||0, items: rows.rows, meta:{ usedUpdatedAt, debug:{ filters, params: params.slice(0, params.length-2) } } });
    } catch(e:any){
      // Fallback: no bloquear la vista si algo falla. Log y retornar lista vacía.
      console.error('[bodegaData] error', e);
      res.json({ ok:true, page:1, limit:50, total:0, items:[], warning: e?.message || 'Error interno (se muestra vacío)' });
    }
  },

  // Data for pre-acondicionamiento lists
  preacondData: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    // Ensure timers table exists (global per-section timer)
    await withTenant(tenant, (c) => c.query(
      `CREATE TABLE IF NOT EXISTS preacond_timers (
         section text PRIMARY KEY,
         started_at timestamptz,
         duration_sec integer,
         lote text,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW()
       )`));
    // Ensure item timers table exists (per-RFID timers)
    await withTenant(tenant, (c) => c.query(
      `CREATE TABLE IF NOT EXISTS preacond_item_timers (
         rfid text NOT NULL,
         section text NOT NULL,
         started_at timestamptz,
         duration_sec integer,
         lote text,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW(),
         PRIMARY KEY (rfid, section)
       )`));

    // Try to add missing columns if table existed before
    await withTenant(tenant, (c) => c.query(`ALTER TABLE preacond_timers ADD COLUMN IF NOT EXISTS lote text`));

   const rowsCong = await withTenant(tenant, (c) => c.query(
      `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado,
              pit.started_at AS started_at, pit.duration_sec AS duration_sec, pit.active AS item_active, pit.lote AS item_lote
       FROM inventario_credocubes ic
       JOIN modelos m ON m.modelo_id = ic.modelo_id
       LEFT JOIN preacond_item_timers pit
         ON pit.rfid = ic.rfid AND pit.section = 'congelamiento'
     WHERE ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado IN ('Congelamiento','Congelado')
         AND (m.nombre_modelo ILIKE '%tic%')
       ORDER BY ic.id DESC
       LIMIT 500`));
   const rowsAtem = await withTenant(tenant, (c) => c.query(
      `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado,
              pit.started_at AS started_at, pit.duration_sec AS duration_sec, pit.active AS item_active, pit.lote AS item_lote
       FROM inventario_credocubes ic
       JOIN modelos m ON m.modelo_id = ic.modelo_id
       LEFT JOIN preacond_item_timers pit
         ON pit.rfid = ic.rfid AND pit.section = 'atemperamiento'
     WHERE ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado IN ('Atemperamiento','Atemperado')
         AND (m.nombre_modelo ILIKE '%tic%')
       ORDER BY ic.id DESC
       LIMIT 500`));
    const nowRes = await withTenant(tenant, (c) => c.query<{ now: string }>(`SELECT NOW()::timestamptz AS now`));
    const timers = await withTenant(tenant, (c) => c.query(
      `SELECT section, started_at, duration_sec, active, lote FROM preacond_timers WHERE section IN ('congelamiento','atemperamiento')`));
    const map: any = { congelamiento: null, atemperamiento: null };
    for(const r of timers.rows as any[]) map[r.section] = r;
    res.json({ now: nowRes.rows[0]?.now, timers: map, congelamiento: rowsCong.rows, atemperamiento: rowsAtem.rows });
  },

  // Scan/move TICs into Congelamiento or Atemperamiento
  preacondScan: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { target, rfids, keepLote } = req.body as any;
    const t = typeof target === 'string' ? target.toLowerCase() : '';
    const input = Array.isArray(rfids) ? rfids : (rfids ? [rfids] : []);
    const codes = [...new Set(input.filter((x: any) => typeof x === 'string').map((s: string) => s.trim()).filter(Boolean))];
    if (!codes.length || (t !== 'congelamiento' && t !== 'atemperamiento')) {
      return res.status(400).json({ ok: false, error: 'Entrada inválida' });
    }

    // Fetch current state for provided RFIDs
    const found = await withTenant(tenant, (c) => c.query(
      `SELECT ic.rfid, ic.estado, ic.sub_estado, m.nombre_modelo
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE ic.rfid = ANY($1::text[])`, [codes]));

    const ticSet = new Set((found.rows as any[])
      .filter(r => /tic/i.test(r.nombre_modelo || ''))
      .map(r => r.rfid));

    const rejects: { rfid: string; reason: string }[] = [];
    const accept: string[] = [];
    for (const code of codes) {
      if (!ticSet.has(code)) {
        rejects.push({ rfid: code, reason: 'No es TIC o no existe' });
        continue;
      }
      const cur = (found.rows as any[]).find(r => r.rfid === code);
      if (t === 'atemperamiento') {
        if (cur?.estado === 'Pre Acondicionamiento' && cur?.sub_estado === 'Congelado') {
          accept.push(code);
        } else if (cur?.estado === 'Pre Acondicionamiento' && (cur?.sub_estado === 'Atemperamiento' || cur?.sub_estado === 'Atemperado')) {
          rejects.push({ rfid: code, reason: 'Ya está en Atemperamiento' });
        } else {
          rejects.push({ rfid: code, reason: 'Debe estar Congelado' });
        }
      } else {
        // Congelamiento: no aceptar si ya está en Congelamiento o Congelado
        if (cur?.estado === 'Pre Acondicionamiento' && (cur?.sub_estado === 'Congelamiento' || cur?.sub_estado === 'Congelado')) {
          rejects.push({ rfid: code, reason: 'Ya está en Congelamiento' });
        } else {
          accept.push(code);
        }
      }
    }

  if (accept.length) {
      if (t === 'congelamiento') {
        await withTenant(tenant, (c) => c.query(
          `UPDATE inventario_credocubes ic
        SET estado = 'Pre Acondicionamiento', sub_estado = 'Congelamiento'
            FROM modelos m
           WHERE ic.modelo_id = m.modelo_id
             AND ic.rfid = ANY($1::text[])
             AND (m.nombre_modelo ILIKE '%tic%')`, [accept]));
      } else {
        const preserve = !!keepLote; // if true, do not clear lote
        if(preserve){
          await withTenant(tenant, (c) => c.query(
            `UPDATE inventario_credocubes ic
          SET estado = 'Pre Acondicionamiento', sub_estado = 'Atemperamiento'
              FROM modelos m
             WHERE ic.modelo_id = m.modelo_id
               AND ic.rfid = ANY($1::text[])
               AND (m.nombre_modelo ILIKE '%tic%')
               AND ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado = 'Congelado'`, [accept]));
        } else {
          await withTenant(tenant, (c) => c.query(
            `UPDATE inventario_credocubes ic
          SET estado = 'Pre Acondicionamiento', sub_estado = 'Atemperamiento', lote = NULL
              FROM modelos m
             WHERE ic.modelo_id = m.modelo_id
               AND ic.rfid = ANY($1::text[])
               AND (m.nombre_modelo ILIKE '%tic%')
               AND ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado = 'Congelado'`, [accept]));
        }
      }

  // Do NOT auto-assign lote on scan; keep items without lote until a timer starts
    }

    res.json({ ok: true, moved: accept, rejected: rejects, target: t });
  },

  // Lookup lote de una TIC congelada y devolver resumen de todas las TICs congeladas de ese lote
  preacondLoteLookup: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { rfid } = req.body as any;
    const code = typeof rfid === 'string' ? rfid.trim() : '';
    if(code.length !== 24) return res.status(400).json({ ok:false, error:'RFID inválido' });
    const row = await withTenant(tenant, (c)=> c.query(
      `SELECT lote, estado, sub_estado FROM inventario_credocubes WHERE rfid=$1`, [code]));
    if(!row.rowCount) return res.status(404).json({ ok:false, error:'No existe' });
    const base = row.rows[0] as any;
    if(!(base.estado==='Pre Acondicionamiento' && (base.sub_estado==='Congelado' || base.sub_estado==='Congelamiento'))){
      return res.status(400).json({ ok:false, error:'TIC no está en Congelado/Congelamiento' });
    }
    const lote = (base.lote||'').toString().trim();
    if(!lote) return res.status(400).json({ ok:false, error:'La TIC no tiene lote asignado' });
    const ticsQ = await withTenant(tenant, (c)=> c.query(
      `SELECT ic.rfid, ic.sub_estado
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE ic.lote = $1
          AND ic.estado='Pre Acondicionamiento'
          AND ic.sub_estado IN ('Congelado','Congelamiento')
          AND (m.nombre_modelo ILIKE '%tic%')
        ORDER BY ic.rfid`, [lote]));
    res.json({ ok:true, lote, total: ticsQ.rowCount, tics: ticsQ.rows });
  },

  // Validate RFIDs before moving (registro-like UX)
  preacondValidate: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { target, rfids } = req.body as any;
    const t = typeof target === 'string' ? target.toLowerCase() : '';
    const input = Array.isArray(rfids) ? rfids : (rfids ? [rfids] : []);
    const codes = [...new Set(input.filter((x: any) => typeof x === 'string').map((s: string) => s.trim()).filter(Boolean))];
    if (!codes.length || (t !== 'congelamiento' && t !== 'atemperamiento')) {
      return res.status(400).json({ ok: false, error: 'Entrada inválida' });
    }

    const found = await withTenant(tenant, (c) => c.query(
      `SELECT ic.rfid, ic.estado, ic.sub_estado, m.nombre_modelo
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE ic.rfid = ANY($1::text[])`, [codes]));

    const rows = found.rows as any[];
    const ok: string[] = [];
    const invalid: { rfid: string; reason: string }[] = [];

    for(const code of codes){
      const r = rows.find(x => x.rfid === code);
      if(!r){ invalid.push({ rfid: code, reason: 'No existe' }); continue; }
      if(!/tic/i.test(r.nombre_modelo || '')){ invalid.push({ rfid: code, reason: 'No es TIC' }); continue; }
      if(t === 'atemperamiento'){
        if(r.estado === 'Pre Acondicionamiento' && r.sub_estado === 'Congelado') {
          ok.push(code);
        } else if (r.estado === 'Pre Acondicionamiento' && (r.sub_estado === 'Atemperamiento' || r.sub_estado === 'Atemperado')) {
          invalid.push({ rfid: code, reason: 'Ya está en Atemperamiento' });
        } else {
          invalid.push({ rfid: code, reason: 'Debe estar Congelado' });
        }
      } else {
        // Congelamiento: bloquear si ya está en Congelamiento/Congelado
        if(r.estado === 'Pre Acondicionamiento' && (r.sub_estado === 'Congelamiento' || r.sub_estado === 'Congelado')){
          invalid.push({ rfid: code, reason: 'Ya está en Congelamiento' });
        } else {
          ok.push(code);
        }
      }
    }

    res.json({ ok: true, valid: ok, invalid });
  },

  // Start/clear global timers per section
  preacondTimerStart: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { section, durationSec, lote, rfids } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    const dur = Number(durationSec);
    let loteVal = typeof lote === 'string' ? lote.trim() : '';
    if(!['congelamiento','atemperamiento'].includes(s) || !Number.isFinite(dur) || dur <= 0){
      return res.status(400).json({ ok:false, error:'Entrada inválida' });
    }
    if(!loteVal){
      loteVal = await generateNextLote(tenant);
    }
    await withTenant(tenant, async (c) => {
      await c.query(`CREATE TABLE IF NOT EXISTS preacond_timers (
         section text PRIMARY KEY,
         started_at timestamptz,
         duration_sec integer,
         lote text,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW()
      )`);
      await c.query(`ALTER TABLE preacond_timers ADD COLUMN IF NOT EXISTS lote text`);
      await c.query(
        `INSERT INTO preacond_timers(section, started_at, duration_sec, lote, active, updated_at)
           VALUES ($1, NOW(), $2, $3, true, NOW())
         ON CONFLICT (section) DO UPDATE
           SET started_at = EXCLUDED.started_at,
               duration_sec = EXCLUDED.duration_sec,
               lote = EXCLUDED.lote,
               active = true,
               updated_at = NOW()`,
        [s, dur, loteVal]
      );
      // If a list of RFIDs is provided, tag those items with the lote now (only if they don't have one)
      const list = Array.isArray(rfids) ? rfids.filter((x:any)=>typeof x==='string' && x.trim()).map((x:string)=>x.trim()) : [];
      if(list.length){
        await c.query(`UPDATE inventario_credocubes SET lote = $1 WHERE rfid = ANY($2::text[]) AND (lote IS NULL OR lote = '')`, [loteVal, list]);
        await c.query(`CREATE TABLE IF NOT EXISTS preacond_item_timers (
           rfid text NOT NULL,
           section text NOT NULL,
           started_at timestamptz,
           duration_sec integer,
           lote text,
           active boolean NOT NULL DEFAULT false,
           updated_at timestamptz NOT NULL DEFAULT NOW(),
           PRIMARY KEY (rfid, section)
        )`);
        await c.query(
          `INSERT INTO preacond_item_timers(rfid, section, started_at, duration_sec, lote, active, updated_at)
             SELECT rfid, $1, NOW(), $2, $3, true, NOW()
               FROM UNNEST($4::text[]) AS rfid
           ON CONFLICT (rfid, section) DO UPDATE
             SET started_at = EXCLUDED.started_at,
                 duration_sec = EXCLUDED.duration_sec,
                 lote = COALESCE(preacond_item_timers.lote, EXCLUDED.lote),
                 active = true,
                 updated_at = NOW()`,
          [s, dur, loteVal, list]
        );
      }
    });
  res.json({ ok:true, lote: loteVal });
  },

  preacondTimerClear: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { section } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    if(!['congelamiento','atemperamiento'].includes(s)) return res.status(400).json({ ok:false, error:'Entrada inválida' });
    await withTenant(tenant, async (c) => {
      await c.query(
        `INSERT INTO preacond_timers(section, started_at, duration_sec, active, updated_at)
           VALUES ($1, NULL, NULL, false, NOW())
         ON CONFLICT (section) DO UPDATE
           SET started_at = NULL, duration_sec = NULL, lote = NULL, active = false, updated_at = NOW()`,
        [s]
      );
      await c.query(`CREATE TABLE IF NOT EXISTS preacond_item_timers (
         rfid text NOT NULL,
         section text NOT NULL,
         started_at timestamptz,
         duration_sec integer,
         lote text,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW(),
         PRIMARY KEY (rfid, section)
      )`);
      await c.query(
        `UPDATE preacond_item_timers SET started_at = NULL, duration_sec = NULL, lote = NULL, active = false, updated_at = NOW()
           WHERE section = $1 AND active = true`,
        [s]
      );
    });
    res.json({ ok:true });
  },

  // Item-level timers
  preacondItemTimerStart: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { section, rfid, durationSec, lote } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    const r = typeof rfid === 'string' ? rfid.trim() : '';
    const dur = Number(durationSec);
    let loteVal = typeof lote === 'string' ? lote.trim() : '';
    if (!['congelamiento','atemperamiento'].includes(s) || !r || !Number.isFinite(dur) || dur <= 0) {
      return res.status(400).json({ ok:false, error: 'Entrada inválida' });
    }
    if(!loteVal){
      loteVal = await generateNextLote(tenant);
    }
    await withTenant(tenant, async (c) => {
      // Do not allow starting if the item is already completed in this section
      const done = await c.query(
        `SELECT sub_estado FROM inventario_credocubes WHERE rfid = $1`, [r]
      );
      const sub = (done.rows?.[0]?.sub_estado || '').toString();
      if ((s === 'congelamiento' && /Congelado/i.test(sub)) || (s === 'atemperamiento' && /Atemperado/i.test(sub))) {
        throw Object.assign(new Error('Item ya completado'), { statusCode: 400 });
      }
      await c.query(`CREATE TABLE IF NOT EXISTS preacond_item_timers (
         rfid text NOT NULL,
         section text NOT NULL,
         started_at timestamptz,
         duration_sec integer,
         lote text,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW(),
         PRIMARY KEY (rfid, section)
      )`);
      await c.query(
        `INSERT INTO preacond_item_timers(rfid, section, started_at, duration_sec, lote, active, updated_at)
           VALUES ($1, $2, NOW(), $3, $4, true, NOW())
         ON CONFLICT (rfid, section) DO UPDATE
           SET started_at = EXCLUDED.started_at,
               duration_sec = EXCLUDED.duration_sec,
               lote = COALESCE(preacond_item_timers.lote, EXCLUDED.lote),
               active = true,
               updated_at = NOW()`,
        [r, s, dur, loteVal]
      );
  // Tag inventario lote only if empty
  await c.query(`UPDATE inventario_credocubes SET lote = $1 WHERE rfid = $2 AND (lote IS NULL OR lote = '')`, [loteVal, r]);
    });
    res.json({ ok:true, lote: loteVal });
  },

  preacondItemTimerClear: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { section, rfid } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    const r = typeof rfid === 'string' ? rfid.trim() : '';
    if (!['congelamiento','atemperamiento'].includes(s) || !r) {
      return res.status(400).json({ ok:false, error: 'Entrada inválida' });
    }
    await withTenant(tenant, async (c) => {
      await c.query(`CREATE TABLE IF NOT EXISTS preacond_item_timers (
         rfid text NOT NULL,
         section text NOT NULL,
         started_at timestamptz,
         duration_sec integer,
         lote text,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW(),
         PRIMARY KEY (rfid, section)
      )`);
      // Keep lote (do not clear) when pausing; only stop timer fields
      await c.query(
        `INSERT INTO preacond_item_timers(rfid, section, started_at, duration_sec, lote, active, updated_at)
           VALUES ($1, $2, NULL, NULL, NULL, false, NOW())
         ON CONFLICT (rfid, section) DO UPDATE
           SET started_at = NULL,
               duration_sec = NULL,
               active = false,
               updated_at = NOW()`,
        [r, s]
      );
    });
    res.json({ ok:true });
  },

  // Complete (auto-finish) all timers for a section when duration ends
  preacondTimerComplete: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { section } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    if(!['congelamiento','atemperamiento'].includes(s)) return res.status(400).json({ ok:false, error:'Entrada inválida' });
    await withTenant(tenant, async (c) => {
      // Only if the timer is actually expired or active
      await c.query('BEGIN');
      try {
        // Mark items with active item timers in this section as completed state
        await c.query(
          `UPDATE inventario_credocubes ic
              SET sub_estado = CASE WHEN $1='congelamiento' THEN 'Congelado' ELSE 'Atemperado' END
            WHERE ic.rfid IN (
                    SELECT pit.rfid FROM preacond_item_timers pit
                     WHERE pit.section = $1 AND pit.active = true
                  )`, [s]
        );
        // Deactivate item timers
        await c.query(
          `UPDATE preacond_item_timers
              SET started_at = NULL, duration_sec = NULL, lote = lote, active = false, updated_at = NOW()
            WHERE section = $1 AND active = true`, [s]
        );
        // Deactivate group timer
        await c.query(
          `UPDATE preacond_timers SET active = false, updated_at = NOW() WHERE section = $1`, [s]
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
    res.json({ ok:true });
  },

  // Complete a single item timer
  preacondItemTimerComplete: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { section, rfid } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    const r = typeof rfid === 'string' ? rfid.trim() : '';
    if(!['congelamiento','atemperamiento'].includes(s) || !r) return res.status(400).json({ ok:false, error:'Entrada inválida' });
    await withTenant(tenant, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(
          `UPDATE inventario_credocubes SET sub_estado = CASE WHEN $1='congelamiento' THEN 'Congelado' ELSE 'Atemperado' END WHERE rfid = $2`,
          [s, r]
        );
        await c.query(
          `UPDATE preacond_item_timers SET started_at = NULL, duration_sec = NULL, active = false, updated_at = NOW() WHERE section = $1 AND rfid = $2`,
          [s, r]
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
    res.json({ ok:true });
  },
  
  // Return a TIC to warehouse: clear timers (any section), remove lote, set estado 'En bodega'
  preacondReturnToBodega: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { rfid } = req.body as any;
    const r = typeof rfid === 'string' ? rfid.trim() : '';
    if(!r) return res.status(400).json({ ok:false, error:'Entrada inválida' });
    await withTenant(tenant, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`CREATE TABLE IF NOT EXISTS preacond_item_timers (
           rfid text NOT NULL,
           section text NOT NULL,
           started_at timestamptz,
           duration_sec integer,
           lote text,
           active boolean NOT NULL DEFAULT false,
           updated_at timestamptz NOT NULL DEFAULT NOW(),
           PRIMARY KEY (rfid, section)
        )`);
        await c.query(
          `UPDATE preacond_item_timers
              SET started_at = NULL, duration_sec = NULL, lote = NULL, active = false, updated_at = NOW()
            WHERE rfid = $1`, [r]
        );
        await c.query(
          `UPDATE inventario_credocubes
              SET estado = 'En bodega', sub_estado = NULL, lote = NULL
            WHERE rfid = $1`, [r]
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    });
    res.json({ ok:true });
  },

  // ============================= ACONDICIONAMIENTO · ENSAMBLAJE =============================
  // Data endpoint: provides resumen of cajas creadas y items disponibles para ensamblar
  acondData: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    // Ensure tables for cajas
    await withTenant(tenant, async (c) => {
       await c.query(`CREATE TABLE IF NOT EXISTS acond_cajas (
         caja_id serial PRIMARY KEY,
         lote text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT NOW()
       )`);
       await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_items (
         caja_id int NOT NULL REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
         rfid text NOT NULL,
         rol text NOT NULL CHECK (rol IN ('cube','vip','tic')),
         PRIMARY KEY (caja_id, rfid)
       )`);
       await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_timers (
          caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
          started_at timestamptz,
          duration_sec integer,
          active boolean NOT NULL DEFAULT false,
          updated_at timestamptz NOT NULL DEFAULT NOW()
        )`);
    });
    // Available TICs: Atemperadas (finished pre-acond) and not already in any caja
    const tics = await withTenant(tenant, (c) => c.query(
      `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
    LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid
        WHERE aci.rfid IS NULL
          AND ic.estado = 'Pre Acondicionamiento'
          AND ic.sub_estado = 'Atemperado'
          AND (m.nombre_modelo ILIKE '%tic%')
        ORDER BY ic.id DESC
        LIMIT 500`));
    // Available CUBEs
    const cubes = await withTenant(tenant, (c) => c.query(
      `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
    LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid
        WHERE aci.rfid IS NULL
          AND ic.estado = 'En bodega'
          AND (m.nombre_modelo ILIKE '%cube%')
        ORDER BY ic.id DESC
        LIMIT 200`));
    // Available VIPs
    const vips = await withTenant(tenant, (c) => c.query(
      `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
    LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid
        WHERE aci.rfid IS NULL
          AND ic.estado = 'En bodega'
          AND (m.nombre_modelo ILIKE '%vip%')
        ORDER BY ic.id DESC
        LIMIT 200`));
        // Existing cajas with litraje + items (litraje may not exist yet → fallback)
  let cajasRows:any[] = []; let cajaItemsRows:any[];
  const nowRes = await withTenant(tenant, (c)=> c.query<{ now:string }>(`SELECT NOW()::timestamptz AS now`));
        try {
          const cajasQ = await withTenant(tenant, (c) => c.query(
            `WITH cajas_validas AS (
               SELECT c.caja_id, c.lote, c.created_at
               FROM acond_cajas c
               JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
               JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
               GROUP BY c.caja_id, c.lote, c.created_at
               HAVING bool_and(ic.estado='Acondicionamiento' AND ic.sub_estado='Ensamblaje')
             )
             SELECT c.caja_id, c.lote, c.created_at,
                    MAX(m.litraje) AS litraje,
                    COUNT(*) FILTER (WHERE aci.rol='tic') AS tics,
                    COUNT(*) FILTER (WHERE aci.rol='cube') AS cubes,
                    COUNT(*) FILTER (WHERE aci.rol='vip') AS vips,
                    act.started_at AS timer_started_at,
                    act.duration_sec AS timer_duration_sec,
                    act.active AS timer_active
             FROM cajas_validas c
             JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
             LEFT JOIN modelos m ON m.modelo_id = ic.modelo_id
             LEFT JOIN acond_caja_timers act ON act.caja_id = c.caja_id
             GROUP BY c.caja_id, c.lote, c.created_at, act.started_at, act.duration_sec, act.active
             ORDER BY c.caja_id DESC
             LIMIT 200`));
          cajasRows = cajasQ.rows;
          const itemsQ = await withTenant(tenant, (c) => c.query(
            `SELECT c.caja_id, aci.rol, ic.rfid, m.litraje
               FROM acond_caja_items aci
               JOIN acond_cajas c ON c.caja_id = aci.caja_id
               JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
               JOIN modelos m ON m.modelo_id = ic.modelo_id
               WHERE c.caja_id = ANY($1::int[])
               ORDER BY c.caja_id DESC, CASE aci.rol WHEN 'vip' THEN 0 WHEN 'tic' THEN 1 ELSE 2 END, ic.rfid`, [cajasRows.map(r=>r.caja_id)]));
          cajaItemsRows = itemsQ.rows;
        } catch (e:any) {
          // Fallback without litraje column
          if(e?.code === '42703') {
            const cajasQ = await withTenant(tenant, (c) => c.query(
              `WITH cajas_validas AS (
                 SELECT c.caja_id, c.lote, c.created_at
                   FROM acond_cajas c
                   JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
                   JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
                  GROUP BY c.caja_id, c.lote, c.created_at
                  HAVING bool_and(ic.estado='Acondicionamiento' AND ic.sub_estado='Ensamblaje')
               )
               SELECT c.caja_id, c.lote, c.created_at,
                      COUNT(*) FILTER (WHERE aci.rol='tic') AS tics,
                      COUNT(*) FILTER (WHERE aci.rol='cube') AS cubes,
                      COUNT(*) FILTER (WHERE aci.rol='vip') AS vips,
                      act.started_at AS timer_started_at,
                      act.duration_sec AS timer_duration_sec,
                      act.active AS timer_active
                 FROM cajas_validas c
                 JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
                 JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
            LEFT JOIN acond_caja_timers act ON act.caja_id = c.caja_id
                GROUP BY c.caja_id, c.lote, c.created_at, act.started_at, act.duration_sec, act.active
                ORDER BY c.caja_id DESC
                LIMIT 200`));
            cajasRows = cajasQ.rows;
            const itemsQ = await withTenant(tenant, (c) => c.query(
              `SELECT c.caja_id, aci.rol, aci.rfid
                 FROM acond_caja_items aci
                 JOIN acond_cajas c ON c.caja_id = aci.caja_id
                 WHERE c.caja_id = ANY($1::int[])
                ORDER BY c.caja_id DESC, CASE aci.rol WHEN 'vip' THEN 0 WHEN 'tic' THEN 1 ELSE 2 END, aci.rfid`, [cajasRows.map(r=>r.caja_id)]));
            cajaItemsRows = itemsQ.rows;
          } else {
            throw e;
          }
        }
  // Items en flujo de despacho: incluyen los que están "Despachando" (timer activo) y los ya "Lista para Despacho"
  const listoRows = await withTenant(tenant, (c)=> c.query(
    `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado, NOW() AS updated_at, m.nombre_modelo,
            act.started_at AS timer_started_at, act.duration_sec AS timer_duration_sec, act.active AS timer_active,
            c.lote AS caja_lote, c.caja_id
       FROM inventario_credocubes ic
       JOIN modelos m ON m.modelo_id = ic.modelo_id
  LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid
  LEFT JOIN acond_cajas c ON c.caja_id = aci.caja_id
  LEFT JOIN acond_caja_timers act ON act.caja_id = aci.caja_id
      WHERE ic.estado='Acondicionamiento' AND ic.sub_estado IN ('Despachando','Lista para Despacho','Listo')
      ORDER BY ic.id DESC
      LIMIT 500`));

  // Normalizar estructura esperada por nuevo front-end (acond.js)
  const nowIso = nowRes.rows[0]?.now;
  const nowMs = nowIso ? new Date(nowIso).getTime() : Date.now();
  // Map caja items by caja_id for componentes list
  const componentesPorCaja: Record<string, { tipo:string; codigo:string }[]> = {};
  for(const it of cajaItemsRows){
    const arr = componentesPorCaja[it.caja_id] || (componentesPorCaja[it.caja_id] = []);
    arr.push({ tipo: it.rol, codigo: it.rfid });
  }
  const cajasUI = cajasRows.map(r => {
    let startsAt: string | null = r.timer_started_at || null;
    let endsAt: string | null = null;
    let completedAt: string | null = null;
    if(r.timer_started_at && r.timer_duration_sec){
      const endMs = new Date(r.timer_started_at).getTime() + (r.timer_duration_sec*1000);
      endsAt = new Date(endMs).toISOString();
      if(!r.timer_active && endMs <= nowMs){
        completedAt = endsAt;
      }
    }
    return {
      id: r.caja_id,
      codigoCaja: r.lote || `Caja #${r.caja_id}`,
      estado: 'Ensamblaje',
      createdAt: r.created_at,
      updatedAt: r.created_at,
      timer: startsAt ? { startsAt, endsAt, completedAt } : null,
      componentes: componentesPorCaja[r.caja_id] || []
    };
  });
  const listoDespacho = listoRows.rows.map(r => {
    let startsAt = r.timer_started_at || null;
    let endsAt: string | null = null;
    let completedAt: string | null = null;
    if(r.timer_started_at && r.timer_duration_sec){
      const endMs = new Date(r.timer_started_at).getTime() + (r.timer_duration_sec*1000);
      endsAt = new Date(endMs).toISOString();
      // Solo marcar completed si estaba activo y ya pasó el tiempo; si timer_active=false desde el inicio, lo tratamos como no iniciado
      if(r.timer_active === false && !r.timer_started_at){
        startsAt = null; endsAt = null; completedAt = null;
      } else if(r.timer_active===false && endMs <= nowMs){
        completedAt = endsAt;
      }
    }
    // categoria simplificada (vip/tic/cube)
    const modeloLower = (r.nombre_modelo||'').toLowerCase();
    let categoriaSimple = 'otros';
    if(/vip/.test(modeloLower)) categoriaSimple = 'vip';
    else if(/tic/.test(modeloLower)) categoriaSimple = 'tic';
    else if(/cube/.test(modeloLower)) categoriaSimple = 'cube';
    return {
      caja_id: r.caja_id,
      codigo: r.rfid,
      nombre: r.nombre_modelo, // mover modelo a nombre
  estado: r.sub_estado || r.estado, // ahora mostrar sub_estado real
      lote: r.caja_lote || r.lote, // mostrar lote de la caja si existe
      updatedAt: r.updated_at,
      fase: 'Acond',
      categoria: categoriaSimple,
      cronometro: startsAt ? { startsAt, endsAt, completedAt } : null
    };
  });
  res.json({ ok:true, now: nowIso, serverNow: nowIso, disponibles: { tics: tics.rows, cubes: cubes.rows, vips: vips.rows }, cajas: cajasUI, listoDespacho });
  },

  // Validate RFIDs for assembling a single caja
  acondEnsamblajeValidate: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { rfids } = req.body as any;
    const input = Array.isArray(rfids) ? rfids : (rfids ? [rfids] : []);
    const codes = [...new Set(input.filter((x:any)=>typeof x==='string').map((s:string)=>s.trim()).filter(Boolean))];
    if(!codes.length) return res.status(400).json({ ok:false, error:'Sin RFIDs' });
    // Limpieza rápida de asignaciones obsoletas (items que ya no están en Ensamblaje)
    await withTenant(tenant, async (c)=>{
      await c.query(`DELETE FROM acond_caja_items aci
                       WHERE NOT EXISTS (
                         SELECT 1 FROM inventario_credocubes ic
                          WHERE ic.rfid = aci.rfid
                            AND ic.estado='Acondicionamiento'
                            AND ic.sub_estado='Ensamblaje'
                       )`);
      await c.query(`DELETE FROM acond_cajas c WHERE NOT EXISTS (SELECT 1 FROM acond_caja_items aci WHERE aci.caja_id=c.caja_id)`);
    });
    const rows = await withTenant(tenant, (c)=> c.query(
      `SELECT ic.rfid, ic.estado, ic.sub_estado, m.nombre_modelo,
              EXISTS(SELECT 1 FROM acond_caja_items aci WHERE aci.rfid=ic.rfid) AS ya_en_caja
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE ic.rfid = ANY($1::text[])`, [codes]));
    // Map para acceso rápido
    const byRfid: Record<string, any> = {};
    rows.rows.forEach(r=>{ byRfid[r.rfid] = r; });
    let haveCube=false, haveVip=false, ticCount=0;
    const valid: { rfid:string; rol:'cube'|'vip'|'tic' }[] = [];
    const invalid: { rfid:string; reason:string }[] = [];
    // Procesar en el mismo orden de entrada (importante para UX del escaneo)
    for(const code of codes){
      const r = byRfid[code];
      if(!r){ invalid.push({ rfid: code, reason: 'No encontrado' }); continue; }
      const estado = (r.estado||'').trim();
      const subEstado = (r.sub_estado||'').trim();
      const estadoLower = estado.toLowerCase();
      const subLower = subEstado.toLowerCase();
      const name=(r.nombre_modelo||'').toLowerCase();
      if(r.ya_en_caja){ invalid.push({ rfid: r.rfid, reason: 'Ya en una caja' }); continue; }
      if(/cube/.test(name)){
        if(haveCube){ invalid.push({ rfid:r.rfid, reason:'Más de un CUBE' }); continue; }
        const enBodega = estadoLower==='en bodega' || subLower==='en bodega';
        if(!enBodega){ invalid.push({ rfid:r.rfid, reason:'CUBE no En bodega' }); continue; }
        haveCube=true; valid.push({ rfid:r.rfid, rol:'cube' });
      } else if(/vip/.test(name)){
        if(haveVip){ invalid.push({ rfid:r.rfid, reason:'Más de un VIP' }); continue; }
        const enBodega = estadoLower==='en bodega' || subLower==='en bodega';
        if(!enBodega){ invalid.push({ rfid:r.rfid, reason:'VIP no En bodega' }); continue; }
        haveVip=true; valid.push({ rfid:r.rfid, rol:'vip' });
      } else if(/tic/.test(name)){
        const atemp = (estadoLower==='pre acondicionamiento' && subLower==='atemperado') || subLower==='atemperado';
        if(!atemp){ invalid.push({ rfid:r.rfid, reason:'TIC no Atemperado' }); continue; }
        ticCount++; valid.push({ rfid:r.rfid, rol:'tic' });
      } else {
        invalid.push({ rfid:r.rfid, reason:'Modelo no permitido' });
      }
    }
    const counts = { tics: ticCount, cube: haveCube?1:0, vip: haveVip?1:0 };
    // Siempre devolver 200 (ok) para permitir escaneo incremental; solo error duro si ninguna válida y todas inválidas
    if(!valid.length && invalid.length){
      return res.status(200).json({ ok:true, counts, roles: valid, valid, invalid, warning:'Sin válidos' });
    }
    res.json({ ok:true, counts, roles: valid, valid, invalid });
  },
  // Create caja (atomic) with exactly 1 cube, 1 vip, 6 tics (atemperadas)
  acondEnsamblajeCreate: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { rfids } = req.body as any;
    const input = Array.isArray(rfids) ? rfids : (rfids ? [rfids] : []);
    const codes = [...new Set(input.filter((x:any)=>typeof x==='string').map((s:string)=>s.trim()).filter(Boolean))];
    if(codes.length !== 8) return res.status(400).json({ ok:false, error:'Se requieren exactamente 8 RFIDs (1 cube, 1 vip, 6 tics)' });
    // Re-validate using same logic
    await withTenant(tenant, async (c)=>{
      await c.query(`DELETE FROM acond_caja_items aci
                       WHERE NOT EXISTS (
                         SELECT 1 FROM inventario_credocubes ic
                          WHERE ic.rfid = aci.rfid
                            AND ic.estado='Acondicionamiento'
                            AND ic.sub_estado='Ensamblaje'
                       )`);
      await c.query(`DELETE FROM acond_cajas c WHERE NOT EXISTS (SELECT 1 FROM acond_caja_items aci WHERE aci.caja_id=c.caja_id)`);
    });
    const rows = await withTenant(tenant, (c) => c.query(
      `WITH cajas_validas AS (
         SELECT c.caja_id
           FROM acond_cajas c
           JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
           JOIN inventario_credocubes ic2 ON ic2.rfid = aci.rfid
          GROUP BY c.caja_id
         HAVING bool_and(ic2.estado='Acondicionamiento' AND ic2.sub_estado='Ensamblaje')
       )
       SELECT ic.rfid, ic.estado, ic.sub_estado, ic.lote, m.nombre_modelo,
              CASE WHEN aci.rfid IS NOT NULL THEN true ELSE false END AS ya_en_caja
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
    LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid AND aci.caja_id IN (SELECT caja_id FROM cajas_validas)
        WHERE ic.rfid = ANY($1::text[])`, [codes]));
  let haveCube=false, haveVip=false, ticCount=0; const litrajes = new Set<string>();
  const roles: { rfid:string; rol:'cube'|'vip'|'tic'; litraje?: any }[] = [];
    for(const r of rows.rows as any[]){
      if(r.rfid.length !== 24) return res.status(400).json({ ok:false, error:`${r.rfid} longitud inválida`, message:`${r.rfid} longitud inválida` });
      const name=(r.nombre_modelo||'').toLowerCase();
      const estado = (r.estado||'').trim();
      const subEstado = (r.sub_estado||'').trim();
      const estadoLower = estado.toLowerCase();
      const subLower = subEstado.toLowerCase();
      if(r.ya_en_caja) return res.status(400).json({ ok:false, error:`${r.rfid} ya está en una caja`, message:`${r.rfid} ya está en una caja` });
      if(/tic/.test(name)){
        const atemp = (estadoLower==='pre acondicionamiento' && subLower==='atemperado') || subLower==='atemperado';
        if(!atemp) return res.status(400).json({ ok:false, error:`TIC ${r.rfid} no Atemperado`, message:`TIC ${r.rfid} no Atemperado` });
        ticCount++; roles.push({ rfid:r.rfid, rol:'tic', litraje: r.litraje }); litrajes.add(String(r.litraje||''));
      } else if(/cube/.test(name)){
        if(haveCube) return res.status(400).json({ ok:false, error:'Más de un CUBE', message:'Más de un CUBE' });
        const enBodega = estadoLower==='en bodega' || subLower==='en bodega';
        if(!enBodega) return res.status(400).json({ ok:false, error:`CUBE ${r.rfid} no está En bodega`, message:`CUBE ${r.rfid} no está En bodega` });
        haveCube=true; roles.push({ rfid:r.rfid, rol:'cube', litraje: r.litraje }); litrajes.add(String(r.litraje||''));
      } else if(/vip/.test(name)){
        if(haveVip) return res.status(400).json({ ok:false, error:'Más de un VIP', message:'Más de un VIP' });
        const enBodega = estadoLower==='en bodega' || subLower==='en bodega';
        if(!enBodega) return res.status(400).json({ ok:false, error:`VIP ${r.rfid} no está En bodega`, message:`VIP ${r.rfid} no está En bodega` });
        haveVip=true; roles.push({ rfid:r.rfid, rol:'vip', litraje: r.litraje }); litrajes.add(String(r.litraje||''));
      } else {
        return res.status(400).json({ ok:false, error:`${r.rfid} modelo no permitido`, message:`${r.rfid} modelo no permitido` });
      }
    }
    if(!(haveCube && haveVip && ticCount===6)) return res.status(400).json({ ok:false, error:'Composición inválida', message:'Composición inválida (1 cube, 1 vip, 6 tics)' });
    if(litrajes.size>1) return res.status(400).json({ ok:false, error:'Todos los items deben tener el mismo litraje', message:'Todos los items deben tener el mismo litraje' });
    // All good: create caja and assign nuevo lote
  const loteNuevo = await generateNextCajaLote(tenant);
    await withTenant(tenant, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`CREATE TABLE IF NOT EXISTS acond_cajas (
           caja_id serial PRIMARY KEY,
           lote text NOT NULL,
           created_at timestamptz NOT NULL DEFAULT NOW()
        )`);
        await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_items (
           caja_id int NOT NULL REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
           rfid text NOT NULL,
           rol text NOT NULL CHECK (rol IN ('cube','vip','tic')),
           PRIMARY KEY (caja_id, rfid)
        )`);
      await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_timers (
        caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
        started_at timestamptz,
        duration_sec integer,
        active boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )`);
        const rCaja = await c.query(`INSERT INTO acond_cajas(lote) VALUES ($1) RETURNING caja_id`, [loteNuevo]);
        const cajaId = rCaja.rows[0].caja_id;
        // Clear lote for TICs first (as per requirement) then set estado/sub_estado + assign lote to all
        const ticRfids = roles.filter(r=>r.rol==='tic').map(r=>r.rfid);
        if(ticRfids.length){
          await c.query(`UPDATE inventario_credocubes SET lote = NULL WHERE rfid = ANY($1::text[])`, [ticRfids]);
        }
        // Assign lote & move to Acondicionamiento/Ensamblaje
        await c.query(`UPDATE inventario_credocubes SET estado='Acondicionamiento', sub_estado='Ensamblaje', lote=$1 WHERE rfid = ANY($2::text[])`, [loteNuevo, codes]);
        // Insert items
        for(const it of roles){
          await c.query(`INSERT INTO acond_caja_items(caja_id, rfid, rol) VALUES ($1,$2,$3)`, [cajaId, it.rfid, it.rol]);
        }
        await c.query('COMMIT');
        res.json({ ok:true, caja_id: cajaId, lote: loteNuevo });
      } catch (e:any) {
        await c.query('ROLLBACK');
        res.status(500).json({ ok:false, error: e.message||'Error creando caja' });
      }
    });
  },
  // ============================= ACONDICIONAMIENTO · CAJA TIMERS =============================
  acondCajaTimerStart: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { caja_id, durationSec } = req.body as any;
    const cajaId = Number(caja_id);
    const dur = Number(durationSec);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    if(!Number.isFinite(dur) || dur<=0) return res.status(400).json({ ok:false, error:'Duración inválida' });
    await withTenant(tenant, async (c)=>{
      await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_timers (
          caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
          started_at timestamptz,
          duration_sec integer,
          active boolean NOT NULL DEFAULT false,
          updated_at timestamptz NOT NULL DEFAULT NOW()
      )`);
      const ex = await c.query(`SELECT 1 FROM acond_cajas WHERE caja_id=$1`, [cajaId]);
      if(!ex.rowCount) return res.status(404).json({ ok:false, error:'Caja no existe' });
      await c.query('BEGIN');
      try {
        await c.query(`INSERT INTO acond_caja_timers(caja_id, started_at, duration_sec, active, updated_at)
            VALUES($1, NOW(), $2, true, NOW())
            ON CONFLICT (caja_id) DO UPDATE SET started_at=NOW(), duration_sec=EXCLUDED.duration_sec, active=true, updated_at=NOW()`,
          [cajaId, dur]);
        // Cambiar estado de los items de la caja a 'Despachando' si estaban en Ensamblaje
        await c.query(`UPDATE inventario_credocubes ic
                         SET sub_estado='Despachando'
                        WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                          AND ic.estado='Acondicionamiento'
                          AND ic.sub_estado='Ensamblaje'`, [cajaId]);
        await c.query('COMMIT');
      } catch(e){
        await c.query('ROLLBACK');
        throw e;
      }
    });
    res.json({ ok:true });
  },
  acondCajaTimerClear: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { caja_id } = req.body as any;
    const cajaId = Number(caja_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    await withTenant(tenant, async (c)=>{
      await c.query(`UPDATE acond_caja_timers SET active=false, started_at=NULL, duration_sec=NULL, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
    });
    res.json({ ok:true });
  },
  acondCajaTimerComplete: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { caja_id } = req.body as any;
    const cajaId = Number(caja_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    let moved = 0;
    await withTenant(tenant, async (c)=>{
      await c.query('BEGIN');
      try {
        // Stop / finalize timer
        await c.query(`UPDATE acond_caja_timers SET active=false, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
        // Fetch lote of caja
        const loteQ = await c.query(`SELECT lote FROM acond_cajas WHERE caja_id=$1`, [cajaId]);
        if(!loteQ.rowCount){ await c.query('ROLLBACK'); return res.status(404).json({ ok:false, error:'Caja no existe' }); }
        const lote = loteQ.rows[0].lote;
        // Ensure any items created later with same lote are linked to this caja
        await c.query(
          `WITH lote_items AS (
              SELECT ic.rfid,
                CASE
                  WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                  WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                  WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                  ELSE 'tic'
                END AS rol
              FROM inventario_credocubes ic
              JOIN modelos m ON m.modelo_id = ic.modelo_id
             WHERE ic.lote = $1
            )
            INSERT INTO acond_caja_items(caja_id, rfid, rol)
            SELECT $2, li.rfid, li.rol
              FROM lote_items li
         LEFT JOIN acond_caja_items aci ON aci.rfid = li.rfid AND aci.caja_id = $2
             WHERE aci.rfid IS NULL`, [lote, cajaId]);
        // Move all components of the caja from Despachando -> Lista para Despacho
        const upd = await c.query(
          `UPDATE inventario_credocubes ic
              SET sub_estado='Lista para Despacho'
             WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
               AND ic.estado='Acondicionamiento'
               AND ic.sub_estado='Despachando'`, [cajaId]);
        moved = upd.rowCount || 0;
        await c.query('COMMIT');
      } catch(e){
        await c.query('ROLLBACK');
        throw e;
      }
    });
    res.json({ ok:true, moved });
  },

  // ============================= ACONDICIONAMIENTO · DESPACHO MANUAL =============================
  // Lookup a caja by scanning one of its RFIDs while in Ensamblaje
  acondDespachoLookup: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { rfid } = req.body as any;
    const code = typeof rfid === 'string' ? rfid.trim() : '';
    if(code.length !== 24) return res.status(400).json({ ok:false, error:'RFID inválido' });
    try {
      // 1. Resolver caja_id y lote usando el RFID
      const cajaRow = await withTenant(tenant, (c)=> c.query(
        `SELECT c.caja_id, c.lote
           FROM acond_caja_items aci
           JOIN acond_cajas c ON c.caja_id = aci.caja_id
          WHERE aci.rfid = $1
          LIMIT 1`, [code]));
      if(!cajaRow.rowCount) return res.status(404).json({ ok:false, error:'RFID no pertenece a ninguna caja' });
      const cajaId = cajaRow.rows[0].caja_id;
      const lote = cajaRow.rows[0].lote;
      // 2. Traer componentes actuales + litraje/rol (fallback si columna litraje no existe)
      let currentQ:any; let litrajeDisponible = true;
      try {
        currentQ = await withTenant(tenant, (c)=> c.query(
          `SELECT aci.rfid,
                  CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                       WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                       WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                       ELSE 'tic' END AS rol,
                  m.litraje,
                  ic.estado, ic.sub_estado
             FROM acond_caja_items aci
             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
             JOIN modelos m ON m.modelo_id = ic.modelo_id
            WHERE aci.caja_id=$1`, [cajaId]));
      } catch(err:any){
        if(/litraje/i.test(err.message||'')){
          litrajeDisponible = false;
          currentQ = await withTenant(tenant, (c)=> c.query(
            `SELECT aci.rfid,
                    CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                         WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                         WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                         ELSE 'tic' END AS rol,
                    ic.estado, ic.sub_estado
               FROM acond_caja_items aci
               JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
               JOIN modelos m ON m.modelo_id = ic.modelo_id
              WHERE aci.caja_id=$1`, [cajaId]));
        } else { throw err; }
      }
      let rows = currentQ.rows as any[];
      // 3. Si faltan roles, intentar autocompletar buscando candidatos libres (no en otra caja) con mismo litraje
      const need = { tic:6, vip:1, cube:1 };
      const counts = { tic:0, vip:0, cube:0 } as any;
      let litrajeRef: any = null;
      for(const r of rows){ counts[r.rol]++; if(r.litraje!=null && litrajeRef==null) litrajeRef = r.litraje; }
      const missingRoles: { rol:'tic'|'vip'|'cube'; falta:number }[] = [];
      (['cube','vip','tic'] as const).forEach(rol => { const falta = (need as any)[rol] - (counts as any)[rol]; if(falta>0) missingRoles.push({ rol, falta }); });
      if(missingRoles.length){
        for(const m of missingRoles){
          let candQ;
          try {
            candQ = await withTenant(tenant, (c)=> c.query(
              `SELECT ic.rfid,
                      CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                           WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                           WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                           ELSE 'tic' END AS rol
                 FROM inventario_credocubes ic
                 JOIN modelos m ON m.modelo_id = ic.modelo_id
            LEFT JOIN acond_caja_items aci2 ON aci2.rfid = ic.rfid
                WHERE aci2.rfid IS NULL
                  AND ic.estado='Acondicionamiento' AND ic.sub_estado='Ensamblaje'
                  AND (( $1::text IS NULL) OR m.litraje = $2)
                  AND (( $3='tic' AND m.nombre_modelo ILIKE '%tic%') OR ( $3='vip' AND m.nombre_modelo ILIKE '%vip%') OR ( $3='cube' AND (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%')))
                LIMIT $4`, [litrajeRef==null?null:String(litrajeRef), litrajeRef, m.rol, m.falta]));
          } catch(err:any){
            if(/litraje/i.test(err.message||'')){
              // Reintentar sin usar columna litraje
              candQ = await withTenant(tenant, (c)=> c.query(
                `SELECT ic.rfid,
                        CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                             WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                             WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                             ELSE 'tic' END AS rol
                   FROM inventario_credocubes ic
                   JOIN modelos m ON m.modelo_id = ic.modelo_id
              LEFT JOIN acond_caja_items aci2 ON aci2.rfid = ic.rfid
                  WHERE aci2.rfid IS NULL
                    AND ic.estado='Acondicionamiento' AND ic.sub_estado='Ensamblaje'
                    AND (( $1='tic' AND m.nombre_modelo ILIKE '%tic%') OR ( $1='vip' AND m.nombre_modelo ILIKE '%vip%') OR ( $1='cube' AND (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%')))
                  LIMIT $2`, [m.rol, m.falta]));
            } else { throw err; }
          }
          const toInsert = candQ.rows as any[];
          for(const ins of toInsert){
            await withTenant(tenant, (c)=> c.query(`INSERT INTO acond_caja_items(caja_id, rfid, rol) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [cajaId, ins.rfid, ins.rol]));
          }
        }
        // recargar
        const recQ = await withTenant(tenant, (c)=> c.query(
          `SELECT aci.rfid,
                  CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                       WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                       WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                       ELSE 'tic' END AS rol,
                  ic.estado, ic.sub_estado
             FROM acond_caja_items aci
             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
             JOIN modelos m ON m.modelo_id = ic.modelo_id
            WHERE aci.caja_id=$1`, [cajaId]));
        rows = recQ.rows as any[];
      }
      const total = rows.length;
      let listos = 0;
      for(const r of rows){ if(r.sub_estado==='Lista para Despacho' || r.sub_estado==='Listo') listos++; }
      const pendientes = total - listos;
      res.json({ ok:true, caja_id: cajaId, lote, rfids: rows.map(r=>r.rfid), pendientes, total });
    } catch(e:any){
      res.status(500).json({ ok:false, error: e.message||'Error lookup' });
    }
  },
  // Move entire caja to Lista para Despacho given one RFID (auto-detect caja)
  acondDespachoMove: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { rfid } = req.body as any;
    const code = typeof rfid === 'string' ? rfid.trim() : '';
    if(code.length !== 24) return res.status(400).json({ ok:false, error:'RFID inválido' });
    try {
      await withTenant(tenant, async (c) => {
        await c.query('BEGIN');
        try {
          const cajaQ = await c.query(`SELECT c.caja_id, c.lote FROM acond_caja_items aci JOIN acond_cajas c ON c.caja_id=aci.caja_id WHERE aci.rfid=$1 LIMIT 1`, [code]);
          if(!cajaQ.rowCount){ await c.query('ROLLBACK'); return res.status(404).json({ ok:false, error:'RFID no pertenece a caja' }); }
          const cajaId = cajaQ.rows[0].caja_id; const lote = cajaQ.rows[0].lote;
          // Detectar si existe columna litraje (para evitar abortar transacción por error)
          const colQ = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='modelos' AND column_name='litraje' LIMIT 1`);
          const litrajeExists = !!colQ.rowCount;
          // Cargar componentes actuales
          const cur = litrajeExists
            ? await c.query(`SELECT aci.rfid, aci.rol, m.litraje FROM acond_caja_items aci JOIN inventario_credocubes ic ON ic.rfid=aci.rfid JOIN modelos m ON m.modelo_id=ic.modelo_id WHERE aci.caja_id=$1`, [cajaId])
            : await c.query(`SELECT aci.rfid, aci.rol FROM acond_caja_items aci JOIN inventario_credocubes ic ON ic.rfid=aci.rfid JOIN modelos m ON m.modelo_id=ic.modelo_id WHERE aci.caja_id=$1`, [cajaId]);
          const counts: any = { tic:0, vip:0, cube:0 }; let litrajeRef:any=null;
          for(const r of cur.rows){ counts[r.rol]++; if(litrajeExists && r.litraje!=null && litrajeRef==null) litrajeRef=r.litraje; }
          const need:any = { tic:6, vip:1, cube:1 };
          for(const rol of ['cube','vip','tic']){
            const falta = need[rol]-counts[rol];
            if(falta>0){
              let cand:any;
              if(litrajeExists){
                cand = await c.query(
                  `SELECT ic.rfid,
                          CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                               WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                               WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                               ELSE 'tic' END AS rol
                     FROM inventario_credocubes ic
                     JOIN modelos m ON m.modelo_id = ic.modelo_id
                LEFT JOIN acond_caja_items aci2 ON aci2.rfid = ic.rfid
                    WHERE aci2.rfid IS NULL
                      AND ic.estado='Acondicionamiento' AND ic.sub_estado='Ensamblaje'
                      AND (($1::text IS NULL) OR m.litraje = $2)
                      AND (( $3='tic' AND m.nombre_modelo ILIKE '%tic%') OR ( $3='vip' AND m.nombre_modelo ILIKE '%vip%') OR ($3='cube' AND (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%')))
                    LIMIT $4`, [litrajeRef==null?null:String(litrajeRef), litrajeRef, rol, falta]);
              } else {
                cand = await c.query(
                  `SELECT ic.rfid,
                          CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                               WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                               WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                               ELSE 'tic' END AS rol
                     FROM inventario_credocubes ic
                     JOIN modelos m ON m.modelo_id = ic.modelo_id
                LEFT JOIN acond_caja_items aci2 ON aci2.rfid = ic.rfid
                    WHERE aci2.rfid IS NULL
                      AND ic.estado='Acondicionamiento' AND ic.sub_estado='Ensamblaje'
                      AND (( $1='tic' AND m.nombre_modelo ILIKE '%tic%') OR ( $1='vip' AND m.nombre_modelo ILIKE '%vip%') OR ($1='cube' AND (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%')))
                    LIMIT $2`, [rol, falta]);
              }
              for(const r of cand.rows){
                await c.query(`INSERT INTO acond_caja_items(caja_id, rfid, rol) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [cajaId, r.rfid, r.rol]);
              }
            }
          }
          // Actualizar por caja (rfids vinculados) independientemente de lote
          const upd = await c.query(
            `UPDATE inventario_credocubes ic
                SET sub_estado='Lista para Despacho'
               WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                 AND ic.estado='Acondicionamiento'
                 AND ic.sub_estado='Ensamblaje'`, [cajaId]);
          await c.query('COMMIT');
          res.json({ ok:true, caja_id: cajaId, lote, moved: upd.rowCount });
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      });
    } catch(e:any){
      res.status(500).json({ ok:false, error: e.message||'Error moviendo a despacho' });
    }
  },

  // ============================= OPERACIÓN · CAJA LOOKUP & MOVE =============================
  // Lookup caja by either a component RFID (24 chars) or the caja lote code (e.g. CAJA001-05092025)
  operacionCajaLookup: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { code } = req.body as any;
    let val = typeof code === 'string' ? code.trim() : '';
    if(!val) return res.status(400).json({ ok:false, error:'Código requerido' });
    try {
      // Resolve caja_id
      let cajaRow: any = null;
      if(val.length === 24){
        const r = await withTenant(tenant, (c)=> c.query(
          `SELECT c.caja_id, c.lote FROM acond_caja_items aci JOIN acond_cajas c ON c.caja_id = aci.caja_id WHERE aci.rfid=$1 LIMIT 1`, [val]));
        if(r.rowCount) cajaRow = r.rows[0];
      }
      if(!cajaRow){
        // Try as lote code
        const r2 = await withTenant(tenant, (c)=> c.query(`SELECT caja_id, lote FROM acond_cajas WHERE lote=$1 LIMIT 1`, [val]));
        if(r2.rowCount) cajaRow = r2.rows[0];
      }
      if(!cajaRow) return res.status(404).json({ ok:false, error:'Caja no encontrada' });
      const cajaId = cajaRow.caja_id;
      const itemsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT aci.rol, ic.rfid, ic.estado, ic.sub_estado, m.nombre_modelo
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
           JOIN modelos m ON m.modelo_id = ic.modelo_id
          WHERE aci.caja_id=$1
          ORDER BY CASE aci.rol WHEN 'vip' THEN 0 WHEN 'tic' THEN 1 ELSE 2 END, ic.rfid`, [cajaId]));
      // Ensure table exists then fetch timer
      await withTenant(tenant, (c)=> c.query(`CREATE TABLE IF NOT EXISTS operacion_caja_timers (
           caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
           started_at timestamptz,
           duration_sec integer,
           active boolean NOT NULL DEFAULT false,
           updated_at timestamptz NOT NULL DEFAULT NOW()
         )`));
      const timerSingleQ = await withTenant(tenant, (c)=> c.query(`SELECT caja_id, started_at, duration_sec, active FROM operacion_caja_timers WHERE caja_id=$1`, [cajaId]));
      let timerRow: any = null;
      if(timerSingleQ.rowCount) timerRow = timerSingleQ.rows[0];
      const items = itemsQ.rows as any[];
      const allListo = items.every(i => i.estado==='Acondicionamiento' && (i.sub_estado==='Lista para Despacho' || i.sub_estado==='Listo'));
      const allOperacion = items.every(i => i.estado==='Operación');
      let timer: any = null;
      if(timerRow && timerRow.started_at && timerRow.duration_sec){
        const startsAt = timerRow.started_at;
        const endsAt = new Date(new Date(startsAt).getTime() + timerRow.duration_sec*1000).toISOString();
        timer = { startsAt, endsAt, active: !!timerRow.active };
      }
      res.json({ ok:true, caja: { id: cajaId, lote: cajaRow.lote, items, allListo, allOperacion, timer } });
    } catch(e:any){
      res.status(500).json({ ok:false, error: e.message||'Error lookup' });
    }
  },
  // Move all items of caja from Lista para Despacho -> Operación (sub_estado 'Transito')
  operacionCajaMove: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { code } = req.body as any;
    let val = typeof code === 'string' ? code.trim() : '';
    if(!val) return res.status(400).json({ ok:false, error:'Código requerido' });
    try {
      let cajaId: number | null = null;
      if(val.length===24){
        const r = await withTenant(tenant, (c)=> c.query(`SELECT c.caja_id FROM acond_caja_items aci JOIN acond_cajas c ON c.caja_id=aci.caja_id WHERE aci.rfid=$1 LIMIT 1`, [val]));
        if(r.rowCount) cajaId = r.rows[0].caja_id;
      }
      if(cajaId==null){
        const r2 = await withTenant(tenant, (c)=> c.query(`SELECT caja_id FROM acond_cajas WHERE lote=$1 LIMIT 1`, [val]));
        if(r2.rowCount) cajaId = r2.rows[0].caja_id;
      }
      if(cajaId==null) return res.status(404).json({ ok:false, error:'Caja no encontrada' });
      await withTenant(tenant, async (c)=>{
        await c.query('BEGIN');
        try {
          // Only move those currently listos para despacho
            await c.query(
        `UPDATE inventario_credocubes ic
          SET estado='Operación', sub_estado=NULL
                 WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                   AND ic.estado='Acondicionamiento'
                   AND ic.sub_estado IN ('Lista para Despacho','Listo')`, [cajaId]);
          await c.query('COMMIT');
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      });
      res.json({ ok:true, caja_id: cajaId });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error moviendo a Operación' }); }
  },
  // Start manual timer in Operación phase for caja
  operacionCajaTimerStart: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { caja_id, durationSec } = req.body as any;
    const cajaId = Number(caja_id);
    const dur = Number(durationSec);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    if(!Number.isFinite(dur) || dur<=0) return res.status(400).json({ ok:false, error:'Duración inválida' });
    await withTenant(tenant, async (c)=>{
      await c.query(`CREATE TABLE IF NOT EXISTS operacion_caja_timers (
           caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
           started_at timestamptz,
           duration_sec integer,
           active boolean NOT NULL DEFAULT false,
           updated_at timestamptz NOT NULL DEFAULT NOW()
        )`);
      const ex = await c.query(`SELECT 1 FROM acond_cajas WHERE caja_id=$1`, [cajaId]);
      if(!ex.rowCount) return res.status(404).json({ ok:false, error:'Caja no existe' });
      await c.query('BEGIN');
      try {
        await c.query(`INSERT INTO operacion_caja_timers(caja_id, started_at, duration_sec, active, updated_at)
                         VALUES($1,NOW(),$2,true,NOW())
            ON CONFLICT (caja_id) DO UPDATE SET started_at=NOW(), duration_sec=EXCLUDED.duration_sec, active=true, updated_at=NOW()`,[cajaId,dur]);
        // Asegurar sub_estado='Transito' para todos los items de la caja que estén en Operación y no finalizados
        await c.query(`UPDATE inventario_credocubes ic
                         SET sub_estado='Transito'
                        WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                          AND ic.estado='Operación'
                          AND (ic.sub_estado IS NULL OR ic.sub_estado NOT IN ('Retorno','Completado','Transito'))`, [cajaId]);
        await c.query('COMMIT');
      } catch(e){ await c.query('ROLLBACK'); throw e; }
    });
    res.json({ ok:true });
  },
  // Start timer for one caja and replicate same duration to all other cajas in Operación with same lote
  operacionCajaTimerStartBulk: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { caja_id, durationSec } = req.body as any;
    const cajaId = Number(caja_id); const dur = Number(durationSec);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    if(!Number.isFinite(dur) || dur<=0) return res.status(400).json({ ok:false, error:'Duración inválida' });
    try {
      await withTenant(tenant, async (c)=>{
        await c.query('BEGIN');
        try {
          // Get lote of target caja
          const loteQ = await c.query(`SELECT lote FROM acond_cajas WHERE caja_id=$1`, [cajaId]);
            if(!loteQ.rowCount){ await c.query('ROLLBACK'); return res.status(404).json({ ok:false, error:'Caja no existe' }); }
          const lote = loteQ.rows[0].lote;
          await c.query(`CREATE TABLE IF NOT EXISTS operacion_caja_timers (
             caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
             started_at timestamptz,
             duration_sec integer,
             active boolean NOT NULL DEFAULT false,
             updated_at timestamptz NOT NULL DEFAULT NOW()
          )`);
          // Find all cajas in Operación with same lote (at least one item in Operación)
          const cajasQ = await c.query(
            `SELECT DISTINCT c.caja_id
               FROM acond_cajas c
               JOIN acond_caja_items aci ON aci.caja_id=c.caja_id
               JOIN inventario_credocubes ic ON ic.rfid=aci.rfid
              WHERE c.lote=$1 AND ic.estado='Operación'`, [lote]);
          const ids = cajasQ.rows.map(r=> r.caja_id);
          for(const id of ids){
            await c.query(`INSERT INTO operacion_caja_timers(caja_id, started_at, duration_sec, active, updated_at)
                            VALUES($1,NOW(),$2,true,NOW())
               ON CONFLICT (caja_id) DO UPDATE SET started_at=NOW(), duration_sec=EXCLUDED.duration_sec, active=true, updated_at=NOW()`, [id, dur]);
          }
          await c.query('COMMIT');
          res.json({ ok:true, lote, cajas: ids.length });
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error iniciando timers' }); }
  },
  operacionCajaTimerClear: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { caja_id } = req.body as any;
    const cajaId = Number(caja_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    await withTenant(tenant, async (c)=>{
      await c.query('BEGIN');
      try {
        await c.query(`UPDATE operacion_caja_timers SET active=false, started_at=NULL, duration_sec=NULL, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
        // Volver items a estado base (sub_estado NULL) para permitir iniciar de nuevo
        await c.query(`UPDATE inventario_credocubes ic
                         SET sub_estado=NULL
                        WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                          AND ic.estado='Operación'`, [cajaId]);
        await c.query('COMMIT');
      } catch(e){ await c.query('ROLLBACK'); throw e; }
    });
    res.json({ ok:true });
  },
  operacionCajaTimerComplete: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { caja_id } = req.body as any;
    const cajaId = Number(caja_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    await withTenant(tenant, async (c)=>{
      await c.query('BEGIN');
      try {
        await c.query(`UPDATE operacion_caja_timers SET active=false, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
        // Marcar items como Retorno (cronómetro finalizado)
        await c.query(`UPDATE inventario_credocubes ic SET sub_estado='Retorno' WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1) AND ic.estado='Operación' AND ic.sub_estado='Transito'`, [cajaId]);
        await c.query('COMMIT');
      } catch(e){ await c.query('ROLLBACK'); throw e; }
    });
    res.json({ ok:true });
  },

  // List cajas currently en Operación (or en tránsito) with timer info (for new UI)
  operacionData: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    try {
      // Ensure timers table exists
      await withTenant(tenant, (c)=> c.query(`CREATE TABLE IF NOT EXISTS operacion_caja_timers (
        caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
        started_at timestamptz,
        duration_sec integer,
        active boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )`));
      // Auto-expirar timers vencidos y marcar items Retorno antes de construir respuesta
      await withTenant(tenant, async (c)=>{
        await c.query('BEGIN');
        try {
          await c.query(`WITH expired AS (
              SELECT caja_id
                FROM operacion_caja_timers
               WHERE active=true
                 AND started_at IS NOT NULL
                 AND duration_sec IS NOT NULL
                 AND started_at + (duration_sec || ' seconds')::interval <= NOW()
          )
          UPDATE operacion_caja_timers oct
             SET active=false, updated_at=NOW()
            WHERE caja_id IN (SELECT caja_id FROM expired)`);
          await c.query(`UPDATE inventario_credocubes ic
                           SET sub_estado='Retorno'
                          WHERE ic.estado='Operación'
                            AND ic.sub_estado='Transito'
                            AND ic.rfid IN (
                               SELECT rfid FROM acond_caja_items aci
                               JOIN operacion_caja_timers oct ON oct.caja_id=aci.caja_id
                               WHERE oct.active=false AND (oct.started_at IS NOT NULL AND oct.duration_sec IS NOT NULL)
                                 AND oct.started_at + (oct.duration_sec || ' seconds')::interval <= NOW()
                           )`);
          // Saneamiento: cualquier item marcado Transito sin timer activo asociado -> reset a NULL
          await c.query(`UPDATE inventario_credocubes ic
                           SET sub_estado=NULL
                          WHERE ic.estado='Operación'
                            AND ic.sub_estado='Transito'
                            AND NOT EXISTS (
                              SELECT 1 FROM acond_caja_items aci
                              JOIN operacion_caja_timers oct ON oct.caja_id=aci.caja_id AND oct.active=true
                              WHERE aci.rfid=ic.rfid
                            )`);
          await c.query('COMMIT');
        } catch(e){ await c.query('ROLLBACK'); /* no bloquear respuesta */ }
      });
      const nowRes = await withTenant(tenant, (c)=> c.query<{ now:string }>(`SELECT NOW()::timestamptz AS now`));
      const cajasQ = await withTenant(tenant, (c)=> c.query(
        `SELECT c.caja_id, c.lote, act.started_at, act.duration_sec, act.active,
                COUNT(*) FILTER (WHERE ic.estado='Operación') AS total_op,
                COUNT(*) FILTER (WHERE ic.estado='Operación' AND ic.sub_estado='Completado') AS completados
           FROM acond_cajas c
           JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
      LEFT JOIN operacion_caja_timers act ON act.caja_id = c.caja_id
          WHERE ic.estado='Operación'
          GROUP BY c.caja_id, c.lote, act.started_at, act.duration_sec, act.active
          ORDER BY c.caja_id DESC
          LIMIT 300`));
      const itemsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT c.caja_id, aci.rol, ic.rfid, ic.estado, ic.sub_estado, m.nombre_modelo
           FROM acond_caja_items aci
           JOIN acond_cajas c ON c.caja_id = aci.caja_id
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
           JOIN modelos m ON m.modelo_id = ic.modelo_id
          WHERE c.caja_id = ANY($1::int[])
          ORDER BY c.caja_id DESC, CASE aci.rol WHEN 'vip' THEN 0 WHEN 'tic' THEN 1 ELSE 2 END, ic.rfid`, [cajasQ.rows.map(r=>r.caja_id)]));
      const mapaItems: Record<string, any[]> = {};
      for(const row of itemsQ.rows as any[]){
        (mapaItems[row.caja_id] ||= []).push({
          codigo: row.rfid,
          rol: row.rol,
          estado: row.estado,
            sub_estado: row.sub_estado,
          nombre: row.nombre_modelo
        });
      }
      const nowIso = nowRes.rows[0]?.now;
      const nowMs = nowIso ? new Date(nowIso).getTime() : Date.now();
      const cajasUI = cajasQ.rows.map(r=>{
        let timer=null; let completedAt=null; let endsAt=null;
        if(r.started_at && r.duration_sec){
          const endMs = new Date(r.started_at).getTime() + r.duration_sec*1000;
          endsAt = new Date(endMs).toISOString();
          if(!r.active && endMs <= nowMs) completedAt = endsAt;
          timer = { startsAt: r.started_at, endsAt, completedAt };
        }
        // Derivar estado de la caja basado en sub_estados:
        const items = mapaItems[r.caja_id]||[];
        const anyTransito = items.some(it=> it.sub_estado==='Transito');
        const anyRetorno = items.some(it=> it.sub_estado==='Retorno');
        let estadoCaja = 'Operación';
        if(anyTransito) estadoCaja = 'Transito';
        else if(anyRetorno) estadoCaja = 'Retorno';
        return {
          id: r.caja_id,
          codigoCaja: r.lote,
          estado: estadoCaja,
          timer,
          componentes: items.map(it=> ({ codigo: it.codigo, tipo: it.rol, nombre: it.nombre, estado: it.estado, sub_estado: it.sub_estado }))
        };
      });
      res.json({ ok:true, now: nowIso, cajas: cajasUI });
    } catch(e:any){
      res.status(500).json({ ok:false, error: e.message||'Error operacion data' });
    }
  },

  // Lookup a caja (by component RFID or lote) that is lista para despacho and NOT yet in Operación
  operacionAddLookup: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { code } = req.body as any;
    const val = typeof code === 'string' ? code.trim() : '';
    if(!val) return res.status(400).json({ ok:false, error:'Código requerido' });
    try {
      let caja: any = null;
      if(val.length===24){
        const q = await withTenant(tenant, (c)=> c.query(
          `SELECT c.caja_id, c.lote
             FROM acond_caja_items aci
             JOIN acond_cajas c ON c.caja_id = aci.caja_id
             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
            WHERE aci.rfid=$1
            LIMIT 1`, [val]));
        if(q.rowCount) caja = q.rows[0];
      }
      if(!caja){
        const q2 = await withTenant(tenant, (c)=> c.query(`SELECT caja_id, lote FROM acond_cajas WHERE lote=$1 LIMIT 1`, [val]));
        if(q2.rowCount) caja = q2.rows[0];
      }
      if(!caja) return res.status(404).json({ ok:false, error:'Caja no encontrada' });
      // Obtener items de la caja y filtrar únicamente los que YA están en 'Lista para Despacho'
      const itemsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT aci.rfid, ic.estado, ic.sub_estado, aci.rol, m.nombre_modelo
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
           JOIN modelos m ON m.modelo_id = ic.modelo_id
          WHERE aci.caja_id=$1`, [caja.caja_id]));
      const items = itemsQ.rows as any[];
      // Solo considerar exactamente sub_estado 'Lista para Despacho'
      const elegibles = items.filter(i=> i.estado==='Acondicionamiento' && i.sub_estado==='Lista para Despacho');
      if(!elegibles.length) return res.status(400).json({ ok:false, error:'Caja no está Lista para Despacho' });
      res.json({
        ok:true,
        caja_id: caja.caja_id,
        lote: caja.lote,
        total: items.length,
        elegibles: elegibles.map(e=> e.rfid),
        roles: elegibles.map(e=> ({ rfid: e.rfid, rol: e.rol }))
      });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error lookup' }); }
  },
  operacionAddMove: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { caja_id } = req.body as any;
    const id = Number(caja_id);
    if(!Number.isFinite(id) || id<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    try {
      await withTenant(tenant, async (c)=>{
        await c.query('BEGIN');
        try {
          const upd = await c.query(
            `UPDATE inventario_credocubes ic
                SET estado='Operación', sub_estado=NULL
               WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                 AND ic.estado='Acondicionamiento'
                 AND ic.sub_estado IN ('Lista para Despacho','Listo')`, [id]);
          await c.query('COMMIT');
          res.json({ ok:true, moved: upd.rowCount });
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error moviendo' }); }
  }
};
