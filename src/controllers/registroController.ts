import { Request, Response } from 'express';
import { withTenant } from '../db/pool';
import { AlertsModel } from '../models/Alerts';
import { resolveTenant } from '../middleware/tenant';
import { getRequestSedeId } from '../utils/sede';
import { SedesModel } from '../models/Sede';
import { findRfidStatusesAcrossTenants } from '../utils/globalInventory';

type ModeloRow = { modelo_id: number; nombre_modelo: string; tipo: string | null };

function normTipo(tipo: string | null): 'TIC' | 'VIP' | 'Cube' | 'Otros' {
  const t = (tipo || '').toLowerCase();
  if (t.startsWith('tic')) return 'TIC';
  if (t.startsWith('vip')) return 'VIP';
  if (t.startsWith('cube') || t.startsWith('cubo')) return 'Cube';
  return 'Otros';
}

async function loadModelosByTipo(tenant: string): Promise<Record<string, Array<{ id: number; name: string }>>> {
  const modelosRes = await withTenant(tenant, (c) => c.query<ModeloRow>('SELECT modelo_id, nombre_modelo, tipo FROM modelos ORDER BY nombre_modelo'));
  const modelos = modelosRes.rows;
  const byTipo: Record<string, Array<{ id: number; name: string }>> = { TIC: [], VIP: [], Cube: [], Otros: [] } as any;
  for (const m of modelos) {
    const key = normTipo(m.tipo);
    (byTipo[key] = byTipo[key] || []).push({ id: m.modelo_id, name: m.nombre_modelo });
  }
  return byTipo;
}

export const RegistroController = {
  index: async (req: Request, res: Response) => {
  const t = (req as any).user?.tenant || resolveTenant(req);
  if (!t) return res.status(400).send('Tenant no especificado');
  const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
  const modelosByTipo = await loadModelosByTipo(tenant);

    res.render('registro/index', {
      title: 'Registro de Items',
      modelosByTipo,
      dups: [],
      foreignConflicts: [],
      globalConflicts: [],
      rfids: [],
      selectedModelo: null,
      selectedTipo: '',
    });
  },

  create: async (req: Request, res: Response) => {
  const t = (req as any).user?.tenant || resolveTenant(req);
  if (!t) return res.status(400).send('Tenant no especificado');
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const tenantKey = String(tenant).startsWith('tenant_') ? String(tenant) : `tenant_${tenant}`;
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
    const modelosByTipo = await loadModelosByTipo(tenant);

    if (!modeloIdNum || rfidsArr.length === 0) {
        return res.status(200).render('registro/index', { title: 'Registro de Items', error: 'Complete tipo, litraje y escanee al menos un RFID', modelosByTipo, rfids: rfidsArr, selectedModelo: modeloIdNum, dups: [], foreignConflicts: [], globalConflicts: [] });
    }

    try {
      const result = await withTenant(tenant, async (c) => {
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
        const selectedTipo = normTipo(meta.rows[0].tipo) as string;

        const existingQ = await c.query<{ rfid: string; sede_id: number | null; sede_nombre: string | null }>(
          `SELECT ic.rfid, ic.sede_id, s.nombre AS sede_nombre
             FROM inventario_credocubes ic
        LEFT JOIN sedes s ON s.sede_id = ic.sede_id
            WHERE ic.rfid = ANY($1::text[])`,
          [rfidsArr]
        );
        const globalStatuses = await findRfidStatusesAcrossTenants(rfidsArr, tenantKey);
        const existingMap = new Map(existingQ.rows.map((row) => [row.rfid, row]));
        const foreignConflicts: Array<{ rfid: string; sedeNombre: string | null }> = [];
        const duplicateRfids: string[] = [];
        const globalConflicts: Array<{ rfid: string; tenant: string; estado: string | null }> = [];
        for (const row of existingQ.rows) {
          const rfid = (row.rfid || '').toUpperCase();
          if (rfid.length !== 24) continue;
          if (sedeId !== null && row.sede_id !== null && row.sede_id !== sedeId) {
            foreignConflicts.push({ rfid, sedeNombre: row.sede_nombre || null });
          } else {
            duplicateRfids.push(rfid);
          }
        }

        // Asegurar índice único para ON CONFLICT (rfid)
        await c.query(`DO $$
        BEGIN
          BEGIN
            EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS inventario_credocubes_rfid_key ON inventario_credocubes(rfid)';
          EXCEPTION WHEN others THEN
          END;
        END$$;`);

        let insertedCount = 0;
        for (const rfid of rfidsArr) {
          if (existingMap.has(rfid)) continue;
          const conflicts = globalStatuses[rfid] || [];
          const activeConflict = conflicts.find((c) => c.activo !== false);
          if (activeConflict) {
            globalConflicts.push({ rfid, tenant: activeConflict.tenant, estado: activeConflict.estado || null });
            continue;
          }
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

        return { insertedCount, selectedTipo, foreignConflicts, duplicateRfids, globalConflicts };
      });

      if (result.insertedCount > 0) {
        const desc = `${result.insertedCount} item${result.insertedCount>1 ? 's' : ''} registrado${result.insertedCount>1 ? 's' : ''} (${result.selectedTipo})`;
        await withTenant(tenant, (c) => AlertsModel.create(c, { tipo_alerta: 'inventario:registro', descripcion: desc }));
      }

      const successMessage = result.insertedCount > 0
        ? `${result.insertedCount} item${result.insertedCount>1 ? 's' : ''} registrado${result.insertedCount>1 ? 's' : ''} correctamente.`
        : '';

      const hasConflicts = result.foreignConflicts.length > 0 || result.duplicateRfids.length > 0 || result.globalConflicts.length > 0;
      const errorMessage = !result.insertedCount && hasConflicts
        ? 'No se registraron items. Revisa los avisos de duplicados, piezas asignadas a otra sede o activos en otro tenant.'
        : '';

      return res.status(200).render('registro/index', {
        title: 'Registro de Items',
        modelosByTipo,
        success: successMessage,
        error: errorMessage,
        dups: result.duplicateRfids,
        foreignConflicts: result.foreignConflicts,
        globalConflicts: result.globalConflicts,
        rfids: [],
        selectedModelo: modeloIdNum,
        selectedTipo: result.selectedTipo,
      });
    } catch (e: any) {
      console.error(e);
      // Fallback: mostrar mensaje amable sin bloquear si algo menor falló
      return res.status(200).render('registro/index', { title: 'Registro de Items', error: 'Error registrando items', modelosByTipo, rfids: [], selectedModelo: modeloIdNum, dups: [], foreignConflicts: [], globalConflicts: [] });
    }
  },
  validate: async (req: Request, res: Response) => {
    try {
      const tenant = (req as any).user?.tenant || resolveTenant(req);
      if (!tenant) return res.json({ dups: [], foreign: [], global: [] });
      const tenantKey = String(tenant).startsWith('tenant_') ? String(tenant) : `tenant_${tenant}`;
      const sedeId = getRequestSedeId(req);
      const body = req.body as any;
      const rawList: string[] = Array.isArray(body.rfids)
        ? body.rfids
        : (body.rfids && typeof body.rfids === 'object')
          ? Object.values(body.rfids)
          : [];
      const rfids = Array.from(new Set(rawList.map((r: any) => String(r || '').trim().toUpperCase()).filter((r: string) => r.length === 24)));
      if (rfids.length === 0) return res.json({ dups: [], foreign: [] });

      const found = await withTenant(tenantKey, (c) => c.query<{ rfid: string; sede_id: number | null; sede_nombre: string | null }>(
        `SELECT ic.rfid, ic.sede_id, s.nombre AS sede_nombre
           FROM inventario_credocubes ic
      LEFT JOIN sedes s ON s.sede_id = ic.sede_id
          WHERE ic.rfid = ANY($1::text[])`,
        [rfids]
      ));
      const globalStatuses = await findRfidStatusesAcrossTenants(rfids, tenantKey);

      const duplicates: string[] = [];
      const foreign: Array<{ rfid: string; sede_nombre: string | null }> = [];
      const globalConflicts: Array<{ rfid: string; tenant: string; estado: string | null }> = [];
      for (const row of found.rows) {
        const rfid = (row.rfid || '').toUpperCase();
        if (rfid.length !== 24) continue;
        if (sedeId !== null && row.sede_id !== null && row.sede_id !== sedeId) {
          foreign.push({ rfid, sede_nombre: row.sede_nombre || null });
        } else {
          duplicates.push(rfid);
        }
      }
      for (const rfid of rfids) {
        const conflicts = globalStatuses[rfid] || [];
        const activeConflict = conflicts.find((c) => c.activo !== false);
        if (activeConflict) {
          globalConflicts.push({ rfid, tenant: activeConflict.tenant, estado: activeConflict.estado || null });
        }
      }
      return res.json({ dups: duplicates, foreign, global: globalConflicts });
    } catch (e) {
      return res.json({ dups: [], foreign: [], global: [] });
    }
  },
};
