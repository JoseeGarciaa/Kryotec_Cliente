import { Request, Response } from 'express';
import { resolveTenant } from '../middleware/tenant';
import { withTenant } from '../db/pool';
import { AuditoriaModel, AuditoriaExtras } from '../models/Auditoria';

export const AuditoriaController = {
  async listView(req: Request, res: Response) {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const tRaw = u?.tenant || resolveTenant(req);
    const t = tRaw || process.env.DEFAULT_TENANT || null;
    const tenantSchema = t ? (String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`) : null;
    const q = (req.query.q ? String(req.query.q) : '').trim() || '';
    const page = Number(req.query.page || 1) || 1;
    const limit = Math.min(100, Number(req.query.limit || 25) || 25);
    if (!tenantSchema) return res.render('auditoria/index', { title: 'Auditoría', item: null, audit: null, error: null, items: [], total: 0, page, limit });

    try {
      const data = await withTenant(tenantSchema, async (client) => {
        // Optional RFID selection
        let selected: { item: any, audit: any } = { item: null, audit: null };
        if (q && q.length >= 8) {
          const inv = await AuditoriaExtras.searchInventario(client, q, 1);
          const item = inv[0] || null;
          if (item) {
            await AuditoriaModel.ensureTable(client);
            const existing = await client.query<{ id:number, auditada:boolean, comentarios:string|null }>(
              `SELECT id, auditada, comentarios FROM auditorias_credocubes WHERE inventario_id=$1 ORDER BY fecha DESC LIMIT 1`, [item.id]
            );
            const audit = existing.rows[0] || null;
            selected = { item, audit };
          }
        }
        // Listing for table (unfiltered by q)
        const { items, total } = await AuditoriaModel.list(client, { page, limit, q: null, auditada: null, fromDate: null, toDate: null });
        return { ...selected, items, total };
      });
      return res.render('auditoria/index', { title: 'Auditoría', ...data, error: null, page, limit });
    } catch (e) {
      console.error('[auditoria][listView] error:', e);
      return res.render('auditoria/index', { title: 'Auditoría', item: null, audit: null, error: 'Error al cargar auditorías', items: [], total: 0, page, limit });
    }
  },

  async markAudited(req: Request, res: Response) {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const tRaw = u?.tenant || resolveTenant(req);
    const t = tRaw || process.env.DEFAULT_TENANT || null;
    const tenantSchema = t ? (String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`) : null;
    const id = Number(req.params.id || 0);
    const auditada = String((req.body as any)?.auditada || 'true') === 'true';
    const comentarios = ((req.body as any)?.comentarios || '').toString().slice(0, 2000) || null;
    if (!tenantSchema || !id) return res.redirect('/auditoria');
    try {
      await withTenant(tenantSchema, (client) => AuditoriaModel.markAudited(client, id, auditada, comentarios));
      return res.redirect('/auditoria');
    } catch (e) {
      console.error('[auditoria][markAudited] error:', e);
      return res.redirect('/auditoria');
    }
  }
  ,
  async update(req: Request, res: Response) {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const tRaw = u?.tenant || resolveTenant(req);
    const t = tRaw || process.env.DEFAULT_TENANT || null;
    const tenantSchema = t ? (String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`) : null;
    const id = Number(req.params.id || 0);
    const comentarios = ((req.body as any)?.comentarios || '').toString().slice(0, 2000) || null;
    const auditadaRaw = (req.body as any)?.auditada;
    const auditada = typeof auditadaRaw === 'string' ? (auditadaRaw === 'true') : (typeof auditadaRaw === 'boolean' ? auditadaRaw : undefined);
    if (!tenantSchema || !id) return res.redirect('/auditoria');
    try {
      await withTenant(tenantSchema, (client) => AuditoriaModel.update(client, id, { comentarios, auditada }));
      return res.redirect('/auditoria');
    } catch (e) {
      console.error('[auditoria][update] error:', e);
      return res.redirect('/auditoria');
    }
  }
  ,
  async remove(req: Request, res: Response) {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const tRaw = u?.tenant || resolveTenant(req);
    const t = tRaw || process.env.DEFAULT_TENANT || null;
    const tenantSchema = t ? (String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`) : null;
    const id = Number(req.params.id || 0);
    if (!tenantSchema || !id) return res.redirect('/auditoria');
    try {
      await withTenant(tenantSchema, (client) => AuditoriaModel.remove(client, id));
      return res.redirect('/auditoria');
    } catch (e) {
      console.error('[auditoria][remove] error:', e);
      return res.redirect('/auditoria');
    }
  }
  ,
  async searchInventario(req: Request, res: Response) {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const tRaw = u?.tenant || resolveTenant(req);
    const t = tRaw || process.env.DEFAULT_TENANT || null;
    const tenantSchema = t ? (String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`) : null;
    const q = (req.query.q ? String(req.query.q) : '').trim();
    if (!tenantSchema) return res.json([]);
    try {
      const items = await withTenant(tenantSchema, (client) => AuditoriaExtras.searchInventario(client, q, 25));
      return res.json(items);
    } catch (e) {
      console.error('[auditoria][searchInventario] error:', e);
      return res.status(500).json([]);
    }
  }
  ,
  async auditByRfid(req: Request, res: Response) {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const tRaw = u?.tenant || resolveTenant(req);
    const t = tRaw || process.env.DEFAULT_TENANT || null;
    const tenantSchema = t ? (String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`) : null;
    const rfid = String((req.body as any)?.rfid || '').trim();
    const auditada = String((req.body as any)?.auditada || 'true') === 'true';
    const comentarios = ((req.body as any)?.comentarios || '').toString().slice(0, 2000) || null;
    if (!tenantSchema || rfid.length < 8) return res.redirect('/auditoria');
    try {
      await withTenant(tenantSchema, async (client) => {
        await client.query('BEGIN');
        try {
          const row = await client.query<{ id:number }>(`SELECT id FROM inventario_credocubes WHERE rfid=$1 LIMIT 1`, [rfid]);
          if (!row.rowCount) { await client.query('ROLLBACK'); return; }
          const inventarioId = row.rows[0].id;
          await AuditoriaExtras.create(client, { inventarioId, comentarios, auditada });
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; }
      });
    } catch (e) {
      console.error('[auditoria][auditByRfid] error:', e);
    }
    return res.redirect('/auditoria?q='+encodeURIComponent(rfid));
  }
  ,
  async create(req: Request, res: Response) {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const tRaw = u?.tenant || resolveTenant(req);
    const t = tRaw || process.env.DEFAULT_TENANT || null;
    const tenantSchema = t ? (String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`) : null;
    const inventarioId = Number((req.body as any)?.inventarioId || 0);
    const comentarios = ((req.body as any)?.comentarios || '').toString().slice(0, 2000) || null;
    if (!tenantSchema || !inventarioId) return res.redirect('/auditoria');
    try {
      await withTenant(tenantSchema, (client) => AuditoriaExtras.create(client, { inventarioId, comentarios }));
      return res.redirect('/auditoria');
    } catch (e) {
      console.error('[auditoria][create] error:', e);
      return res.redirect('/auditoria');
    }
  }
  ,
  async inhabilitar(req: Request, res: Response) {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const tRaw = u?.tenant || resolveTenant(req);
    const t = tRaw || process.env.DEFAULT_TENANT || null;
    const tenantSchema = t ? (String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`) : null;
    const { rfid, motivo, descripcion, severidad } = (req.body as any) || {};
    const code = typeof rfid === 'string' ? rfid.trim() : '';
    const mot = typeof motivo === 'string' ? motivo.trim() : '';
    const desc = typeof descripcion === 'string' ? descripcion.trim() : null;
    const sv = Number(severidad); const sev = Number.isFinite(sv) ? Math.min(5, Math.max(1, sv)) : 3;
    if (!tenantSchema || code.length !== 24 || !mot) return res.redirect('/auditoria');
    try {
      await withTenant(tenantSchema, async (client) => {
        await client.query('BEGIN');
        try {
          const itemQ = await client.query<{ id:number }>(`SELECT id FROM inventario_credocubes WHERE rfid=$1 LIMIT 1`, [code]);
          if(!itemQ.rowCount){ await client.query('ROLLBACK'); return; }
          const piezaId = itemQ.rows[0].id;
          // Asegurar tabla novedades
          await client.query(`CREATE TABLE IF NOT EXISTS inspeccion_novedades (
            novedad_id serial PRIMARY KEY,
            pieza_id integer NOT NULL,
            rfid text,
            tipo text NOT NULL DEFAULT 'otro',
            motivo text NOT NULL,
            descripcion text,
            severidad smallint NOT NULL DEFAULT 3 CHECK (severidad BETWEEN 1 AND 5),
            inhabilita boolean NOT NULL DEFAULT true,
            estado text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada')),
            creado_por text,
            creado_en timestamptz NOT NULL DEFAULT NOW(),
            actualizado_en timestamptz NOT NULL DEFAULT NOW(),
            cerrado_en timestamptz
          )`);
          const nov = await client.query<{ novedad_id:number }>(
            `INSERT INTO inspeccion_novedades (pieza_id, rfid, tipo, motivo, descripcion, severidad, inhabilita, creado_por)
             VALUES ($1,$2,'otro',$3,$4,$5,true,$6)
             RETURNING novedad_id`,
            [piezaId, code, mot, desc, sev, (u.email||u.name||u.id||'sistema')]
          );
          const novId = nov.rows[0]?.novedad_id || null;
          await AuditoriaModel.ensureTable(client);
          await client.query(`INSERT INTO auditorias_credocubes (inventario_id, novedad_id, comentarios, auditada)
                              VALUES ($1,$2,$3,false)`, [piezaId, novId, 'Inhabilitada desde Auditoría']);
          await client.query(`UPDATE inventario_credocubes SET estado='Inhabilitado', sub_estado=NULL, activo=false, lote=NULL WHERE id=$1`, [piezaId]);
          await client.query('COMMIT');
        } catch(e){ await client.query('ROLLBACK'); throw e; }
      });
    } catch(e) {
      console.error('[auditoria][inhabilitar] error:', e);
    }
    return res.redirect('/auditoria');
  }
};
