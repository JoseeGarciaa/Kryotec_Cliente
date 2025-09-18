import { Request, Response } from 'express';
import { resolveTenant } from '../middleware/tenant';
import { withTenant } from '../db/pool';
import { AuditoriaModel } from '../models/Auditoria';

export const AuditoriaController = {
  async listView(req: Request, res: Response) {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const tRaw = u?.tenant || resolveTenant(req);
    const t = tRaw || process.env.DEFAULT_TENANT || null;
    const tenantSchema = t ? (String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`) : null;
    const page = Number(req.query.page || 1) || 1;
    const limit = Math.min(100, Number(req.query.limit || 25) || 25);
    const q = (req.query.q ? String(req.query.q) : '').trim() || null;
    const auditadaParam = (req.query.auditada as string | undefined);
    const auditada = auditadaParam === 'true' ? true : auditadaParam === 'false' ? false : null;
    const fromDate = (req.query.from as string | undefined) || null;
    const toDate = (req.query.to as string | undefined) || null;

    if (!tenantSchema) return res.render('auditoria/index', { title: 'Auditoría', items: [], total: 0, page, limit, q, auditada, fromDate, toDate });

    try {
      const { items, total } = await withTenant(tenantSchema, (client) => AuditoriaModel.list(client, { page, limit, q, auditada, fromDate, toDate }));
      return res.render('auditoria/index', { title: 'Auditoría', items, total, page, limit, q, auditada, fromDate, toDate });
    } catch (e) {
      console.error('[auditoria][listView] error:', e);
      return res.status(500).render('auditoria/index', { title: 'Auditoría', items: [], total: 0, page, limit, q, auditada, fromDate, toDate, error: 'Error al cargar auditorías' });
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
};
