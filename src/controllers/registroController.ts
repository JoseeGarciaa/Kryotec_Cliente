import { Request, Response } from 'express';
import { withTenant } from '../db/pool';

type ModeloRow = { modelo_id: number; nombre_modelo: string };

function categorize(nombre: string): 'TIC' | 'VIP' | 'Cubes' | 'Otros' {
  const n = nombre.toLowerCase();
  if (n.includes('tic')) return 'TIC';
  if (n.includes('vip')) return 'VIP';
  if (n.includes('cube') || n.includes('cubo')) return 'Cubes';
  return 'Otros';
}

export const RegistroController = {
  index: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const modelosRes = await withTenant(tenant, (c) => c.query<ModeloRow>('SELECT modelo_id, nombre_modelo FROM modelos ORDER BY nombre_modelo'));
    const modelos = modelosRes.rows;

    // Build a simple data structure { category: [{id, name}, ...] }
    const byCat: Record<string, Array<{ id: number; name: string }>> = { TIC: [], VIP: [], Cubes: [], Otros: [] };
    for (const m of modelos) {
      const cat = categorize(m.nombre_modelo);
      byCat[cat].push({ id: m.modelo_id, name: m.nombre_modelo });
    }

    res.render('registro/index', {
      title: 'Registro de Items',
      modelosByCat: byCat,
    });
  },

  create: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { modelo_id, rfids } = req.body as { modelo_id: number; rfids: string[] };
    if (!modelo_id || !Array.isArray(rfids) || rfids.length === 0) {
      return res.status(400).render('registro/index', { title: 'Registro de Items', error: 'Complete tipo, litraje y escanee al menos un RFID', modelosByCat: {} });
    }

    try {
      await withTenant(tenant, async (c) => {
        // Simple bulk insert; defaults chosen for the new record
        for (const raw of rfids) {
          const rfid = String(raw || '').trim();
          if (!rfid) continue;
          await c.query(
            `INSERT INTO inventario_credocubes (modelo_id, nombre_unidad, rfid, lote, estado, sub_estado)
             VALUES ($1, (SELECT nombre_modelo FROM modelos WHERE modelo_id=$1), $2, NULL, 'Pre-acondicionamiento', NULL)`,
            [modelo_id, rfid]
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
