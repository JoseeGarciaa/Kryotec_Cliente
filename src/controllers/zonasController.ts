import { URLSearchParams } from 'url';
import { Request, Response } from 'express';
import { withTenant } from '../db/pool';
import { SedesModel } from '../models/Sede';
import { ZonasModel } from '../models/Zona';
import { getRequestSedeId } from '../utils/sede';

function ensureTenant(req: Request): string | null {
  const tenant = (req as any)?.user?.tenant as string | undefined;
  return tenant ?? null;
}

function sanitizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    return ['true', '1', 'on', 'si'].includes(value.toLowerCase());
  }
  return undefined;
}

function redirectWithMessage(
  res: Response,
  baseUrl: string,
  message: { ok?: string; error?: string },
  extraQuery?: Record<string, string | number | null | undefined>,
) {
  const params = new URLSearchParams();
  if (message.ok) params.set('ok', message.ok);
  if (message.error) params.set('error', message.error);
  if (extraQuery) {
    for (const [key, value] of Object.entries(extraQuery)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  res.redirect(query ? `${baseUrl}?${query}` : baseUrl);
}

export const ZonasController = {
  async view(req: Request, res: Response) {
    const tenant = ensureTenant(req);
    if (!tenant) return res.status(400).send('Tenant no definido');

    const querySede = req.query.sede_id ? Number(req.query.sede_id) : null;

    try {
      const sedes = await withTenant(tenant, (client) => SedesModel.listAll(client));
      const selectedSedeId = querySede && Number.isFinite(querySede) ? querySede : sedes[0]?.sede_id ?? null;
      const zonas = selectedSedeId
        ? await withTenant(tenant, (client) => ZonasModel.listBySede(client, selectedSedeId))
        : [];

      res.render('administracion/zonas', {
        pageTitle: 'Zonas y secciones',
        sedes,
        zonas,
        selectedSedeId,
        flash: {
          ok: (req.query.ok as string) || null,
          error: (req.query.error as string) || null,
        },
      });
    } catch (err) {
      console.error('[zonas:view]', err);
      res.status(500).render('administracion/zonas', {
        pageTitle: 'Zonas y secciones',
        sedes: [],
        zonas: [],
        selectedSedeId: null,
        flash: {
          ok: null,
          error: 'No se pudieron cargar las zonas',
        },
      });
    }
  },

  async createZona(req: Request, res: Response) {
    const tenant = ensureTenant(req);
    if (!tenant) return res.status(400).send('Tenant no definido');

    const sedeId = Number(req.body.sede_id);
    const nombre = sanitizeName(req.body.nombre);
    if (!sedeId || !nombre) {
      return redirectWithMessage(res, '/administracion/zonas', { error: 'Selecciona la sede y el nombre de la zona' });
    }

    try {
      await withTenant(tenant, (client) => ZonasModel.createZona(client, {
        sede_id: sedeId,
        nombre,
        activa: parseBoolean(req.body.activa) ?? true,
      }));
      redirectWithMessage(res, '/administracion/zonas', { ok: 'Zona creada correctamente' }, { sede_id: sedeId });
    } catch (err) {
      console.error('[zonas:createZona]', err);
      redirectWithMessage(res, '/administracion/zonas', { error: 'No se pudo crear la zona' }, { sede_id: sedeId });
    }
  },

  async updateZona(req: Request, res: Response) {
    const tenant = ensureTenant(req);
    if (!tenant) return res.status(400).send('Tenant no definido');

    const zonaId = Number(req.params.zonaId);
    if (!zonaId) return redirectWithMessage(res, '/administracion/zonas', { error: 'Zona no válida' });

    try {
      const zona = await withTenant(tenant, (client) => ZonasModel.findZonaById(client, zonaId));
      if (!zona) {
        return redirectWithMessage(res, '/administracion/zonas', { error: 'Zona no encontrada' });
      }

      const nombre = sanitizeName(req.body.nombre);
      const activa = parseBoolean(req.body.activa);

      await withTenant(tenant, (client) => ZonasModel.updateZona(client, zonaId, {
        nombre: nombre || undefined,
        activa,
      }));

      redirectWithMessage(res, '/administracion/zonas', { ok: 'Zona actualizada' }, { sede_id: zona.sede_id });
    } catch (err) {
      console.error('[zonas:updateZona]', err);
      redirectWithMessage(res, '/administracion/zonas', { error: 'No se pudo actualizar la zona' });
    }
  },

  async deleteZona(req: Request, res: Response) {
    const tenant = ensureTenant(req);
    if (!tenant) return res.status(400).send('Tenant no definido');

    const zonaId = Number(req.params.zonaId);
    if (!zonaId) return redirectWithMessage(res, '/administracion/zonas', { error: 'Zona no válida' });

    try {
      const zona = await withTenant(tenant, (client) => ZonasModel.findZonaById(client, zonaId));
      if (!zona) {
        return redirectWithMessage(res, '/administracion/zonas', { error: 'Zona no encontrada' });
      }

      const removal = await withTenant(tenant, (client) => ZonasModel.removeZona(client, zonaId));
      if (!removal.removed) {
        let detail = 'La zona está en uso.';
        if (removal.secciones > 0) {
          detail = `La zona tiene ${removal.secciones} sección${removal.secciones === 1 ? '' : 'es'} asociada${removal.secciones === 1 ? '' : 's'}.`;
        } else if (removal.inventario > 0) {
          detail = `La zona tiene ${removal.inventario} elemento${removal.inventario === 1 ? '' : 's'} en inventario.`;
        }
        return redirectWithMessage(res, '/administracion/zonas', { error: `No se pudo eliminar la zona. ${detail}` }, { sede_id: zona.sede_id });
      }
      redirectWithMessage(res, '/administracion/zonas', { ok: 'Zona eliminada' }, { sede_id: zona.sede_id });
    } catch (err) {
      console.error('[zonas:deleteZona]', err);
      redirectWithMessage(res, '/administracion/zonas', { error: 'No se pudo eliminar la zona' });
    }
  },

  async createSeccion(req: Request, res: Response) {
    const tenant = ensureTenant(req);
    if (!tenant) return res.status(400).send('Tenant no definido');

    const zonaId = Number(req.params.zonaId);
    const nombre = sanitizeName(req.body.nombre);
    if (!zonaId || !nombre) {
      return redirectWithMessage(res, '/administracion/zonas', { error: 'Datos de sección incompletos' });
    }

    try {
      const zona = await withTenant(tenant, (client) => ZonasModel.findZonaById(client, zonaId));
      if (!zona) {
        return redirectWithMessage(res, '/administracion/zonas', { error: 'Zona no encontrada' });
      }

      await withTenant(tenant, (client) => ZonasModel.createSeccion(client, {
        zona_id: zonaId,
        nombre,
        activa: parseBoolean(req.body.activa) ?? true,
      }));

      redirectWithMessage(res, '/administracion/zonas', { ok: 'Sección creada' }, { sede_id: zona.sede_id });
    } catch (err) {
      console.error('[zonas:createSeccion]', err);
      redirectWithMessage(res, '/administracion/zonas', { error: 'No se pudo crear la sección' });
    }
  },

  async updateSeccion(req: Request, res: Response) {
    const tenant = ensureTenant(req);
    if (!tenant) return res.status(400).send('Tenant no definido');

    const seccionId = Number(req.params.seccionId);
    if (!seccionId) {
      return redirectWithMessage(res, '/administracion/zonas', { error: 'Sección no válida' });
    }

    try {
      const seccion = await withTenant(tenant, (client) => ZonasModel.findSeccionById(client, seccionId));
      if (!seccion) {
        return redirectWithMessage(res, '/administracion/zonas', { error: 'Sección no encontrada' });
      }

      const nombre = sanitizeName(req.body.nombre);
      const activa = parseBoolean(req.body.activa);

      await withTenant(tenant, (client) => ZonasModel.updateSeccion(client, seccionId, {
        nombre: nombre || undefined,
        activa,
      }));

      redirectWithMessage(res, '/administracion/zonas', { ok: 'Sección actualizada' }, { sede_id: seccion.sede_id });
    } catch (err) {
      console.error('[zonas:updateSeccion]', err);
      redirectWithMessage(res, '/administracion/zonas', { error: 'No se pudo actualizar la sección' });
    }
  },

  async deleteSeccion(req: Request, res: Response) {
    const tenant = ensureTenant(req);
    if (!tenant) return res.status(400).send('Tenant no definido');

    const seccionId = Number(req.params.seccionId);
    if (!seccionId) {
      return redirectWithMessage(res, '/administracion/zonas', { error: 'Sección no válida' });
    }

    try {
      const seccion = await withTenant(tenant, (client) => ZonasModel.findSeccionById(client, seccionId));
      if (!seccion) {
        return redirectWithMessage(res, '/administracion/zonas', { error: 'Sección no encontrada' });
      }

      const removal = await withTenant(tenant, (client) => ZonasModel.removeSeccion(client, seccionId));
      if (!removal.removed) {
        const detail = removal.inUse > 0
          ? `La sección tiene ${removal.inUse} elemento${removal.inUse === 1 ? '' : 's'} asignado${removal.inUse === 1 ? '' : 's'}.`
          : 'La sección está en uso.';
        return redirectWithMessage(res, '/administracion/zonas', { error: `No se pudo eliminar la sección. ${detail}` }, { sede_id: seccion.sede_id });
      }
      redirectWithMessage(res, '/administracion/zonas', { ok: 'Sección eliminada' }, { sede_id: seccion.sede_id });
    } catch (err) {
      console.error('[zonas:deleteSeccion]', err);
      redirectWithMessage(res, '/administracion/zonas', { error: 'No se pudo eliminar la sección' });
    }
  },

  async apiListBySede(req: Request, res: Response) {
    const tenant = ensureTenant(req);
    if (!tenant) return res.status(400).json({ error: 'Tenant no definido' });

    const sedeId = Number(req.params.sedeId || req.query.sede_id);
    if (!sedeId) return res.json({ zonas: [] });

    try {
      const zonas = await withTenant(tenant, (client) => ZonasModel.listBySede(client, sedeId));
      res.json({ zonas });
    } catch (err) {
      console.error('[zonas:apiListBySede]', err);
      res.status(500).json({ error: 'No se pudieron cargar las zonas' });
    }
  },

  async apiListCurrentSede(req: Request, res: Response) {
    const tenant = ensureTenant(req);
    if (!tenant) return res.status(400).json({ error: 'Tenant no definido' });

    const sedeId = Number(req.query.sede_id) || getRequestSedeId(req);
    if (!sedeId) return res.json({ zonas: [] });

    try {
      const zonas = await withTenant(tenant, (client) => ZonasModel.listBySede(client, sedeId));
      res.json({ zonas });
    } catch (err) {
      console.error('[zonas:apiListCurrentSede]', err);
      res.status(500).json({ error: 'No se pudieron cargar las zonas' });
    }
  },
};
