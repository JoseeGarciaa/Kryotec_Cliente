import { Request } from 'express';

export function getRequestSedeId(req: Request): number | null {
  const raw = (req as any)?.user?.sede_id;
  if (raw === undefined || raw === null || raw === '') return null;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
