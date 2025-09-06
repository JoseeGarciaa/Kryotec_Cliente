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
export const OperacionController = {
  index: (_req: Request, res: Response) => res.redirect('/operacion/todas'),
  todas: (_req: Request, res: Response) => res.render('operacion/todas', { title: 'Operación · Todas las fases' }),
  bodega: (_req: Request, res: Response) => res.render('operacion/bodega', { title: 'Operación · En bodega' }),
  preacond: (_req: Request, res: Response) => res.render('operacion/preacond', { title: 'Operación · Registrar pre-acondicionamiento' }),
  acond: (_req: Request, res: Response) => res.render('operacion/acond', { title: 'Operación · Acondicionamiento' }),
  operacion: (_req: Request, res: Response) => res.render('operacion/operacion', { title: 'Operación · Operación' }),
  devolucion: (_req: Request, res: Response) => res.render('operacion/devolucion', { title: 'Operación · Devolución' }),
  inspeccion: (_req: Request, res: Response) => res.render('operacion/inspeccion', { title: 'Operación · Inspección' }),

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
};
