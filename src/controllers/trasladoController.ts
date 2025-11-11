import { Request, Response } from 'express';
import { withTenant } from '../db/pool';
import { getRequestSedeId } from '../utils/sede';
import {
  allowSedeTransferFromValue,
  ensureCrossSedeAuthorization,
  runWithSede,
} from './operacionController';

export const TrasladoController = {
  index: (_req: Request, res: Response) =>
    res.render('traslado/index', { title: 'Traslado entre sedes' }),

  apply: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);

    if (!tenant) {
      return res.status(400).json({ ok: false, error: 'Sesión inválida: tenant no disponible.' });
    }
    if (sedeId === null) {
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
      return res.json({ ok: true, moved: [], already: [], not_found: notFound, duplicates });
    }

    const allowFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    const transferRows = Array.from(infoMap.values()).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
    const transferCheck = await ensureCrossSedeAuthorization(req, res, transferRows, sedeId, allowFlag, {
      fallbackRfids: rfids,
      customMessage: 'Una o más piezas pertenecen a otra sede. ¿Deseas trasladarlas a tu sede actual?',
    });
    if (transferCheck.blocked) return;

    const targetSede = transferCheck.targetSede;
    if (targetSede === null) {
      return res.status(400).json({ ok: false, error: 'No se pudo determinar la sede destino para el traslado.' });
    }

    const toUpdate: any[] = [];
    const already: any[] = [];
    infoMap.forEach((row) => {
      const hasSubEstado = row.sub_estado != null && String(row.sub_estado).trim() !== '';
      const hasLote = row.lote != null && String(row.lote).trim() !== '';
      const hasOrden = row.numero_orden != null && String(row.numero_orden).trim() !== '';
      const hasZona = row.zona_id != null;
      const hasSeccion = row.seccion_id != null;
      const belongsToCaja = row.caja_id != null;
      const requiresChange =
        row.sede_id !== targetSede ||
        row.estado !== 'En bodega' ||
        hasSubEstado ||
        hasLote ||
        hasOrden ||
        hasZona ||
        hasSeccion ||
        belongsToCaja;
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
      };
      if (requiresChange) {
        toUpdate.push(snapshot);
      } else {
        already.push(snapshot);
      }
    });

    if (toUpdate.length) {
      const rfidsToUpdate = toUpdate.map((row) => row.rfid);
      await runWithSede(
        tenant,
        sedeId,
        async (c) => {
          await c.query('BEGIN');
          try {
            await c.query(`DELETE FROM acond_caja_items WHERE rfid = ANY($1::text[])`, [rfidsToUpdate]);
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
              [rfidsToUpdate, targetSede]
            );
            await c.query('COMMIT');
          } catch (err) {
            await c.query('ROLLBACK');
            throw err;
          }
        },
        { allowCrossSedeTransfer: transferCheck.allowCrossTransfer }
      );
    }

    res.json({ ok: true, moved: toUpdate, already, not_found: notFound, duplicates });
  },
};
