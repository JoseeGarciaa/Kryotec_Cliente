import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

// Determine tenant schema from subdomain, header, query or body
export function resolveTenant(req: Request): string | null {
  // priority: explicit body->query->header->host
  const explicit = (req.body?.tenant || req.query?.tenant || req.headers['x-tenant']) as string | undefined;
  if (explicit && typeof explicit === 'string') return explicit;

  const host = req.headers.host || '';
  // e.g., brandon.app.com -> tenant_brandon
  const subdomain = host.split(':')[0].split('.')[0];
  if (subdomain && subdomain !== 'www' && subdomain !== 'localhost') return `tenant_${subdomain}`;
  if (config.defaultTenant) return config.defaultTenant;
  return null;
}

export function requireTenant(req: Request, res: Response, next: NextFunction) {
  const tenant = resolveTenant(req);
  if (!tenant) return res.status(400).send('Tenant no especificado');
  (req as any).tenant = tenant;
  next();
}
