import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

// Determine tenant schema from subdomain, header, query or body
export function resolveTenant(req: Request): string | null {
  // priority: explicit body->query->header->host
  const explicit = (req.body?.tenant || req.query?.tenant || req.headers['x-tenant']) as string | undefined;
  if (explicit && typeof explicit === 'string') return explicit;

  const host = req.headers.host || '';
  const hostname = host.split(':')[0];
  // Don't infer tenant from hosting platform domains like Railway
  const isPlatformHost = /\.railway\.app$/i.test(hostname);

  // e.g., brandon.mydomain.com -> tenant_brandon (only if not platform host)
  if (!isPlatformHost) {
    const parts = hostname.split('.');
    const subdomain = parts.length > 2 ? parts[0] : '';
    if (subdomain && subdomain !== 'www' && subdomain !== 'localhost') return `tenant_${subdomain}`;
  }

  if (config.defaultTenant) return config.defaultTenant;
  return null;
}

export function requireTenant(req: Request, res: Response, next: NextFunction) {
  const tenant = resolveTenant(req);
  if (!tenant) return res.status(400).send('Tenant no especificado');
  (req as any).tenant = tenant;
  next();
}
