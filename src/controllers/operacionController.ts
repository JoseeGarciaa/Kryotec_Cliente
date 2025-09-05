import { Request, Response } from 'express';
import { withTenant } from '../db/pool';

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
       WHERE ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado = 'Congelamiento'
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
       WHERE ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado = 'Atemperamiento'
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
    const { target, rfids } = req.body as any;
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
        if (cur?.estado === 'Pre Acondicionamiento' && cur?.sub_estado === 'Congelamiento') {
          accept.push(code);
        } else {
          rejects.push({ rfid: code, reason: 'Debe estar en Congelamiento' });
        }
      } else {
        // Congelamiento: aceptar cualquier TIC
        accept.push(code);
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
        await withTenant(tenant, (c) => c.query(
          `UPDATE inventario_credocubes ic
        SET estado = 'Pre Acondicionamiento', sub_estado = 'Atemperamiento'
            FROM modelos m
           WHERE ic.modelo_id = m.modelo_id
             AND ic.rfid = ANY($1::text[])
             AND (m.nombre_modelo ILIKE '%tic%')
             AND ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado = 'Congelamiento'`, [accept]));
      }

      // If there is an active group timer with a lote set for the target section, apply that lote to these RFIDs
      const timer = await withTenant(tenant, (c) => c.query(
        `SELECT lote FROM preacond_timers WHERE section = $1 AND active = true AND lote IS NOT NULL`, [t]
      ));
      const lote = timer.rows?.[0]?.lote as string | undefined;
      if (lote) {
        await withTenant(tenant, (c) => c.query(
          `UPDATE inventario_credocubes SET lote = $1 WHERE rfid = ANY($2::text[])`, [lote, accept]
        ));
      }
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
        if(r.estado === 'Pre Acondicionamiento' && r.sub_estado === 'Congelamiento') ok.push(code);
        else invalid.push({ rfid: code, reason: 'Debe estar en Congelamiento' });
      } else {
        // Congelamiento acepta cualquier TIC
        ok.push(code);
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
    const loteVal = typeof lote === 'string' ? lote.trim() : '';
    if(!['congelamiento','atemperamiento'].includes(s) || !Number.isFinite(dur) || dur <= 0 || !loteVal){
      return res.status(400).json({ ok:false, error:'Entrada inválida' });
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
      // If a list of RFIDs is provided, tag those items with the lote now
      const list = Array.isArray(rfids) ? rfids.filter((x:any)=>typeof x==='string' && x.trim()).map((x:string)=>x.trim()) : [];
      if(list.length){
        await c.query(`UPDATE inventario_credocubes SET lote = $1 WHERE rfid = ANY($2::text[])`, [loteVal, list]);
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
                 lote = EXCLUDED.lote,
                 active = true,
                 updated_at = NOW()`,
          [s, dur, loteVal, list]
        );
      }
    });
    res.json({ ok:true });
  },

  preacondTimerClear: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { section } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    if(!['congelamiento','atemperamiento'].includes(s)) return res.status(400).json({ ok:false, error:'Entrada inválida' });
    await withTenant(tenant, (c) => c.query(
      `INSERT INTO preacond_timers(section, started_at, duration_sec, active, updated_at)
         VALUES ($1, NULL, NULL, false, NOW())
       ON CONFLICT (section) DO UPDATE
         SET started_at = NULL, duration_sec = NULL, lote = NULL, active = false, updated_at = NOW()`,
      [s]
    ));
    res.json({ ok:true });
  },

  // Item-level timers
  preacondItemTimerStart: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { section, rfid, durationSec, lote } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    const r = typeof rfid === 'string' ? rfid.trim() : '';
    const dur = Number(durationSec);
    const loteVal = typeof lote === 'string' ? lote.trim() : '';
    if (!['congelamiento','atemperamiento'].includes(s) || !r || !Number.isFinite(dur) || dur <= 0 || !loteVal) {
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
      await c.query(
        `INSERT INTO preacond_item_timers(rfid, section, started_at, duration_sec, lote, active, updated_at)
           VALUES ($1, $2, NOW(), $3, $4, true, NOW())
         ON CONFLICT (rfid, section) DO UPDATE
           SET started_at = EXCLUDED.started_at,
               duration_sec = EXCLUDED.duration_sec,
               lote = EXCLUDED.lote,
               active = true,
               updated_at = NOW()`,
        [r, s, dur, loteVal]
      );
      // Optionally tag the item's lote field too
      await c.query(`UPDATE inventario_credocubes SET lote = $1 WHERE rfid = $2`, [loteVal, r]);
    });
    res.json({ ok:true });
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
      await c.query(
        `INSERT INTO preacond_item_timers(rfid, section, started_at, duration_sec, lote, active, updated_at)
           VALUES ($1, $2, NULL, NULL, NULL, false, NOW())
         ON CONFLICT (rfid, section) DO UPDATE
           SET started_at = NULL,
               duration_sec = NULL,
               lote = NULL,
               active = false,
               updated_at = NOW()`,
        [r, s]
      );
    });
    res.json({ ok:true });
  },
};
