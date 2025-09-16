import { Request, Response } from 'express';
import { withTenant } from '../db/pool';
import { AlertsModel } from '../models/Alerts';
import { resolveTenant } from '../middleware/tenant';

type ModeloRow = { modelo_id: number; nombre_modelo: string; tipo: string | null };

function normTipo(tipo: string | null): 'TIC' | 'VIP' | 'Cube' | 'Otros' {
  const t = (tipo || '').toLowerCase();
  if (t.startsWith('tic')) return 'TIC';
  if (t.startsWith('vip')) return 'VIP';
  if (t.startsWith('cube') || t.startsWith('cubo')) return 'Cube';
  return 'Otros';
}

export const RegistroController = {
  index: async (req: Request, res: Response) => {
  const t = resolveTenant(req);
  if (!t) return res.status(400).send('Tenant no especificado');
  const tenant = t.startsWith('tenant_') ? t : `tenant_${t}`;
  const modelosRes = await withTenant(tenant, (c) => c.query<ModeloRow>('SELECT modelo_id, nombre_modelo, tipo FROM modelos ORDER BY nombre_modelo'));
    const modelos = modelosRes.rows;

    // Build a simple data structure { category: [{id, name}, ...] }
    const byTipo: Record<string, Array<{ id: number; name: string }>> = { TIC: [], VIP: [], Cube: [], Otros: [] } as any;
    for (const m of modelos) {
      const key = normTipo(m.tipo);
      (byTipo[key] = byTipo[key] || []).push({ id: m.modelo_id, name: m.nombre_modelo });
    }

    res.render('registro/index', {
      title: 'Registro de Items',
      modelosByTipo: byTipo,
    });
  },

  create: async (req: Request, res: Response) => {
  const t = resolveTenant(req);
  if (!t) return res.status(400).send('Tenant no especificado');
  const tenant = t.startsWith('tenant_') ? t : `tenant_${t}`;
  const { modelo_id, rfids } = req.body as any;
    const modeloIdNum = Number(modelo_id);
    // rfids may come as array or object (rfids[0], rfids[1], ...)
    const rawList: string[] = Array.isArray(rfids)
      ? rfids
      : (rfids && typeof rfids === 'object')
        ? Object.values(rfids as any)
        : [];
    // normalize: trim, filter 24-length, unique
    const rfidsArr = Array.from(new Set(
      rawList.map((r) => String(r || '').trim().toUpperCase()).filter((r) => r.length === 24)
    ));
    if (!modeloIdNum || rfidsArr.length === 0) {
      // Rebuild modelosByTipo for re-render
      const modelosRes = await withTenant(tenant, (c) => c.query<ModeloRow>('SELECT modelo_id, nombre_modelo, tipo FROM modelos ORDER BY nombre_modelo'));
      const byTipo: Record<string, Array<{ id: number; name: string }>> = { TIC: [], VIP: [], Cube: [], Otros: [] } as any;
      for (const m of modelosRes.rows) {
        const key = normTipo(m.tipo);
        (byTipo[key] = byTipo[key] || []).push({ id: m.modelo_id, name: m.nombre_modelo });
      }
  return res.status(200).render('registro/index', { title: 'Registro de Items', error: 'Complete tipo, litraje y escanee al menos un RFID', modelosByTipo: byTipo, rfids: rfidsArr, selectedModelo: modeloIdNum });
    }

    try {
  type DuplicatePayload = { dups: string[]; modelosByTipo: Record<string, Array<{ id: number; name: string }>> };
  let selectedTipo: string = 'Otros';
  let duplicatePayload: DuplicatePayload | null = null;
  let insertedCount = 0;
  await withTenant(tenant, async (c) => {
        const meta = await c.query<{ nombre_modelo: string; tipo: string | null }>(
          'SELECT nombre_modelo, tipo FROM modelos WHERE modelo_id = $1',
          [modeloIdNum]
        );
        if (!meta.rowCount) throw new Error('Modelo no encontrado');
        const nombre = meta.rows[0].nombre_modelo;
        selectedTipo = normTipo(meta.rows[0].tipo) as string;
        const categoria = meta.rows[0].tipo || null;

        // Pre-check duplicates y filtrar los existentes
        const dupCheck = await c.query<{ rfid: string }>(
          'SELECT rfid FROM inventario_credocubes WHERE rfid = ANY($1::text[])',
          [rfidsArr]
        );
        const existing = new Set((dupCheck.rows || []).map(r => r.rfid));
  const toInsert = rfidsArr.filter(r => !existing.has(r));
  insertedCount = toInsert.length;

        // Insertar solo los no existentes
        for (const rfid of toInsert) {
          await c.query(
            `INSERT INTO inventario_credocubes 
               (modelo_id, nombre_unidad, rfid, lote, estado, sub_estado, categoria, fecha_ingreso, fecha_vencimiento)
             VALUES ($1, $2, $3, NULL, 'En Bodega', NULL, $4, NOW(), NOW() + INTERVAL '5 years')`,
            [modeloIdNum, nombre, rfid, categoria]
          );
        }
        // Si algunos eran duplicados, redirigir igual (operación idempotente)
      });
      // Crear alerta de registro si se insertó al menos un item
      if (insertedCount > 0) {
        const desc = `${insertedCount} item${insertedCount>1 ? 's' : ''} registrado${insertedCount>1 ? 's' : ''} (${selectedTipo})`;
        await withTenant(tenant, (c) => AlertsModel.create(c, { tipo_alerta: 'inventario:registro', descripcion: desc }));
      }
      return res.redirect('/inventario');
    } catch (e: any) {
      console.error(e);
      let msg = e?.code === '23505' ? 'Uno o más RFID ya existen' : 'Error registrando items';
      let dups: string[] = [];
      if (e?.code === '23505') {
        // Attempt to figure out which RFIDs exist
        try {
          await withTenant(tenant, async (c) => {
            const found = await c.query<{ rfid: string }>('SELECT rfid FROM inventario_credocubes WHERE rfid = ANY($1::text[])', [
              Array.isArray((req.body as any).rfids) ? (req.body as any).rfids : Object.values((req.body as any).rfids || {}),
            ]);
            dups = found.rows.map((r) => r.rfid);
          });
        } catch {}
      }
      // Re-render with error and modelosByTipo; the view can recover using client-side state
      const modelosRes = await withTenant(tenant, (c) => c.query<ModeloRow>('SELECT modelo_id, nombre_modelo, tipo FROM modelos ORDER BY nombre_modelo'));
      const byTipo: Record<string, Array<{ id: number; name: string }>> = { TIC: [], VIP: [], Cube: [], Otros: [] } as any;
      for (const m of modelosRes.rows) {
        const key = normTipo(m.tipo);
        (byTipo[key] = byTipo[key] || []).push({ id: m.modelo_id, name: m.nombre_modelo });
      }
      return res.status(200).render('registro/index', { title: 'Registro de Items', error: msg, modelosByTipo: byTipo, rfids: [], selectedModelo: modeloIdNum, dups });
    }
  },
  validate: async (req: Request, res: Response) => {
    try {
      const tenant = (req as any).user?.tenant;
      const body = req.body as any;
      const rawList: string[] = Array.isArray(body.rfids)
        ? body.rfids
        : (body.rfids && typeof body.rfids === 'object')
          ? Object.values(body.rfids)
          : [];
      const rfids = Array.from(new Set(rawList.map((r: any) => String(r || '').trim()).filter((r: string) => r.length === 24)));
      if (rfids.length === 0) return res.json({ dups: [] });
      const found = await withTenant(tenant, (c) => c.query<{ rfid: string }>('SELECT rfid FROM inventario_credocubes WHERE rfid = ANY($1::text[])', [rfids]));
      return res.json({ dups: found.rows.map((r) => r.rfid) });
    } catch (e) {
      return res.json({ dups: [] });
    }
  },
};
