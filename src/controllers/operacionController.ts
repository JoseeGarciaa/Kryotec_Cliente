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
   // Ensure columns for timers exist
   await withTenant(tenant, (c) => c.query(
    `ALTER TABLE inventario_credocubes
      ADD COLUMN IF NOT EXISTS preacond_cong_started_at timestamptz,
      ADD COLUMN IF NOT EXISTS preacond_atem_started_at timestamptz`));

   const rowsCong = await withTenant(tenant, (c) => c.query(
      `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado
        , ic.preacond_cong_started_at AS started_at
     FROM inventario_credocubes ic
       JOIN modelos m ON m.modelo_id = ic.modelo_id
       WHERE ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado = 'Congelamiento'
         AND (m.nombre_modelo ILIKE '%tic%')
       ORDER BY ic.id DESC
       LIMIT 500`));
   const rowsAtem = await withTenant(tenant, (c) => c.query(
      `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado
        , ic.preacond_atem_started_at AS started_at
     FROM inventario_credocubes ic
       JOIN modelos m ON m.modelo_id = ic.modelo_id
       WHERE ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado = 'Atemperamiento'
         AND (m.nombre_modelo ILIKE '%tic%')
       ORDER BY ic.id DESC
       LIMIT 500`));
   const nowRes = await withTenant(tenant, (c) => c.query<{ now: string }>(`SELECT NOW()::timestamptz AS now`));
   res.json({ now: nowRes.rows[0]?.now, congelamiento: rowsCong.rows, atemperamiento: rowsAtem.rows });
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
      // Ensure columns exist before update
      await withTenant(tenant, (c) => c.query(
        `ALTER TABLE inventario_credocubes
           ADD COLUMN IF NOT EXISTS preacond_cong_started_at timestamptz,
           ADD COLUMN IF NOT EXISTS preacond_atem_started_at timestamptz`));
      if (t === 'congelamiento') {
        await withTenant(tenant, (c) => c.query(
          `UPDATE inventario_credocubes ic
              SET estado = 'Pre Acondicionamiento', sub_estado = 'Congelamiento',
                  preacond_cong_started_at = COALESCE(preacond_cong_started_at, NOW())
            FROM modelos m
           WHERE ic.modelo_id = m.modelo_id
             AND ic.rfid = ANY($1::text[])
             AND (m.nombre_modelo ILIKE '%tic%')`, [accept]));
      } else {
        await withTenant(tenant, (c) => c.query(
          `UPDATE inventario_credocubes ic
              SET estado = 'Pre Acondicionamiento', sub_estado = 'Atemperamiento',
                  preacond_atem_started_at = COALESCE(preacond_atem_started_at, NOW())
            FROM modelos m
           WHERE ic.modelo_id = m.modelo_id
             AND ic.rfid = ANY($1::text[])
             AND (m.nombre_modelo ILIKE '%tic%')
             AND ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado = 'Congelamiento'`, [accept]));
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
};
