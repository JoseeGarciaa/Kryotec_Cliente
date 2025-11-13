import { Request, Response } from 'express';
import { withTenant } from '../db/pool';
import { getRequestSedeId } from '../utils/sede';
import { resolveTenant } from '../middleware/tenant';
import {
  allowSedeTransferFromValue,
  ensureCrossSedeAuthorization,
  runWithSede,
} from './operacionController';

export const TrasladoController = {
  index: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant || resolveTenant(req);
    let sedes: Array<{ sede_id: number; nombre: string | null }> = [];
    if (tenant) {
      try {
        const result = await withTenant(tenant, (client) =>
          client.query<{ sede_id: number; nombre: string | null }>(
            `SELECT sede_id, nombre
               FROM sedes
           ORDER BY nombre NULLS LAST, sede_id`
          )
        );
        sedes = result.rows;
      } catch (err) {
        console.error('[TrasladoController.index] sedes fetch failed', err);
      }
    }
    res.render('traslado/index', {
      title: 'Traslado entre sedes',
      sedes,
    });
  },

  apply: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);

    if (!tenant) {
      return res.status(400).json({ ok: false, error: 'Sesión inválida: tenant no disponible.' });
    }
    const modeRaw = typeof req.body?.mode === 'string' ? req.body.mode : '';
    const mode = modeRaw === 'to_destination' ? 'to_destination' : 'to_current';

    let targetSedeIdForTransit: number | null = null;
    let targetSedeNombre: string | null = null;

    if (mode === 'to_destination') {
      const targetIdRaw = Number(req.body?.targetSedeId);
      if (!Number.isFinite(targetIdRaw) || targetIdRaw <= 0) {
        return res.status(400).json({ ok: false, error: 'Selecciona una sede destino válida.' });
      }
      try {
        const lookup = await withTenant(tenant, (client) =>
          client.query<{ sede_id: number; nombre: string | null }>(
            `SELECT sede_id, nombre FROM sedes WHERE sede_id = $1 LIMIT 1`,
            [targetIdRaw]
          )
        );
        if (!lookup.rowCount) {
          return res.status(404).json({ ok: false, error: 'Sede destino no encontrada.' });
        }
        targetSedeIdForTransit = lookup.rows[0].sede_id;
        const nombreRaw = lookup.rows[0].nombre || null;
        targetSedeNombre = nombreRaw && nombreRaw.trim() ? nombreRaw.trim() : `Sede ${targetSedeIdForTransit}`;
      } catch (err) {
        console.error('[TrasladoController.apply] target sede lookup failed', err);
        return res.status(500).json({ ok: false, error: 'No se pudo validar la sede destino.' });
      }
    } else if (sedeId === null) {
      return res.status(400).json({ ok: false, error: 'El usuario no tiene una sede asignada.' });
    }

    const rawInput = (() => {
      const list = req.body?.rfids;
      if (Array.isArray(list)) return list;
      if (typeof list === 'string') return list.split(/[\s,;]+/);
      if (typeof req.body?.codes === 'string') return req.body.codes.split(/[\s,;]+/);
      return [];
    })();

    const seen = new Set<string>();
    const duplicates: string[] = [];
    const rfids: string[] = [];
    for (const item of rawInput) {
      const normalized = String(item || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (normalized.length !== 24) continue;
      if (seen.has(normalized)) {
        duplicates.push(normalized);
        continue;
      }
      seen.add(normalized);
      rfids.push(normalized);
      if (rfids.length >= 300) break;
    }

    if (!rfids.length) {
      return res.status(400).json({ ok: false, error: 'Proporciona al menos un RFID válido (24 caracteres).' });
    }

    const infoQ = await withTenant(tenant, (c) =>
      c.query(
        `SELECT DISTINCT ON (ic.rfid)
                ic.rfid, ic.estado, ic.sub_estado, ic.sede_id, ic.lote, ic.numero_orden,
                ic.zona_id, ic.seccion_id, aci.caja_id
           FROM inventario_credocubes ic
           LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid
          WHERE ic.rfid = ANY($1::text[])
          ORDER BY ic.rfid, aci.caja_id NULLS LAST`,
        [rfids]
      )
    );
    const infoMap = new Map<string, any>();
    for (const row of infoQ.rows as any[]) {
      if (!infoMap.has(row.rfid)) infoMap.set(row.rfid, row);
    }

    const notFound = rfids.filter((code) => !infoMap.has(code));

    if (infoMap.size === 0) {
      return res.json({ ok: true, mode, moved: [], already: [], not_found: notFound, duplicates });
    }

    let toCurrentSedeTarget: number | null = null;
    let allowCrossTransfer = false;
    let transferCheck:
      | Awaited<ReturnType<typeof ensureCrossSedeAuthorization>>
      | null = null;

    if (mode === 'to_current') {
      const allowFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
      const transferRows = Array.from(infoMap.values()).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
      transferCheck = await ensureCrossSedeAuthorization(req, res, transferRows, sedeId, allowFlag, {
        fallbackRfids: rfids,
        customMessage: 'Una o más piezas pertenecen a otra sede. ¿Deseas trasladarlas a tu sede actual?',
      });
      if (transferCheck.blocked) return;

      toCurrentSedeTarget = transferCheck.targetSede;
      if (toCurrentSedeTarget === null) {
        return res.status(400).json({ ok: false, error: 'No se pudo determinar la sede destino para el traslado.' });
      }
      allowCrossTransfer = transferCheck.allowCrossTransfer;
    } else {
      allowCrossTransfer = true;
    }

    const toUpdate: any[] = [];
    const already: any[] = [];
    infoMap.forEach((row) => {
      const currentEstado = typeof row.estado === 'string' ? row.estado.trim() : '';
      const currentSubEstado = typeof row.sub_estado === 'string' ? row.sub_estado.trim() : '';
      const hasSubEstado = row.sub_estado != null && String(row.sub_estado).trim() !== '';
      const hasLote = row.lote != null && String(row.lote).trim() !== '';
      const hasOrden = row.numero_orden != null && String(row.numero_orden).trim() !== '';
      const hasZona = row.zona_id != null;
      const hasSeccion = row.seccion_id != null;
      const belongsToCaja = row.caja_id != null;
      let requiresChange = true;
      if (mode === 'to_current') {
        requiresChange =
          row.sede_id !== toCurrentSedeTarget ||
          currentEstado !== 'En bodega' ||
          hasSubEstado ||
          hasLote ||
          hasOrden ||
          hasZona ||
          hasSeccion ||
          belongsToCaja;
      } else {
        const targetMatch =
          currentEstado.toLowerCase() === 'en traslado' &&
          targetSedeNombre && currentSubEstado.toLowerCase() === targetSedeNombre.toLowerCase();
        requiresChange = !targetMatch;
      }
      const snapshot = {
        rfid: row.rfid,
        prev_estado: row.estado,
        prev_sub_estado: row.sub_estado,
        prev_sede_id: row.sede_id,
        prev_lote: row.lote,
        prev_numero_orden: row.numero_orden,
        prev_zona_id: row.zona_id,
        prev_seccion_id: row.seccion_id,
        prev_caja_id: row.caja_id ?? null,
        next_estado: mode === 'to_destination' ? 'En traslado' : 'En bodega',
        next_sub_estado: mode === 'to_destination' ? targetSedeNombre : null,
        target_sede_id: mode === 'to_destination' ? targetSedeIdForTransit : toCurrentSedeTarget,
        target_sede_nombre: mode === 'to_destination' ? targetSedeNombre : null,
      };
      if (requiresChange) {
        toUpdate.push(snapshot);
      } else {
        already.push(snapshot);
      }
    });

    if (toUpdate.length) {
      const rfidsToUpdate = toUpdate.map((row) => row.rfid);
      const nextSedeId = mode === 'to_destination' ? targetSedeIdForTransit : toCurrentSedeTarget;
      await runWithSede(
        tenant,
        sedeId,
        async (c) => {
          await c.query('BEGIN');
          try {
            await c.query(`DELETE FROM acond_caja_items WHERE rfid = ANY($1::text[])`, [rfidsToUpdate]);
            if (mode === 'to_destination') {
              await c.query(
                `UPDATE inventario_credocubes ic
                    SET estado='En traslado',
                        sub_estado=$3,
                        sede_id = $2,
                        lote=NULL,
                        numero_orden=NULL,
                        zona_id=NULL,
                        seccion_id=NULL
                  WHERE ic.rfid = ANY($1::text[])`,
                [rfidsToUpdate, nextSedeId, targetSedeNombre]
              );
            } else {
              await c.query(
                `UPDATE inventario_credocubes ic
                    SET estado='En bodega',
                        sub_estado=NULL,
                        sede_id = $2,
                        lote=NULL,
                        numero_orden=NULL,
                        zona_id=NULL,
                        seccion_id=NULL
                  WHERE ic.rfid = ANY($1::text[])`,
                [rfidsToUpdate, nextSedeId]
              );
            }
            await c.query('COMMIT');
          } catch (err) {
            await c.query('ROLLBACK');
            throw err;
          }
        },
        { allowCrossSedeTransfer: allowCrossTransfer }
      );
    }

    res.json({
      ok: true,
      mode,
      moved: toUpdate,
      already,
      not_found: notFound,
      duplicates,
      target:
        mode === 'to_destination'
          ? { id: targetSedeIdForTransit, nombre: targetSedeNombre }
          : { id: toCurrentSedeTarget, nombre: null },
    });
  },
};
