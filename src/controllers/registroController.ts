import { Request, Response } from 'express';
import { withTenant } from '../db/pool';
import { AlertsModel } from '../models/Alerts';
import { resolveTenant } from '../middleware/tenant';
import { getRequestSedeId } from '../utils/sede';
import { SedesModel } from '../models/Sede';

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
  const t = (req as any).user?.tenant || resolveTenant(req);
  if (!t) return res.status(400).send('Tenant no especificado');
  const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
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
  const t = (req as any).user?.tenant || resolveTenant(req);
  if (!t) return res.status(400).send('Tenant no especificado');
  const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
  const sedeId = getRequestSedeId(req);
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
      let selectedTipo: string = 'Otros';
      let insertedCount = 0;
      await withTenant(tenant, async (c) => {
        let sedeToUse: number | null = sedeId ?? null;
        if (sedeToUse !== null) {
          const sedeExists = await SedesModel.findById(c, sedeToUse);
          if (!sedeExists) {
            console.warn('[registro][create] sede asignada no existe, se omite', { sedeToUse });
            sedeToUse = null;
          }
        }
        const meta = await c.query<{ nombre_modelo: string; tipo: string | null }>(
          'SELECT nombre_modelo, tipo FROM modelos WHERE modelo_id = $1',
          [modeloIdNum]
        );
        if (!meta.rowCount) throw new Error('Modelo no encontrado');
        const nombre = meta.rows[0].nombre_modelo;
        selectedTipo = normTipo(meta.rows[0].tipo) as string;

        // Asegurar índice único para ON CONFLICT (rfid)
        await c.query(`DO $$
        BEGIN
          BEGIN
            EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS inventario_credocubes_rfid_key ON inventario_credocubes(rfid)';
          EXCEPTION WHEN others THEN
          END;
        END$$;`);

        // Insertar con ON CONFLICT DO NOTHING para evitar 23505 y permitir éxito parcial
        for (const rfid of rfidsArr) {
          const r = await c.query(
            `INSERT INTO inventario_credocubes 
               (modelo_id, nombre_unidad, rfid, lote, estado, sub_estado, sede_id)
             VALUES ($1, $2, $3, NULL, 'En Bodega', NULL, $4)
             ON CONFLICT (rfid) DO NOTHING
             RETURNING id`,
            [modeloIdNum, nombre, rfid, sedeToUse]
          );
          if (r.rowCount) insertedCount += r.rowCount;
        }
      });
      // Crear alerta de registro si se insertó al menos un item
      if (insertedCount > 0) {
        const desc = `${insertedCount} item${insertedCount>1 ? 's' : ''} registrado${insertedCount>1 ? 's' : ''} (${selectedTipo})`;
        await withTenant(tenant, (c) => AlertsModel.create(c, { tipo_alerta: 'inventario:registro', descripcion: desc }));
      }
      return res.redirect('/inventario');
    } catch (e: any) {
      console.error(e);
      // Fallback: mostrar mensaje amable sin bloquear si algo menor falló
      const modelosRes = await withTenant(tenant, (c) => c.query<ModeloRow>('SELECT modelo_id, nombre_modelo, tipo FROM modelos ORDER BY nombre_modelo'));
      const byTipo: Record<string, Array<{ id: number; name: string }>> = { TIC: [], VIP: [], Cube: [], Otros: [] } as any;
      for (const m of modelosRes.rows) {
        const key = normTipo(m.tipo);
        (byTipo[key] = byTipo[key] || []).push({ id: m.modelo_id, name: m.nombre_modelo });
      }
      return res.status(200).render('registro/index', { title: 'Registro de Items', error: 'Error registrando items', modelosByTipo: byTipo, rfids: [], selectedModelo: modeloIdNum });
    }
  },
  validate: async (req: Request, res: Response) => {
    try {
      const tenant = (req as any).user?.tenant || resolveTenant(req);
      if (!tenant) return res.json({ dups: [] });
      const sedeId = getRequestSedeId(req);
      const body = req.body as any;
      const rawList: string[] = Array.isArray(body.rfids)
        ? body.rfids
        : (body.rfids && typeof body.rfids === 'object')
          ? Object.values(body.rfids)
          : [];
      const rfids = Array.from(new Set(rawList.map((r: any) => String(r || '').trim()).filter((r: string) => r.length === 24)));
      if (rfids.length === 0) return res.json({ dups: [] });
      let sql = 'SELECT rfid FROM inventario_credocubes WHERE rfid = ANY($1::text[])';
      const params: any[] = [rfids];
      if (sedeId !== null) {
        params.push(sedeId);
        sql += ' AND (sede_id = $2 OR sede_id IS NULL)';
      }
      const found = await withTenant(String(tenant).startsWith('tenant_') ? String(tenant) : `tenant_${tenant}`, (c) => c.query<{ rfid: string }>(sql, params));
      return res.json({ dups: found.rows.map((r) => r.rfid) });
    } catch (e) {
      return res.json({ dups: [] });
    }
  },
};
