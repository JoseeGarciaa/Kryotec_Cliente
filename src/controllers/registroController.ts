import { Request, Response } from 'express';
import { withTenant } from '../db/pool';

type ModeloRow = { modelo_id: number; nombre_modelo: string; tipo: string | null };

function normCat(tipo: string | null): 'TIC' | 'VIP' | 'Cubes' | 'Otros' {
  const t = (tipo || '').toLowerCase();
  if (t.startsWith('tic')) return 'TIC';
  if (t.startsWith('vip')) return 'VIP';
  if (t.startsWith('cube') || t.startsWith('cubo')) return 'Cubes';
  return 'Otros';
}

export const RegistroController = {
  index: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
  const modelosRes = await withTenant(tenant, (c) => c.query<ModeloRow>('SELECT modelo_id, nombre_modelo, tipo FROM modelos ORDER BY nombre_modelo'));
    const modelos = modelosRes.rows;

    // Build a simple data structure { category: [{id, name}, ...] }
    const byCat: Record<string, Array<{ id: number; name: string }>> = { TIC: [], VIP: [], Cubes: [], Otros: [] };
    for (const m of modelos) {
      const cat = normCat(m.tipo);
      byCat[cat].push({ id: m.modelo_id, name: m.nombre_modelo });
    }

    res.render('registro/index', {
      title: 'Registro de Items',
      modelosByCat: byCat,
    });
  },

  create: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { modelo_id, rfids, lote } = req.body as any;
    const modeloIdNum = Number(modelo_id);
    const rfidsArr: string[] = Array.isArray(rfids) ? rfids : [];
    if (!modeloIdNum || rfidsArr.length === 0) {
      return res.status(400).render('registro/index', { title: 'Registro de Items', error: 'Complete tipo, litraje y escanee al menos un RFID', modelosByCat: {} });
    }

    try {
      await withTenant(tenant, async (c) => {
        const meta = await c.query<{ nombre_modelo: string; tipo: string | null }>(
          'SELECT nombre_modelo, tipo FROM modelos WHERE modelo_id = $1',
          [modeloIdNum]
        );
        if (!meta.rowCount) throw new Error('Modelo no encontrado');
        const nombre = meta.rows[0].nombre_modelo;
        const categoria = meta.rows[0].tipo || null;

        for (const raw of rfidsArr) {
          const rfid = String(raw || '').trim();
          if (!rfid || rfid.length !== 24) continue; // solo RFIDs de 24 caracteres
          await c.query(
            `INSERT INTO inventario_credocubes 
               (modelo_id, nombre_unidad, rfid, lote, estado, sub_estado, categoria, fecha_ingreso, fecha_vencimiento)
             VALUES ($1, $2, $3, $4, '', '', $5, NOW(), NOW() + INTERVAL '5 years')`,
            [modeloIdNum, nombre, rfid, lote || null, categoria]
          );
        }
      });
      return res.redirect('/inventario');
    } catch (e: any) {
      console.error(e);
      const msg = e?.code === '23505' ? 'Uno o más RFID ya existen' : 'Error registrando items';
      // Re-render with error; the view can recover using client-side state
      return res.status(400).render('registro/index', { title: 'Registro de Items', error: msg, modelosByCat: {} });
    }
  },
};
