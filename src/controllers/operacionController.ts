import { Request, Response } from 'express';
import { withTenant, TenantOptions } from '../db/pool';
import { AlertsModel } from '../models/Alerts';
import { ZonasModel } from '../models/Zona';
import { getRequestSedeId } from '../utils/sede';
import { runWithSedeContext } from '../utils/sedeContext';

const normalizeBasic = (val: string | null | undefined): string => {
  if (typeof val !== 'string') return '';
  return val
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
};

// Debug control for kanbanData verbosity
const KANBAN_DEBUG = process.env.KANBAN_DEBUG === '1';
let lastKanbanLog = 0; // rate-limit logs (ms)

const pushSedeFilter = (params: any[], sedeId: number | null, alias = 'ic') => {
  if (sedeId === null) return '';
  params.push(sedeId);
  return ` AND ${alias}.sede_id = $${params.length}`;
};

const LOCATION_ERROR_CODES = new Set([
  'INVALID_ZONA',
  'INVALID_SECCION',
  'SECTION_MISMATCH',
  'ZONE_SEDE_MISMATCH',
  'SECTION_SEDE_MISMATCH',
]);

const parseOptionalNumber = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const isLocationError = (err: any): boolean => {
  return typeof err?.code === 'string' && LOCATION_ERROR_CODES.has(err.code as string);
};

const fetchSedeNames = async (tenant: string, ids: number[]): Promise<Map<number, string>> => {
  const cleanIds = Array.from(new Set(ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id))));
  const map = new Map<number, string>();
  if (!cleanIds.length) return map;
  const result = await withTenant(tenant, (client) =>
    client.query<{ sede_id: number; nombre: string | null }>(
      `SELECT sede_id, nombre FROM sedes WHERE sede_id = ANY($1::int[])`,
      [cleanIds]
    )
  );
  for (const row of result.rows) {
    if (row && typeof row.sede_id === 'number') {
      map.set(row.sede_id, row.nombre || `Sede ${row.sede_id}`);
    }
  }
  return map;
};

const parseSedeMismatchDetail = (detail: string | null | undefined) => {
  const info: { origenId: number | null; destinoId: number | null; rfid: string | null } = {
    origenId: null,
    destinoId: null,
    rfid: null,
  };
  if (typeof detail !== 'string' || !detail) return info;
  const parts = detail.split(',');
  for (const part of parts) {
    const [rawKey, rawValue] = part.split('=').map((v) => v?.trim() ?? '');
    const value = rawValue || '';
    if (!rawKey) continue;
    if (rawKey === 'old_sede_id' || rawKey === 'origen_sede_id') {
      const num = Number(value);
      if (Number.isFinite(num)) info.origenId = num;
    } else if (rawKey === 'target_sede_id' || rawKey === 'destino_sede_id') {
      const num = Number(value);
      if (Number.isFinite(num)) info.destinoId = num;
    } else if (rawKey === 'rfid') {
      info.rfid = value || null;
    }
  }
  return info;
};

export const allowSedeTransferFromValue = (value: any): boolean => {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'si' || value === 'sí';
};

type SedeAwareRow = { rfid: string; sede_id: number | null | undefined };

const analyzeCrossSedeContext = (rows: SedeAwareRow[], sedeId: number | null) => {
  const hasSedeContext = typeof sedeId === 'number' && Number.isFinite(sedeId);
  const mismatched = hasSedeContext
    ? rows.filter((row) => typeof row.sede_id === 'number' && row.sede_id !== sedeId)
    : rows.filter((row) => typeof row.sede_id === 'number' && Number.isFinite(row.sede_id));
  const unknown = rows.filter((row) => typeof row.sede_id !== 'number');
  const requiresTransfer = mismatched.length > 0 || unknown.length > 0;
  const origenIds = mismatched
    .map((row) => (typeof row.sede_id === 'number' ? row.sede_id : null))
    .filter((id): id is number => id !== null);
  return { hasSedeContext, mismatched, unknown, requiresTransfer, origenIds };
};

export const ensureCrossSedeAuthorization = async (
  req: Request,
  res: Response,
  rows: SedeAwareRow[],
  sedeId: number | null,
  allowFlag: boolean,
  options?: { fallbackRfids?: string[]; customMessage?: string }
) => {
  const { mismatched, unknown, requiresTransfer, origenIds } = analyzeCrossSedeContext(rows, sedeId);
  const allowCrossTransfer = allowFlag && requiresTransfer;
  if (requiresTransfer && !allowCrossTransfer) {
    const promptRows = mismatched.length ? mismatched : rows;
    const fallback = options?.fallbackRfids || [];
    const rfids = Array.from(new Set([...promptRows.map((row) => row.rfid), ...fallback]));
    const targetMessage = options?.customMessage
      || (!mismatched.length && unknown.length
        ? `Las piezas seleccionadas no tienen sede registrada. ¿Deseas asignarlas a ${(typeof sedeId === 'number' ? 'tu sede actual' : 'esta sede')}?`
        : undefined);
    await respondSedeMismatch(req, res, { code: 'PX001', detail: null }, {
      rfids,
      destinoIdOverride: typeof sedeId === 'number' && Number.isFinite(sedeId) ? sedeId : null,
      origenIds: origenIds.length ? origenIds : undefined,
      customMessage: targetMessage,
    });
    return {
      blocked: true,
      allowCrossTransfer: false,
      requiresTransfer,
      mismatched,
      unknown,
      targetSede: typeof sedeId === 'number' && Number.isFinite(sedeId) ? sedeId : null,
    } as const;
  }

  return {
    blocked: false,
    allowCrossTransfer,
    requiresTransfer,
    mismatched,
    unknown,
    targetSede: typeof sedeId === 'number' && Number.isFinite(sedeId) ? sedeId : null,
  } as const;
};

const buildTenantOptions = (sedeId: number | null, allowCross: boolean): TenantOptions | undefined => {
  if (sedeId === null && !allowCross) return undefined;
  const opts: TenantOptions = {};
  if (sedeId !== null) opts.sedeId = sedeId;
  if (allowCross) opts.allowCrossSedeTransfer = true;
  return opts;
};

export const runWithSede = <T = any>(
  tenant: string,
  sedeId: number | null,
  fn: (client: any) => Promise<T>,
  options?: { allowCrossSedeTransfer?: boolean }
) => {
  const tenantOptions = buildTenantOptions(sedeId ?? null, !!options?.allowCrossSedeTransfer);
  return runWithSedeContext(sedeId, () => withTenant<T>(tenant, fn, tenantOptions));
};

export const respondSedeMismatch = async (
  req: Request,
  res: Response,
  err: any,
  context?: { rfids?: string[]; destinoIdOverride?: number | null; origenIds?: number[]; customMessage?: string }
): Promise<boolean> => {
  if (err?.code !== 'PX001') return false;
  const tenant = (req as any).user?.tenant;
  if (!tenant) {
    res.status(409).json({ ok: false, code: 'SEDE_MISMATCH', error: 'La transferencia entre sedes no está autorizada.' });
    return true;
  }

  const detalle = parseSedeMismatchDetail(err?.detail);
  const sedeId = context?.destinoIdOverride ?? getRequestSedeId(req) ?? detalle.destinoId ?? null;
  const origenIds = context?.origenIds?.length ? context?.origenIds : (detalle.origenId !== null ? [detalle.origenId] : []);
  const sedeIdsForNames = [...(origenIds || []), ...(sedeId !== null ? [sedeId] : []), detalle.destinoId ?? null]
    .filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
  const nombres = await fetchSedeNames(tenant, sedeIdsForNames);
  const origenNombre = origenIds && origenIds.length ? (nombres.get(origenIds[0]) || `Sede ${origenIds[0]}`) : (detalle.origenId !== null ? (nombres.get(detalle.origenId) || `Sede ${detalle.origenId}`) : 'otra sede');
  const destinoNombre = sedeId !== null ? (nombres.get(sedeId) || (req as any).user?.sede_nombre || `Sede ${sedeId}`) : ((detalle.destinoId !== null ? (nombres.get(detalle.destinoId) || `Sede ${detalle.destinoId}`) : (req as any).user?.sede_nombre || 'la sede actual'));
  const rfids = [detalle.rfid, ...(context?.rfids || [])].filter((val): val is string => typeof val === 'string' && val.length > 0);

  const mensajeBase = context?.customMessage || (rfids.length === 1
    ? `La pieza ${rfids[0]} pertenece a ${origenNombre}.`
    : `Las piezas seleccionadas pertenecen a ${origenNombre}.`);
  const confirmacion = rfids.length === 1
    ? `La pieza ${rfids[0]} está registrada en ${origenNombre}. ¿Deseas trasladarla a ${destinoNombre}?`
    : `Hay ${rfids.length || 'varias'} piezas registradas en ${origenNombre}. ¿Deseas trasladarlas a ${destinoNombre}?`;

  res.status(409).json({
    ok: false,
    code: 'SEDE_MISMATCH',
    error: mensajeBase,
    confirm: confirmacion,
    sedes_origen: (origenIds && origenIds.length ? origenIds : (detalle.origenId !== null ? [detalle.origenId] : []))
      .filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
      .map((id) => ({ id, nombre: nombres.get(id) || `Sede ${id}` })),
    sede_destino: sedeId !== null ? { id: sedeId, nombre: destinoNombre } : null,
    rfids,
    detail: err?.detail || null,
  });
  return true;
};

const resolveLocationForRequest = async (
  tenant: string,
  sedeId: number | null,
  body: any
): Promise<{ apply: boolean; zonaId: number | null; seccionId: number | null }> => {
  const hasZonaField = body && Object.prototype.hasOwnProperty.call(body, 'zona_id');
  const hasSeccionField = body && Object.prototype.hasOwnProperty.call(body, 'seccion_id');
  if (!hasZonaField && !hasSeccionField) {
    return { apply: false, zonaId: null, seccionId: null };
  }

  let zonaId = parseOptionalNumber(body?.zona_id);
  let seccionId = parseOptionalNumber(body?.seccion_id);

  if (zonaId === null && seccionId === null) {
    return { apply: true, zonaId: null, seccionId: null };
  }

  let resolvedZonaId = zonaId;
  let resolvedSeccionId = seccionId;
  let zonaSedeId: number | null = null;
  let seccionSedeId: number | null = null;

  await withTenant(tenant, async (client) => {
    if (seccionId !== null) {
      const found = await ZonasModel.findSeccionById(client, seccionId);
      if (!found) {
        throw Object.assign(new Error('Sección no encontrada'), { code: 'INVALID_SECCION' });
      }
      seccionSedeId = found.sede_id;
      resolvedSeccionId = found.seccion_id;
      if (zonaId !== null && zonaId !== found.zona_id) {
        throw Object.assign(new Error('La sección no pertenece a la zona seleccionada'), { code: 'SECTION_MISMATCH' });
      }
      resolvedZonaId = found.zona_id;
    }
    if (resolvedZonaId !== null) {
      const foundZona = await ZonasModel.findZonaById(client, resolvedZonaId);
      if (!foundZona) {
        throw Object.assign(new Error('Zona no encontrada'), { code: 'INVALID_ZONA' });
      }
      zonaSedeId = foundZona.sede_id;
    }
    if (seccionSedeId === null && resolvedSeccionId !== null) {
      const foundSeccion = await ZonasModel.findSeccionById(client, resolvedSeccionId);
      if (!foundSeccion) {
        throw Object.assign(new Error('Sección no encontrada'), { code: 'INVALID_SECCION' });
      }
      seccionSedeId = foundSeccion.sede_id;
    }
  });

  if (sedeId !== null) {
    if (zonaSedeId !== null && zonaSedeId !== sedeId) {
      throw Object.assign(new Error('Zona no pertenece a la sede del usuario'), { code: 'ZONE_SEDE_MISMATCH' });
    }
    if (seccionSedeId !== null && seccionSedeId !== sedeId) {
      throw Object.assign(new Error('Sección no pertenece a la sede del usuario'), { code: 'SECTION_SEDE_MISMATCH' });
    }
  }

  return {
    apply: true,
    zonaId: resolvedZonaId,
    seccionId: resolvedSeccionId,
  };
};

// Helper: generate next lote code for current day (ddMMyyyy-XXX)
async function generateNextLote(tenant: string): Promise<string> {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2,'0');
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const yyyy = String(now.getFullYear());
  const prefix = `${dd}${mm}${yyyy}`; // e.g. 05092025
  let nextNum = 1;
  await withTenant(tenant, async (c) => {
    const r = await c.query<{ lote: string }>(`SELECT lote FROM inventario_credocubes WHERE lote LIKE $1`, [prefix+'-%']);
    let max = 0;
    for(const row of r.rows){
      const lote = row.lote || '';
      const parts = lote.split('-');
      if(parts.length===2 && parts[0]===prefix){
        const n = parseInt(parts[1], 10);
        if(!isNaN(n) && n>max) max = n;
      }
    }
    nextNum = max + 1;
  });
  const suffix = String(nextNum).padStart(3,'0');
  return `${prefix}-${suffix}`;
}
// Helper: generate random unique caja lote code: CAJA-ddMMyyyy-XXXXX (XXXXX = base36 random, uppercase)
async function generateNextCajaLote(tenant: string): Promise<string> {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2,'0');
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const yyyy = String(now.getFullYear());
  const datePart = `${dd}${mm}${yyyy}`;
  await withTenant(tenant, async (c) => {
    await c.query(`CREATE TABLE IF NOT EXISTS acond_cajas (
       caja_id serial PRIMARY KEY,
       lote text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT NOW()
    )`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS acond_cajas_lote_uidx ON acond_cajas(lote)`);
  });
  function randSuffix(){
    return Array.from({length:5},()=> (Math.floor(Math.random()*36)).toString(36)).join('').toUpperCase();
  }
  for(let attempt=0; attempt<10; attempt++){
    const candidate = `CAJA-${datePart}-${randSuffix()}`;
    const exists = await withTenant(tenant, (c)=> c.query(`SELECT 1 FROM acond_cajas WHERE lote=$1 LIMIT 1`, [candidate]));
    if(!exists.rowCount) return candidate;
  }
  // Fallback extremely unlikely path: include ms timestamp
  return `CAJA-${datePart}-${Date.now().toString(36).toUpperCase()}`;
}
// Helper: generate random unique TIC lote code for pre-acond (prefix TICS-) similar to caja but distinct
async function generateNextTicLote(tenant: string): Promise<string> {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2,'0');
  const mm = String(now.getMonth()+1).padStart(2,'0');
  const yyyy = String(now.getFullYear());
  const datePart = `${dd}${mm}${yyyy}`; // ddMMyyyy
  function randSuffix(){ return Array.from({length:5},()=> (Math.floor(Math.random()*36)).toString(36)).join('').toUpperCase(); }
  for(let attempt=0; attempt<12; attempt++){
    const candidate = `TICS-${datePart}-${randSuffix()}`;
    // Check uniqueness against existing lotes in inventario (avoid collision if someone manually set one)
    const exists = await withTenant(tenant, (c)=> c.query(`SELECT 1 FROM inventario_credocubes WHERE lote=$1 LIMIT 1`, [candidate]));
    if(!exists.rowCount) return candidate;
  }
  return `TICS-${datePart}-${Date.now().toString(36).toUpperCase()}`;
}
export const OperacionController = {
  index: (_req: Request, res: Response) => res.redirect('/operacion/todas'),
  todas: (_req: Request, res: Response) => res.render('operacion/todas', { title: 'Operación · Todas las fases' }),
  // Kanban data summary for all phases
  kanbanData: async (req: Request, res: Response) => {
  const tenant = (req as any).user?.tenant;
  const sedeId = getRequestSedeId(req);
  try {
      // Ensure optional tables exist (cajas)
      await withTenant(tenant, async (c) => {
        await c.query(`CREATE TABLE IF NOT EXISTS acond_cajas (
           caja_id serial PRIMARY KEY,
           lote text NOT NULL,
           created_at timestamptz NOT NULL DEFAULT NOW()
        )`);
        await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_timers (
          caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
          started_at timestamptz,
          duration_sec integer,
          active boolean NOT NULL DEFAULT false,
          updated_at timestamptz NOT NULL DEFAULT NOW()
        )`);
        await c.query(`CREATE TABLE IF NOT EXISTS operacion_caja_timers (
          caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
          started_at timestamptz,
          duration_sec integer,
          active boolean NOT NULL DEFAULT false,
          updated_at timestamptz NOT NULL DEFAULT NOW()
        )`);
        // NEW: ensure items table exists (needed for LEFT JOIN later)
        await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_items (
          caja_id int NOT NULL REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
          rfid text NOT NULL,
          rol text NOT NULL CHECK (rol IN ('cube','vip','tic')),
          PRIMARY KEY (caja_id, rfid)
        )`);
        // Keep referential integrity and speed lookups
        await c.query(`CREATE INDEX IF NOT EXISTS acond_caja_items_rfid_idx ON acond_caja_items(rfid)`);
        await c.query(`DO $$
        BEGIN
          -- Ensure referenced column is unique (some tenants may lack the constraint)
          BEGIN
            EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS inventario_credocubes_rfid_key ON inventario_credocubes(rfid)';
          EXCEPTION WHEN others THEN
            -- ignore (could be duplicates present or index already exists differently)
          END;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = 'acond_caja_items'::regclass
               AND conname = 'acond_caja_items_rfid_fkey'
          ) THEN
            ALTER TABLE acond_caja_items
              ADD CONSTRAINT acond_caja_items_rfid_fkey
              FOREIGN KEY (rfid) REFERENCES inventario_credocubes(rfid) ON DELETE CASCADE;
          END IF;
        END $$;`);

        // Ensure and harden timers for Pendiente a Inspección and Inspección
        await c.query(`CREATE TABLE IF NOT EXISTS pend_insp_caja_timers (
           caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
           started_at timestamptz,
           duration_sec integer,
           active boolean NOT NULL DEFAULT false,
           updated_at timestamptz NOT NULL DEFAULT NOW()
        )`);
        await c.query(`CREATE TABLE IF NOT EXISTS inspeccion_caja_timers (
           caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
           started_at timestamptz,
           duration_sec integer,
           active boolean NOT NULL DEFAULT false,
           updated_at timestamptz NOT NULL DEFAULT NOW()
        )`);
        // Some tenants may miss duration_sec historically; add if missing
        await c.query(`ALTER TABLE inspeccion_caja_timers ADD COLUMN IF NOT EXISTS duration_sec integer`);

  // Cleanup: remove orphan/irrelevant timer rows that no longer match their owning estados
  // Operación timers: keep only if caja tiene items en estado 'Operación'
        await c.query(`DELETE FROM operacion_caja_timers oct
                         WHERE NOT EXISTS (
                           SELECT 1
                             FROM acond_caja_items aci
                             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
                            WHERE aci.caja_id = oct.caja_id
                              AND ic.estado = 'Operación'
                         )`);
  // Pendiente a Inspección timers: keep only if caja tiene items en 'En bodega' · 'Pendiente a Inspección'
        await c.query(`DELETE FROM pend_insp_caja_timers pit
                         WHERE NOT EXISTS (
                           SELECT 1
                             FROM acond_caja_items aci
                             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
                            WHERE aci.caja_id = pit.caja_id
                              AND LOWER(ic.estado) = LOWER('En bodega')
                              AND ic.sub_estado IN ('Pendiente a Inspección','Pendiente a Inspeccion')
                         )`);
  // Inspección timers: keep only if caja tiene items en estado 'Inspección'
        await c.query(`DELETE FROM inspeccion_caja_timers ict
                         WHERE NOT EXISTS (
                           SELECT 1
                             FROM acond_caja_items aci
                             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
                            WHERE aci.caja_id = ict.caja_id
                              AND LOWER(ic.estado) IN ('inspeccion','inspección')
                         )`);
  // Acond timers: keep only if caja tiene items en Acondicionamiento u Operación
        await c.query(`DELETE FROM acond_caja_timers act
                         WHERE NOT EXISTS (
                           SELECT 1
                             FROM acond_caja_items aci
                             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
                            WHERE aci.caja_id = act.caja_id
                              AND ic.estado IN ('Acondicionamiento','Operación')
                         )`);
      });
      // En bodega counts
      const enBodegaParams: any[] = [];
      const enBodegaSede = pushSedeFilter(enBodegaParams, sedeId);
      const enBodega = await withTenant(tenant, (c) => c.query(
        `SELECT
            SUM(CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 1 ELSE 0 END)::int AS tics,
            SUM(CASE WHEN m.nombre_modelo ILIKE '%vip%' THEN 1 ELSE 0 END)::int AS vips,
            SUM(CASE WHEN (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%') THEN 1 ELSE 0 END)::int AS cubes
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE LOWER(ic.estado)=LOWER('En bodega')${enBodegaSede}`,
        enBodegaParams
      ));
      // Pre-acond (congelamiento / atemperamiento) only TICs
      const preAcondCongParams: any[] = [];
      const preAcondCongSede = pushSedeFilter(preAcondCongParams, sedeId);
      const preAcondCong = await withTenant(tenant, (c) => c.query(
        `SELECT
            SUM(CASE WHEN ic.sub_estado='Congelamiento' THEN 1 ELSE 0 END)::int AS en_proceso,
            SUM(CASE WHEN ic.sub_estado='Congelado' THEN 1 ELSE 0 END)::int AS completado
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE ic.estado='Pre Acondicionamiento' AND (m.nombre_modelo ILIKE '%tic%')${preAcondCongSede}`,
        preAcondCongParams
      ));
      const preAcondAtempParams: any[] = [];
      const preAcondAtempSede = pushSedeFilter(preAcondAtempParams, sedeId);
      const preAcondAtemp = await withTenant(tenant, (c) => c.query(
        `SELECT
            SUM(CASE WHEN ic.sub_estado='Atemperamiento' THEN 1 ELSE 0 END)::int AS en_proceso,
            SUM(CASE WHEN ic.sub_estado='Atemperado' THEN 1 ELSE 0 END)::int AS completado
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE ic.estado='Pre Acondicionamiento' AND (m.nombre_modelo ILIKE '%tic%')${preAcondAtempSede}`,
        preAcondAtempParams
      ));
      // Acondicionamiento (ensamblaje items y cajas construidas)
      const ensamblajeParams: any[] = [];
      const ensamblajeSede = pushSedeFilter(ensamblajeParams, sedeId);
      const ensamblaje = await withTenant(tenant, (c) => c.query(
        `SELECT COUNT(*)::int AS items
           FROM inventario_credocubes ic
           WHERE ic.estado='Acondicionamiento' AND ic.sub_estado='Ensamblaje'${ensamblajeSede}`,
        ensamblajeParams
      ));
      const cajasParams: any[] = [];
      const cajasSede = pushSedeFilter(cajasParams, sedeId);
      const cajas = await withTenant(tenant, (c) => c.query(
        `SELECT COUNT(DISTINCT c.caja_id)::int AS total
           FROM acond_cajas c
           JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
           WHERE 1=1${cajasSede}`,
        cajasParams
      ));
      // Inspección (items cuyo estado es 'Inspección' o 'Inspeccion')
      const inspeccionParams: any[] = [];
      const inspeccionSede = pushSedeFilter(inspeccionParams, sedeId);
      const inspeccionQ = await withTenant(tenant, (c) => c.query(
        `SELECT
            SUM(CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 1 ELSE 0 END)::int AS tics,
            SUM(CASE WHEN m.nombre_modelo ILIKE '%vip%' THEN 1 ELSE 0 END)::int AS vips
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE ic.estado IN ('Inspección','Inspeccion')${inspeccionSede}`,
        inspeccionParams
      ));
      const inspeccion = inspeccionQ.rows[0] || { tics:0, vips:0 };
      const operacionParams: any[] = [];
      const operacionSede = pushSedeFilter(operacionParams, sedeId, 'ic');
      const opQ = await withTenant(tenant, (c)=> c.query(
        `SELECT
           SUM(CASE WHEN m.nombre_modelo ILIKE '%tic%' AND ic.sub_estado='Transito' THEN 1 ELSE 0 END)::int AS tic_transito,
           SUM(CASE WHEN m.nombre_modelo ILIKE '%vip%' AND ic.sub_estado='Transito' THEN 1 ELSE 0 END)::int AS vip_transito,
           COUNT(DISTINCT CASE WHEN ic.estado='Operación' THEN aci.caja_id END)::int AS cajas_op
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
    LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid
        WHERE ic.estado='Operación'${operacionSede}`,
        operacionParams
      ));
      const operacion = opQ.rows[0] || { tic_transito:0, vip_transito:0, cajas_op:0 };
      // Operación: timers activos de cajas en tránsito
      const opTimersParams: any[] = [];
      let opTimersSede = '';
      if (sedeId !== null) {
        opTimersParams.push(sedeId);
        opTimersSede = ` AND EXISTS (
              SELECT 1
                FROM acond_caja_items aci2
                JOIN inventario_credocubes ic2 ON ic2.rfid = aci2.rfid
               WHERE aci2.caja_id = oct.caja_id
                 AND ic2.sede_id = $${opTimersParams.length}
            )`;
      }
      const opTimersQ = await withTenant(tenant, (c)=> c.query(
        `SELECT oct.caja_id, c.lote, oct.started_at, oct.duration_sec, oct.active,
                (oct.active=false AND oct.started_at IS NOT NULL AND (oct.started_at + COALESCE(oct.duration_sec,0) * INTERVAL '1 second') <= NOW()) AS finished
           FROM operacion_caja_timers oct
           JOIN acond_cajas c ON c.caja_id = oct.caja_id
          WHERE oct.started_at IS NOT NULL
            AND (oct.active=true OR (oct.active=false AND (oct.started_at + COALESCE(oct.duration_sec,0) * INTERVAL '1 second') > NOW() - INTERVAL '10 minutes'))${opTimersSede}`,
        opTimersParams
      ));
      // Devolución: items en Operación con sub_estado Retorno (pendientes) y VIP/TIC
      const devParams: any[] = [];
      const devSede = pushSedeFilter(devParams, sedeId);
      const devQ = await withTenant(tenant, (c)=> c.query(
        `SELECT
           SUM(CASE WHEN m.nombre_modelo ILIKE '%tic%' AND ic.sub_estado='Retorno' THEN 1 ELSE 0 END)::int AS tic_pendiente,
           SUM(CASE WHEN m.nombre_modelo ILIKE '%vip%' AND ic.sub_estado='Retorno' THEN 1 ELSE 0 END)::int AS vip_pendiente
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE ic.estado='Operación'${devSede}`,
        devParams
      ));
      const devolucion = devQ.rows[0] || { tic_pendiente:0, vip_pendiente:0 };
      // Timers de cajas todavía activos en acond (Ensamblaje) y en despacho (acond_caja_timers activos)
      const acondTimersParams: any[] = [];
      let acondTimersSede = '';
      if (sedeId !== null) {
        acondTimersParams.push(sedeId);
        acondTimersSede = ` AND EXISTS (
              SELECT 1
                FROM acond_caja_items aci2
                JOIN inventario_credocubes ic2 ON ic2.rfid = aci2.rfid
               WHERE aci2.caja_id = act.caja_id
                 AND ic2.sede_id = $${acondTimersParams.length}
            )`;
      }
      const acondTimersQ = await withTenant(tenant, (c)=> c.query(
        `SELECT act.caja_id, c.lote, act.started_at, act.duration_sec, act.active,
                (act.active=false AND act.started_at IS NOT NULL AND (act.started_at + COALESCE(act.duration_sec,0) * INTERVAL '1 second') <= NOW()) AS finished
           FROM acond_caja_timers act
           JOIN acond_cajas c ON c.caja_id = act.caja_id
          WHERE act.started_at IS NOT NULL
            AND (act.active=true OR (act.active=false AND (act.started_at + COALESCE(act.duration_sec,0) * INTERVAL '1 second') > NOW() - INTERVAL '10 minutes'))${acondTimersSede}`,
        acondTimersParams
      ));
      // Inspección: timers hacia adelante (started_at) por caja actualmente en inspección
      await withTenant(tenant, async (c)=>{
        await c.query(`CREATE TABLE IF NOT EXISTS inspeccion_caja_timers (
           caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
           started_at timestamptz,
           duration_sec integer,
           active boolean NOT NULL DEFAULT false,
           updated_at timestamptz NOT NULL DEFAULT NOW()
        )`);
  // Hardening: algunas bases antiguas pueden no tener la columna duration_sec
  await c.query(`ALTER TABLE inspeccion_caja_timers ADD COLUMN IF NOT EXISTS duration_sec integer`);
      });
      const inspTimersParams: any[] = [];
      let inspTimersSedeCond = '';
      if (sedeId !== null) {
        inspTimersParams.push(sedeId);
        inspTimersSedeCond = ` AND ic.sede_id = $${inspTimersParams.length}`;
      }
      const inspTimersQ = await withTenant(tenant, (c)=> c.query(
        `SELECT ict.caja_id, c.lote, ict.started_at, ict.duration_sec, ict.active
           FROM inspeccion_caja_timers ict
           JOIN acond_cajas c ON c.caja_id = ict.caja_id
          WHERE ict.started_at IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM acond_caja_items aci
                JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
               WHERE aci.caja_id = ict.caja_id
                 AND LOWER(ic.estado) IN ('inspeccion','inspección')${inspTimersSedeCond}
            )`,
        inspTimersParams
      ));
    function mapTimers(rows:any[]){
        const nowMs = Date.now();
        return rows.map(r=>{
          let endsAt: string | null = null; let remainingSec: number | null = null;
          if(r.started_at && r.duration_sec){
            const endMs = new Date(r.started_at).getTime() + (r.duration_sec*1000);
            endsAt = new Date(endMs).toISOString();
            remainingSec = Math.max(0, Math.floor((endMs - nowMs)/1000));
          }
      return { caja_id: r.caja_id, lote: r.lote, started_at: r.started_at, duration_sec: r.duration_sec, ends_at: endsAt, remaining_sec: remainingSec, active: !!r.active, finished: remainingSec===0 && !!endsAt };
        });
      }
      const timers = {
        acond: mapTimers(acondTimersQ.rows as any[]),
        operacion: mapTimers(opTimersQ.rows as any[]),
  preAcond: [] as any[],
  inspeccion: (inspTimersQ.rows as any[]).map(r=> ({ caja_id: r.caja_id, lote: r.lote, started_at: r.started_at, duration_sec: r.duration_sec, active: !!r.active }))
      };
      // PreAcond timers (global section timers)
      try {
        // Ensure preacond tables live in the tenant schema (migrate from public if they exist there)
        await withTenant(tenant, (c)=> c.query(`DO $$
        DECLARE target_schema text := current_schema();
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE c.relname='preacond_item_timers' AND n.nspname='public'
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE c.relname='preacond_item_timers' AND n.nspname=target_schema
          ) THEN
            EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I','public','preacond_item_timers', target_schema);
          END IF;
          IF EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE c.relname='preacond_timers' AND n.nspname='public'
          ) AND NOT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE c.relname='preacond_timers' AND n.nspname=target_schema
          ) THEN
            EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I','public','preacond_timers', target_schema);
          END IF;
        END $$;`));
        await withTenant(tenant, (c)=> c.query(`CREATE TABLE IF NOT EXISTS preacond_timers (
           section text PRIMARY KEY,
           started_at timestamptz,
           duration_sec integer,
           lote text,
           active boolean NOT NULL DEFAULT false,
           updated_at timestamptz NOT NULL DEFAULT NOW()
        )`));
        await withTenant(tenant, (c)=> c.query(`CREATE TABLE IF NOT EXISTS preacond_item_timers (
           rfid text NOT NULL,
           section text NOT NULL,
           started_at timestamptz,
           duration_sec integer,
           lote text,
           active boolean NOT NULL DEFAULT false,
           updated_at timestamptz NOT NULL DEFAULT NOW(),
           PRIMARY KEY (rfid, section)
        )`));
        await withTenant(tenant, (c)=> c.query(`CREATE INDEX IF NOT EXISTS preacond_item_timers_rfid_idx ON preacond_item_timers(rfid)`));
        await withTenant(tenant, (c)=> c.query(`DO $$
        BEGIN
          BEGIN
            EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS inventario_credocubes_rfid_key ON inventario_credocubes(rfid)';
          EXCEPTION WHEN others THEN
          END;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = 'preacond_item_timers'::regclass
               AND conname = 'preacond_item_timers_rfid_fkey'
          ) THEN
            ALTER TABLE preacond_item_timers
              ADD CONSTRAINT preacond_item_timers_rfid_fkey
              FOREIGN KEY (rfid) REFERENCES inventario_credocubes(rfid) ON DELETE CASCADE;
          END IF;
        END $$;`));
        // Cleanup: remove timers for RFIDs that are no longer in Pre Acondicionamiento (avoid table growth)
        await withTenant(tenant, (c)=> c.query(
          `DELETE FROM preacond_item_timers pit
             WHERE NOT EXISTS (
               SELECT 1 FROM inventario_credocubes ic
                WHERE ic.rfid = pit.rfid
                  AND ic.estado = 'Pre Acondicionamiento'
                  AND ic.sub_estado IN ('Congelamiento','Congelado','Atemperamiento','Atemperado')
             )`
        ));
        // Cleanup: clear section timer when no TICs remain in the corresponding section/lote
        await withTenant(tenant, (c)=> c.query(
          `UPDATE preacond_timers pt
              SET started_at = NULL,
                  duration_sec = NULL,
                  lote = NULL,
                  active = false,
                  updated_at = NOW()
            WHERE NOT EXISTS (
                    SELECT 1
                      FROM inventario_credocubes ic
                      JOIN modelos m ON m.modelo_id = ic.modelo_id
                     WHERE ic.estado = 'Pre Acondicionamiento'
                       AND ( (pt.section='congelamiento'   AND ic.sub_estado IN ('Congelamiento','Congelado'))
                          OR (pt.section='atemperamiento' AND ic.sub_estado IN ('Atemperamiento','Atemperado')) )
                       AND (pt.lote IS NULL OR ic.lote = pt.lote)
                       AND m.nombre_modelo ILIKE '%tic%'
                  )`
        ));
        const ptQ = await withTenant(tenant, (c)=> c.query(`SELECT section, started_at, duration_sec, active, lote,
            (active=false AND started_at IS NOT NULL AND (started_at + COALESCE(duration_sec,0) * INTERVAL '1 second') <= NOW()) AS finished
           FROM preacond_timers
          WHERE started_at IS NOT NULL
            AND (active=true OR (active=false AND (started_at + COALESCE(duration_sec,0) * INTERVAL '1 second') > NOW() - INTERVAL '10 minutes'))`));
  const pitQ = await withTenant(tenant, (c)=> c.query(`SELECT rfid, section, started_at, duration_sec, active, lote,
             (active=false AND started_at IS NOT NULL AND (started_at + COALESCE(duration_sec,0) * INTERVAL '1 second') <= NOW()) AS finished
            FROM preacond_item_timers
           WHERE started_at IS NOT NULL
             AND (active=true OR (active=false AND (started_at + COALESCE(duration_sec,0) * INTERVAL '1 second') > NOW() - INTERVAL '10 minutes'))`));
        if (KANBAN_DEBUG) {
          console.log('[kanbanData] raw pitQ rows', pitQ.rowCount, pitQ.rows.slice(0,3).map(r=>({rfid:r.rfid, section:r.section, active:r.active})));
        }
        const nowMs = Date.now();
        timers.preAcond = ptQ.rows.map((r:any)=>{
          let endsAt: string | null = null; let remainingSec: number | null = null;
            if(r.started_at && r.duration_sec){ const endMs = new Date(r.started_at).getTime() + r.duration_sec*1000; endsAt = new Date(endMs).toISOString(); remainingSec = Math.max(0, Math.floor((endMs-nowMs)/1000)); }
          return { section: r.section, lote: r.lote, started_at: r.started_at, duration_sec: r.duration_sec, ends_at: endsAt, remaining_sec: remainingSec, active: !!r.active, finished: remainingSec===0 && !!endsAt };
        });
        // Append item-level timers (each TIC) so dashboard shows granular cronómetros
        for(const r of pitQ.rows as any[]){
          let endsAt: string | null = null; let remainingSec: number | null = null;
          if(r.started_at && r.duration_sec){ const endMs = new Date(r.started_at).getTime() + r.duration_sec*1000; endsAt = new Date(endMs).toISOString(); remainingSec = Math.max(0, Math.floor((endMs-nowMs)/1000)); }
          timers.preAcond.push({ section: r.section, lote: r.lote, rfid: r.rfid, started_at: r.started_at, duration_sec: r.duration_sec, ends_at: endsAt, remaining_sec: remainingSec, active: !!r.active, finished: remainingSec===0 && !!endsAt, item:true });
        }
  // Remove finished group timers (keep item timers for recent context) to avoid UI flicker
  timers.preAcond = timers.preAcond.filter((t:any)=> t.item || (t.remaining_sec||0) > 0);
      } catch {}
  // Debug counts for visibility (no PII)
  const preGroupsCount = timers.preAcond.filter((t:any)=> !t.item).length;
  const preItemsCount = timers.preAcond.filter((t:any)=> t.item).length;
  if (KANBAN_DEBUG && Date.now() - lastKanbanLog > 30000) { // log at most cada 30s
    console.log('[kanbanData] timers preAcond groups/items', preGroupsCount, preItemsCount);
    lastKanbanLog = Date.now();
  }
  res.json({ ok: true, data: {
        enBodega: enBodega.rows[0] || { tics:0, vips:0, cubes:0 },
        preAcond: {
          congelamiento: preAcondCong.rows[0] || { en_proceso:0, completado:0 },
          atemperamiento: preAcondAtemp.rows[0] || { en_proceso:0, completado:0 }
        },
        acond: {
          ensamblaje: ensamblaje.rows[0]?.items || 0,
          cajas: cajas.rows[0]?.total || 0
        },
        inspeccion,
        operacion,
        devolucion,
        timers
      }});
    } catch (e:any) {
  console.error('[kanbanData] error', e);
  res.status(500).json({ ok:false, error: e.message || 'Error resumen kanban' });
    }
  },
  preacond: (_req: Request, res: Response) => res.render('operacion/preacond', { title: 'Operación · Registrar pre-acondicionamiento' }),
  acond: (_req: Request, res: Response) => res.render('operacion/acond', { title: 'Operación · Acondicionamiento' }),
  operacion: (_req: Request, res: Response) => res.render('operacion/operacion', { title: 'Operación · Operación' }),
  devolucion: (_req: Request, res: Response) => res.render('operacion/devolucion', { title: 'Operación · Devolución' }),
  devolucionData: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    try {
      // Cronómetro general: reutilizamos el timer definido en etapa Acond (acond_caja_timers)
      await withTenant(tenant, (c)=> c.query(`CREATE TABLE IF NOT EXISTS acond_caja_timers (
          caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
          started_at timestamptz,
          duration_sec integer,
          active boolean NOT NULL DEFAULT false,
          updated_at timestamptz NOT NULL DEFAULT NOW()
        )`));
      // Traer NOW() server para offset
      const nowRes = await withTenant(tenant, (c)=> c.query<{ now:string }>(`SELECT NOW()::timestamptz AS now`));
   // Solo cajas elegibles: items en Operación y sub_estado exactamente 'Transito'
      const pendParams: any[] = [];
      const pendSede = pushSedeFilter(pendParams, sedeId, 'ic');
   const pendQ = await withTenant(tenant, (c)=> c.query(
     `SELECT ic.rfid,
       ic.nombre_unidad,
       m.nombre_modelo,
       ic.estado,
       ic.sub_estado,
       CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
         WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
         WHEN (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%') THEN 'cube'
         ELSE 'otro' END AS rol,
       c.caja_id,
       c.lote AS caja_lote,
       c.order_id AS order_id,
       o.numero_orden AS order_num,
       act.started_at AS caja_started_at,
       act.duration_sec AS caja_duration_sec,
       act.active AS caja_active
     FROM inventario_credocubes ic
     JOIN modelos m ON m.modelo_id = ic.modelo_id
     LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid
     LEFT JOIN acond_cajas c ON c.caja_id = aci.caja_id
     LEFT JOIN ordenes o ON o.id = c.order_id
     LEFT JOIN acond_caja_timers act ON act.caja_id = c.caja_id
   WHERE ic.estado='Operación' AND ic.sub_estado = 'Transito'${pendSede}
    ORDER BY ic.id DESC
    LIMIT 1200`, pendParams));
      const rows = pendQ.rows as any[];
      let cubes=0,vips=0,tics=0; for(const r of rows){ if(r.rol==='cube') cubes++; else if(r.rol==='vip') vips++; else if(r.rol==='tic') tics++; }
      // De vuelta (estadísticas): estado='En bodega' y sub_estado NULL recientemente? Simple aggregate.
      const devueltosParams: any[] = [];
      const devueltosSede = pushSedeFilter(devueltosParams, sedeId, 'ic');
      const devueltosQ = await withTenant(tenant, (c)=> c.query(
        `SELECT 
           SUM(CASE WHEN m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%' THEN 1 ELSE 0 END)::int AS cubes,
           SUM(CASE WHEN m.nombre_modelo ILIKE '%vip%' THEN 1 ELSE 0 END)::int AS vips,
           SUM(CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 1 ELSE 0 END)::int AS tics
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE ic.estado='En bodega'${devueltosSede}`, devueltosParams));
      const statsRow = devueltosQ.rows[0] || { cubes:0,vips:0,tics:0 };
      const nowIso = nowRes.rows[0]?.now;
      const nowMs = nowIso ? new Date(nowIso).getTime() : Date.now();
      const pendientes = rows.map(r=>{
        // Construir objeto timer basado en timer de la caja
        let timer: any = null;
        if(r.caja_started_at && r.caja_duration_sec){
          const endMs = new Date(r.caja_started_at).getTime() + (r.caja_duration_sec*1000);
            const endsAt = new Date(endMs).toISOString();
            let completedAt: string | null = null;
            if(r.caja_active===false && endMs <= nowMs){ completedAt = endsAt; }
            timer = { startsAt: r.caja_started_at, endsAt, completedAt };
        }
        return {
          rfid: r.rfid,
          rol: r.rol,
          nombre: r.nombre_modelo,
          nombre_unidad: r.nombre_unidad || null,
          estado: r.estado,
          sub_estado: r.sub_estado,
          caja: r.caja_lote || null,
          caja_id: r.caja_id || null,
          order_id: r.order_id || null,
          order_num: r.order_num || null,
          timer
        };
      });
      // Agrupar por caja para UI tipo tarjetas (similar a Operación)
      const cajasMap: Record<string, any> = {};
      for(const p of pendientes){
        if(!p.caja_id) continue;
        let g = cajasMap[p.caja_id];
        if(!g){
          g = cajasMap[p.caja_id] = {
            id: p.caja_id,
            codigoCaja: p.caja || ('CAJA-'+p.caja_id),
            timer: p.timer,
            componentes: [] as any[],
            estado: p.sub_estado || p.estado,
            orderId: p.order_id || null,
            orderNumero: p.order_num || null
          };
        }
        g.componentes.push({ codigo: p.rfid, tipo: p.rol, estado: p.estado, sub_estado: p.sub_estado, nombreUnidad: p.nombre_unidad || null });
      }
      const cajas = Object.values(cajasMap);
      cajas.forEach((c:any) => {
        const cubeComp = (c.componentes||[]).find((cmp:any) => cmp?.tipo === 'cube' && cmp?.nombreUnidad);
        c.nombreCaja = cubeComp?.nombreUnidad?.trim() || c.codigoCaja;
      });
      // ==== Agregación por orden (conteo de cajas y esperado) ====
      // Obtener order_id únicos
      const orderIds = [...new Set(cajas.filter(c=> c.orderId).map(c=> c.orderId))];
  let ordenesInfo: Record<string, { order_id:number; numero_orden:string|null; cajas:number; expected:number|null; }> = {};
      if(orderIds.length){
        // Contar cajas por order_id (ya las tenemos en memoria) y traer expected (cantidad) y numero_orden
        const counts: Record<string, number> = {};
        cajas.forEach(c=>{ if(c.orderId){ counts[c.orderId] = (counts[c.orderId]||0)+1; } });
        const ordRows = await withTenant(tenant, (c)=> c.query(`SELECT id, numero_orden, cantidad FROM ordenes WHERE id = ANY($1::int[])`, [orderIds]));
        for(const r of ordRows.rows as any[]){
          ordenesInfo[String(r.id)] = { order_id:r.id, numero_orden: r.numero_orden||null, cajas: counts[r.id]||0, expected: (r.cantidad!=null? Number(r.cantidad): null) };
        }
        // Enriquecer cada caja con contadores
        cajas.forEach(c=>{ if(c.orderId && ordenesInfo[String(c.orderId)]){ const meta = ordenesInfo[String(c.orderId)]; c.orderCajaCount = meta.cajas; c.orderCajaExpected = meta.expected; c.orderNumero = meta.numero_orden || c.orderNumero; } });
      }
      res.json({ ok:true, serverNow: nowIso, pendientes, cajas, ordenes: ordenesInfo, stats:{ cubes: statsRow.cubes, vips: statsRow.vips, tics: statsRow.tics, total: (statsRow.cubes||0)+(statsRow.vips||0)+(statsRow.tics||0) } });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error devolucion data' }); }
  },
  // Nueva: devolver caja completa (todas sus piezas) a Bodega desde Operación (cualquier sub_estado)
  devolucionCajaReturn: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { caja_id } = req.body as any;
    const cajaId = Number(caja_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    try {
      const itemsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT rfid FROM acond_caja_items WHERE caja_id=$1`,
        [cajaId]));
      if(!itemsQ.rowCount) return res.status(404).json({ ok:false, error:'Caja sin items' });
      const rfids = itemsQ.rows.map((r:any)=> r.rfid);

      const sedeRows = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.sede_id
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id=$1`,
        [cajaId]
      ));
      const transferRows = (sedeRows.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
      const transferCheck = await ensureCrossSedeAuthorization(
        req,
        res,
        transferRows,
        sedeId,
        allowSedeTransferFlag,
        { fallbackRfids: rfids }
      );
      if (transferCheck.blocked) return;

      await runWithSede(tenant, sedeId, async (c)=>{
        const targetSede = transferCheck.targetSede;
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS habilitada boolean NOT NULL DEFAULT true`);
        await c.query('BEGIN');
        try {
          await c.query(
            `UPDATE inventario_credocubes ic
                SET estado='En bodega',
                    sub_estado=NULL,
                    lote=NULL,
                    sede_id = COALESCE($2::int, ic.sede_id)
              WHERE ic.rfid = ANY($1::text[])`,
            [rfids, targetSede]
          );
          await c.query(`DELETE FROM acond_caja_timers WHERE caja_id=$1`, [cajaId]);
          await c.query(`DELETE FROM operacion_caja_timers WHERE caja_id=$1`, [cajaId]);
          await c.query(`DELETE FROM acond_caja_items WHERE caja_id=$1`, [cajaId]);
          await c.query(`DELETE FROM acond_cajas WHERE caja_id=$1`, [cajaId]);
          await c.query('COMMIT');
          res.json({ ok:true, caja_id: cajaId, items: rfids.length, caja_deleted: true });
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      }, { allowCrossSedeTransfer: transferCheck.allowCrossTransfer });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error devolviendo caja' }); }
  },
  devolucionConfirm: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { rfids } = req.body as any;
    const list = Array.isArray(rfids)? rfids.filter((x:any)=> typeof x==='string' && x.trim().length===24).slice(0,500):[];
    if(!list.length) return res.status(400).json({ ok:false, error:'Sin RFIDs' });
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    let trackedRfids = list.slice();
    try {
      const stateRows = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.sede_id
           FROM inventario_credocubes ic
          WHERE ic.rfid = ANY($1::text[])`, [list]));
      const transferRows = (stateRows.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
      const transferCheck = await ensureCrossSedeAuthorization(
        req,
        res,
        transferRows,
        sedeId,
        allowSedeTransferFlag,
        { fallbackRfids: list }
      );
      if (transferCheck.blocked) return;

      const tenantOptions = buildTenantOptions(sedeId ?? null, transferCheck.allowCrossTransfer);
      const targetSede = transferCheck.targetSede;
      const updated = await withTenant(tenant, (c)=> c.query(
        `UPDATE inventario_credocubes ic
            SET estado='En bodega',
                sub_estado=NULL,
                sede_id = COALESCE($2::int, ic.sede_id)
          WHERE ic.rfid = ANY($1::text[])
            AND ic.estado='Operación'
            AND ic.sub_estado IN ('Transito','Retorno','Completado')
          RETURNING ic.rfid`, [list, targetSede]), tenantOptions);
      res.json({ ok:true, devueltos: updated.rowCount });
    } catch(e:any){
      if (await respondSedeMismatch(req, res, e, { rfids: trackedRfids })) return;
      res.status(500).json({ ok:false, error: e.message||'Error confirmando devolución' });
    }
  },
  // Validar únicamente items en estado Operación / sub_estado Retorno para flujo rápido
  devolucionRetValidate: async (req: Request, res: Response) => {
  const tenant = (req as any).user?.tenant;
    const { rfids } = req.body as any;
    const list = Array.isArray(rfids)? rfids.filter((x:any)=> typeof x==='string' && x.trim().length===24).slice(0,300):[];
    if(!list.length) return res.json({ ok:true, valid:[], invalid:[] });
    try {
      const q = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.estado, ic.sub_estado
           FROM inventario_credocubes ic
          WHERE ic.rfid = ANY($1::text[])`, [list]));
      const map = new Map(q.rows.map((r:any)=> [r.rfid, r]));
      const valid:any[] = []; const invalid:any[] = [];
      for(const r of list){
        const row = map.get(r);
        if(!row){ invalid.push({ rfid:r, reason:'no_encontrado' }); continue; }
        if(row.estado !== 'Operación'){ invalid.push({ rfid:r, reason:'estado_'+row.estado }); continue; }
        if(row.sub_estado !== 'Retorno'){ invalid.push({ rfid:r, reason: row.sub_estado? ('subestado_'+row.sub_estado): 'no_retorno' }); continue; }
        valid.push({ rfid:r });
      }
      res.json({ ok:true, valid, invalid });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error validando RFIDs retorno' }); }
  },
  // Confirmar retorno -> bodega
  devolucionRetConfirm: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { rfids } = req.body as any;
    const list = Array.isArray(rfids)? rfids.filter((x:any)=> typeof x==='string' && x.trim().length===24).slice(0,800):[];
    if(!list.length) return res.status(400).json({ ok:false, error:'Sin RFIDs' });
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    let trackedRfids = list.slice();
    try {
      const stateRows = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.sede_id
           FROM inventario_credocubes ic
          WHERE ic.rfid = ANY($1::text[])`, [list]));
      const transferRows = (stateRows.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
      const transferCheck = await ensureCrossSedeAuthorization(
        req,
        res,
        transferRows,
        sedeId,
        allowSedeTransferFlag,
        { fallbackRfids: list }
      );
      if (transferCheck.blocked) return;

      const tenantOptions = buildTenantOptions(sedeId ?? null, transferCheck.allowCrossTransfer);
      const targetSede = transferCheck.targetSede;
      const upd = await withTenant(tenant, (c)=> c.query(
        `UPDATE inventario_credocubes ic
            SET estado='En bodega',
                sub_estado=NULL,
                sede_id = COALESCE($2::int, ic.sede_id)
          WHERE ic.rfid = ANY($1::text[])
            AND ic.estado='Operación'
            AND ic.sub_estado='Retorno'
          RETURNING ic.rfid`, [list, targetSede]), tenantOptions);
      res.json({ ok:true, devueltos: upd.rowCount });
    } catch(e:any){
      if (await respondSedeMismatch(req, res, e, { rfids: trackedRfids })) return;
      res.status(500).json({ ok:false, error: e.message||'Error confirmando retorno' });
    }
  },
  // Nuevo flujo devolución: si resta >50% del cronómetro original de acond, vuelve a Acond (Lista para Despacho) conservando timer; si <=50%, pasa a "En bodega · Pendiente a Inspección".
  devolucionCajaProcess: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { caja_id } = req.body as any;
    const cajaId = Number(caja_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    let trackedRfids: string[] = [];
    try {
      const eligQ = await withTenant(tenant, (c)=> c.query(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN ic.estado='Operación' AND ic.sub_estado='Transito' THEN 1 ELSE 0 END)::int AS ok
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
         WHERE aci.caja_id=$1`, [cajaId]));
      const row = eligQ.rows[0] as any;
      if(!row || row.ok < row.total){
        return res.status(400).json({ ok:false, error:'Caja no elegible: requiere Operación · Transito' });
      }

      const nowQ = await withTenant(tenant, (c)=> c.query<{ now:string }>(`SELECT NOW()::timestamptz AS now`));
      const nowMs = new Date(nowQ.rows[0].now).getTime();
      const tQ = await withTenant(tenant, (c)=> c.query(`SELECT started_at, duration_sec, active FROM acond_caja_timers WHERE caja_id=$1`, [cajaId]));
      let remainingRatio = 0; let decide:'inspeccion'|'reuse' = 'inspeccion';
      if(tQ.rowCount){
        const t = tQ.rows[0] as any;
        if(t.started_at && t.duration_sec){
          const startMs = new Date(t.started_at).getTime();
          const durMs = Number(t.duration_sec)*1000;
          const endMs = startMs + durMs;
          const remMs = Math.max(0, endMs - nowMs);
          remainingRatio = durMs>0? (remMs/durMs) : 0;
          decide = remainingRatio>0.5? 'reuse':'inspeccion';
        }
      }

      const itemsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT rfid FROM acond_caja_items WHERE caja_id=$1`, [cajaId]));
      if(!itemsQ.rowCount) return res.status(404).json({ ok:false, error:'Caja sin items' });
      const rfids = itemsQ.rows.map((r:any)=> r.rfid);
      trackedRfids = rfids.slice();

      const sedeRows = await withTenant(tenant, (c)=> c.query(
        `SELECT rfid, sede_id FROM inventario_credocubes WHERE rfid = ANY($1::text[])`,
        [rfids]
      ));
      const transferRows = (sedeRows.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
      const transferCheck = await ensureCrossSedeAuthorization(
        req,
        res,
        transferRows,
        sedeId,
        allowSedeTransferFlag,
        { fallbackRfids: rfids }
      );
      if (transferCheck.blocked) return;

      await runWithSede(tenant, sedeId, async (c)=>{
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS habilitada boolean NOT NULL DEFAULT true`);
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS estado_orden boolean DEFAULT true`);
        await c.query('BEGIN');
        try {
          const targetSede = transferCheck.targetSede;
          const orderRow = await c.query(`SELECT order_id FROM acond_cajas WHERE caja_id=$1 FOR UPDATE`, [cajaId]);
          const orderId = orderRow.rowCount ? orderRow.rows[0].order_id : null;
          if(decide==='reuse'){
            await c.query(
              `UPDATE inventario_credocubes ic
                  SET estado='Acondicionamiento',
                      sub_estado='Lista para Despacho',
                      sede_id = COALESCE($2::int, ic.sede_id)
                WHERE ic.rfid = ANY($1::text[])
                  AND ic.estado='Operación'`,
              [rfids, targetSede]
            );
          } else {
            await c.query(
              `UPDATE inventario_credocubes ic
                  SET estado='En bodega',
                      sub_estado='Pendiente a Inspección',
                      sede_id = COALESCE($2::int, ic.sede_id)
                WHERE ic.rfid = ANY($1::text[])
                  AND ic.estado='Operación'`,
              [rfids, targetSede]
            );
            await c.query(`UPDATE acond_caja_timers SET active=false, started_at=NULL, duration_sec=NULL, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
            await c.query(`UPDATE operacion_caja_timers SET active=false, started_at=NULL, duration_sec=NULL, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
            await c.query(`CREATE TABLE IF NOT EXISTS pend_insp_caja_timers (
               caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
               started_at timestamptz,
               duration_sec integer,
               active boolean NOT NULL DEFAULT false,
               updated_at timestamptz NOT NULL DEFAULT NOW()
            )`);
          }
          if(orderId){
            await c.query(`UPDATE ordenes SET estado_orden = false, habilitada = false WHERE id = $1`, [orderId]);
          }
          await c.query('COMMIT');
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      }, { allowCrossSedeTransfer: transferCheck.allowCrossTransfer });

      res.json({ ok:true, action: decide, remaining_ratio: Number(remainingRatio.toFixed(4)) });
    } catch(e:any){
      if (await respondSedeMismatch(req, res, e, { rfids: trackedRfids })) return;
      res.status(500).json({ ok:false, error: e.message||'Error procesando devolución' });
    }
  },
  // Acción explícita: enviar caja a En bodega · Pendiente a Inspección (opcionalmente iniciar timer manual)
  devolucionCajaToPendInsp: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { caja_id, durationSec } = req.body as any;
    const cajaId = Number(caja_id);
  const dur = Number(durationSec);
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    try {
      // Validar elegibilidad primero
      const eligQ = await withTenant(tenant, (c)=> c.query(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN ic.estado='Operación' AND ic.sub_estado='Transito' THEN 1 ELSE 0 END)::int AS ok
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id=$1`,
        [cajaId]));
      const erow = eligQ.rows[0] as any; if(!erow || erow.ok < erow.total){ return res.status(400).json({ ok:false, error:'Caja no elegible: requiere Operación · Transito' }); }
      const itemsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT rfid FROM acond_caja_items WHERE caja_id=$1`, [cajaId]));
      if(!itemsQ.rowCount) return res.status(404).json({ ok:false, error:'Caja sin items' });
      const rfids = itemsQ.rows.map((r:any)=> r.rfid);
      const sedeRows = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.sede_id
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id=$1`,
        [cajaId]
      ));
      const transferRows = (sedeRows.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
      const transferCheck = await ensureCrossSedeAuthorization(
        req,
        res,
        transferRows,
        sedeId,
        allowSedeTransferFlag,
        { fallbackRfids: rfids }
      );
      if (transferCheck.blocked) return;

      await runWithSede(tenant, sedeId, async (c)=>{
        const targetSede = transferCheck.targetSede;
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS habilitada boolean NOT NULL DEFAULT true`);
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS estado_orden boolean DEFAULT true`);
        await c.query('BEGIN');
        try {
          const orderRow = await c.query(`SELECT order_id FROM acond_cajas WHERE caja_id=$1 FOR UPDATE`, [cajaId]);
          const orderId = orderRow.rowCount ? orderRow.rows[0].order_id : null;
          await c.query(
            `UPDATE inventario_credocubes ic
                SET estado='En bodega',
                    sub_estado='Pendiente a Inspección',
                    sede_id = COALESCE($2::int, ic.sede_id)
              WHERE ic.rfid = ANY($1::text[])
                AND ic.estado='Operación'`,
            [rfids, targetSede]
          );
          await c.query(`UPDATE acond_caja_timers SET active=false, started_at=NULL, duration_sec=NULL, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
          await c.query(`UPDATE operacion_caja_timers SET active=false, started_at=NULL, duration_sec=NULL, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
          await c.query(`CREATE TABLE IF NOT EXISTS pend_insp_caja_timers (
             caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
             started_at timestamptz,
             duration_sec integer,
             active boolean NOT NULL DEFAULT false,
             updated_at timestamptz NOT NULL DEFAULT NOW()
          )`);
          if(Number.isFinite(dur) && dur>0){
            await c.query(
              `INSERT INTO pend_insp_caja_timers(caja_id, started_at, duration_sec, active, updated_at)
                 VALUES ($1, NOW(), $2, true, NOW())
               ON CONFLICT (caja_id) DO UPDATE
                 SET started_at = NOW(), duration_sec = EXCLUDED.duration_sec, active = true, updated_at = NOW()`,
              [cajaId, dur]
            );
          } else {
            throw new Error('Se requiere aceptar y asignar un cronómetro (horas/minutos)');
          }
          if(orderId){
            await c.query(`UPDATE ordenes SET estado_orden = false, habilitada = false WHERE id = $1`, [orderId]);
          }
          await c.query('COMMIT');
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      }, { allowCrossSedeTransfer: transferCheck.allowCrossTransfer });
      res.json({ ok:true });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error enviando a Pendiente a Inspección' }); }
  },
  devolucionValidate: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { rfids } = req.body as any;
  const list = Array.isArray(rfids)? rfids.filter((x:any)=> typeof x==='string' && x.trim().length===24).slice(0,300):[];
    if(!list.length) return res.json({ ok:true, valid:[], invalid:[] });
    try {
      const q = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.estado, ic.sub_estado, m.nombre_modelo,
                CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                     WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                     WHEN (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%') THEN 'cube'
                     ELSE 'otro' END AS rol
           FROM inventario_credocubes ic
           JOIN modelos m ON m.modelo_id = ic.modelo_id
          WHERE ic.rfid = ANY($1::text[])`, [list]));
      const map = new Map(q.rows.map((r:any)=> [r.rfid, r]));
      const valid:any[] = []; const invalid:any[] = [];
      for(const r of list){
        const row = map.get(r);
        if(!row){ invalid.push({ rfid:r, reason:'no_encontrado' }); continue; }
    if(row.estado !== 'Operación'){ invalid.push({ rfid:r, reason:'estado_'+row.estado }); continue; }
  // Ahora sólo válido si está exactamente en sub_estado 'Retorno'
  if(row.sub_estado !== 'Retorno'){ invalid.push({ rfid:r, reason: row.sub_estado? ('subestado_'+row.sub_estado): 'no_retorno' }); continue; }
        valid.push({ rfid:r, rol: row.rol });
      }
      res.json({ ok:true, valid, invalid });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error validando RFIDs' }); }
  },
  // Evaluar si una caja puede reutilizarse según cronómetro (>50% restante)
  devolucionCajaEvaluate: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { caja_id } = req.body as any;
    const cajaId = Number(caja_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    try {
      // Validar elegibilidad: Operación · Transito
      const eligQ = await withTenant(tenant, (c)=> c.query(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN ic.estado='Operación' AND ic.sub_estado='Transito' THEN 1 ELSE 0 END)::int AS ok
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id=$1`,
        [cajaId]));
      const row = eligQ.rows[0] as any; if(!row || row.ok < row.total){
        return res.status(400).json({ ok:false, error:'Caja no elegible: requiere Operación · Transito' });
      }
      const nowQ = await withTenant(tenant, (c)=> c.query<{ now:string }>(`SELECT NOW()::timestamptz AS now`));
      const nowMs = new Date(nowQ.rows[0].now).getTime();
      const tQ = await withTenant(tenant, (c)=> c.query(`SELECT started_at, duration_sec, active FROM acond_caja_timers WHERE caja_id=$1`, [cajaId]));
      let reusable=false, remainingRatio=0, secondsRemaining=0, durationSec=0, startsAt:null|string=null, endsAt:null|string=null;
      if(tQ.rowCount){
        const t = tQ.rows[0] as any;
        if(t.started_at && t.duration_sec){
          const startMs = new Date(t.started_at).getTime();
          const durMs = Number(t.duration_sec)*1000; durationSec = Number(t.duration_sec)||0; startsAt = t.started_at;
          const endMs = startMs + durMs; endsAt = new Date(endMs).toISOString();
          const remMs = Math.max(0, endMs - nowMs); secondsRemaining = Math.floor(remMs/1000);
          remainingRatio = durMs>0? (remMs/durMs) : 0; reusable = remainingRatio>0.5;
        }
      }
      res.json({ ok:true, reusable, remaining_ratio: Number(remainingRatio.toFixed(4)), seconds_remaining: secondsRemaining, duration_sec: durationSec, starts_at: startsAt, ends_at: endsAt });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error evaluando caja' }); }
  },
  // Accion explicita: reutilizar caja (volver a Acond -> Lista para Despacho) conservando cronometro
  devolucionCajaReuse: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { caja_id } = req.body as any; const cajaId = Number(caja_id);
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id invalido' });
    try {
      const eligQ = await withTenant(tenant, (c)=> c.query(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN ic.estado='Operación' AND ic.sub_estado='Transito' THEN 1 ELSE 0 END)::int AS ok
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id=$1`,
        [cajaId]));
      const erow = eligQ.rows[0] as any;
      if(!erow || erow.ok < erow.total){
        return res.status(400).json({ ok:false, error:'Caja no elegible: requiere Operación -> Transito' });
      }
      const itemsQ = await withTenant(tenant, (c)=> c.query(`SELECT rfid FROM acond_caja_items WHERE caja_id=$1`, [cajaId]));
      if(!itemsQ.rowCount) return res.status(404).json({ ok:false, error:'Caja sin items' });
      const rfids = itemsQ.rows.map((r:any)=> r.rfid);
      const sedeRows = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.sede_id
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id=$1`,
        [cajaId]
      ));
      const transferRows = (sedeRows.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
      const transferCheck = await ensureCrossSedeAuthorization(
        req,
        res,
        transferRows,
        sedeId,
        allowSedeTransferFlag,
        { fallbackRfids: rfids }
      );
      if (transferCheck.blocked) return;

      await runWithSede(tenant, sedeId, async (c)=>{
        const targetSede = transferCheck.targetSede;
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS estado_orden boolean DEFAULT true`);
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS habilitada boolean NOT NULL DEFAULT true`);
        await c.query('BEGIN');
        try {
          const orderRow = await c.query(`SELECT order_id FROM acond_cajas WHERE caja_id=$1 FOR UPDATE`, [cajaId]);
          const orderId = orderRow.rowCount ? orderRow.rows[0].order_id : null;
          await c.query(
            `UPDATE inventario_credocubes ic
                SET estado='Acondicionamiento',
                    sub_estado='Lista para Despacho',
                    sede_id = COALESCE($2::int, ic.sede_id)
              WHERE ic.rfid = ANY($1::text[])
                AND ic.estado='Operación'`,
            [rfids, targetSede]
          );
          await c.query(`UPDATE inventario_credocubes SET numero_orden=NULL WHERE rfid = ANY($1::text[])`, [rfids]);
          await c.query(`UPDATE acond_cajas SET order_id = NULL WHERE caja_id=$1`, [cajaId]);
          if(orderId){
            await c.query(`UPDATE ordenes SET estado_orden = false, habilitada = false WHERE id = $1`, [orderId]);
          }
          await c.query('COMMIT');
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      }, { allowCrossSedeTransfer: transferCheck.allowCrossTransfer });
      res.json({ ok:true, caja_id: cajaId, order_id: null, reusada: true });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error reutilizando caja' }); }
  },

  // Accion explicita: enviar a Inspeccion y desactivar cronometro
  devolucionCajaToInspeccion: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { caja_id } = req.body as any; const cajaId = Number(caja_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id invalido' });
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    try {
      const itemsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT rfid FROM acond_caja_items WHERE caja_id=$1`, [cajaId]));
      if(!itemsQ.rowCount) return res.status(404).json({ ok:false, error:'Caja sin items' });
      const rfids = itemsQ.rows.map((r:any)=> r.rfid);
      const sedeRows = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.sede_id
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id=$1`,
        [cajaId]
      ));
      const transferRows = (sedeRows.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
      const transferCheck = await ensureCrossSedeAuthorization(
        req,
        res,
        transferRows,
        sedeId,
        allowSedeTransferFlag,
        { fallbackRfids: rfids }
      );
      if (transferCheck.blocked) return;

      await runWithSede(tenant, sedeId, async (c)=>{
        const targetSede = transferCheck.targetSede;
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS estado_orden boolean DEFAULT true`);
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS habilitada boolean NOT NULL DEFAULT true`);
        await c.query('BEGIN');
        try {
          const orderRow = await c.query(`SELECT order_id FROM acond_cajas WHERE caja_id=$1 FOR UPDATE`, [cajaId]);
          const orderId = orderRow.rowCount ? orderRow.rows[0].order_id : null;
          await c.query(
            `UPDATE inventario_credocubes ic
                SET estado='Inspección',
                    sub_estado=NULL,
                    sede_id = COALESCE($2::int, ic.sede_id)
              WHERE ic.rfid = ANY($1::text[])
                AND ic.estado='Operación'`,
            [rfids, targetSede]
          );
          await c.query(`UPDATE inventario_credocubes SET numero_orden=NULL WHERE rfid = ANY($1::text[])`, [rfids]);
          await c.query(
            `UPDATE inventario_credocubes ic
                SET validacion_limpieza = NULL,
                    validacion_goteo = NULL,
                    validacion_desinfeccion = NULL
               FROM modelos m
              WHERE ic.rfid = ANY($1::text[])
                AND ic.modelo_id = m.modelo_id
                AND m.nombre_modelo ILIKE '%tic%'`, [rfids]
          );
          await c.query(`UPDATE acond_cajas SET order_id = NULL WHERE caja_id=$1`, [cajaId]);
          if(orderId){
            await c.query(`UPDATE ordenes SET estado_orden = false, habilitada = false WHERE id = $1`, [orderId]);
          }
          await c.query(`UPDATE acond_caja_timers SET active=false, started_at=NULL, duration_sec=NULL, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
          await c.query(`UPDATE operacion_caja_timers SET active=false, started_at=NULL, duration_sec=NULL, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
          await c.query(`CREATE TABLE IF NOT EXISTS inspeccion_caja_timers (
            caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
            started_at timestamptz,
            duration_sec integer,
            active boolean NOT NULL DEFAULT false,
            updated_at timestamptz NOT NULL DEFAULT NOW()
          )`);
          await c.query(`ALTER TABLE inspeccion_caja_timers ADD COLUMN IF NOT EXISTS duration_sec integer`);
          await c.query(
            `INSERT INTO inspeccion_caja_timers(caja_id, started_at, duration_sec, active, updated_at)
               VALUES ($1, NULL, NULL, false, NOW())
             ON CONFLICT (caja_id) DO UPDATE
               SET started_at = NULL,
                   duration_sec = NULL,
                   active = false,
                   updated_at = NOW()`,
            [cajaId]
          );
          await c.query('COMMIT');
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      }, { allowCrossSedeTransfer: transferCheck.allowCrossTransfer });
      res.json({ ok:true });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error enviando a Inspección' }); }
  },

  inspeccion: (_req: Request, res: Response) => res.render('operacion/inspeccion', { title: 'Operación · Inspección' }),
  inspeccionData: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    try {
      // Traer cajas cuyos items estén en estado 'Inspección'
      const nowRes = await withTenant(tenant, (c)=> c.query<{ now:string }>(`SELECT NOW()::timestamptz AS now`));
      const rowsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT c.caja_id, c.lote,
          aci.rol,
          ic.rfid,
          ic.estado,
          ic.sub_estado,
          ic.nombre_unidad,
          m.nombre_modelo
           FROM inventario_credocubes ic
      LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid
      LEFT JOIN acond_cajas c ON c.caja_id = aci.caja_id
      LEFT JOIN modelos m ON m.modelo_id = ic.modelo_id
          WHERE ic.estado='Inspección'
          ORDER BY c.caja_id NULLS LAST, ic.rfid`));
      const mapa: Record<string, any> = {};
      const ids: number[] = [];
      for(const r of rowsQ.rows as any[]){
        const id = r.caja_id || 0; // puede venir sin caja si se canceló mapping
        if(!mapa[id]){
          mapa[id] = {
            id,
            codigoCaja: r.lote || (id? ('CAJA-'+id): '(sin lote)'),
            componentes: [] as any[],
            timer: null as null | { startsAt: string }
          };
        }
        mapa[id].componentes.push({ codigo: r.rfid, tipo: r.rol||inferRol(r.nombre_modelo||'') , estado: r.estado, sub_estado: r.sub_estado, nombreUnidad: r.nombre_unidad || null });
        if(id && !ids.includes(id)) ids.push(id);
      }
      function inferRol(nombre:string){ const n=nombre.toLowerCase(); if(n.includes('vip')) return 'vip'; if(n.includes('tic')) return 'tic'; if(n.includes('cube')||n.includes('cubo')) return 'cube'; return 'otro'; }
      // Asegurar tabla de timers (sin auto-iniciar). Sólo leer timers existentes con duración (cuenta regresiva)
      if(ids.length){
        await withTenant(tenant, async (c)=>{
          await c.query(`CREATE TABLE IF NOT EXISTS inspeccion_caja_timers (
             caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
             started_at timestamptz,
             duration_sec integer,
             active boolean NOT NULL DEFAULT false,
             updated_at timestamptz NOT NULL DEFAULT NOW()
          )`);
          await c.query(`ALTER TABLE inspeccion_caja_timers ADD COLUMN IF NOT EXISTS duration_sec integer`);
          // Obtener timers existentes
          const tQ = await c.query(`SELECT caja_id, started_at, duration_sec, active FROM inspeccion_caja_timers WHERE caja_id = ANY($1::int[])`, [ids]);
          const tMap = new Map<number, any>(tQ.rows.map((r:any)=> [r.caja_id, r]));
          for(const id of ids){
            const g = mapa[id]; if(!g) continue;
            const t = tMap.get(id);
            if(t && (t.duration_sec || 0) > 0){ g.timer = { startsAt: t.started_at, durationSec: t.duration_sec }; }
          }
        });
      }
      Object.values(mapa).forEach((c:any) => {
        const cubeComp = (c.componentes||[]).find((cmp:any) => cmp?.tipo === 'cube' && cmp?.nombreUnidad);
        c.nombreCaja = cubeComp?.nombreUnidad?.trim() || c.codigoCaja;
      });
      const cajas = Object.values(mapa).filter((c:any)=> (c.componentes||[]).length>0);
      res.json({ ok:true, serverNow: nowRes.rows[0]?.now, cajas });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error inspección data' }); }
  },
  // ==== INSPECCIÓN: flujo de validación TICs ====
  // 1) Identificar caja por un RFID (de cualquier componente) y devolver TICs de esa caja si está en Inspección
  inspeccionCajaLookup: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { rfid } = req.body as any;
    const code = typeof rfid === 'string' ? rfid.trim() : '';
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    if(code.length !== 24) return res.status(400).json({ ok:false, error:'RFID inválido' });
    try {
      const cajaQ = await withTenant(tenant, (c)=> c.query(
        `SELECT c.caja_id, c.lote
           FROM acond_caja_items aci
           JOIN acond_cajas c ON c.caja_id = aci.caja_id
          WHERE aci.rfid = $1
          LIMIT 1`, [code]));
      if(!cajaQ.rowCount) return res.status(404).json({ ok:false, error:'RFID no pertenece a ninguna caja' });
      const cajaId = cajaQ.rows[0].caja_id; const lote = cajaQ.rows[0].lote;

      const fetchTics = async () => {
        const q = await withTenant(tenant, (c)=> c.query(
          `SELECT ic.rfid, ic.estado, ic.sub_estado, ic.validacion_limpieza, ic.validacion_goteo, ic.validacion_desinfeccion
             FROM acond_caja_items aci
             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
             JOIN modelos m ON m.modelo_id = ic.modelo_id
            WHERE aci.caja_id = $1
              AND (m.nombre_modelo ILIKE '%tic%')
              AND LOWER(ic.estado) IN ('inspeccion','inspección')
            ORDER BY ic.rfid`, [cajaId]));
        return q.rows || [];
      };

      const fetchVipCube = async () => {
        const q = await withTenant(tenant, (c)=> c.query(
          `SELECT ic.rfid,
                  CASE WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                       WHEN (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%') THEN 'cube'
                       ELSE 'otro' END AS rol
             FROM acond_caja_items aci
             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
             JOIN modelos m ON m.modelo_id = ic.modelo_id
            WHERE aci.caja_id = $1
              AND LOWER(ic.estado) IN ('inspeccion','inspección')
              AND (m.nombre_modelo ILIKE '%vip%' OR m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%')
            ORDER BY ic.rfid`, [cajaId]));
        return q.rows || [];
      };

      let tics = await fetchTics();
      let comps: any[] = [];
      let reactivated = false;

      if(!tics.length){
        comps = await fetchVipCube();
        if(!comps.length){
          const pendQ = await withTenant(tenant, (c)=> c.query(
            `SELECT COUNT(*)::int AS cnt
               FROM acond_caja_items aci
               JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
              WHERE aci.caja_id = $1
                AND LOWER(ic.estado)=LOWER('En bodega')
                AND ic.sub_estado IN ('Pendiente a Inspección','Pendiente a Inspeccion')`, [cajaId]));
          const pendCount = pendQ.rows[0]?.cnt || 0;
          if(pendCount > 0){
            const sedeRows = await withTenant(tenant, (c)=> c.query(
              `SELECT ic.rfid, ic.sede_id
                 FROM acond_caja_items aci
                 JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
                WHERE aci.caja_id=$1`,
              [cajaId]
            ));
            const fallbackRfids = (sedeRows.rows as any[]).map((row) => row.rfid);
            const transferCheck = await ensureCrossSedeAuthorization(
              req,
              res,
              (sedeRows.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id })),
              sedeId,
              allowSedeTransferFlag,
              { fallbackRfids }
            );
            if (transferCheck.blocked) return;

            await runWithSede(tenant, sedeId, async (c)=>{
              await c.query(`CREATE TABLE IF NOT EXISTS pend_insp_caja_timers (
                 caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
                 started_at timestamptz,
                 duration_sec integer,
                 active boolean NOT NULL DEFAULT false,
                 updated_at timestamptz NOT NULL DEFAULT NOW()
              )`);
              await c.query(`CREATE TABLE IF NOT EXISTS inspeccion_caja_timers (
                 caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
                 started_at timestamptz,
                 duration_sec integer,
                 active boolean NOT NULL DEFAULT false,
                 updated_at timestamptz NOT NULL DEFAULT NOW()
              )`);
              await c.query('BEGIN');
              try {
                const targetSede = transferCheck.targetSede;
                await c.query(
                  `UPDATE inventario_credocubes ic
                      SET estado='Inspección',
                          sub_estado=NULL,
                          sede_id = COALESCE($2::int, ic.sede_id)
                    WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)`,
                  [cajaId, targetSede]
                );
                await c.query(`DELETE FROM pend_insp_caja_timers WHERE caja_id=$1`, [cajaId]);
                await c.query(
                  `INSERT INTO inspeccion_caja_timers(caja_id, started_at, duration_sec, active, updated_at)
                     VALUES ($1, NULL, NULL, false, NOW())
                   ON CONFLICT (caja_id) DO UPDATE
                     SET active=false, started_at=NULL, updated_at=NOW()`,
                  [cajaId]
                );
                await c.query('COMMIT');
              } catch(e){ await c.query('ROLLBACK'); throw e; }
            }, { allowCrossSedeTransfer: transferCheck.allowCrossTransfer });
            reactivated = true;
            tics = await fetchTics();
            comps = await fetchVipCube();
          }
        }

        if(!tics.length && !comps.length){
          return res.status(400).json({ ok:false, error:'Caja no está en Inspección ni Pendiente a Inspección' });
        }
      }

      if(!comps.length){
        comps = await fetchVipCube();
      }

      return res.json({ ok:true, caja:{ id: cajaId, lote }, tics, comps, reactivated });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error lookup caja inspección' }); }
  },
  // 1b) Pull: desde Inspección, escanear un RFID (TIC/VIP/CUBE) de una caja que esté en 'En bodega · Pendiente a Inspección', cancelar su timer pendiente, iniciar un timer manual de inspección y devolver info para checklist
  inspeccionPullFromPending: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { rfid, durationSec } = req.body as any;
    const code = typeof rfid === 'string' ? rfid.trim() : '';
    const dur = Number(durationSec);
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    if(code.length !== 24) return res.status(400).json({ ok:false, error:'RFID inválido' });
    if(!Number.isFinite(dur) || dur<=0) return res.status(400).json({ ok:false, error:'Se requiere un cronómetro (horas/minutos)' });
    try {
      // Localizar caja por RFID
      const cajaQ = await withTenant(tenant, (c)=> c.query(
        `SELECT c.caja_id, c.lote
           FROM acond_caja_items aci
           JOIN acond_cajas c ON c.caja_id = aci.caja_id
          WHERE aci.rfid = $1
          LIMIT 1`, [code]));
      if(!cajaQ.rowCount) return res.status(404).json({ ok:false, error:'RFID no pertenece a ninguna caja' });
      const cajaId = cajaQ.rows[0].caja_id; const lote = cajaQ.rows[0].lote;
      // Verificar que la caja esté en Pendiente a Inspección
      const pendQ = await withTenant(tenant, (c)=> c.query(
        `SELECT COUNT(*)::int AS cnt
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id = $1 AND LOWER(ic.estado)=LOWER('En bodega') AND ic.sub_estado IN ('Pendiente a Inspección','Pendiente a Inspeccion')`, [cajaId]));
      if(!pendQ.rowCount || pendQ.rows[0].cnt<=0) return res.status(400).json({ ok:false, error:'La caja no está Pendiente a Inspección' });

      const sedeRows = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.sede_id
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id=$1`,
        [cajaId]
      ));
      const fallbackRfids = (sedeRows.rows as any[]).map((row) => row.rfid);
      const transferCheck = await ensureCrossSedeAuthorization(
        req,
        res,
        (sedeRows.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id })),
        sedeId,
        allowSedeTransferFlag,
        { fallbackRfids }
      );
      if (transferCheck.blocked) return;

      await runWithSede(tenant, sedeId, async (c)=>{
        await c.query('BEGIN');
        try {
          const targetSede = transferCheck.targetSede;
          // 1) Mover todos los items de la caja a Inspección, limpiar sub_estado
          await c.query(
            `UPDATE inventario_credocubes ic
                SET estado='Inspección',
                    sub_estado=NULL,
                    sede_id = COALESCE($2::int, ic.sede_id)
              WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)`,
            [cajaId, targetSede]
          );
          // 2) Resetear checklist solo para TICs
          await c.query(
            `UPDATE inventario_credocubes ic
                SET validacion_limpieza = NULL,
                    validacion_goteo = NULL,
                    validacion_desinfeccion = NULL
               FROM modelos m
              WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                AND ic.modelo_id = m.modelo_id
                AND m.nombre_modelo ILIKE '%tic%'`, [cajaId]
          );
          // 3) Cancelar timer pendiente y arrancar timer de inspección (manual con duración)
          await c.query(`CREATE TABLE IF NOT EXISTS pend_insp_caja_timers (
             caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
             started_at timestamptz,
             duration_sec integer,
             active boolean NOT NULL DEFAULT false,
             updated_at timestamptz NOT NULL DEFAULT NOW()
          )`);
          await c.query(`DELETE FROM pend_insp_caja_timers WHERE caja_id=$1`, [cajaId]);
          await c.query(`CREATE TABLE IF NOT EXISTS inspeccion_caja_timers (
             caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
             started_at timestamptz,
             duration_sec integer,
             active boolean NOT NULL DEFAULT false,
             updated_at timestamptz NOT NULL DEFAULT NOW()
          )`);
          await c.query(`ALTER TABLE inspeccion_caja_timers ADD COLUMN IF NOT EXISTS duration_sec integer`);
          await c.query(
            `INSERT INTO inspeccion_caja_timers(caja_id, started_at, duration_sec, active, updated_at)
               VALUES ($1, NOW(), $2, true, NOW())
             ON CONFLICT (caja_id) DO UPDATE
               SET started_at = NOW(), duration_sec = EXCLUDED.duration_sec, active = true, updated_at = NOW()`,
            [cajaId, dur]
          );
          await c.query('COMMIT');
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      }, { allowCrossSedeTransfer: transferCheck.allowCrossTransfer });

      // Devolver info de checklist (TICs ahora en Inspección)
      const ticsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.estado, ic.sub_estado, ic.validacion_limpieza, ic.validacion_goteo, ic.validacion_desinfeccion
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id = $1
          ORDER BY ic.rfid`, [cajaId]));
      return res.json({ ok:true, caja:{ id: cajaId, lote }, tics: ticsQ.rows||[] });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error al jalar caja a Inspección' }); }
  },
  // Preview-only: verify a caja (by any component RFID) is exactly 'En bodega · Pendiente a Inspección' and return its items/roles
  inspeccionPendingPreview: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { rfid } = req.body as any;
    const code = typeof rfid === 'string' ? rfid.trim() : '';
    if(code.length !== 24){ return res.status(400).json({ ok:false, error:'RFID inválido' }); }
    try{
      const cajaQ = await withTenant(tenant, (c)=> c.query(
        `SELECT c.caja_id, c.lote
           FROM acond_caja_items aci
           JOIN acond_cajas c ON c.caja_id = aci.caja_id
          WHERE aci.rfid = $1
          LIMIT 1`, [code]));
      if(!cajaQ.rowCount) return res.status(404).json({ ok:false, error:'RFID no pertenece a ninguna caja' });
      const cajaId = cajaQ.rows[0].caja_id; const lote = cajaQ.rows[0].lote;
      const pendQ = await withTenant(tenant, (c)=> c.query(
        `SELECT COUNT(*)::int AS cnt
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id = $1
            AND LOWER(ic.estado) = LOWER('En bodega')
            AND ic.sub_estado IN ('Pendiente a Inspección','Pendiente a Inspeccion')`, [cajaId]));
      if(!pendQ.rowCount || pendQ.rows[0].cnt<=0){ return res.json({ ok:false, error:'Caja no está Pendiente a Inspección' }); }
      const itemsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT aci.rfid, aci.rol
           FROM acond_caja_items aci
          WHERE aci.caja_id = $1
          ORDER BY CASE aci.rol WHEN 'vip' THEN 0 WHEN 'tic' THEN 1 WHEN 'cube' THEN 2 ELSE 3 END, aci.rfid`, [cajaId]));
      return res.json({ ok:true, caja:{ id: cajaId, lote }, items: itemsQ.rows });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error preview' }); }
  },
  // 2) (Deprecated to no-op) Actualizar checklist para una TIC — ahora no persiste nada; se mantiene por compatibilidad
  inspeccionTicChecklist: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { rfid, field, value } = req.body as any;
    const code = typeof rfid==='string' ? rfid.trim() : '';
    const f = typeof field==='string' ? field.toLowerCase() : '';
    if(code.length!==24 || !['limpieza','goteo','desinfeccion'].includes(f)){
      return res.status(400).json({ ok:false, error:'Entrada inválida' });
    }
    // No persistence: just check that the RFID exists; return ok
    try {
      const ex = await withTenant(tenant, (c)=> c.query(`SELECT 1 FROM inventario_credocubes WHERE rfid=$1`, [code]));
      if(!ex.rowCount) return res.status(404).json({ ok:false, error:'RFID no encontrado' });
      res.json({ ok:true, persisted:false });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error checklist (no-op)' }); }
  },
  // 3) Completar inspección de una caja: validar que se envían 6 TICs confirmadas del conjunto de la caja en Inspección y devolver todo a Bodega
  inspeccionCajaComplete: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { caja_id, confirm_rfids } = req.body as any;
    const cajaId = Number(caja_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    try {
      const list = Array.isArray(confirm_rfids) ? confirm_rfids.filter((x:any)=> typeof x==='string' && x.trim().length===24) : [];
      // Validate against current TICs in Inspección for this caja (can be 0..6)
      const ticsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
           JOIN modelos m ON m.modelo_id = ic.modelo_id
          WHERE aci.caja_id = $1
            AND (m.nombre_modelo ILIKE '%tic%')
            AND LOWER(ic.estado) IN ('inspeccion','inspección')`, [cajaId]));
      const current = (ticsQ.rows||[]).map((r:any)=> r.rfid);
      const set = new Set(current);
      const allBelong = list.every((r:string)=> set.has(r));
      if(!allBelong || list.length !== current.length){
        return res.status(400).json({ ok:false, error:'Faltan checks de TICs o hay RFIDs inválidos' });
      }

      const sedeRows = await withTenant(tenant, (c)=> c.query(
        `SELECT aci.rfid, ic.sede_id
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id=$1`,
        [cajaId]
      ));
      const cajaRfids = (sedeRows.rows as any[]).map((row) => row.rfid);
      const transferCheck = await ensureCrossSedeAuthorization(
        req,
        res,
        (sedeRows.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id })),
        sedeId,
        allowSedeTransferFlag,
        { fallbackRfids: cajaRfids }
      );
      if (transferCheck.blocked) return;

      // Con todas las TICs OK: devolver a En bodega SOLO los items que estén actualmente en Inspección (TICs/VIP/CUBE).
      // No tocar piezas previamente marcadas como Inhabilitado.
      await runWithSede(tenant, sedeId, async (c)=>{
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS habilitada boolean NOT NULL DEFAULT true`);
        await c.query('BEGIN');
        try {
          const targetSede = transferCheck.targetSede;
          const cajaParams: any[] = [cajaId];
          let cajaSedeJoin = '';
          if(sedeId !== null){
            cajaParams.push(sedeId);
            cajaSedeJoin = ` JOIN acond_caja_items aci2 ON aci2.caja_id = c.caja_id
                             JOIN inventario_credocubes ic2 ON ic2.rfid = aci2.rfid AND ic2.sede_id = $2`;
          }
          const orderRow = await c.query(`SELECT c.order_id FROM acond_cajas c${cajaSedeJoin ? cajaSedeJoin : ''} WHERE c.caja_id=$1 FOR UPDATE`, cajaParams);
          const orderId = orderRow.rowCount ? orderRow.rows[0].order_id : null;
          // 1) Devolver a En bodega sólo los RFIDs de esta caja cuyo estado actual sea Inspección
          const upd = await c.query(
            `UPDATE inventario_credocubes ic
                SET estado='En bodega', sub_estado=NULL, lote=NULL,
                    sede_id = COALESCE($2::int, ic.sede_id)
              WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                AND LOWER(ic.estado) IN ('inspeccion','inspección')
              RETURNING ic.rfid`, [cajaId, targetSede]);
          // 2) Inhabilitar orden asociada (si aplica)
          if (orderId) {
            await c.query(`UPDATE ordenes SET habilitada = false WHERE id = $1`, [orderId]);
          }
          // 3) No persistimos checklist; no hay que limpiar columnas de validación
          // 4) Eliminar/limpiar timers asociados a la caja
          await c.query(`DELETE FROM inspeccion_caja_timers WHERE caja_id=$1`, [cajaId]);
          await c.query(`DELETE FROM acond_caja_timers WHERE caja_id=$1`, [cajaId]);
          await c.query(`DELETE FROM operacion_caja_timers WHERE caja_id=$1`, [cajaId]);
          // 5) Eliminar asociaciones y la caja: empezar de cero
          await c.query(`DELETE FROM acond_caja_items WHERE caja_id=$1`, [cajaId]);
          await c.query(`DELETE FROM acond_cajas WHERE caja_id=$1`, [cajaId]);
          await c.query('COMMIT');
          // Responder después del commit con totales devueltos
          const count = upd.rowCount || 0;
          return res.json({ ok:true, devueltos: count, caja_deleted: true });
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      }, { allowCrossSedeTransfer: transferCheck.allowCrossTransfer });
      // Inalcanzable normalmente: si se llega aquí, algo falló en el transaction handler
      return;
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error completando inspección' }); }
  },
  // INSPECCIÓN: registrar novedad e inhabilitar pieza
  inspeccionNovedadInhabilitar: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const user = (req as any).user || {};
    const { rfid, tipo, motivo, descripcion, severidad, inhabilita } = req.body as any;
    const code = typeof rfid==='string' ? rfid.trim() : '';
    if(code.length !== 24) return res.status(400).json({ ok:false, error:'RFID inválido' });
    const tp = (typeof tipo==='string' ? tipo.toLowerCase() : 'otro');
    const sv = Number(severidad); const sev = Number.isFinite(sv) ? Math.min(5, Math.max(1, sv)) : 3;
    const inh = !(inhabilita===false || inhabilita==='false');
    const mot = (typeof motivo==='string' ? motivo.trim() : '');
    const desc = (typeof descripcion==='string' ? descripcion.trim() : null);
    if(!mot) return res.status(400).json({ ok:false, error:'Motivo requerido' });
    try{
      const rItem = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.id, ic.rfid, m.nombre_modelo
           FROM inventario_credocubes ic
           JOIN modelos m ON m.modelo_id = ic.modelo_id
          WHERE ic.rfid=$1`, [code]));
      if(!rItem.rowCount) return res.status(404).json({ ok:false, error:'RFID no encontrado' });
      const piezaId = rItem.rows[0].id;
      const nombreModelo = String((rItem.rows[0] as any).nombre_modelo||'');
      const lower = nombreModelo.toLowerCase();
      const piezaRol: 'tic'|'vip'|'cube'|'otro' = lower.includes('tic') ? 'tic' : (lower.includes('vip') ? 'vip' : ((lower.includes('cube')||lower.includes('cubo')) ? 'cube' : 'otro'));
  let autoReturnedCount = 0;
  let clearedCaja = false;
  await runWithSede(tenant, sedeId, async (c)=>{
        await c.query('BEGIN');
        try{
          await c.query(`CREATE TABLE IF NOT EXISTS inspeccion_novedades (
            novedad_id serial PRIMARY KEY,
            pieza_id integer NOT NULL,
            rfid text,
            tipo text NOT NULL CHECK (tipo IN ('fisico','funcional','contaminacion','faltante','otro')),
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
          await c.query(`DO $$
          BEGIN
            BEGIN
              EXECUTE 'ALTER TABLE inspeccion_novedades
                       ADD CONSTRAINT IF NOT EXISTS inspeccion_novedades_pieza_fk
                       FOREIGN KEY (pieza_id) REFERENCES inventario_credocubes(id) ON DELETE CASCADE';
            EXCEPTION WHEN others THEN END;
            BEGIN
              EXECUTE 'ALTER TABLE inspeccion_novedades
                       ADD CONSTRAINT IF NOT EXISTS inspeccion_novedades_rfid_fk
                       FOREIGN KEY (rfid) REFERENCES inventario_credocubes(rfid) ON DELETE SET NULL';
            EXCEPTION WHEN others THEN END;
          END$$;`);
          await c.query(`CREATE OR REPLACE FUNCTION trg_set_actualizado_en() RETURNS trigger AS $$
          BEGIN NEW.actualizado_en := NOW(); RETURN NEW; END$$ LANGUAGE plpgsql;`);
          await c.query(`DROP TRIGGER IF EXISTS trg_inspeccion_nov_set_updated ON inspeccion_novedades`);
          await c.query(`CREATE TRIGGER trg_inspeccion_nov_set_updated
            BEFORE UPDATE ON inspeccion_novedades FOR EACH ROW EXECUTE FUNCTION trg_set_actualizado_en()`);

          // Registrar novedad y obtener su ID
          const novIns = await c.query(
            `INSERT INTO inspeccion_novedades (pieza_id, rfid, tipo, motivo, descripcion, severidad, inhabilita, creado_por)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING novedad_id`,
             [piezaId, code, tp, mot, desc, sev, inh, (user.email||user.name||user.id||'sistema')]
          );
          const createdNovedadId = Number(novIns.rows?.[0]?.novedad_id||0) || null;
          // Asegurar tabla de auditoría y registrar evento vinculado a la novedad/pieza
          await c.query(`
            CREATE TABLE IF NOT EXISTS auditorias_credocubes (
              id SERIAL PRIMARY KEY,
              inventario_id INTEGER NULL,
              novedad_id INTEGER NULL,
              comentarios TEXT NULL,
              auditada BOOLEAN NOT NULL DEFAULT FALSE,
              fecha TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_auditorias_fecha ON auditorias_credocubes (fecha DESC);
            CREATE INDEX IF NOT EXISTS idx_auditorias_auditada ON auditorias_credocubes (auditada, fecha DESC);
            CREATE INDEX IF NOT EXISTS idx_auditorias_inv ON auditorias_credocubes (inventario_id);
            CREATE INDEX IF NOT EXISTS idx_auditorias_nov ON auditorias_credocubes (novedad_id);
          `);
          await c.query(
            `INSERT INTO auditorias_credocubes (inventario_id, novedad_id, comentarios, auditada, fecha)
             VALUES ($1, $2, NULL, FALSE, NOW())`,
            [piezaId, createdNovedadId]
          );
          await c.query(`UPDATE inventario_credocubes
                            SET estado='Inhabilitado', sub_estado=NULL, activo=false, lote=NULL
                          WHERE id=$1`, [piezaId]);

          // If all TICs in this caja are now inhabilitadas, send VIP and CUBE back to En bodega and teardown the caja
          const cajaQ = await c.query(`SELECT caja_id FROM acond_caja_items WHERE rfid=$1 LIMIT 1`, [code]);
          if(cajaQ.rowCount){
            const cajaId = cajaQ.rows[0].caja_id as number;
            // Count TICs and how many are inactive
            const agg = await c.query(
              `SELECT
                 SUM(CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 1 ELSE 0 END)::int AS total_tics,
                 SUM(CASE WHEN m.nombre_modelo ILIKE '%tic%' AND ic.activo = false THEN 1 ELSE 0 END)::int AS inact_tics
               FROM acond_caja_items aci
               JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
               JOIN modelos m ON m.modelo_id = ic.modelo_id
              WHERE aci.caja_id = $1`, [cajaId]);
            const totalTics = Number(agg.rows?.[0]?.total_tics||0);
            const inactTics = Number(agg.rows?.[0]?.inact_tics||0);
            if(totalTics>0 && inactTics === totalTics && piezaRol === 'tic'){
              // Todos los TICs quedaron inhabilitados: NO devolver VIP/CUBE a Bodega.
              // Mantener VIP y CUBE en Inspección para su revisión y conservar la caja/timers.
              const vc = await c.query(`SELECT rfid FROM acond_caja_items WHERE caja_id=$1 AND rol IN ('vip','cube')`, [cajaId]);
              const vcrfids = (vc.rows||[]).map((r:any)=> r.rfid);
              if(vcrfids.length){
                await c.query(`UPDATE inventario_credocubes SET estado='Inspección', sub_estado=NULL WHERE rfid = ANY($1::text[])`, [vcrfids]);
                // Asegurar timer de Inspección activo (no crear duplicados, reutilizar si existe)
                await c.query(`CREATE TABLE IF NOT EXISTS inspeccion_caja_timers (
                  caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
                  started_at timestamptz,
                  duration_sec integer,
                  active boolean NOT NULL DEFAULT false,
                  updated_at timestamptz NOT NULL DEFAULT NOW()
                )`);
                await c.query(`ALTER TABLE inspeccion_caja_timers ADD COLUMN IF NOT EXISTS duration_sec integer`);
                await c.query(
                  `INSERT INTO inspeccion_caja_timers(caja_id, started_at, active, updated_at)
                     VALUES ($1, COALESCE((SELECT started_at FROM inspeccion_caja_timers WHERE caja_id=$1), NOW()), true, NOW())
                   ON CONFLICT (caja_id) DO UPDATE
                     SET active = true, updated_at = NOW()`,
                  [cajaId]
                );
              }
              // Importante: NO desarmar la caja ni borrar timers; requiere revisión de VIP/CUBE.
              autoReturnedCount = 0;
            }

            // Después de registrar la novedad, si ya no quedan items en estado 'Inspección' dentro de la caja,
            // limpiar cronómetro y desmontar la caja.
            const leftQ = await c.query(
              `SELECT COUNT(*)::int AS cnt
                 FROM acond_caja_items aci
                 JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
                WHERE aci.caja_id = $1 AND LOWER(ic.estado) IN ('inspeccion','inspección')`, [cajaId]);
            const remain = Number(leftQ.rows?.[0]?.cnt||0);
            if(remain === 0){
              await c.query(`DELETE FROM inspeccion_caja_timers WHERE caja_id=$1`, [cajaId]);
              await c.query(`DELETE FROM acond_caja_items WHERE caja_id=$1`, [cajaId]);
              await c.query(`DELETE FROM acond_cajas WHERE caja_id=$1`, [cajaId]);
              clearedCaja = true;
            }
          }
          await c.query('COMMIT');
        }catch(e){ await c.query('ROLLBACK'); throw e; }
      });
      return res.json({ ok:true, auto_returned: autoReturnedCount, cleared: clearedCaja });
    }catch(e:any){ return res.status(500).json({ ok:false, error: e.message||'Error registrando novedad' }); }
  },
  // Vista: En bodega
  bodega: (_req: Request, res: Response) => res.render('operacion/bodega', { title: 'Operación · En bodega' }),
  // Datos para la vista En bodega
  bodegaData: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    try {
  const page = Math.max(1, parseInt(String(req.query.page||'1'),10)||1);
  const limit = Math.min(200, Math.max(5, parseInt(String(req.query.limit||'10'),10)||10));
      const offset = (page-1)*limit;
      const q = (req.query.q||'').toString().trim();
      const cat = (req.query.cat||'').toString(); // tics | vips | cubes
  const filters: string[] = ["TRIM(LOWER(ic.estado))=TRIM(LOWER('En bodega'))"]; const params: any[] = [];
      if(q){
        params.push('%'+q.toLowerCase()+'%');
        const idx = params.length;
        // Correct empty string quoting inside COALESCE
        filters.push(`(LOWER(ic.rfid) LIKE $${idx} OR LOWER(ic.nombre_unidad) LIKE $${idx} OR LOWER(COALESCE(ic.lote,'')) LIKE $${idx})`);
      }
      if(cat){
        if(cat==='tics'){ params.push('%tic%'); filters.push('m.nombre_modelo ILIKE $'+params.length); }
        else if(cat==='vips'){ params.push('%vip%'); filters.push('m.nombre_modelo ILIKE $'+params.length); }
  else if(cat==='cubes'){ params.push('%cube%'); filters.push('(m.nombre_modelo ILIKE $'+params.length+" OR m.nombre_modelo ILIKE '%cubo%')"); }
      }
      if(sedeId !== null){
        params.push(sedeId);
        filters.push(`ic.sede_id = $${params.length}`);
      }
      const where = filters.length? ('WHERE '+filters.join(' AND ')) : '';
      const baseSel = `FROM inventario_credocubes ic JOIN modelos m ON m.modelo_id = ic.modelo_id ${where}`;
   // Use parameterized limit/offset via appended params to avoid string concat issues (even if safe here)
   params.push(limit); const limitIdx = params.length;
   params.push(offset); const offsetIdx = params.length;
      let rows; let usedUpdatedAt=true;
      try {
        rows = await withTenant(tenant, (c) => c.query(
          `SELECT ic.id AS id, ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado, m.nombre_modelo,
         CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 'TIC'
           WHEN m.nombre_modelo ILIKE '%vip%' THEN 'VIP'
           WHEN (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%') THEN 'CUBE'
           ELSE 'OTRO' END AS categoria,
         ic.updated_at AS fecha_ingreso
       ${baseSel}
       ORDER BY ic.updated_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`, params));
      } catch(e:any){
        // Si la columna updated_at no existe (bases antiguas), reintentar usando id
        if(e?.code==='42703'){
          usedUpdatedAt=false;
          rows = await withTenant(tenant, (c) => c.query(
            `SELECT ic.id AS id, ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado, m.nombre_modelo,
             CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 'TIC'
               WHEN m.nombre_modelo ILIKE '%vip%' THEN 'VIP'
               WHEN (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%') THEN 'CUBE'
               ELSE 'OTRO' END AS categoria,
             NOW() AS fecha_ingreso
             ${baseSel}
             ORDER BY ic.id DESC
             LIMIT $${limitIdx} OFFSET $${offsetIdx}`, params));
        } else { throw e; }
      }
  const totalQ = await withTenant(tenant, (c) => c.query(`SELECT COUNT(*)::int AS total ${baseSel}`, params.slice(0, params.length-2))); // exclude limit & offset
  res.json({ ok:true, page, limit, total: totalQ.rows[0]?.total||0, items: rows.rows, meta:{ usedUpdatedAt, debug:{ filters, params: params.slice(0, params.length-2) } } });
    } catch(e:any){
      // Fallback: no bloquear la vista si algo falla. Log y retornar lista vacía.
  console.error('[bodegaData] error', e);
  res.json({ ok:true, page:1, limit:10, total:0, items:[], warning: e?.message || 'Error interno (se muestra vacío)' });
    }
  },

  // Sub vista: En bodega · Pendiente a Inspección (cajas)
  bodegaPendInspData: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    try {
  // Pagination params (independent from main Bodega list)
  const page = Math.max(1, parseInt(String(req.query.page||'1'),10)||1);
  const limit = Math.min(200, Math.max(8, parseInt(String(req.query.limit||'24'),10)||24));
  const offset = (page-1)*limit;
      // Ensure base tables exist and rebuild caja associations for items Pendiente a Inspección
      await withTenant(tenant, async (c) => {
        // Ensure caja tables
        await c.query(`CREATE TABLE IF NOT EXISTS acond_cajas (
           caja_id serial PRIMARY KEY,
           lote text NOT NULL,
           created_at timestamptz NOT NULL DEFAULT NOW()
        )`);
        await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_items (
           caja_id int NOT NULL REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
           rfid text NOT NULL,
           rol text NOT NULL CHECK (rol IN ('cube','vip','tic')),
           PRIMARY KEY (caja_id, rfid)
        )`);
        await c.query(`CREATE INDEX IF NOT EXISTS acond_caja_items_rfid_idx ON acond_caja_items(rfid)`);
        // 1) Ensure there is a caja row for every lote that has at least one item in En bodega · Pendiente a Inspección
        const ensureCajaParams: any[] = [];
        const ensureCajaSede = pushSedeFilter(ensureCajaParams, sedeId);
        await c.query(`
          INSERT INTO acond_cajas(lote)
          SELECT DISTINCT ic.lote
            FROM inventario_credocubes ic
       LEFT JOIN acond_cajas c ON c.lote = ic.lote
           WHERE LOWER(ic.estado) = LOWER('En bodega')
             AND ic.sub_estado IN ('Pendiente a Inspección','Pendiente a Inspeccion')
             AND c.caja_id IS NULL
             AND ic.lote IS NOT NULL AND ic.lote <> ''${ensureCajaSede}
        `, ensureCajaParams);
        // 2) Backfill missing item->caja associations for those items
        const ensureItemsParams: any[] = [];
        const ensureItemsSede = pushSedeFilter(ensureItemsParams, sedeId);
     await c.query(`
    INSERT INTO acond_caja_items(caja_id, rfid, rol)
    SELECT c.caja_id, ic.rfid,
        CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
          WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
          WHEN (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%') THEN 'cube'
        END AS rol
      FROM inventario_credocubes ic
      JOIN modelos m ON m.modelo_id = ic.modelo_id
      JOIN acond_cajas c ON c.lote = ic.lote
    LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid AND aci.caja_id = c.caja_id
     WHERE LOWER(ic.estado) = LOWER('En bodega')
       AND ic.sub_estado IN ('Pendiente a Inspección','Pendiente a Inspeccion')
       AND aci.rfid IS NULL
       AND (
      m.nombre_modelo ILIKE '%tic%'
      OR m.nombre_modelo ILIKE '%vip%'
      OR m.nombre_modelo ILIKE '%cube%'
      OR m.nombre_modelo ILIKE '%cubo%'
       )${ensureItemsSede}
     `, ensureItemsParams);
      });
      // Count total cajas en 'En bodega · Pendiente a Inspección'
      const totalParams: any[] = [];
      const totalSede = pushSedeFilter(totalParams, sedeId);
      const totalQ = await withTenant(tenant, (c)=> c.query(
        `SELECT COUNT(DISTINCT c.caja_id)::int AS total
           FROM acond_cajas c
           JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE LOWER(ic.estado)=LOWER('En bodega')
            AND ic.sub_estado IN ('Pendiente a Inspección','Pendiente a Inspeccion')${totalSede}`,
        totalParams
      ));
      const total = totalQ.rows[0]?.total || 0;
      // Cajas con al menos un item en estado 'En bodega' y sub_estado 'Pendiente a Inspección' (paginado)
      const listParams: any[] = [];
      const listSede = pushSedeFilter(listParams, sedeId);
      listParams.push(limit); const listLimitIdx = listParams.length;
      listParams.push(offset); const listOffsetIdx = listParams.length;
      const cajasQ = await withTenant(tenant, (c)=> c.query(
        `SELECT c.caja_id, c.lote,
                COUNT(*) FILTER (WHERE m.nombre_modelo ILIKE '%tic%') AS tics,
                COUNT(*) FILTER (WHERE m.nombre_modelo ILIKE '%vip%') AS vips,
                COUNT(*) FILTER (WHERE (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%')) AS cubes
           FROM acond_cajas c
           JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
           JOIN modelos m ON m.modelo_id = ic.modelo_id
          WHERE LOWER(ic.estado)=LOWER('En bodega') AND ic.sub_estado IN ('Pendiente a Inspección','Pendiente a Inspeccion')${listSede}
          GROUP BY c.caja_id, c.lote
          ORDER BY c.caja_id DESC
          LIMIT $${listLimitIdx} OFFSET $${listOffsetIdx}`,
        listParams));
      const ids = cajasQ.rows.map((r:any)=> r.caja_id);
      let itemsRows:any[] = [];
      if(ids.length){
        const itemsParams: any[] = [ids];
        const itemsSede = pushSedeFilter(itemsParams, sedeId);
        const itQ = await withTenant(tenant, (c)=> c.query(
          `SELECT aci.caja_id, aci.rol, ic.rfid
             FROM acond_caja_items aci
             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
            WHERE aci.caja_id = ANY($1::int[])${itemsSede}
            ORDER BY aci.caja_id DESC, aci.rol, ic.rfid`, itemsParams));
        itemsRows = itQ.rows as any[];
      }
      await withTenant(tenant, (c)=> c.query(`CREATE TABLE IF NOT EXISTS pend_insp_caja_timers (
         caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
         started_at timestamptz,
         duration_sec integer,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW()
      )`));
      const timersQ = ids.length ? await withTenant(tenant, (c)=> c.query(`SELECT caja_id, started_at, duration_sec, active FROM pend_insp_caja_timers WHERE caja_id = ANY($1::int[])`, [ids])) : { rows: [] } as any;
      const nowRes = await withTenant(tenant, (c)=> c.query<{ now:string }>(`SELECT NOW()::timestamptz AS now`));
      const nowIso = nowRes.rows[0]?.now; const nowMs = new Date(nowIso).getTime();
      const compsMap: Record<string, any[]> = {};
      for(const r of itemsRows){ (compsMap[r.caja_id] ||= []).push({ tipo: r.rol, codigo: r.rfid }); }
      const tMap = new Map<number, any>((timersQ.rows||[]).map((r:any)=> [r.caja_id, r]));
      const cajas = (cajasQ.rows||[]).map((r:any)=>{
        const t = tMap.get(r.caja_id);
        let timer:null|{ startsAt:string; endsAt:string|null; completedAt:string|null } = null;
        if(t && t.started_at && t.duration_sec){
          const endMs = new Date(t.started_at).getTime() + (Number(t.duration_sec)||0)*1000;
          const endsAt = new Date(endMs).toISOString();
          timer = { startsAt: t.started_at, endsAt, completedAt: (!t.active && endMs<=nowMs)? endsAt : null };
        }
        return {
          id: r.caja_id,
          codigoCaja: r.lote,
          componentes: compsMap[r.caja_id]||[],
          timer
        };
      });
  res.json({ ok:true, serverNow: nowIso, cajas, page, limit, total });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error data pendiente inspección' }); }
  },
  bodegaPendInspTimerStart: async (req: Request, res: Response) => {
  // Seguridad: desde Bodega no se permite crear/cambiar el cronómetro de "Pendiente a Inspección".
  // El cronómetro se asigna únicamente al devolver (Devolución) o al jalar desde Inspección.
  return res.status(403).json({ ok:false, error:'No permitido: Bodega no puede modificar el cronómetro' });
  },
  /*bodegaPendInspTimerClear: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant; const { caja_id } = req.body as any;
    const cajaId = Number(caja_id); if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'Entrada inválida' });
    await withTenant(tenant, async (c)=>{
      await c.query(`CREATE TABLE IF NOT EXISTS pend_insp_caja_timers (
         caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
         started_at timestamptz,
         duration_sec integer,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW()
      )`);
      await c.query(
        `INSERT INTO pend_insp_caja_timers(caja_id, started_at, duration_sec, active, updated_at)
           VALUES ($1, NULL, NULL, false, NOW())
         ON CONFLICT (caja_id) DO UPDATE
           SET started_at = NULL, duration_sec = NULL, active = false, updated_at = NOW()`,
        [cajaId]
      );
    });
    res.json({ ok:true });
  },*/
  /*bodegaPendInspSendInspeccion: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant; const { caja_id } = req.body as any;
    const cajaId = Number(caja_id); if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'Entrada inválida' });
    try{
      const itemsQ = await withTenant(tenant, (c)=> c.query(`SELECT rfid FROM acond_caja_items WHERE caja_id=$1`, [cajaId]));
      if(!itemsQ.rowCount) return res.status(404).json({ ok:false, error:'Caja sin items' });
      const rfids = itemsQ.rows.map((r:any)=> r.rfid);
      await withTenant(tenant, async (c)=>{
        await c.query('BEGIN');
        try{
          await c.query(`UPDATE inventario_credocubes SET estado='Inspección', sub_estado=NULL WHERE rfid = ANY($1::text[]) AND estado='En bodega' AND sub_estado='Pendiente a Inspección'`, [rfids]);
          // Resetear checklist solo para TICs
          await c.query(
            `UPDATE inventario_credocubes ic
                SET validacion_limpieza = NULL,
                    validacion_goteo = NULL,
                    validacion_desinfeccion = NULL
               FROM modelos m
              WHERE ic.rfid = ANY($1::text[])
                AND ic.modelo_id = m.modelo_id
                AND m.nombre_modelo ILIKE '%tic%'`, [rfids]
          );
          // Clear pending timer and start inspeccion timer forward
          await c.query(`DELETE FROM pend_insp_caja_timers WHERE caja_id=$1`, [cajaId]);
          await c.query(`CREATE TABLE IF NOT EXISTS inspeccion_caja_timers (
             caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
             started_at timestamptz,
             active boolean NOT NULL DEFAULT false,
             updated_at timestamptz NOT NULL DEFAULT NOW()
          )`);
          await c.query(
            `INSERT INTO inspeccion_caja_timers(caja_id, started_at, active, updated_at)
               VALUES ($1, NOW(), true, NOW())
             ON CONFLICT (caja_id) DO UPDATE SET started_at = COALESCE(inspeccion_caja_timers.started_at, EXCLUDED.started_at), active = true, updated_at = NOW()`,
            [cajaId]
          );
          await c.query('COMMIT');
        }catch(e){ await c.query('ROLLBACK'); throw e; }
      });
      res.json({ ok:true });
    }catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error enviando a Inspección' }); }
  },*/

  // Data for pre-acondicionamiento lists
  preacondData: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    // Ensure timers table exists (global per-section timer)
    // Ensure tables live in tenant schema (migrate from public if needed)
    await withTenant(tenant, (c) => c.query(`DO $$
    DECLARE target_schema text := current_schema();
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE c.relname='preacond_item_timers' AND n.nspname='public'
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE c.relname='preacond_item_timers' AND n.nspname=target_schema
      ) THEN
        EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I','public','preacond_item_timers', target_schema);
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE c.relname='preacond_timers' AND n.nspname='public'
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE c.relname='preacond_timers' AND n.nspname=target_schema
      ) THEN
        EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I','public','preacond_timers', target_schema);
      END IF;
    END $$;`));
    await withTenant(tenant, (c) => c.query(
      `CREATE TABLE IF NOT EXISTS preacond_timers (
         section text PRIMARY KEY,
         started_at timestamptz,
         duration_sec integer,
         lote text,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW()
       )`));
    // Ensure item timers table exists (per-RFID timers)
    await withTenant(tenant, (c) => c.query(
      `CREATE TABLE IF NOT EXISTS preacond_item_timers (
         rfid text NOT NULL,
         section text NOT NULL,
         started_at timestamptz,
         duration_sec integer,
         lote text,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW(),
         PRIMARY KEY (rfid, section)
       )`));
    // Helpful index for frequent lookups/deletes
    await withTenant(tenant, (c) => c.query(`CREATE INDEX IF NOT EXISTS preacond_item_timers_rfid_idx ON preacond_item_timers(rfid)`));
    await withTenant(tenant, (c) => c.query(`DO $$
    BEGIN
      BEGIN
        EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS inventario_credocubes_rfid_key ON inventario_credocubes(rfid)';
      EXCEPTION WHEN others THEN
      END;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'preacond_item_timers'::regclass
           AND conname = 'preacond_item_timers_rfid_fkey'
      ) THEN
        ALTER TABLE preacond_item_timers
          ADD CONSTRAINT preacond_item_timers_rfid_fkey
          FOREIGN KEY (rfid) REFERENCES inventario_credocubes(rfid) ON DELETE CASCADE;
      END IF;
    END $$;`));

    // Try to add missing columns if table existed before
    await withTenant(tenant, (c) => c.query(`ALTER TABLE preacond_timers ADD COLUMN IF NOT EXISTS lote text`));
    await withTenant(tenant, (c) => c.query(`ALTER TABLE preacond_item_timers ADD COLUMN IF NOT EXISTS completed_at timestamptz`));

    // Auto-complete item timers whose duration already finished (even if UI not open)
    const expiredTimers = await withTenant(tenant, (c) => c.query<{
      rfid: string;
      section: 'congelamiento' | 'atemperamiento';
      completed_at: Date;
    }>(
      `SELECT pit.rfid,
              pit.section,
              (pit.started_at + pit.duration_sec * INTERVAL '1 second') AS completed_at
         FROM preacond_item_timers pit
        WHERE pit.active = true
          AND pit.started_at IS NOT NULL
          AND pit.duration_sec IS NOT NULL
          AND (pit.started_at + pit.duration_sec * INTERVAL '1 second') <= NOW()`
    ));
    if (expiredTimers.rowCount) {
      const rows = expiredTimers.rows;
      const rfids = rows.map((r) => r.rfid);
      const sections = rows.map((r) => r.section);
      const completedList = rows.map((r) => r.completed_at);
      await withTenant(tenant, async (c) => {
        await c.query('BEGIN');
        try {
          await c.query(
            `UPDATE inventario_credocubes ic
                SET sub_estado = CASE WHEN exp.section = 'congelamiento' THEN 'Congelado' ELSE 'Atemperado' END
               FROM UNNEST($1::text[], $2::text[]) AS exp(rfid, section)
              WHERE ic.rfid = exp.rfid`,
            [rfids, sections]
          );
          await c.query(
            `UPDATE preacond_item_timers pit
                SET completed_at = CASE
                                     WHEN pit.completed_at IS NOT NULL THEN pit.completed_at
                                     ELSE exp.completed_at
                                   END,
                    started_at = NULL,
                    duration_sec = NULL,
                    active = false,
                    updated_at = CASE
                                   WHEN exp.completed_at IS NOT NULL THEN exp.completed_at
                                   ELSE NOW()
                                 END
               FROM UNNEST($1::text[], $2::text[], $3::timestamptz[]) AS exp(rfid, section, completed_at)
              WHERE pit.rfid = exp.rfid AND pit.section = exp.section`,
            [rfids, sections, completedList]
          );
          const lotesQ = await c.query<{ rfid: string; lote: string | null }>(
            `SELECT ic.rfid, ic.lote FROM inventario_credocubes ic WHERE ic.rfid = ANY($1::text[])`,
            [rfids]
          );
          const loteMap = new Map<string, string | null>();
          for (const row of lotesQ.rows) {
            loteMap.set(row.rfid, row.lote);
          }
          for (const row of rows) {
            const nextState = row.section === 'congelamiento' ? 'Congelado' : 'Atemperado';
            const lote = (loteMap.get(row.rfid) || '').trim() || null;
            try {
              await AlertsModel.createOrIncrementPreacondGroup(c, {
                tipo_alerta: `inventario:preacond:${nextState.toLowerCase()}`,
                lote,
                nextState,
                delta: 1,
              });
            } catch (alertErr) {
              if (process.env.NODE_ENV === 'development') {
                console.warn('[preacondData] alerta expirado falló', alertErr);
              }
            }
          }
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK');
          throw err;
        }
      });
    }

    // Cleanup: drop rows for RFIDs that are no longer in Pre Acondicionamiento
    await withTenant(tenant, (c) => c.query(
      `DELETE FROM preacond_item_timers pit
         WHERE NOT EXISTS (
           SELECT 1 FROM inventario_credocubes ic
            WHERE ic.rfid = pit.rfid
              AND ic.estado = 'Pre Acondicionamiento'
              AND ic.sub_estado IN ('Congelamiento','Congelado','Atemperamiento','Atemperado')
         )`
    ));
    // Cleanup: clear section timer if no TICs remain for that section/lote
    await withTenant(tenant, (c) => c.query(
      `UPDATE preacond_timers pt
          SET started_at = NULL,
              duration_sec = NULL,
              lote = NULL,
              active = false,
              updated_at = NOW()
        WHERE NOT EXISTS (
                SELECT 1
                  FROM inventario_credocubes ic
                  JOIN modelos m ON m.modelo_id = ic.modelo_id
                 WHERE ic.estado = 'Pre Acondicionamiento'
                   AND ( (pt.section='congelamiento'   AND ic.sub_estado IN ('Congelamiento','Congelado'))
                      OR (pt.section='atemperamiento' AND ic.sub_estado IN ('Atemperamiento','Atemperado')) )
                   AND (pt.lote IS NULL OR ic.lote = pt.lote)
                   AND m.nombre_modelo ILIKE '%tic%'
            )`
    ));

   const rowsCongParams: any[] = [];
   const rowsCongSede = pushSedeFilter(rowsCongParams, sedeId);
   const rowsCong = await withTenant(tenant, (c) => c.query(
                  `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado,
                    pit.started_at AS started_at, pit.duration_sec AS duration_sec, pit.active AS item_active, pit.lote AS item_lote,
                    pit.updated_at AS item_updated_at, pit.completed_at AS item_completed_at
       FROM inventario_credocubes ic
       JOIN modelos m ON m.modelo_id = ic.modelo_id
       LEFT JOIN preacond_item_timers pit
         ON pit.rfid = ic.rfid AND pit.section = 'congelamiento'
  WHERE ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado IN ('Congelamiento','Congelado')
    AND ic.activo = true
         AND (m.nombre_modelo ILIKE '%tic%')${rowsCongSede}
       ORDER BY ic.id DESC
       LIMIT 500`, rowsCongParams));
   const rowsAtemParams: any[] = [];
   const rowsAtemSede = pushSedeFilter(rowsAtemParams, sedeId);
   const rowsAtem = await withTenant(tenant, (c) => c.query(
                  `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado,
                    pit.started_at AS started_at, pit.duration_sec AS duration_sec, pit.active AS item_active, pit.lote AS item_lote,
                    pit.updated_at AS item_updated_at, pit.completed_at AS item_completed_at
       FROM inventario_credocubes ic
       JOIN modelos m ON m.modelo_id = ic.modelo_id
       LEFT JOIN preacond_item_timers pit
         ON pit.rfid = ic.rfid AND pit.section = 'atemperamiento'
  WHERE ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado IN ('Atemperamiento','Atemperado')
    AND ic.activo = true
         AND (m.nombre_modelo ILIKE '%tic%')${rowsAtemSede}
       ORDER BY ic.id DESC
       LIMIT 500`, rowsAtemParams));
    const nowRes = await withTenant(tenant, (c) => c.query<{ now: string }>(`SELECT NOW()::timestamptz AS now`));
    const timers = await withTenant(tenant, (c) => c.query(
      `SELECT section, started_at, duration_sec, active, lote FROM preacond_timers WHERE section IN ('congelamiento','atemperamiento')`));
    const map: any = { congelamiento: null, atemperamiento: null };
    for(const r of timers.rows as any[]) map[r.section] = r;
    res.json({ now: nowRes.rows[0]?.now, timers: map, congelamiento: rowsCong.rows, atemperamiento: rowsAtem.rows });
  },

  // Scan/move TICs into Congelamiento or Atemperamiento
  preacondScan: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);

    try {
      const { target, rfids, keepLote } = req.body as any;
      const t = typeof target === 'string' ? target.toLowerCase() : '';
      const input = Array.isArray(rfids) ? rfids : (rfids ? [rfids] : []);
      const codes = [...new Set(input.filter((x: any) => typeof x === 'string').map((s: string) => s.trim()).filter(Boolean))];
      if (!codes.length || (t !== 'congelamiento' && t !== 'atemperamiento')) {
        return res.status(400).json({ ok: false, error: 'Entrada inválida' });
      }

      const normalize = (val: string | null | undefined): string => {
        return typeof val === 'string'
          ? val.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
          : '';
      };

      // Fetch current state for provided RFIDs
      const found = await withTenant(tenant, (c) => c.query(
        `SELECT ic.rfid, ic.estado, ic.sub_estado, ic.activo, ic.sede_id, m.nombre_modelo
           FROM inventario_credocubes ic
           JOIN modelos m ON m.modelo_id = ic.modelo_id
          WHERE ic.rfid = ANY($1::text[])`,
        [codes]));

      const ticSet = new Set((found.rows as any[])
        .filter(r => /tic/i.test(r.nombre_modelo || ''))
        .map(r => r.rfid));

      const rejects: { rfid: string; reason: string }[] = [];
      const accept: string[] = [];
      for (const code of codes) {
        if (!ticSet.has(code)) {
          rejects.push({ rfid: code, reason: 'No es TIC o no existe' });
          continue;
        }
        const cur = (found.rows as any[]).find(r => r.rfid === code);
        if (cur?.activo === false) {
          rejects.push({ rfid: code, reason: 'Item inhabilitado (activo=false)' });
          continue;
        }
        if (t === 'atemperamiento') {
          if (cur?.estado === 'Pre Acondicionamiento' && cur?.sub_estado === 'Congelado') {
            accept.push(code);
          } else if (cur?.estado === 'Pre Acondicionamiento' && (cur?.sub_estado === 'Atemperamiento' || cur?.sub_estado === 'Atemperado')) {
            rejects.push({ rfid: code, reason: 'Ya está en Atemperamiento' });
          } else {
            rejects.push({ rfid: code, reason: 'Debe estar Congelado' });
          }
        } else {
          const estadoNorm = normalize(cur?.estado);
          const subEstadoNorm = normalize(cur?.sub_estado);
          const enBodega = estadoNorm.includes('bodega');
          const desdeAtemperamiento = estadoNorm === 'pre acondicionamiento' && (subEstadoNorm === 'atemperamiento' || subEstadoNorm === 'atemperado');
          const subEstadoTieneValor = !!subEstadoNorm;
          // Congelamiento: no aceptar si ya está en Congelamiento o si proviene de otra fase
          if (cur?.estado === 'Pre Acondicionamiento' && (cur?.sub_estado === 'Congelamiento' || cur?.sub_estado === 'Congelado')) {
            rejects.push({ rfid: code, reason: 'Ya está en Congelamiento' });
          } else if (enBodega && subEstadoTieneValor) {
            rejects.push({ rfid: code, reason: `Subestado no permitido en Bodega (${cur?.sub_estado || 'pendiente'})` });
          } else if (!enBodega && !desdeAtemperamiento) {
            rejects.push({ rfid: code, reason: 'Solo se acepta desde En bodega o Atemperamiento' });
          } else {
            accept.push(code);
          }
        }
      }

      if (accept.length) {
        console.log('[preacondScan] transfer check', {
          allowFlag: allowSedeTransferFlag,
          bodyAllow: req.body?.allowSedeTransfer,
          sedeId,
          acceptCount: accept.length,
        });
        let locationResult: { apply: boolean; zonaId: number | null; seccionId: number | null } | null = null;
        try {
          locationResult = await resolveLocationForRequest(tenant, sedeId, req.body);
        } catch (err: any) {
          if (isLocationError(err)) {
            return res.status(400).json({ ok: false, error: err.message || 'Ubicación inválida' });
          }
          throw err;
        }

        const acceptedRows = (found.rows as any[]).filter(r => accept.includes(r.rfid));
        const hasSedeContext = typeof sedeId === 'number' && Number.isFinite(sedeId);
        const mismatchedAccepted = hasSedeContext
          ? acceptedRows.filter(r => typeof r.sede_id === 'number' && r.sede_id !== sedeId)
          : acceptedRows.filter(r => typeof r.sede_id === 'number');
        const unknownSedeAccepted = acceptedRows.filter(r => typeof r.sede_id !== 'number');
        const requiresTransfer = mismatchedAccepted.length > 0 || unknownSedeAccepted.length > 0;
        const allowCrossTransfer = allowSedeTransferFlag && requiresTransfer;
        console.log('[preacondScan] mismatch state', {
          hasSedeContext,
          allowCrossTransfer,
          allowSedeTransferFlag,
          requiresTransfer,
          mismatched: mismatchedAccepted.map(r => r.sede_id),
          unknown: unknownSedeAccepted.length,
        });

        if (requiresTransfer && !allowCrossTransfer) {
          const promptRows = mismatchedAccepted.length ? mismatchedAccepted : acceptedRows;
          const sedeIds = mismatchedAccepted
            .map(row => (typeof row.sede_id === 'number' ? row.sede_id : null))
            .filter((id): id is number => id !== null);
          const uniqueOrigen = Array.from(new Set(sedeIds));
          return respondSedeMismatch(req, res, { code: 'PX001', detail: null }, {
            rfids: promptRows.map(r => r.rfid),
            destinoIdOverride: typeof sedeId === 'number' ? sedeId : null,
            origenIds: uniqueOrigen.length ? uniqueOrigen : undefined,
            customMessage: (!mismatchedAccepted.length && unknownSedeAccepted.length)
              ? `Las piezas seleccionadas no tienen sede registrada. ¿Deseas asignarlas a ${(typeof sedeId === 'number' ? 'tu sede actual' : 'esta sede')}?`
              : undefined,
          });
        }

        await runWithSede(tenant, sedeId, async (client) => {
          const cfgRes = await client.query(
            "SELECT current_setting('app.allow_cross_sede_transfer', true) AS allow, current_setting('app.current_sede_id', true) AS sede"
          );
          console.log('[preacondScan] session settings', cfgRes.rows?.[0] || null);
          const targetSede = typeof sedeId === 'number' ? sedeId : null;
          console.log('[preacondScan] applying transfer', { allowCrossTransfer, targetSede, accept });
          if (t === 'congelamiento') {
            await client.query(
              `UPDATE inventario_credocubes ic
                  SET estado = 'Pre Acondicionamiento',
                      sub_estado = 'Congelamiento',
                      sede_id = COALESCE($2::int, ic.sede_id)
                  FROM modelos m
                 WHERE ic.modelo_id = m.modelo_id
                   AND ic.rfid = ANY($1::text[])
                   AND ic.activo = true
                   AND (m.nombre_modelo ILIKE '%tic%')`,
              [accept, targetSede]
            );
            try {
              const lotesParams: any[] = [accept];
              const lotesSede = pushSedeFilter(lotesParams, sedeId);
              const lotesQ = await client.query(
                `SELECT DISTINCT COALESCE(lote,'') AS lote FROM inventario_credocubes ic WHERE ic.rfid = ANY($1::text[])${lotesSede}`,
                lotesParams
              );
              const lotes = (lotesQ.rows as Array<{ lote: string | null }>).map((row) => (row.lote || '').trim()).filter(Boolean);
              const lotesMsg = lotes.length ? ` (Lote${lotes.length > 1 ? 's' : ''}: ${lotes.join(', ')})` : '';
              await AlertsModel.create(client, {
                tipo_alerta: 'inventario:preacond:inicio_congelamiento',
                descripcion: `${accept.length} TIC${accept.length > 1 ? 's' : ''} a Congelamiento${lotesMsg}`
              });
            } catch {}
          } else {
            const preserve = !!keepLote;
            if (preserve) {
              await client.query(
                `UPDATE inventario_credocubes ic
                    SET estado = 'Pre Acondicionamiento',
                        sub_estado = 'Atemperamiento',
                        sede_id = COALESCE($2::int, ic.sede_id)
                    FROM modelos m
                   WHERE ic.modelo_id = m.modelo_id
                     AND ic.rfid = ANY($1::text[])
                     AND ic.activo = true
                     AND (m.nombre_modelo ILIKE '%tic%')
                     AND ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado = 'Congelado'`,
                [accept, targetSede]
              );
            } else {
              await client.query(
                `UPDATE inventario_credocubes ic
                    SET estado = 'Pre Acondicionamiento',
                        sub_estado = 'Atemperamiento',
                        lote = NULL,
                        sede_id = COALESCE($2::int, ic.sede_id)
                    FROM modelos m
                   WHERE ic.modelo_id = m.modelo_id
                     AND ic.rfid = ANY($1::text[])
                     AND ic.activo = true
                     AND (m.nombre_modelo ILIKE '%tic%')
                     AND ic.estado = 'Pre Acondicionamiento' AND ic.sub_estado = 'Congelado'`,
                [accept, targetSede]
              );
            }
            try {
              await AlertsModel.create(client, {
                tipo_alerta: 'inventario:preacond:inicio_atemperamiento',
                descripcion: `${accept.length} TIC${accept.length > 1 ? 's' : ''} a Atemperamiento`
              });
            } catch {}
          }

          if (locationResult?.apply) {
            await client.query(
              `UPDATE inventario_credocubes
                  SET zona_id = $2, seccion_id = $3
                WHERE rfid = ANY($1::text[])`,
              [accept, locationResult.zonaId, locationResult.seccionId]
            );
          }
  }, { allowCrossSedeTransfer: allowCrossTransfer });

        // Do NOT auto-assign lote on scan; keep items without lote until a timer starts
      }

      res.json({ ok: true, moved: accept, rejected: rejects, target: t });
    } catch (err: any) {
      console.error('[preacondScan] caught error', { code: err?.code, detail: err?.detail, message: err?.message });
      if (await respondSedeMismatch(req, res, err, { rfids: (req.body?.rfids || []) })) return;
      console.error('[preacondScan] error', err);
      return res.status(500).json({ ok: false, error: 'Error al procesar la solicitud' });
    }
  },

  // Lookup lote de una TIC congelada y devolver resumen de todas las TICs congeladas de ese lote
  preacondLoteLookup: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { rfid } = req.body as any;
    const code = typeof rfid === 'string' ? rfid.trim() : '';
    if(code.length !== 24) return res.status(400).json({ ok:false, error:'RFID inválido' });
    const row = await withTenant(tenant, (c)=> c.query(
      `SELECT ic.lote, ic.estado, ic.sub_estado FROM inventario_credocubes ic WHERE ic.rfid=$1`,
      [code]));
    if(!row.rowCount) return res.status(404).json({ ok:false, error:'No existe' });
    const base = row.rows[0] as any;
    if(!(base.estado==='Pre Acondicionamiento' && (base.sub_estado==='Congelado' || base.sub_estado==='Congelamiento'))){
      return res.status(400).json({ ok:false, error:'TIC no está en Congelado/Congelamiento' });
    }
    const lote = (base.lote||'').toString().trim();
    if(!lote) return res.status(400).json({ ok:false, error:'La TIC no tiene lote asignado' });
    const ticsQ = await withTenant(tenant, (c)=> c.query(
      `SELECT ic.rfid, ic.sub_estado, m.nombre_modelo AS nombre_unidad
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE ic.lote = $1
          AND ic.estado='Pre Acondicionamiento'
          AND ic.sub_estado IN ('Congelado','Congelamiento')
          AND (m.nombre_modelo ILIKE '%tic%')
        ORDER BY ic.rfid`, [lote]));
    res.json({ ok:true, lote, total: ticsQ.rowCount, tics: ticsQ.rows });
  },

  // Move entire lote (all TICs in estado Pre Acondicionamiento sub_estado Congelado) to Atemperamiento
  preacondLoteMove: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
  const sedeId = getRequestSedeId(req);
  const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    const { lote, keepLote } = req.body as any;
    const loteVal = typeof lote === 'string' ? lote.trim() : '';
    if(!loteVal) return res.status(400).json({ ok:false, error:'Lote requerido' });

  let trackedRfids: string[] = [];

  try {
      // Fetch TICs in lote
      const tics = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.sub_estado, ic.estado, ic.sede_id
           FROM inventario_credocubes ic
           JOIN modelos m ON m.modelo_id = ic.modelo_id
          WHERE ic.lote = $1
            AND ic.estado = 'Pre Acondicionamiento'
            AND ic.sub_estado IN ('Congelado','Congelamiento')
            AND (m.nombre_modelo ILIKE '%tic%')
          ORDER BY ic.rfid`, [loteVal]));
      if(!tics.rowCount) return res.status(404).json({ ok:false, error:'Lote sin TICs válidas' });
      // Only move the ones strictly Congelado
      const congeladosRows = tics.rows.filter((r: any)=> r.sub_estado === 'Congelado');
  const congelados = congeladosRows.map((r: any)=> r.rfid);
  trackedRfids = congelados.slice();
      if(!congelados.length) return res.status(400).json({ ok:false, error:'No hay TICs en estado Congelado' });

      let locationResult: { apply: boolean; zonaId: number | null; seccionId: number | null } | null = null;
      try {
        locationResult = await resolveLocationForRequest(tenant, sedeId, req.body);
      } catch (err: any) {
        if (isLocationError(err)) {
          return res.status(400).json({ ok: false, error: err.message || 'Ubicación inválida' });
        }
        throw err;
      }

      const hasSedeContext = typeof sedeId === 'number' && Number.isFinite(sedeId);
      const mismatched = hasSedeContext
        ? congeladosRows.filter((row: any) => typeof row.sede_id === 'number' && row.sede_id !== sedeId)
        : [];
      const allowCrossTransfer = allowSedeTransferFlag && mismatched.length > 0;

      if (mismatched.length && !allowCrossTransfer) {
        const sedeIds = mismatched
          .map(row => (typeof row.sede_id === 'number' ? row.sede_id : null))
          .filter((id): id is number => id !== null);
        const uniqueOrigen = Array.from(new Set(sedeIds));
        return respondSedeMismatch(req, res, { code: 'PX001', detail: null }, {
          rfids: mismatched.map(r => r.rfid),
          destinoIdOverride: typeof sedeId === 'number' ? sedeId : null,
          origenIds: uniqueOrigen,
        });
      }

      const tenantOptions = buildTenantOptions(sedeId ?? null, allowCrossTransfer);

      if(keepLote){
        await withTenant(tenant, (c)=> c.query(
          `UPDATE inventario_credocubes ic SET sub_estado = 'Atemperamiento'
            WHERE ic.rfid = ANY($1::text[])`,
          [congelados]), tenantOptions);
      } else {
        await withTenant(tenant, (c)=> c.query(
          `UPDATE inventario_credocubes ic SET sub_estado = 'Atemperamiento', lote = NULL
            WHERE ic.rfid = ANY($1::text[])`,
          [congelados]), tenantOptions);
      }

      if (locationResult?.apply) {
        const params: any[] = [congelados, locationResult.zonaId, locationResult.seccionId];
        await withTenant(
          tenant,
          (c) =>
            c.query(
              `UPDATE inventario_credocubes
                  SET zona_id = $2, seccion_id = $3
                WHERE rfid = ANY($1::text[])`,
              params
            ),
          tenantOptions
        );
      }

      // Alert: lote moved to Atemperamiento
      try {
        await withTenant(tenant, (c)=> AlertsModel.create(c, {
          tipo_alerta: 'inventario:preacond:inicio_atemperamiento',
          descripcion: `${congelados.length} TIC${congelados.length>1?'s':''} a Atemperamiento (Lote: ${loteVal})`
  }), tenantOptions);
      } catch {}
      res.json({ ok:true, moved: congelados, lote: loteVal });
    } catch (err: any) {
      if (await respondSedeMismatch(req, res, err, { rfids: trackedRfids })) return;
      console.error('[preacondLoteMove] error', err);
      return res.status(500).json({ ok:false, error:'Error al mover el lote' });
    }
  },

  // Validate RFIDs before moving (registro-like UX)
  preacondValidate: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { target, rfids } = req.body as any;
    const t = typeof target === 'string' ? target.toLowerCase() : '';
    const input = Array.isArray(rfids) ? rfids : (rfids ? [rfids] : []);
    const codes = [...new Set(input.filter((x: any) => typeof x === 'string').map((s: string) => s.trim()).filter(Boolean))];
    if (!codes.length || (t !== 'congelamiento' && t !== 'atemperamiento')) {
      return res.status(400).json({ ok: false, error: 'Entrada inválida' });
    }

    const found = await withTenant(tenant, (c) => c.query(
      `SELECT ic.rfid, ic.estado, ic.sub_estado, ic.activo, ic.sede_id, m.nombre_modelo
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
        WHERE ic.rfid = ANY($1::text[])`,
      [codes]));

    const normalize = (val: string | null | undefined): string => {
      return typeof val === 'string'
        ? val.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
        : '';
    };

    const rows = found.rows as any[];
    const ok: string[] = [];
    const invalid: { rfid: string; reason: string }[] = [];

    for (const code of codes) {
      const r = rows.find(x => x.rfid === code);
  if (!r) { invalid.push({ rfid: code, reason: 'No existe' }); continue; }
      if (r.activo === false) { invalid.push({ rfid: code, reason: 'Item inhabilitado (activo=false)' }); continue; }
      if (!/tic/i.test(r.nombre_modelo || '')) { invalid.push({ rfid: code, reason: 'No es TIC' }); continue; }
      const estadoNorm = normalizeBasic(r.estado);
      const subEstadoNorm = normalizeBasic(r.sub_estado);
      const enBodega = estadoNorm.includes('en bodega') || subEstadoNorm.includes('en bodega');
      const enPreAcond = estadoNorm.replace(/\s+/g,'').includes('preacondicionamiento') || estadoNorm.includes('pre acond');
      const subAtemper = subEstadoNorm.includes('atemperad');
      if (t === 'atemperamiento') {
        if (enPreAcond && subEstadoNorm.includes('congelado')) {
          ok.push(code);
        } else if (enPreAcond && subAtemper) {
          invalid.push({ rfid: code, reason: 'Ya está en Atemperamiento' });
        } else {
          invalid.push({ rfid: code, reason: 'Debe estar Congelado' });
        }
      } else {
        if (enPreAcond && (subEstadoNorm.includes('congelamiento') || subEstadoNorm.includes('congelado'))) {
          invalid.push({ rfid: code, reason: 'Ya está en Congelamiento' });
        } else if (enBodega && subEstadoNorm.length > 0) {
          invalid.push({ rfid: code, reason: `Subestado no permitido en Bodega (${r.sub_estado || 'pendiente'})` });
        } else if (!enBodega && !(enPreAcond && subAtemper)) {
          invalid.push({ rfid: code, reason: 'Solo se acepta desde En bodega o Atemperamiento' });
        } else {
          ok.push(code);
        }
      }
    }

    res.json({ ok: true, valid: ok, invalid });
  },

  // Start/clear global timers per section
  preacondTimerStart: async (req: Request, res: Response) => {
  const tenant = (req as any).user?.tenant;
  const sedeId = getRequestSedeId(req);
    const { section, durationSec, lote, rfids } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    const dur = Number(durationSec);
    let loteVal = typeof lote === 'string' ? lote.trim() : '';
    if(!['congelamiento','atemperamiento'].includes(s) || !Number.isFinite(dur) || dur <= 0){
      return res.status(400).json({ ok:false, error:'Entrada inválida' });
    }
  if(!loteVal){ loteVal = await generateNextTicLote(tenant); }
  await withTenant(tenant, async (c) => {
      await c.query(`CREATE TABLE IF NOT EXISTS preacond_timers (
         section text PRIMARY KEY,
         started_at timestamptz,
         duration_sec integer,
         lote text,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW()
      )`);
      await c.query(`ALTER TABLE preacond_timers ADD COLUMN IF NOT EXISTS lote text`);
      await c.query(
        `INSERT INTO preacond_timers(section, started_at, duration_sec, lote, active, updated_at)
           VALUES ($1, NOW(), $2, $3, true, NOW())
         ON CONFLICT (section) DO UPDATE
           SET started_at = EXCLUDED.started_at,
               duration_sec = EXCLUDED.duration_sec,
               lote = EXCLUDED.lote,
               active = true,
               updated_at = NOW()`,
        [s, dur, loteVal]
      );
      // If a list of RFIDs is provided, tag those items with the lote now (only if they don't have one)
      const list = Array.isArray(rfids) ? rfids.filter((x:any)=>typeof x==='string' && x.trim()).map((x:string)=>x.trim()) : [];
      if(list.length){
        const allowRes = await c.query<{ rfid: string }>(
          `SELECT ic.rfid FROM inventario_credocubes ic WHERE ic.rfid = ANY($1::text[])`,
          [list]
        );
  const allowed = allowRes.rows.map(r => r.rfid);
        if(allowed.length){
          await c.query(`UPDATE inventario_credocubes ic SET lote = $1 WHERE ic.rfid = ANY($2::text[]) AND (ic.lote IS NULL OR ic.lote = '')`,
            [loteVal, allowed]);
          await c.query(`CREATE TABLE IF NOT EXISTS preacond_item_timers (
           rfid text NOT NULL,
           section text NOT NULL,
           started_at timestamptz,
           duration_sec integer,
           lote text,
           active boolean NOT NULL DEFAULT false,
           updated_at timestamptz NOT NULL DEFAULT NOW(),
           PRIMARY KEY (rfid, section)
        )`);
          await c.query(
          `INSERT INTO preacond_item_timers(rfid, section, started_at, duration_sec, lote, active, updated_at)
             SELECT rfid, $1, NOW(), $2, $3, true, NOW()
               FROM UNNEST($4::text[]) AS rfid
           ON CONFLICT (rfid, section) DO UPDATE
             SET started_at = EXCLUDED.started_at,
                 duration_sec = EXCLUDED.duration_sec,
                 lote = COALESCE(preacond_item_timers.lote, EXCLUDED.lote),
                 active = true,
                 updated_at = NOW()`,
          [s, dur, loteVal, allowed]
        );
        }
      }
    }, sedeId !== null ? { sedeId } : undefined);
  res.json({ ok:true, lote: loteVal });
  },

  preacondTimerClear: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { section } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    if(!['congelamiento','atemperamiento'].includes(s)) return res.status(400).json({ ok:false, error:'Entrada inválida' });
    await withTenant(tenant, async (c) => {
      await c.query(
        `INSERT INTO preacond_timers(section, started_at, duration_sec, active, updated_at)
           VALUES ($1, NULL, NULL, false, NOW())
         ON CONFLICT (section) DO UPDATE
           SET started_at = NULL, duration_sec = NULL, lote = NULL, active = false, updated_at = NOW()`,
        [s]
      );
      await c.query(`CREATE TABLE IF NOT EXISTS preacond_item_timers (
         rfid text NOT NULL,
         section text NOT NULL,
         started_at timestamptz,
         duration_sec integer,
         lote text,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW(),
         PRIMARY KEY (rfid, section)
      )`);
      await c.query(
        `UPDATE preacond_item_timers SET started_at = NULL, duration_sec = NULL, lote = NULL, active = false, updated_at = NOW()
           WHERE section = $1 AND active = true`,
        [s]
      );
    });
    res.json({ ok:true });
  },

  // Item-level timers
  preacondItemTimerStart: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { section, rfid, durationSec, lote } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    const r = typeof rfid === 'string' ? rfid.trim() : '';
    const dur = Number(durationSec);
    let loteVal = typeof lote === 'string' ? lote.trim() : '';
    if (!['congelamiento','atemperamiento'].includes(s) || !r || !Number.isFinite(dur) || dur <= 0) {
      return res.status(400).json({ ok:false, error: 'Entrada inválida' });
    }
    if(!loteVal){ loteVal = await generateNextTicLote(tenant); }
    await withTenant(tenant, async (c) => {
      // Do not allow starting if the item is already completed in this section
      const done = await c.query(
        `SELECT ic.sub_estado FROM inventario_credocubes ic WHERE ic.rfid = $1`,
        [r]
      );
      const sub = (done.rows?.[0]?.sub_estado || '').toString();
      if ((s === 'congelamiento' && /Congelado/i.test(sub)) || (s === 'atemperamiento' && /Atemperado/i.test(sub))) {
        throw Object.assign(new Error('Item ya completado'), { statusCode: 400 });
      }
      await c.query(`CREATE TABLE IF NOT EXISTS preacond_item_timers (
         rfid text NOT NULL,
         section text NOT NULL,
         started_at timestamptz,
         duration_sec integer,
         lote text,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW(),
         PRIMARY KEY (rfid, section)
      )`);
      await c.query(
        `INSERT INTO preacond_item_timers(rfid, section, started_at, duration_sec, lote, active, updated_at)
           VALUES ($1, $2, NOW(), $3, $4, true, NOW())
         ON CONFLICT (rfid, section) DO UPDATE
           SET started_at = EXCLUDED.started_at,
               duration_sec = EXCLUDED.duration_sec,
               lote = COALESCE(preacond_item_timers.lote, EXCLUDED.lote),
              completed_at = NULL,
              active = true,
               updated_at = NOW()`,
        [r, s, dur, loteVal]
      );
  // Tag inventario lote only if empty
      await c.query(`UPDATE inventario_credocubes ic SET lote = $1 WHERE ic.rfid = $2 AND (ic.lote IS NULL OR ic.lote = '')`,
        [loteVal, r]);
    }, sedeId !== null ? { sedeId } : undefined);
    res.json({ ok:true, lote: loteVal });
  },

  preacondItemTimerClear: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { section, rfid } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    const r = typeof rfid === 'string' ? rfid.trim() : '';
    if (!['congelamiento','atemperamiento'].includes(s) || !r) {
      return res.status(400).json({ ok:false, error: 'Entrada inválida' });
    }
    await withTenant(tenant, async (c) => {
      await c.query(`CREATE TABLE IF NOT EXISTS preacond_item_timers (
         rfid text NOT NULL,
         section text NOT NULL,
         started_at timestamptz,
         duration_sec integer,
         lote text,
         active boolean NOT NULL DEFAULT false,
         updated_at timestamptz NOT NULL DEFAULT NOW(),
         PRIMARY KEY (rfid, section)
      )`);
      // Keep lote (do not clear) when pausing; only stop timer fields
      await c.query(
        `INSERT INTO preacond_item_timers(rfid, section, started_at, duration_sec, lote, active, updated_at)
           VALUES ($1, $2, NULL, NULL, NULL, false, NOW())
         ON CONFLICT (rfid, section) DO UPDATE
           SET started_at = NULL,
               duration_sec = NULL,
              completed_at = NULL,
               active = false,
               updated_at = NOW()`,
        [r, s]
      );
    });
    res.json({ ok:true });
  },

  // Complete (auto-finish) all timers for a section when duration ends
  preacondTimerComplete: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { section } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    if(!['congelamiento','atemperamiento'].includes(s)) return res.status(400).json({ ok:false, error:'Entrada inválida' });
    await withTenant(tenant, async (c) => {
      // Only if the timer is actually expired or active
      await c.query('BEGIN');
      try {
        // Mark items with active item timers in this section as completed state
        const upd = await c.query(
          `UPDATE inventario_credocubes ic
              SET sub_estado = CASE WHEN $1='congelamiento' THEN 'Congelado' ELSE 'Atemperado' END
            WHERE ic.rfid IN (
                    SELECT pit.rfid FROM preacond_item_timers pit
                     WHERE pit.section = $1 AND pit.active = true
                  )
          RETURNING ic.id, ic.rfid, ic.lote`,
          [s]
        );
        // Deactivate item timers
        await c.query(
          `UPDATE preacond_item_timers
              SET completed_at = CASE
                                    WHEN started_at IS NOT NULL AND duration_sec IS NOT NULL
                                      THEN COALESCE(completed_at, started_at + duration_sec * INTERVAL '1 second')
                                    ELSE COALESCE(completed_at, NOW())
                                  END,
                  started_at = NULL,
                  duration_sec = NULL,
                  lote = lote,
                  active = false,
                  updated_at = NOW()
            WHERE section = $1 AND active = true`, [s]
        );
        // Deactivate group timer
        await c.query(
          `UPDATE preacond_timers SET active = false, updated_at = NOW() WHERE section = $1`, [s]
        );
        await c.query('COMMIT');
        // Crear alerta agregada (fallback a trigger): N TIC(s) marcadas Congelado/Atemperado
        const count = upd.rowCount || 0;
        if (count > 0) {
          const nextState = s === 'congelamiento' ? 'Congelado' : 'Atemperado';
          // Agrupar por lote y crear/incrementar una sola alerta por cada lote afectado
          const byLote = new Map<string, number>();
          for (const r of (upd.rows || []) as any[]) {
            const lote = String(r.lote || '').trim();
            const key = lote || '';
            byLote.set(key, (byLote.get(key) || 0) + 1);
          }
          try {
            for (const [loteKey, n] of byLote.entries()) {
              await AlertsModel.createOrIncrementPreacondGroup(c, {
                tipo_alerta: `inventario:preacond:${nextState.toLowerCase()}`,
                lote: loteKey || null,
                nextState,
                delta: n
              });
            }
          } catch {}
        }
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }, sedeId !== null ? { sedeId } : undefined);
    res.json({ ok:true });
  },

  // Complete a single item timer
  preacondItemTimerComplete: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { section, rfid } = req.body as any;
    const s = typeof section === 'string' ? section.toLowerCase() : '';
    const r = typeof rfid === 'string' ? rfid.trim() : '';
    if(!['congelamiento','atemperamiento'].includes(s) || !r) return res.status(400).json({ ok:false, error:'Entrada inválida' });
    await withTenant(tenant, async (c) => {
      await c.query('BEGIN');
      try {
        const upd = await c.query(
          `UPDATE inventario_credocubes ic
              SET sub_estado = CASE WHEN $1='congelamiento' THEN 'Congelado' ELSE 'Atemperado' END
            WHERE ic.rfid = $2
          RETURNING ic.id, ic.rfid, ic.lote`,
          [s, r]
        );
        await c.query(
          `UPDATE preacond_item_timers
              SET completed_at = CASE
                                    WHEN started_at IS NOT NULL AND duration_sec IS NOT NULL
                                      THEN COALESCE(completed_at, started_at + duration_sec * INTERVAL '1 second')
                                    ELSE COALESCE(completed_at, NOW())
                                  END,
                  started_at = NULL,
                  duration_sec = NULL,
                  active = false,
                  updated_at = NOW()
            WHERE section = $1 AND rfid = $2`,
          [s, r]
        );
        await c.query('COMMIT');
        // Alerta por pieza (fallback): RFID → Congelado/Atemperado
        if (upd.rowCount) {
          const nextState = s === 'congelamiento' ? 'Congelado' : 'Atemperado';
          const row = (upd.rows || [])[0] as any;
          try {
            await AlertsModel.createOrIncrementPreacondGroup(c, {
              tipo_alerta: `inventario:preacond:${nextState.toLowerCase()}`,
              lote: String(row?.lote || '').trim() || null,
              nextState,
              delta: 1
            });
          } catch {}
        }
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }, sedeId !== null ? { sedeId } : undefined);
    res.json({ ok:true });
  },
  
  // Return a TIC to warehouse: clear timers (any section), remove lote, set estado 'En bodega'
  preacondReturnToBodega: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { rfid } = req.body as any;
    const r = typeof rfid === 'string' ? rfid.trim() : '';
    if(!r) return res.status(400).json({ ok:false, error:'Entrada inválida' });
    await withTenant(tenant, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`CREATE TABLE IF NOT EXISTS preacond_item_timers (
           rfid text NOT NULL,
           section text NOT NULL,
           started_at timestamptz,
           duration_sec integer,
           lote text,
           active boolean NOT NULL DEFAULT false,
           updated_at timestamptz NOT NULL DEFAULT NOW(),
           PRIMARY KEY (rfid, section)
        )`);
  // Remove any leftover preacond timers for this RFID completely
        await c.query(
          `UPDATE inventario_credocubes ic
              SET estado = 'En bodega', sub_estado = NULL, lote = NULL
            WHERE ic.rfid = $1`,
          [r]
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }, sedeId !== null ? { sedeId } : undefined);
    res.json({ ok:true });
  },

  // ============================= ACONDICIONAMIENTO · ENSAMBLAJE =============================
  // Data endpoint: provides resumen of cajas creadas y items disponibles para ensamblar
  acondData: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    try {
      // Ensure tables for cajas
      await withTenant(tenant, async (c) => {
       // Migrate from public to tenant schema if needed (avoid duplicates across schemas)
       await c.query(`DO $$
       DECLARE target_schema text := current_schema();
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='acond_cajas' AND n.nspname='public')
           AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='acond_cajas' AND n.nspname=target_schema) THEN
           EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I','public','acond_cajas', target_schema);
         END IF;
         IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='acond_caja_items' AND n.nspname='public')
           AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='acond_caja_items' AND n.nspname=target_schema) THEN
           EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I','public','acond_caja_items', target_schema);
         END IF;
         IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='acond_caja_timers' AND n.nspname='public')
           AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='acond_caja_timers' AND n.nspname=target_schema) THEN
           EXECUTE format('ALTER TABLE %I.%I SET SCHEMA %I','public','acond_caja_timers', target_schema);
         END IF;
       END $$;`);
       await c.query(`ALTER TABLE inventario_credocubes ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true`);
       await c.query(`ALTER TABLE inventario_credocubes ADD COLUMN IF NOT EXISTS numero_orden text`);
       await c.query(`CREATE TABLE IF NOT EXISTS acond_cajas (
         caja_id serial PRIMARY KEY,
         lote text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT NOW()
       )`);
       await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_items (
         caja_id int NOT NULL REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
         rfid text NOT NULL,
         rol text NOT NULL CHECK (rol IN ('cube','vip','tic')),
         PRIMARY KEY (caja_id, rfid)
       )`);
       await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_timers (
          caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
          started_at timestamptz,
          duration_sec integer,
          active boolean NOT NULL DEFAULT false,
          updated_at timestamptz NOT NULL DEFAULT NOW()
        )`);
  // Ensure FK and index to inventario_credocubes
       await c.query(`CREATE INDEX IF NOT EXISTS acond_caja_items_rfid_idx ON acond_caja_items(rfid)`);
       await c.query(`DO $$
       BEGIN
         BEGIN
           EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS inventario_credocubes_rfid_key ON inventario_credocubes(rfid)';
         EXCEPTION WHEN others THEN
         END;
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint
             WHERE conrelid = 'acond_caja_items'::regclass
               AND conname = 'acond_caja_items_rfid_fkey'
         ) THEN
           ALTER TABLE acond_caja_items
             ADD CONSTRAINT acond_caja_items_rfid_fkey
             FOREIGN KEY (rfid) REFERENCES inventario_credocubes(rfid) ON DELETE CASCADE;
         END IF;
       END $$;`);
    });
    // Available TICs: Atemperadas (finished pre-acond) and not already in any caja
    const ticsParams: any[] = [];
    const ticsSede = pushSedeFilter(ticsParams, sedeId);
  const tics = await withTenant(tenant, (c) => c.query(
      `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
    LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid
        WHERE aci.rfid IS NULL
          AND ic.estado = 'Pre Acondicionamiento'
          AND ic.sub_estado = 'Atemperado'
      AND ic.activo = true
          AND (m.nombre_modelo ILIKE '%tic%')${ticsSede}
        ORDER BY ic.id DESC
        LIMIT 500`,
      ticsParams));
    // Available CUBEs
    const cubesParams: any[] = [];
    const cubesSede = pushSedeFilter(cubesParams, sedeId);
  const cubes = await withTenant(tenant, (c) => c.query(
      `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
    LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid
        WHERE aci.rfid IS NULL
          AND ic.estado = 'En bodega'
      AND ic.activo = true
          AND (m.nombre_modelo ILIKE '%cube%')${cubesSede}
        ORDER BY ic.id DESC
        LIMIT 200`,
      cubesParams));
    // Available VIPs
    const vipsParams: any[] = [];
    const vipsSede = pushSedeFilter(vipsParams, sedeId);
  const vips = await withTenant(tenant, (c) => c.query(
      `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
    LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid
        WHERE aci.rfid IS NULL
          AND ic.estado = 'En bodega'
      AND ic.activo = true
          AND (m.nombre_modelo ILIKE '%vip%')${vipsSede}
        ORDER BY ic.id DESC
        LIMIT 200`,
      vipsParams));
    // Existing cajas with litraje + items (litraje may not exist yet → fallback)
  let cajasRows:any[] = []; let cajaItemsRows:any[] = [];
  const nowRes = await withTenant(tenant, (c)=> c.query<{ now:string }>(`SELECT NOW()::timestamptz AS now`));
        try {
          // Ensure ordenes table and acond_cajas.order_id column+FK exist (for older tenants)
          await withTenant(tenant, async (c) => {
            await c.query(`CREATE TABLE IF NOT EXISTS ordenes (
              id serial PRIMARY KEY,
              numero_orden text,
              codigo_producto text,
              cantidad integer,
              ciudad_destino text,
              ubicacion_destino text,
              cliente text,
              fecha_generacion timestamptz
            )`);
            await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS habilitada boolean NOT NULL DEFAULT true`);
            await c.query(`ALTER TABLE acond_cajas ADD COLUMN IF NOT EXISTS order_id integer`);
            await c.query(`DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'acond_cajas'::regclass
                   AND conname = 'acond_cajas_order_id_fkey'
              ) THEN
                BEGIN
                  ALTER TABLE acond_cajas
                    ADD CONSTRAINT acond_cajas_order_id_fkey
                    FOREIGN KEY (order_id) REFERENCES ordenes(id) ON DELETE SET NULL;
                EXCEPTION WHEN others THEN
                END;
              END IF;
            END $$;`);
          });
          const cajasParams: any[] = [];
          const cajasSede = pushSedeFilter(cajasParams, sedeId);
          const cajasQ = await withTenant(tenant, (c) => c.query(
            `WITH cajas_validas AS (
               SELECT c.caja_id, c.lote, c.created_at, c.order_id
               FROM acond_cajas c
               JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
               JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
              WHERE 1=1${cajasSede}
               GROUP BY c.caja_id, c.lote, c.created_at, c.order_id
               HAVING bool_and(ic.estado='Acondicionamiento' AND ic.sub_estado IN ('Ensamblaje','Ensamblado'))
             )
             SELECT c.caja_id, c.lote, c.created_at, c.order_id,
                    o.numero_orden AS order_num,
                    MAX(m.litraje) AS litraje,
                    COUNT(*) FILTER (WHERE aci.rol='tic') AS tics,
                    COUNT(*) FILTER (WHERE aci.rol='cube') AS cubes,
                    COUNT(*) FILTER (WHERE aci.rol='vip') AS vips,
                    act.started_at AS timer_started_at,
                    act.duration_sec AS timer_duration_sec,
                    act.active AS timer_active
             FROM cajas_validas c
             JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
             LEFT JOIN modelos m ON m.modelo_id = ic.modelo_id
             LEFT JOIN acond_caja_timers act ON act.caja_id = c.caja_id
             LEFT JOIN ordenes o ON o.id = c.order_id
         GROUP BY c.caja_id, c.lote, c.created_at, c.order_id, o.numero_orden, act.started_at, act.duration_sec, act.active
             ORDER BY c.caja_id DESC
             LIMIT 200`,
          cajasParams));
          cajasRows = cajasQ.rows;
          const itemsParams: any[] = [cajasRows.map(r=>r.caja_id)];
          const itemsSede = pushSedeFilter(itemsParams, sedeId);
          const itemsQ = await withTenant(tenant, (c) => c.query(
            `SELECT c.caja_id, aci.rol, ic.rfid, ic.sub_estado, ic.nombre_unidad, m.litraje
               FROM acond_caja_items aci
               JOIN acond_cajas c ON c.caja_id = aci.caja_id
               JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
               JOIN modelos m ON m.modelo_id = ic.modelo_id
               WHERE c.caja_id = ANY($1::int[])${itemsSede}
               ORDER BY c.caja_id DESC, CASE aci.rol WHEN 'vip' THEN 0 WHEN 'tic' THEN 1 ELSE 2 END, ic.rfid`,
            itemsParams));
          cajaItemsRows = itemsQ.rows;
        } catch (e:any) {
          // Fallback without litraje column
          if(e?.code === '42703') {
            const cajasParams2: any[] = [];
            const cajasSede2 = pushSedeFilter(cajasParams2, sedeId);
            const cajasQ = await withTenant(tenant, (c) => c.query(
              `WITH cajas_validas AS (
                 SELECT c.caja_id, c.lote, c.created_at, c.order_id
                   FROM acond_cajas c
                   JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
                   JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
                  WHERE 1=1${cajasSede2}
                  GROUP BY c.caja_id, c.lote, c.created_at, c.order_id
                  HAVING bool_and(ic.estado='Acondicionamiento' AND ic.sub_estado IN ('Ensamblaje','Ensamblado'))
               )
               SELECT c.caja_id, c.lote, c.created_at, c.order_id,
                      o.numero_orden AS order_num,
                      COUNT(*) FILTER (WHERE aci.rol='tic') AS tics,
                      COUNT(*) FILTER (WHERE aci.rol='cube') AS cubes,
                      COUNT(*) FILTER (WHERE aci.rol='vip') AS vips,
                      act.started_at AS timer_started_at,
                      act.duration_sec AS timer_duration_sec,
                      act.active AS timer_active
                 FROM cajas_validas c
                 JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
                 JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
                 LEFT JOIN acond_caja_timers act ON act.caja_id = c.caja_id
                 LEFT JOIN ordenes o ON o.id = c.order_id
                   GROUP BY c.caja_id, c.lote, c.created_at, c.order_id, o.numero_orden, act.started_at, act.duration_sec, act.active
                   ORDER BY c.caja_id DESC
                LIMIT 200`,
            cajasParams2));
            cajasRows = cajasQ.rows;
            const itemsParams2: any[] = [cajasRows.map(r=>r.caja_id)];
            const itemsSede2 = pushSedeFilter(itemsParams2, sedeId);
              const itemsQ = await withTenant(tenant, (c) => c.query(
                `SELECT c.caja_id, aci.rol, ic.rfid, ic.sub_estado, ic.nombre_unidad
                 FROM acond_caja_items aci
                 JOIN acond_cajas c ON c.caja_id = aci.caja_id
                 JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
                 WHERE c.caja_id = ANY($1::int[])${itemsSede2}
                ORDER BY c.caja_id DESC, CASE aci.rol WHEN 'vip' THEN 0 WHEN 'tic' THEN 1 ELSE 2 END, aci.rfid`,
            itemsParams2));
            cajaItemsRows = itemsQ.rows;
          } else {
            throw e;
          }
        }
  // Items en flujo de despacho: incluyen los que están ya "Lista para Despacho" (se eliminó etapa intermedia 'Despachando')
    const listoParams: any[] = [];
    const listoSede = pushSedeFilter(listoParams, sedeId);
  const listoRows = await withTenant(tenant, (c)=> c.query(
    `SELECT ic.rfid, ic.nombre_unidad, ic.lote, ic.estado, ic.sub_estado, NOW() AS updated_at, m.nombre_modelo,
      act.started_at AS timer_started_at, act.duration_sec AS timer_duration_sec, act.active AS timer_active,
      c.lote AS caja_lote, c.caja_id, c.order_id, o.numero_orden AS order_num
    FROM inventario_credocubes ic
    JOIN modelos m ON m.modelo_id = ic.modelo_id
  LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid
  LEFT JOIN acond_cajas c ON c.caja_id = aci.caja_id
  LEFT JOIN acond_caja_timers act ON act.caja_id = aci.caja_id
  LEFT JOIN ordenes o ON o.id = c.order_id
  WHERE ic.estado='Acondicionamiento' AND ic.sub_estado IN ('Lista para Despacho','Listo')${listoSede}
   ORDER BY ic.id DESC
   LIMIT 500`,
    listoParams));

  // Normalizar estructura esperada por nuevo front-end (acond.js)
  const nowIso = nowRes.rows[0]?.now;
  const nowMs = nowIso ? new Date(nowIso).getTime() : Date.now();
  // Map caja items by caja_id for componentes list
  const componentesPorCaja: Record<string, { tipo:string; codigo:string; sub_estado?:string; nombreUnidad?:string|null }[]> = {};
  for(const it of cajaItemsRows){
    const arr = componentesPorCaja[it.caja_id] || (componentesPorCaja[it.caja_id] = [] as { tipo:string; codigo:string; sub_estado?:string; nombreUnidad?:string|null }[]);
    arr.push({ tipo: it.rol, codigo: it.rfid, sub_estado: (it as any).sub_estado, nombreUnidad: (it as any).nombre_unidad || null });
  }
  const cajasUI = cajasRows.map(r => {
    let startsAt: string | null = r.timer_started_at || null;
    let endsAt: string | null = null;
    let completedAt: string | null = null;
    if(r.timer_started_at && r.timer_duration_sec){
      const endMs = new Date(r.timer_started_at).getTime() + (r.timer_duration_sec*1000);
      endsAt = new Date(endMs).toISOString();
      if(!r.timer_active && endMs <= nowMs){
        completedAt = endsAt;
      }
    }
    const comps = componentesPorCaja[r.caja_id] || [];
    const allEnsamblado = comps.length>0 && comps.every((cmp) => cmp.sub_estado==='Ensamblado');
    const cubeComp = comps.find((cmp) => cmp.tipo === 'cube' && cmp.nombreUnidad);
    const nombreCaja = cubeComp?.nombreUnidad?.trim() || r.lote || `Caja #${r.caja_id}`;
    return {
      id: r.caja_id,
      codigoCaja: r.lote || `Caja #${r.caja_id}`,
      nombreCaja,
      estado: allEnsamblado ? 'Ensamblado' : 'Ensamblaje',
      createdAt: r.created_at,
      updatedAt: r.created_at,
      orderId: (r as any).order_id ?? null,
      orderNumero: (r as any).order_num ?? null,
      timer: startsAt ? { startsAt, endsAt, completedAt } : null,
      componentes: componentesPorCaja[r.caja_id] || []
    };
  });
  const listoDespacho = listoRows.rows.map(r => {
    let startsAt = r.timer_started_at || null;
    let endsAt: string | null = null;
    let completedAt: string | null = null;
    if(r.timer_started_at && r.timer_duration_sec){
      const endMs = new Date(r.timer_started_at).getTime() + (r.timer_duration_sec*1000);
      endsAt = new Date(endMs).toISOString();
      // Solo marcar completed si estaba activo y ya pasó el tiempo; si timer_active=false desde el inicio, lo tratamos como no iniciado
      if(r.timer_active === false && !r.timer_started_at){
        startsAt = null; endsAt = null; completedAt = null;
      } else if(r.timer_active===false && endMs <= nowMs){
        completedAt = endsAt;
      }
    }
    // categoria simplificada (vip/tic/cube)
    const modeloLower = (r.nombre_modelo||'').toLowerCase();
    let categoriaSimple = 'otros';
    if(/vip/.test(modeloLower)) categoriaSimple = 'vip';
    else if(/tic/.test(modeloLower)) categoriaSimple = 'tic';
    else if(/cube/.test(modeloLower)) categoriaSimple = 'cube';
    return {
      caja_id: r.caja_id,
      codigo: r.rfid,
      nombre: r.nombre_modelo, // mover modelo a nombre
      nombre_unidad: r.nombre_unidad || null,
  estado: r.sub_estado || r.estado, // ahora mostrar sub_estado real
      lote: r.caja_lote || r.lote, // mostrar lote de la caja si existe
      updatedAt: r.updated_at,
      fase: 'Acond',
      categoria: categoriaSimple,
      cronometro: startsAt ? { startsAt, endsAt, completedAt } : null,
      order_id: (r as any).order_id ?? null,
      order_num: (r as any).order_num ?? null
    };
  });
  res.json({ ok:true, now: nowIso, serverNow: nowIso, disponibles: { tics: tics.rows, cubes: cubes.rows, vips: vips.rows }, cajas: cajasUI, listoDespacho });
    } catch (e:any) {
      console.error('[ACOND][DATA] error', e);
      const status = Number.isInteger(e?.statusCode) ? Number(e.statusCode) : 500;
      if(!res.headersSent){
        res.status(status).json({ ok:false, error: e?.message || 'Error obteniendo datos de acondicionamiento' });
      }
    }
  },

  // Validate RFIDs for assembling a single caja
  acondEnsamblajeValidate: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { rfids } = req.body as any;
    const input = Array.isArray(rfids) ? rfids : (rfids ? [rfids] : []);
    const codes = [...new Set(input.filter((x:any)=>typeof x==='string').map((s:string)=>s.trim()).filter(Boolean))];
    if(!codes.length) return res.status(400).json({ ok:false, error:'Sin RFIDs' });
  // Limpieza rápida de asignaciones obsoletas (items que ya no están en Ensamblaje/Ensamblado)
    await withTenant(tenant, async (c)=>{
      // Limpieza (versión endurecida):
      // Problema original: Al crear una nueva caja se borraban timers de cajas ya armadas porque algún item
      // cambiaba momentáneamente de sub_estado y la condición estricta lo excluía, provocando DELETE y cascade.
      // Nueva estrategia: Sólo borrar asociaciones cuyo RFID ya NO esté en ninguno de los estados del flujo
      // Acondicionamiento u Operación. Es decir, mientras el item siga en cualquier fase conocida de estos
      // macro-estados lo conservamos (sin mirar sub_estado, evitando ventanas de carrera con NULL / transición).
      // Además, evitamos borrar items de una caja que tenga un timer activo o definido, como salvaguarda extra.
      // Nota: Si en el futuro hay estados terminales adicionales, este DELETE seguirá siendo seguro porque
      // requiere que el item abandone completamente ambos estados antes de eliminar la asociación.
      await c.query(`DELETE FROM acond_caja_items aci
                       WHERE NOT EXISTS (
                         SELECT 1 FROM inventario_credocubes ic
                          WHERE ic.rfid = aci.rfid
                            AND ic.estado IN ('Acondicionamiento','Operación')
                       )
                         AND NOT EXISTS (
                           SELECT 1 FROM acond_caja_timers t
                            WHERE t.caja_id = aci.caja_id
                              AND ((t.active IS TRUE) OR t.started_at IS NOT NULL)
                         )`);
      // Eliminar cajas huérfanas (sin items). No elimina timers activos porque arriba no se borran sus items.
      await c.query(`DELETE FROM acond_cajas c WHERE NOT EXISTS (SELECT 1 FROM acond_caja_items aci WHERE aci.caja_id=c.caja_id)`);
    });
    const rows = await withTenant(tenant, (c)=> c.query(
      `SELECT ic.rfid, ic.estado, ic.sub_estado, ic.activo, m.nombre_modelo,
              EXISTS(SELECT 1 FROM acond_caja_items aci WHERE aci.rfid=ic.rfid) AS ya_en_caja,
              CASE
                WHEN LOWER(ic.estado) = LOWER('Pre Acondicionamiento')
                  AND LOWER(COALESCE(ic.sub_estado, '')) LIKE 'atemperad%'
                  AND (pit.completed_at IS NOT NULL OR pit.updated_at IS NOT NULL)
                THEN GREATEST(
                       0,
                       EXTRACT(EPOCH FROM (
                         NOW() - COALESCE(GREATEST(pit.completed_at, pit.updated_at), pit.completed_at, pit.updated_at)
                       ))::int
                     )
                ELSE NULL
              END AS atemperado_elapsed_sec
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
    LEFT JOIN preacond_item_timers pit
           ON pit.rfid = ic.rfid AND pit.section = 'atemperamiento'
        WHERE ic.rfid = ANY($1::text[])`, [codes]));
    // Map para acceso rápido
    const byRfid: Record<string, any> = {};
    rows.rows.forEach(r=>{ byRfid[r.rfid] = r; });
    let haveCube=false, haveVip=false, ticCount=0;
    const valid: { rfid:string; rol:'cube'|'vip'|'tic'; atemperadoElapsedSec?: number | null }[] = [];
    const invalid: { rfid:string; reason:string }[] = [];
    // Procesar en el mismo orden de entrada (importante para UX del escaneo)
    for(const code of codes){
      const r = byRfid[code];
      if(!r){ invalid.push({ rfid: code, reason: 'No encontrado' }); continue; }
      const estado = (r.estado||'').trim();
      const subEstado = (r.sub_estado||'').trim();
      const estadoLower = estado.toLowerCase();
      const subLower = subEstado.toLowerCase();
      const name=(r.nombre_modelo||'').toLowerCase();
  if(r.ya_en_caja){ invalid.push({ rfid: r.rfid, reason: 'Ya en una caja' }); continue; }
  if(r.activo === false){ invalid.push({ rfid:r.rfid, reason:'Item inhabilitado (activo=false)' }); continue; }
      if(/cube/.test(name)){
        if(haveCube){ invalid.push({ rfid:r.rfid, reason:'Más de un CUBE' }); continue; }
  const enBodega = estadoLower.includes('en bodega') || subLower.includes('en bodega');
        if(!enBodega){ invalid.push({ rfid:r.rfid, reason:'CUBE no En bodega' }); continue; }
        haveCube=true; valid.push({ rfid:r.rfid, rol:'cube' });
      } else if(/vip/.test(name)){
        if(haveVip){ invalid.push({ rfid:r.rfid, reason:'Más de un VIP' }); continue; }
        const enBodega = estadoLower.includes('en bodega') || subLower.includes('en bodega');
        if(!enBodega){ invalid.push({ rfid:r.rfid, reason:'VIP no En bodega' }); continue; }
        haveVip=true; valid.push({ rfid:r.rfid, rol:'vip' });
      } else if(/tic/.test(name)){
        const atemp = (estadoLower.replace(/\s+/g,'').includes('preacondicionamiento') || estadoLower.includes('pre acond')) && subLower.includes('atemperad');
        if(!atemp){ invalid.push({ rfid:r.rfid, reason:'TIC no Atemperado' }); continue; }
  // Cap estricto: máximo 6 TICs
  if(ticCount >= 6){ invalid.push({ rfid:r.rfid, reason:'Máximo 6 TICs' }); continue; }
        const elapsedNum = Number(r.atemperado_elapsed_sec);
        const atemperadoElapsedSec = Number.isFinite(elapsedNum) && elapsedNum > 0 ? elapsedNum : null;
        ticCount++; valid.push({ rfid:r.rfid, rol:'tic', atemperadoElapsedSec });
      } else {
        invalid.push({ rfid:r.rfid, reason:'Modelo no permitido' });
      }
    }
    const counts = { tics: ticCount, cube: haveCube?1:0, vip: haveVip?1:0 };
    // Siempre devolver 200 (ok) para permitir escaneo incremental; solo error duro si ninguna válida y todas inválidas
    if(!valid.length && invalid.length){
      return res.status(200).json({ ok:true, counts, roles: valid, valid, invalid, warning:'Sin válidos' });
    }
    res.json({ ok:true, counts, roles: valid, valid, invalid });
  },
  // Create caja (atomic) with exactly 1 cube, 1 vip, 6 tics (atemperadas)
  acondEnsamblajeCreate: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { rfids, order_id } = req.body as any;
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    let orderId: number | null = null;
    if(order_id != null){
      const n = Number(order_id);
      orderId = Number.isFinite(n) && n>0 ? n : null;
    }
    const input = Array.isArray(rfids) ? rfids : (rfids ? [rfids] : []);
    const codes = [...new Set(input.filter((x:any)=>typeof x==='string').map((s:string)=>s.trim()).filter(Boolean))];
    if(codes.length !== 8) return res.status(400).json({ ok:false, error:'Se requieren exactamente 8 RFIDs (1 cube, 1 vip, 6 tics)' });
  // Reglas rápidas: no permitir más de 6 TICs en los códigos provistos
  const maybeTicCount = codes.filter(c => /TIC/i.test(c)).length; // fallback por patrón del modelo no disponible en código; validación real ocurre abajo
  if(maybeTicCount > 6){ return res.status(400).json({ ok:false, error:'No se permiten más de 6 TICs', message:'No se permiten más de 6 TICs' }); }
  // Re-validate using same logic (include Ensamblado retention)

    let locationResult: { apply: boolean; zonaId: number | null; seccionId: number | null } | null = null;
    try {
      locationResult = await resolveLocationForRequest(tenant, sedeId, req.body);
    } catch (err: any) {
      if (isLocationError(err)) {
        return res.status(400).json({ ok: false, error: err.message || 'Ubicación inválida' });
      }
      throw err;
    }

    await withTenant(tenant, async (c)=>{
      // Limpieza conservadora (misma lógica que en validate). Ver comentarios allí.
      await c.query(`DELETE FROM acond_caja_items aci
                       WHERE NOT EXISTS (
                         SELECT 1 FROM inventario_credocubes ic
                          WHERE ic.rfid = aci.rfid
                            AND ic.estado IN ('Acondicionamiento','Operación')
                       )
                         AND NOT EXISTS (
                           SELECT 1 FROM acond_caja_timers t
                            WHERE t.caja_id = aci.caja_id
                              AND ((t.active IS TRUE) OR t.started_at IS NOT NULL)
                         )`);
      await c.query(`DELETE FROM acond_cajas c WHERE NOT EXISTS (SELECT 1 FROM acond_caja_items aci WHERE aci.caja_id=c.caja_id)`);
    });
    const rows = await withTenant(tenant, (c) => c.query(
      `WITH cajas_validas AS (
         SELECT c.caja_id
           FROM acond_cajas c
           JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
           JOIN inventario_credocubes ic2 ON ic2.rfid = aci.rfid
          GROUP BY c.caja_id
         HAVING bool_and(ic2.estado='Acondicionamiento' AND ic2.sub_estado IN ('Ensamblaje','Ensamblado'))
       )
  SELECT ic.rfid, ic.estado, ic.sub_estado, ic.lote, ic.activo, ic.sede_id, m.nombre_modelo,
              CASE WHEN aci.rfid IS NOT NULL THEN true ELSE false END AS ya_en_caja
         FROM inventario_credocubes ic
         JOIN modelos m ON m.modelo_id = ic.modelo_id
    LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid AND aci.caja_id IN (SELECT caja_id FROM cajas_validas)
        WHERE ic.rfid = ANY($1::text[])`, [codes]));
  let haveCube=false, haveVip=false, ticCount=0; const litrajes = new Set<string>();
  const roles: { rfid:string; rol:'cube'|'vip'|'tic'; litraje?: any }[] = [];
        for (const r of rows.rows as any[]) {
      if (r.rfid.length !== 24) return res.status(400).json({ ok:false, error:`${r.rfid} longitud inválida`, message:`${r.rfid} longitud inválida` });
      if (r.ya_en_caja) return res.status(400).json({ ok:false, error:`${r.rfid} ya está en una caja`, message:`${r.rfid} ya está en una caja` });
      if (r.activo === false) return res.status(400).json({ ok:false, error:`${r.rfid} está inhabilitado (activo=false)`, message:`${r.rfid} está inhabilitado (activo=false)` });
      const nombreNorm = normalizeBasic(r.nombre_modelo);
      const estadoNorm = normalizeBasic(r.estado);
      const subEstadoNorm = normalizeBasic(r.sub_estado);
      const esTic = nombreNorm.includes('tic');
      const esCube = nombreNorm.includes('cube');
      const esVip = nombreNorm.includes('vip');
      const enBodega = estadoNorm.includes('en bodega') || subEstadoNorm.includes('en bodega');
      const enPreAcond = estadoNorm.replace(/\s+/g,'').includes('preacondicionamiento') || estadoNorm.includes('pre acond');
      const subAtemper = subEstadoNorm.includes('atemperad');
      if (esTic) {
        if (ticCount >= 6) return res.status(400).json({ ok:false, error:'No se permiten más de 6 TICs', message:'No se permiten más de 6 TICs' });
        if (!(enPreAcond && subAtemper)) return res.status(400).json({ ok:false, error:`TIC ${r.rfid} no Atemperado`, message:`TIC ${r.rfid} no Atemperado` });
        ticCount++; roles.push({ rfid:r.rfid, rol:'tic', litraje: r.litraje }); litrajes.add(String(r.litraje||''));
      } else if (esCube) {
        if (haveCube) return res.status(400).json({ ok:false, error:'Más de un CUBE', message:'Más de un CUBE' });
        if (!enBodega) return res.status(400).json({ ok:false, error:`CUBE ${r.rfid} no está En bodega`, message:`CUBE ${r.rfid} no está En bodega` });
        haveCube=true; roles.push({ rfid:r.rfid, rol:'cube', litraje: r.litraje }); litrajes.add(String(r.litraje||''));
      } else if (esVip) {
        if (haveVip) return res.status(400).json({ ok:false, error:'Más de un VIP', message:'Más de un VIP' });
        if (!enBodega) return res.status(400).json({ ok:false, error:`VIP ${r.rfid} no está En bodega`, message:`VIP ${r.rfid} no está En bodega` });
        haveVip=true; roles.push({ rfid:r.rfid, rol:'vip', litraje: r.litraje }); litrajes.add(String(r.litraje||''));
      } else {
        return res.status(400).json({ ok:false, error:`${r.rfid} modelo no permitido`, message:`${r.rfid} modelo no permitido` });
      }
    }
    if(!(haveCube && haveVip && ticCount===6)) return res.status(400).json({ ok:false, error:'Composición inválida', message:'Composición inválida (1 cube, 1 vip, 6 tics)' });
    if(litrajes.size>1) return res.status(400).json({ ok:false, error:'Todos los items deben tener el mismo litraje', message:'Todos los items deben tener el mismo litraje' });
    const transferRows = (rows.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
    const transferCheck = await ensureCrossSedeAuthorization(
      req,
      res,
      transferRows,
      sedeId,
      allowSedeTransferFlag,
      { fallbackRfids: codes }
    );
    if (transferCheck.blocked) return;
    // All good: create caja and assign nuevo lote (random unique pattern)
  let loteNuevo = await generateNextCajaLote(tenant);
  await runWithSede(tenant, sedeId, async (c) => {
      const targetSede = transferCheck.targetSede;
      await c.query('BEGIN');
      try {
        // Ensure dependent tables/columns
        await c.query(`CREATE TABLE IF NOT EXISTS ordenes (
          id serial PRIMARY KEY,
          numero_orden text,
          codigo_producto text,
          cantidad integer,
          ciudad_destino text,
          ubicacion_destino text,
          cliente text,
          fecha_generacion timestamptz
        )`);
        await c.query(`ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS habilitada boolean NOT NULL DEFAULT true`);
        await c.query(`CREATE TABLE IF NOT EXISTS acond_cajas (
           caja_id serial PRIMARY KEY,
           lote text NOT NULL,
           created_at timestamptz NOT NULL DEFAULT NOW()
        )`);
        await c.query(`ALTER TABLE acond_cajas ADD COLUMN IF NOT EXISTS order_id integer`);
        await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_items (
           caja_id int NOT NULL REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
           rfid text NOT NULL,
           rol text NOT NULL CHECK (rol IN ('cube','vip','tic')),
           PRIMARY KEY (caja_id, rfid)
        )`);
      await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_timers (
        caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
        started_at timestamptz,
        duration_sec integer,
        active boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )`);
        await c.query(`CREATE INDEX IF NOT EXISTS acond_caja_items_rfid_idx ON acond_caja_items(rfid)`);
        await c.query(`DO $$
        BEGIN
          BEGIN
            EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS inventario_credocubes_rfid_key ON inventario_credocubes(rfid)';
          EXCEPTION WHEN others THEN
          END;
          -- FK to ordenes(order_id) if not exists
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = 'acond_cajas'::regclass
               AND conname = 'acond_cajas_order_id_fkey'
          ) THEN
            BEGIN
              ALTER TABLE acond_cajas
                ADD CONSTRAINT acond_cajas_order_id_fkey
                FOREIGN KEY (order_id) REFERENCES ordenes(id) ON DELETE SET NULL;
            EXCEPTION WHEN others THEN
            END;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = 'acond_caja_items'::regclass
               AND conname = 'acond_caja_items_rfid_fkey'
          ) THEN
            ALTER TABLE acond_caja_items
              ADD CONSTRAINT acond_caja_items_rfid_fkey
              FOREIGN KEY (rfid) REFERENCES inventario_credocubes(rfid) ON DELETE CASCADE;
          END IF;
        END $$;`);
        // Validate provided order_id exists (if provided)
        let orderNumero: string | null = null;
        if(orderId != null){
          const chk = await c.query(`SELECT numero_orden FROM ordenes WHERE id=$1 AND COALESCE(habilitada, true)`, [orderId]);
          if(!chk.rowCount){
            const err = new Error('Orden seleccionada no existe');
            (err as any).statusCode = 400;
            throw err;
          }
          orderNumero = chk.rows[0].numero_orden || null;
        }
        let rCaja; let retries=0;
        while(true){
          try {
            if(orderId != null){
              rCaja = await c.query(`INSERT INTO acond_cajas(lote, order_id) VALUES ($1, $2) RETURNING caja_id`, [loteNuevo, orderId]);
            } else {
              rCaja = await c.query(`INSERT INTO acond_cajas(lote) VALUES ($1) RETURNING caja_id`, [loteNuevo]);
            }
            break;
          } catch(e:any){
            if(/unique/i.test(e.message||'') && retries<4){
              loteNuevo = await generateNextCajaLote(tenant); retries++; continue;
            }
            throw e; }
        }
  // Hard uniqueness guard: if any other caja already has this lote but different id, abort
  const dupChk = await c.query(`SELECT caja_id FROM acond_cajas WHERE lote=$1`, [loteNuevo]);
  if((dupChk.rowCount||0) > 1){ throw new Error('Lote duplicado detectado: '+loteNuevo); }
        const cajaId = rCaja.rows[0].caja_id;
        // Clear lote for TICs first (as per requirement) then set estado/sub_estado + assign lote to all
        const ticRfids = roles.filter(r=>r.rol==='tic').map(r=>r.rfid);
        if(ticRfids.length){
          await c.query(
            `UPDATE inventario_credocubes ic
                SET lote = NULL,
                    sede_id = COALESCE($2::int, ic.sede_id)
               WHERE ic.rfid = ANY($1::text[])`,
            [ticRfids, targetSede]
          );
        }
        // Assign lote & move to Acondicionamiento/Ensamblaje
        if(orderNumero){
          await c.query(
            `UPDATE inventario_credocubes ic
                SET estado='Acondicionamiento',
                    sub_estado='Ensamblaje',
                    lote=$1,
                    numero_orden=$4,
                    sede_id = COALESCE($3::int, ic.sede_id)
              WHERE ic.rfid = ANY($2::text[])`,
            [loteNuevo, codes, targetSede, orderNumero]
          );
        } else {
          await c.query(
            `UPDATE inventario_credocubes ic
                SET estado='Acondicionamiento',
                    sub_estado='Ensamblaje',
                    lote=$1,
                    sede_id = COALESCE($3::int, ic.sede_id)
              WHERE ic.rfid = ANY($2::text[])`,
            [loteNuevo, codes, targetSede]
          );
        }
        if (locationResult?.apply) {
          await c.query(
            `UPDATE inventario_credocubes
                SET zona_id = $2, seccion_id = $3
              WHERE rfid = ANY($1::text[])`,
            [codes, locationResult.zonaId, locationResult.seccionId]
          );
        }
        // Cleanup: remove any leftover preacond timers for these TICs (they left Pre Acond)
        if(ticRfids.length){
          await c.query(`DELETE FROM preacond_item_timers WHERE rfid = ANY($1::text[])`, [ticRfids]);
        }
        // Insert items
        for(const it of roles){
          await c.query(`INSERT INTO acond_caja_items(caja_id, rfid, rol) VALUES ($1,$2,$3)`, [cajaId, it.rfid, it.rol]);
        }
        await c.query('COMMIT');
  console.log('[ACOND][CREATE] Nueva caja', { caja_id: cajaId, lote: loteNuevo });
  res.json({ ok:true, caja_id: cajaId, lote: loteNuevo });
      } catch (e:any) {
        await c.query('ROLLBACK');
        const status = Number.isInteger(e?.statusCode) ? Number(e.statusCode) : 500;
        res.status(status).json({ ok:false, error: e?.message || 'Error creando caja' });
      }
    }, { allowCrossSedeTransfer: transferCheck.allowCrossTransfer });
  },
  // ============================= ACONDICIONAMIENTO · CAJA TIMERS =============================
  acondCajaTimerStart: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { caja_id, durationSec } = req.body as any;
    const cajaId = Number(caja_id);
    const dur = Number(durationSec);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    if(!Number.isFinite(dur) || dur<=0) return res.status(400).json({ ok:false, error:'Duración inválida' });
  await runWithSede(tenant, sedeId, async (c)=>{
      await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_timers (
          caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
          started_at timestamptz,
          duration_sec integer,
          active boolean NOT NULL DEFAULT false,
          updated_at timestamptz NOT NULL DEFAULT NOW()
      )`);
      const ex = await c.query(`SELECT 1 FROM acond_cajas WHERE caja_id=$1`, [cajaId]);
      if(!ex.rowCount) return res.status(404).json({ ok:false, error:'Caja no existe' });
      await c.query('BEGIN');
      try {
        await c.query(`INSERT INTO acond_caja_timers(caja_id, started_at, duration_sec, active, updated_at)
            VALUES($1, NOW(), $2, true, NOW())
            ON CONFLICT (caja_id) DO UPDATE SET started_at=NOW(), duration_sec=EXCLUDED.duration_sec, active=true, updated_at=NOW()`,
          [cajaId, dur]);
  // (Ajuste) Ya no mover automáticamente a 'Despachando' al iniciar cronómetro.
  // Los items permanecen en 'Ensamblaje' hasta acción explícita posterior.
        await c.query('COMMIT');
      } catch(e){
        await c.query('ROLLBACK');
        throw e;
      }
    });
    res.json({ ok:true });
  },
  acondCajaTimerClear: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { caja_id } = req.body as any;
    const cajaId = Number(caja_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    await runWithSede(tenant, sedeId, async (c)=>{
      await c.query(`UPDATE acond_caja_timers SET active=false, started_at=NULL, duration_sec=NULL, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
    });
    res.json({ ok:true });
  },
  acondCajaTimerComplete: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { caja_id } = req.body as any;
    const cajaId = Number(caja_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    let moved = 0;
    await runWithSede(tenant, sedeId, async (c)=>{
      await c.query('BEGIN');
      try {
        // Stop / finalize timer
        await c.query(`UPDATE acond_caja_timers SET active=false, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
        // Fetch lote of caja
        const loteQ = await c.query(`SELECT lote FROM acond_cajas WHERE caja_id=$1`, [cajaId]);
        if(!loteQ.rowCount){ await c.query('ROLLBACK'); return res.status(404).json({ ok:false, error:'Caja no existe' }); }
        const lote = loteQ.rows[0].lote;
        // Ensure any items created later with same lote are linked to this caja
        await c.query(
          `WITH lote_items AS (
              SELECT ic.rfid,
                CASE
                  WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                  WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                  WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                  ELSE 'tic'
                END AS rol
              FROM inventario_credocubes ic
              JOIN modelos m ON m.modelo_id = ic.modelo_id
             WHERE ic.lote = $1
            )
            INSERT INTO acond_caja_items(caja_id, rfid, rol)
            SELECT $2, li.rfid, li.rol
              FROM lote_items li
         LEFT JOIN acond_caja_items aci ON aci.rfid = li.rfid AND aci.caja_id = $2
             WHERE aci.rfid IS NULL`, [lote, cajaId]);
        // New: transition Ensamblaje -> Ensamblado when timer completes
        const updEnsam = await c.query(
          `UPDATE inventario_credocubes ic
              SET sub_estado='Ensamblado'
             WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
               AND ic.estado='Acondicionamiento'
               AND ic.sub_estado='Ensamblaje'`, [cajaId]);
  // Ya no existe transición 'Despachando'; sólo se marca Ensamblado aquí
  moved = (updEnsam.rowCount||0);
        await c.query('COMMIT');
      } catch(e){
        await c.query('ROLLBACK');
        throw e;
      }
    });
    res.json({ ok:true, moved });
  },

  // ============================= ACONDICIONAMIENTO · DESPACHO MANUAL =============================
  // Lookup a caja by scanning one of its RFIDs while in Ensamblaje
  acondDespachoLookup: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { rfid } = req.body as any;
    const code = typeof rfid === 'string' ? rfid.trim() : '';
    if(code.length !== 24) return res.status(400).json({ ok:false, error:'RFID inválido' });
    try {
      // 1. Resolver caja_id y lote usando el RFID
      const cajaRow = await withTenant(tenant, (c)=> c.query(
        `SELECT c.caja_id, c.lote, c.order_id, o.numero_orden AS order_num
           FROM acond_caja_items aci
           JOIN acond_cajas c ON c.caja_id = aci.caja_id
      LEFT JOIN ordenes o ON o.id = c.order_id
          WHERE aci.rfid = $1
          LIMIT 1`, [code]));
      if(!cajaRow.rowCount) return res.status(404).json({ ok:false, error:'RFID no pertenece a ninguna caja' });
  const cajaId = cajaRow.rows[0].caja_id;
  const lote = cajaRow.rows[0].lote;
  const orderId = cajaRow.rows[0].order_id ?? null;
  const orderNum = cajaRow.rows[0].order_num ?? null;
      // 2. Traer componentes actuales + litraje/rol (fallback si columna litraje no existe)
      let currentQ:any; let litrajeDisponible = true;
      try {
        currentQ = await withTenant(tenant, (c)=> c.query(
          `SELECT aci.rfid,
                  CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                       WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                       WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                       ELSE 'tic' END AS rol,
                  m.litraje,
                  ic.estado, ic.sub_estado
             FROM acond_caja_items aci
             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
             JOIN modelos m ON m.modelo_id = ic.modelo_id
            WHERE aci.caja_id=$1`, [cajaId]));
      } catch(err:any){
        if(/litraje/i.test(err.message||'')){
          litrajeDisponible = false;
          currentQ = await withTenant(tenant, (c)=> c.query(
            `SELECT aci.rfid,
                    CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                         WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                         WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                         ELSE 'tic' END AS rol,
                    ic.estado, ic.sub_estado
               FROM acond_caja_items aci
               JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
               JOIN modelos m ON m.modelo_id = ic.modelo_id
              WHERE aci.caja_id=$1`, [cajaId]));
        } else { throw err; }
      }
      let rows = currentQ.rows as any[];
      // 3. Si faltan roles, intentar autocompletar buscando candidatos libres (no en otra caja) con mismo litraje
      const need = { tic:6, vip:1, cube:1 };
      const counts = { tic:0, vip:0, cube:0 } as any;
      let litrajeRef: any = null;
      for(const r of rows){ counts[r.rol]++; if(r.litraje!=null && litrajeRef==null) litrajeRef = r.litraje; }
      const missingRoles: { rol:'tic'|'vip'|'cube'; falta:number }[] = [];
      (['cube','vip','tic'] as const).forEach(rol => { const falta = (need as any)[rol] - (counts as any)[rol]; if(falta>0) missingRoles.push({ rol, falta }); });
      if(missingRoles.length){
        for(const m of missingRoles){
          let candQ;
          try {
            candQ = await withTenant(tenant, (c)=> c.query(
              `SELECT ic.rfid,
                      CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                           WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                           WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                           ELSE 'tic' END AS rol
                 FROM inventario_credocubes ic
                 JOIN modelos m ON m.modelo_id = ic.modelo_id
            LEFT JOIN acond_caja_items aci2 ON aci2.rfid = ic.rfid
                WHERE aci2.rfid IS NULL
                  AND ic.estado='Acondicionamiento' AND ic.sub_estado IN ('Ensamblaje','Ensamblado')
                  AND (( $1::text IS NULL) OR m.litraje = $2)
                  AND (( $3='tic' AND m.nombre_modelo ILIKE '%tic%') OR ( $3='vip' AND m.nombre_modelo ILIKE '%vip%') OR ( $3='cube' AND (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%')))
                LIMIT $4`, [litrajeRef==null?null:String(litrajeRef), litrajeRef, m.rol, m.falta]));
          } catch(err:any){
            if(/litraje/i.test(err.message||'')){
              // Reintentar sin usar columna litraje
              candQ = await withTenant(tenant, (c)=> c.query(
                `SELECT ic.rfid,
                        CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                             WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                             WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                             ELSE 'tic' END AS rol
                   FROM inventario_credocubes ic
                   JOIN modelos m ON m.modelo_id = ic.modelo_id
              LEFT JOIN acond_caja_items aci2 ON aci2.rfid = ic.rfid
                  WHERE aci2.rfid IS NULL
                    AND ic.estado='Acondicionamiento' AND ic.sub_estado IN ('Ensamblaje','Ensamblado')
                    AND (( $1='tic' AND m.nombre_modelo ILIKE '%tic%') OR ( $1='vip' AND m.nombre_modelo ILIKE '%vip%') OR ( $1='cube' AND (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%')))
                  LIMIT $2`, [m.rol, m.falta]));
            } else { throw err; }
          }
          const toInsert = candQ.rows as any[];
          for(const ins of toInsert){
            await withTenant(tenant, (c)=> c.query(`INSERT INTO acond_caja_items(caja_id, rfid, rol) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [cajaId, ins.rfid, ins.rol]));
          }
        }
        // recargar
        const recQ = await withTenant(tenant, (c)=> c.query(
          `SELECT aci.rfid,
                  CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                       WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                       WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                       ELSE 'tic' END AS rol,
                  ic.estado, ic.sub_estado
             FROM acond_caja_items aci
             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
             JOIN modelos m ON m.modelo_id = ic.modelo_id
            WHERE aci.caja_id=$1`, [cajaId]));
        rows = recQ.rows as any[];
      }
      const total = rows.length;
      let listos = 0;
      for(const r of rows){ if(r.sub_estado==='Lista para Despacho' || r.sub_estado==='Listo') listos++; }
      const pendientes = total - listos;
      let timer = null;
      const timerQ = await withTenant(tenant, (c)=> c.query(
        `SELECT started_at, duration_sec, active FROM acond_caja_timers WHERE caja_id=$1`,
        [cajaId]
      ));
      if(timerQ.rowCount){
        const t = timerQ.rows[0] as any;
        let endsAt: string | null = null;
        let remainingSec: number | null = null;
        if(t.started_at && t.duration_sec != null){
          const startMs = new Date(t.started_at).getTime();
          const durMs = Number(t.duration_sec)*1000;
          const endMs = startMs + durMs;
          endsAt = new Date(endMs).toISOString();
          remainingSec = Math.max(0, Math.floor((endMs - Date.now())/1000));
        }
        timer = { startsAt: t.started_at, durationSec: t.duration_sec, active: t.active === true, endsAt, remainingSec };
      }
      // Nueva regla: Sólo exponer lista de componentes (rfids) si TODOS están en sub_estado 'Ensamblado'
      const allEnsamblado = rows.length>0 && rows.every(r=> r.sub_estado==='Ensamblado');
      res.json({
        ok:true,
        caja_id: cajaId,
        lote,
        order_id: orderId,
        order_num: orderNum,
        timer,
        // Back-compat: mantener rfids plano; nuevo: incluir rol por componente
        rfids: allEnsamblado ? rows.map(r=>r.rfid) : [],
        componentes: allEnsamblado ? rows.map(r=> ({ rfid: r.rfid, rol: r.rol })) : [],
        pendientes,
        total,
        allEnsamblado,
        componentesOcultos: !allEnsamblado
      });
    } catch(e:any){
      res.status(500).json({ ok:false, error: e.message||'Error lookup' });
    }
  },
  // Move entire caja to Lista para Despacho given one RFID (auto-detect caja)
  acondDespachoMove: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { rfid, durationSec, order_id, allowIncomplete } = req.body as any;
    const allowIncompleteFlag = allowIncomplete === true;
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    const code = typeof rfid === 'string' ? rfid.trim() : '';
    const dur = Number(durationSec);
    if(code.length !== 24) return res.status(400).json({ ok:false, error:'RFID inválido' });
    if(!Number.isFinite(dur) || dur <= 0) return res.status(400).json({ ok:false, error:'durationSec requerido (>0)' });
    try {
      const cajaInfoQ = await withTenant(tenant, (c)=> c.query(
        `SELECT c.caja_id, c.lote, c.order_id
           FROM acond_caja_items aci
           JOIN acond_cajas c ON c.caja_id = aci.caja_id
          WHERE aci.rfid=$1
          LIMIT 1`,
        [code]
      ));
      if(!cajaInfoQ.rowCount){ return res.status(404).json({ ok:false, error:'RFID no pertenece a caja' }); }
      const cajaInfo = cajaInfoQ.rows[0] as any;
      const cajaId = cajaInfo.caja_id;

      const itemsSedeQ = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.sede_id
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id=$1`,
        [cajaId]
      ));
      if(!itemsSedeQ.rowCount){ return res.status(404).json({ ok:false, error:'Caja sin items' }); }
      const transferRows = (itemsSedeQ.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
      const transferCheck = await ensureCrossSedeAuthorization(
        req,
        res,
        transferRows,
        sedeId,
        allowSedeTransferFlag,
        { fallbackRfids: transferRows.map((r) => r.rfid) }
      );
      if (transferCheck.blocked) return;

      await runWithSede(tenant, sedeId, async (c) => {
        const targetSede = transferCheck.targetSede;
        await c.query('BEGIN');
        try {
          const cajaQ = await c.query(
            `SELECT c.caja_id, c.lote, c.order_id
               FROM acond_caja_items aci
               JOIN acond_cajas c ON c.caja_id = aci.caja_id
              WHERE aci.rfid=$1
              LIMIT 1`,
            [code]
          );
          if(!cajaQ.rowCount){ await c.query('ROLLBACK'); return res.status(404).json({ ok:false, error:'RFID no pertenece a caja' }); }
          const cajaRow = cajaQ.rows[0] as any;
          const cajaIdActual = cajaRow.caja_id;
          const lote = cajaRow.lote;
          const cajaOrderId = cajaRow.order_id ?? null;

          if(cajaIdActual !== cajaId){
            await c.query('ROLLBACK');
            return res.status(409).json({ ok:false, error:'La caja cambió durante el proceso, intenta nuevamente' });
          }
    // Bloquear si cronómetro de ensamblaje aún activo (no se ha marcado Ensamblado)
    const timerQ = await c.query(`SELECT active, started_at, duration_sec FROM acond_caja_timers WHERE caja_id=$1`, [cajaId]);
    const timerRow = timerQ.rowCount ? timerQ.rows[0] : null;
    const timerActive = timerRow ? timerRow.active === true : false;
    if(timerActive && !allowIncompleteFlag){ await c.query('ROLLBACK'); return res.status(400).json({ ok:false, error:'Cronometro en progreso: espera a que termine (Ensamblado) antes de despachar' }); }
      // Verificar que TODOS los items estén Ensamblado (no permitir mover si quedan en Ensamblaje)
      const estadoItems = await c.query(`SELECT ic.sub_estado FROM acond_caja_items aci JOIN inventario_credocubes ic ON ic.rfid=aci.rfid WHERE aci.caja_id=$1`, [cajaId]);
      if(!estadoItems.rowCount){ await c.query('ROLLBACK'); return res.status(400).json({ ok:false, error:'Caja sin items' }); }
  const allEnsamblado = estadoItems.rows.every((r: any) => r.sub_estado==='Ensamblado');
      if(!allEnsamblado){ await c.query('ROLLBACK'); return res.status(400).json({ ok:false, error:'Caja no está completamente Ensamblada' }); }
          // Detectar si existe columna litraje (para evitar abortar transacción por error)
          const colQ = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='modelos' AND column_name='litraje' LIMIT 1`);
          const litrajeExists = !!colQ.rowCount;
          // Cargar componentes actuales
          const cur = litrajeExists
            ? await c.query(`SELECT aci.rfid, aci.rol, m.litraje FROM acond_caja_items aci JOIN inventario_credocubes ic ON ic.rfid=aci.rfid JOIN modelos m ON m.modelo_id=ic.modelo_id WHERE aci.caja_id=$1`, [cajaId])
            : await c.query(`SELECT aci.rfid, aci.rol FROM acond_caja_items aci JOIN inventario_credocubes ic ON ic.rfid=aci.rfid JOIN modelos m ON m.modelo_id=ic.modelo_id WHERE aci.caja_id=$1`, [cajaId]);
          const counts: any = { tic:0, vip:0, cube:0 }; let litrajeRef:any=null;
          for(const r of cur.rows){ counts[r.rol]++; if(litrajeExists && r.litraje!=null && litrajeRef==null) litrajeRef=r.litraje; }
          const need:any = { tic:6, vip:1, cube:1 };
          for(const rol of ['cube','vip','tic']){
            const falta = need[rol]-counts[rol];
            if(falta>0){
              let cand:any;
              if(litrajeExists){
                cand = await c.query(
                  `SELECT ic.rfid,
                          CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                               WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                               WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                               ELSE 'tic' END AS rol
                     FROM inventario_credocubes ic
                     JOIN modelos m ON m.modelo_id = ic.modelo_id
                LEFT JOIN acond_caja_items aci2 ON aci2.rfid = ic.rfid
                    WHERE aci2.rfid IS NULL
                      AND ic.estado='Acondicionamiento' AND ic.sub_estado IN ('Ensamblaje','Ensamblado')
                      AND (($1::text IS NULL) OR m.litraje = $2)
                      AND (( $3='tic' AND m.nombre_modelo ILIKE '%tic%') OR ( $3='vip' AND m.nombre_modelo ILIKE '%vip%') OR ($3='cube' AND (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%')))
                    LIMIT $4`, [litrajeRef==null?null:String(litrajeRef), litrajeRef, rol, falta]);
              } else {
                cand = await c.query(
                  `SELECT ic.rfid,
                          CASE WHEN m.nombre_modelo ILIKE '%cube%' THEN 'cube'
                               WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
                               WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
                               ELSE 'tic' END AS rol
                     FROM inventario_credocubes ic
                     JOIN modelos m ON m.modelo_id = ic.modelo_id
                LEFT JOIN acond_caja_items aci2 ON aci2.rfid = ic.rfid
                    WHERE aci2.rfid IS NULL
                      AND ic.estado='Acondicionamiento' AND ic.sub_estado IN ('Ensamblaje','Ensamblado')
                      AND (( $1='tic' AND m.nombre_modelo ILIKE '%tic%') OR ( $1='vip' AND m.nombre_modelo ILIKE '%vip%') OR ($1='cube' AND (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%')))
                    LIMIT $2`, [rol, falta]);
              }
              for(const r of cand.rows){
                await c.query(`INSERT INTO acond_caja_items(caja_id, rfid, rol) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [cajaId, r.rfid, r.rol]);
              }
            }
          }
          // Arranque obligatorio de cronómetro de despacho: crear/actualizar timer de caja
          await c.query(`CREATE TABLE IF NOT EXISTS acond_caja_timers (
              caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
              started_at timestamptz,
              duration_sec integer,
              active boolean NOT NULL DEFAULT false,
              updated_at timestamptz NOT NULL DEFAULT NOW()
            )`);
          await c.query(`INSERT INTO acond_caja_timers(caja_id, started_at, duration_sec, active, updated_at)
              VALUES($1,NOW(),$2,true,NOW())
            ON CONFLICT (caja_id) DO UPDATE SET started_at=NOW(), duration_sec=EXCLUDED.duration_sec, active=true, updated_at=NOW()`,[cajaId,dur]);
      // Flujo simplificado: al iniciar cronómetro se pasa directamente a 'Lista para Despacho'
          const estadoFiltro = allowIncompleteFlag ? "IN ('Ensamblado','Ensamblaje')" : "='Ensamblado'";
          const upd = await c.query(
            `UPDATE inventario_credocubes ic
                SET sub_estado='Lista para Despacho',
                    sede_id = COALESCE($2::int, ic.sede_id)
               WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                 AND ic.estado='Acondicionamiento'
                 AND ic.sub_estado ${estadoFiltro}`, [cajaId, targetSede]);
          // Si viene order_id y la caja no tiene uno asignado todavía, asociarlo
          if(order_id!=null && cajaOrderId==null){
            const parsed = Number(order_id);
            if(Number.isFinite(parsed) && parsed>0){
              // Obtener numero_orden
              const ordQ = await c.query(`SELECT numero_orden FROM ordenes WHERE id=$1 AND COALESCE(habilitada, true)`, [parsed]);
              if(ordQ.rowCount){
                const numOrd = ordQ.rows[0].numero_orden || null;
                try { await c.query(`UPDATE acond_cajas SET order_id=$1 WHERE caja_id=$2 AND order_id IS NULL`, [parsed, cajaId]); } catch(e){ /* ignore */ }
                if(numOrd){
                  try { await c.query(`UPDATE inventario_credocubes SET numero_orden=$2 WHERE rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)`, [cajaId, numOrd]); } catch(e){ /* ignore */ }
                }
              }
            }
          }
          await c.query('COMMIT');
          res.json({ ok:true, caja_id: cajaId, lote, moved: upd.rowCount, timer: { durationSec: dur }, forced: allowIncompleteFlag });
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      }, { allowCrossSedeTransfer: transferCheck.allowCrossTransfer });
    } catch(e:any){
      res.status(500).json({ ok:false, error: e.message||'Error moviendo a despacho' });
    }
  },
  // Move caja by caja_id directly, only if ALL items are Ensamblado (post-timer completion)
  acondDespachoMoveCaja: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { caja_id } = req.body as any;
    const cajaId = Number(caja_id);
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    if(!Number.isFinite(cajaId) || cajaId <= 0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    try {
      const sedeRowsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.sede_id
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id=$1`,
        [cajaId]
      ));
      if(!sedeRowsQ.rowCount) return res.status(404).json({ ok:false, error:'Caja sin items o no existe' });
      const transferRows = (sedeRowsQ.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
      const transferCheck = await ensureCrossSedeAuthorization(
        req,
        res,
        transferRows,
        sedeId,
        allowSedeTransferFlag,
        { fallbackRfids: transferRows.map((r) => r.rfid) }
      );
      if (transferCheck.blocked) return;

      let moved = 0;
      await runWithSede(tenant, sedeId, async (c)=>{
        const targetSede = transferCheck.targetSede;
        await c.query('BEGIN');
        try {
          const itemsQ = await c.query(
            `SELECT ic.rfid, ic.sub_estado, ic.estado
               FROM acond_caja_items aci
               JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
              WHERE aci.caja_id=$1`, [cajaId]);
          if(!itemsQ.rowCount){ await c.query('ROLLBACK'); return res.status(404).json({ ok:false, error:'Caja sin items o no existe' }); }
          const timerQ = await c.query(`SELECT active FROM acond_caja_timers WHERE caja_id=$1`, [cajaId]);
          if(timerQ.rowCount && timerQ.rows[0].active){ await c.query('ROLLBACK'); return res.status(400).json({ ok:false, error:'Cronómetro en progreso: espera a que finalice (Ensamblado) para mover a despacho' }); }
          const allEnsamblado = itemsQ.rows.every((r: any) => r.estado==='Acondicionamiento' && r.sub_estado==='Ensamblado');
          if(!allEnsamblado){ await c.query('ROLLBACK'); return res.status(400).json({ ok:false, error:'Caja no está completamente Ensamblada' }); }
          const upd = await c.query(
            `UPDATE inventario_credocubes ic
                SET sub_estado='Lista para Despacho',
                    sede_id = COALESCE($2::int, ic.sede_id)
               WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                 AND ic.estado='Acondicionamiento'
                 AND ic.sub_estado='Ensamblado'`, [cajaId, targetSede]);
          moved = upd.rowCount || 0;
          await c.query('COMMIT');
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      }, { allowCrossSedeTransfer: transferCheck.allowCrossTransfer });
      res.json({ ok:true, moved });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error moviendo caja' }); }
  },
  // Set or change order for an existing caja (any estado) and propagate numero_orden to its items
  acondCajaSetOrder: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { caja_id, order_id } = req.body as any;
    const cajaId = Number(caja_id);
    const orderId = Number(order_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    if(!Number.isFinite(orderId) || orderId<=0) return res.status(400).json({ ok:false, error:'order_id inválido' });
    try {
      let orderNum: string | null = null;
      await runWithSede(tenant, sedeId, async (c)=>{
        await c.query('BEGIN');
        try {
          const cajaQ = await c.query(`SELECT caja_id, order_id FROM acond_cajas WHERE caja_id=$1 FOR UPDATE`, [cajaId]);
          if(!cajaQ.rowCount){ await c.query('ROLLBACK'); return res.status(404).json({ ok:false, error:'Caja no existe' }); }
          const ordQ = await c.query(`SELECT id, numero_orden FROM ordenes WHERE id=$1 AND COALESCE(habilitada, true)`, [orderId]);
          if(!ordQ.rowCount){ await c.query('ROLLBACK'); return res.status(404).json({ ok:false, error:'Orden no existe' }); }
          orderNum = ordQ.rows[0].numero_orden || null;
          // Actualizar caja (permitir cambiar de orden también)
          await c.query(`UPDATE acond_cajas SET order_id=$1 WHERE caja_id=$2`, [orderId, cajaId]);
          if(orderNum){
            // Propagar numero_orden a items de inventario
            await c.query(`UPDATE inventario_credocubes SET numero_orden=$2 WHERE rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)`, [cajaId, orderNum]);
          }
          await c.query('COMMIT');
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      });
      res.json({ ok:true, caja_id: cajaId, order_id: orderId, order_num: orderNum });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error asignando orden' }); }
  },

  // ============================= OPERACIÓN · CAJA LOOKUP & MOVE =============================
  // Lookup caja by either a component RFID (24 chars) or the caja lote code (e.g. CAJA001-05092025)
  operacionCajaLookup: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { code } = req.body as any;
    let val = typeof code === 'string' ? code.trim() : '';
    if(!val) return res.status(400).json({ ok:false, error:'Código requerido' });
    try {
      // Resolve caja_id
      let cajaRow: any = null;
      if(val.length === 24){
        const r = await withTenant(tenant, (c)=> c.query(
          `SELECT c.caja_id, c.lote FROM acond_caja_items aci JOIN acond_cajas c ON c.caja_id = aci.caja_id WHERE aci.rfid=$1 LIMIT 1`, [val]));
        if(r.rowCount) cajaRow = r.rows[0];
      }
      if(!cajaRow){
        // Try as lote code
        const r2 = await withTenant(tenant, (c)=> c.query(`SELECT caja_id, lote FROM acond_cajas WHERE lote=$1 LIMIT 1`, [val]));
        if(r2.rowCount) cajaRow = r2.rows[0];
      }
      if(!cajaRow) return res.status(404).json({ ok:false, error:'Caja no encontrada' });
      const cajaId = cajaRow.caja_id;
      const itemsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT aci.rol, ic.rfid, ic.estado, ic.sub_estado, m.nombre_modelo
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
           JOIN modelos m ON m.modelo_id = ic.modelo_id
          WHERE aci.caja_id=$1
          ORDER BY CASE aci.rol WHEN 'vip' THEN 0 WHEN 'tic' THEN 1 ELSE 2 END, ic.rfid`, [cajaId]));
      // Ensure table exists then fetch timer
      await withTenant(tenant, (c)=> c.query(`CREATE TABLE IF NOT EXISTS operacion_caja_timers (
           caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
           started_at timestamptz,
           duration_sec integer,
           active boolean NOT NULL DEFAULT false,
           updated_at timestamptz NOT NULL DEFAULT NOW()
         )`));
      const timerSingleQ = await withTenant(tenant, (c)=> c.query(`SELECT caja_id, started_at, duration_sec, active FROM operacion_caja_timers WHERE caja_id=$1`, [cajaId]));
      let timerRow: any = null;
      if(timerSingleQ.rowCount) timerRow = timerSingleQ.rows[0];
      const items = itemsQ.rows as any[];
      const allListo = items.every(i => i.estado==='Acondicionamiento' && (i.sub_estado==='Lista para Despacho' || i.sub_estado==='Listo'));
      const allOperacion = items.every(i => i.estado==='Operación');
      let timer: any = null;
      if(timerRow && timerRow.started_at && timerRow.duration_sec){
        const startsAt = timerRow.started_at;
        const endsAt = new Date(new Date(startsAt).getTime() + timerRow.duration_sec*1000).toISOString();
        timer = { startsAt, endsAt, active: !!timerRow.active };
      }
  // Fetch order info for caja
  const orderQ = await withTenant(tenant, (c)=> c.query(`SELECT c.order_id, o.numero_orden AS order_num FROM acond_cajas c LEFT JOIN ordenes o ON o.id = c.order_id WHERE c.caja_id=$1`, [cajaId]));
  const orderRow = orderQ.rowCount ? orderQ.rows[0] as any : { order_id: null, order_num: null };
  res.json({ ok:true, caja: { id: cajaId, lote: cajaRow.lote, items, allListo, allOperacion, timer, order_id: orderRow.order_id ?? null, order_num: orderRow.order_num ?? null } });
    } catch(e:any){
      res.status(500).json({ ok:false, error: e.message||'Error lookup' });
    }
  },
  // Move all items of caja from Lista para Despacho -> Operación (sub_estado 'Transito')
  operacionCajaMove: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { code } = req.body as any;
    let val = typeof code === 'string' ? code.trim() : '';
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    if(!val) return res.status(400).json({ ok:false, error:'Código requerido' });
    try {
      let cajaId: number | null = null;
      if(val.length===24){
        const r = await withTenant(tenant, (c)=> c.query(`SELECT c.caja_id FROM acond_caja_items aci JOIN acond_cajas c ON c.caja_id=aci.caja_id WHERE aci.rfid=$1 LIMIT 1`, [val]));
        if(r.rowCount) cajaId = r.rows[0].caja_id;
      }
      if(cajaId==null){
        const r2 = await withTenant(tenant, (c)=> c.query(`SELECT caja_id FROM acond_cajas WHERE lote=$1 LIMIT 1`, [val]));
        if(r2.rowCount) cajaId = r2.rows[0].caja_id;
      }
      if(cajaId==null) return res.status(404).json({ ok:false, error:'Caja no encontrada' });
      const sedeRowsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.sede_id
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id=$1`,
        [cajaId]
      ));
      if(!sedeRowsQ.rowCount) return res.status(404).json({ ok:false, error:'Caja sin items' });
      const transferRows = (sedeRowsQ.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
      const transferCheck = await ensureCrossSedeAuthorization(
        req,
        res,
        transferRows,
        sedeId,
        allowSedeTransferFlag,
        { fallbackRfids: transferRows.map((r) => r.rfid) }
      );
      if (transferCheck.blocked) return;

      await runWithSede(tenant, sedeId, async (c)=>{
        const targetSede = transferCheck.targetSede;
        await c.query('BEGIN');
        try {
          // Only move those currently listos para despacho
            await c.query(
            `UPDATE inventario_credocubes ic
          SET estado='Operación', sub_estado='Transito', zona_id = NULL, seccion_id = NULL,
              sede_id = COALESCE($2::int, ic.sede_id)
                 WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                   AND ic.estado='Acondicionamiento'
                   AND ic.sub_estado IN ('Lista para Despacho','Listo')`, [cajaId, targetSede]);
          await c.query('COMMIT');
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      }, { allowCrossSedeTransfer: transferCheck.allowCrossTransfer });
      res.json({ ok:true, caja_id: cajaId });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error moviendo a Operación' }); }
  },
  // Start manual timer in Operación phase for caja
  operacionCajaTimerStart: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { caja_id, durationSec } = req.body as any;
    const cajaId = Number(caja_id);
    const dur = Number(durationSec);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    if(!Number.isFinite(dur) || dur<=0) return res.status(400).json({ ok:false, error:'Duración inválida' });
    await withTenant(tenant, async (c)=>{
      await c.query(`CREATE TABLE IF NOT EXISTS operacion_caja_timers (
           caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
           started_at timestamptz,
           duration_sec integer,
           active boolean NOT NULL DEFAULT false,
           updated_at timestamptz NOT NULL DEFAULT NOW()
        )`);
      const ex = await c.query(`SELECT 1 FROM acond_cajas WHERE caja_id=$1`, [cajaId]);
      if(!ex.rowCount) return res.status(404).json({ ok:false, error:'Caja no existe' });
      await c.query('BEGIN');
      try {
        await c.query(`INSERT INTO operacion_caja_timers(caja_id, started_at, duration_sec, active, updated_at)
                         VALUES($1,NOW(),$2,true,NOW())
            ON CONFLICT (caja_id) DO UPDATE SET started_at=NOW(), duration_sec=EXCLUDED.duration_sec, active=true, updated_at=NOW()`,[cajaId,dur]);
        // Asegurar sub_estado='Transito' para todos los items de la caja que estén en Operación y no finalizados
        await c.query(`UPDATE inventario_credocubes ic
                         SET sub_estado='Transito'
                        WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                          AND ic.estado='Operación'
                          AND (ic.sub_estado IS NULL OR ic.sub_estado NOT IN ('Retorno','Completado','Transito'))`, [cajaId]);
        await c.query('COMMIT');
      } catch(e){ await c.query('ROLLBACK'); throw e; }
    });
    res.json({ ok:true });
  },
  // Start timer for one caja and replicate same duration to all other cajas in Operación with same lote
  operacionCajaTimerStartBulk: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { caja_id, durationSec } = req.body as any;
    const cajaId = Number(caja_id); const dur = Number(durationSec);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    if(!Number.isFinite(dur) || dur<=0) return res.status(400).json({ ok:false, error:'Duración inválida' });
    try {
      await withTenant(tenant, async (c)=>{
        await c.query('BEGIN');
        try {
          // Get lote of target caja
          const loteQ = await c.query(`SELECT lote FROM acond_cajas WHERE caja_id=$1`, [cajaId]);
            if(!loteQ.rowCount){ await c.query('ROLLBACK'); return res.status(404).json({ ok:false, error:'Caja no existe' }); }
          const lote = loteQ.rows[0].lote;
          await c.query(`CREATE TABLE IF NOT EXISTS operacion_caja_timers (
             caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
             started_at timestamptz,
             duration_sec integer,
             active boolean NOT NULL DEFAULT false,
             updated_at timestamptz NOT NULL DEFAULT NOW()
          )`);
          // Find all cajas in Operación with same lote (at least one item in Operación)
          const cajasQ = await c.query(
            `SELECT DISTINCT c.caja_id
               FROM acond_cajas c
               JOIN acond_caja_items aci ON aci.caja_id=c.caja_id
               JOIN inventario_credocubes ic ON ic.rfid=aci.rfid
              WHERE c.lote=$1 AND ic.estado='Operación'`, [lote]);
          const ids = cajasQ.rows.map(r=> r.caja_id);
          for(const id of ids){
            await c.query(`INSERT INTO operacion_caja_timers(caja_id, started_at, duration_sec, active, updated_at)
                            VALUES($1,NOW(),$2,true,NOW())
               ON CONFLICT (caja_id) DO UPDATE SET started_at=NOW(), duration_sec=EXCLUDED.duration_sec, active=true, updated_at=NOW()`, [id, dur]);
          }
          await c.query('COMMIT');
          res.json({ ok:true, lote, cajas: ids.length });
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error iniciando timers' }); }
  },
  operacionCajaTimerClear: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { caja_id } = req.body as any;
    const cajaId = Number(caja_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    await withTenant(tenant, async (c)=>{
      await c.query('BEGIN');
      try {
        await c.query(`UPDATE operacion_caja_timers SET active=false, started_at=NULL, duration_sec=NULL, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
        // Volver items a estado base (sub_estado NULL) para permitir iniciar de nuevo
        await c.query(`UPDATE inventario_credocubes ic
                         SET sub_estado=NULL
                        WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                          AND ic.estado='Operación'`, [cajaId]);
        await c.query('COMMIT');
      } catch(e){ await c.query('ROLLBACK'); throw e; }
    });
    res.json({ ok:true });
  },
  operacionCajaTimerComplete: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { caja_id } = req.body as any;
    const cajaId = Number(caja_id);
    if(!Number.isFinite(cajaId) || cajaId<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    await withTenant(tenant, async (c)=>{
      await c.query('BEGIN');
      try {
        await c.query(`UPDATE operacion_caja_timers SET active=false, updated_at=NOW() WHERE caja_id=$1`, [cajaId]);
        // Marcar items como Retorno (cronómetro finalizado)
        await c.query(`UPDATE inventario_credocubes ic SET sub_estado='Retorno' WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1) AND ic.estado='Operación' AND ic.sub_estado='Transito'`, [cajaId]);
        await c.query('COMMIT');
      } catch(e){ await c.query('ROLLBACK'); throw e; }
    });
    res.json({ ok:true });
  },

  // List cajas currently en Operación (or en tránsito) with timer info (for new UI)
  operacionData: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    try {
  // Cronómetro general: reutilizar acond_caja_timers (definido en etapa Lista para Despacho)
      await withTenant(tenant, (c)=> c.query(`CREATE TABLE IF NOT EXISTS acond_caja_timers (
        caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
        started_at timestamptz,
        duration_sec integer,
        active boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )`));
      // Asegurar que cada lote en Operación/Transito tenga fila en acond_cajas
      try {
        await withTenant(tenant, (c)=> c.query(`
          INSERT INTO acond_cajas (lote)
          SELECT DISTINCT ic.lote
            FROM inventario_credocubes ic
       LEFT JOIN acond_cajas c ON c.lote = ic.lote
           WHERE ic.estado='Operación' AND ic.sub_estado='Transito' AND c.caja_id IS NULL AND ic.lote IS NOT NULL AND ic.lote <> ''`));
      } catch(e){ if(KANBAN_DEBUG) console.log('[operacionData] insert missing cajas error', (e as any)?.message); }
   // Auto-reparación: si existen items cuyo lote coincide con una caja pero no están en acond_caja_items, insertarlos.
   try {
     await withTenant(tenant, (c)=> c.query(`
    INSERT INTO acond_caja_items (caja_id, rfid, rol)
    SELECT c.caja_id, ic.rfid,
        CASE WHEN m.nombre_modelo ILIKE '%tic%' THEN 'tic'
          WHEN m.nombre_modelo ILIKE '%vip%' THEN 'vip'
          WHEN (m.nombre_modelo ILIKE '%cube%' OR m.nombre_modelo ILIKE '%cubo%') THEN 'cube'
          ELSE 'otro' END AS rol
      FROM inventario_credocubes ic
      JOIN acond_cajas c ON c.lote = ic.lote
      JOIN modelos m ON m.modelo_id = ic.modelo_id
    LEFT JOIN acond_caja_items aci ON aci.rfid = ic.rfid
     WHERE aci.rfid IS NULL`));
   } catch(e){ if(KANBAN_DEBUG) console.log('[operacionData] backfill acond_caja_items error', (e as any)?.message); }
      const nowRes = await withTenant(tenant, (c)=> c.query<{ now:string }>(`SELECT NOW()::timestamptz AS now`));
      const cajasParams: any[] = [];
      const cajasSede = pushSedeFilter(cajasParams, sedeId);
      const cajasQ = await withTenant(tenant, (c)=> c.query(
        `SELECT c.caja_id, c.lote, c.order_id, o.numero_orden AS order_num,
                act.started_at, act.duration_sec, act.active,
                COUNT(*) FILTER (WHERE ic.estado='Operación') AS total_op,
                COUNT(*) FILTER (WHERE ic.estado='Operación' AND ic.sub_estado='Completado') AS completados
           FROM acond_cajas c
           JOIN acond_caja_items aci ON aci.caja_id = c.caja_id
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
      LEFT JOIN ordenes o ON o.id = c.order_id
     LEFT JOIN acond_caja_timers act ON act.caja_id = c.caja_id
          WHERE ic.estado='Operación'${cajasSede}
          GROUP BY c.caja_id, c.lote, c.order_id, o.numero_orden, act.started_at, act.duration_sec, act.active
          ORDER BY c.caja_id DESC
          LIMIT 300`, cajasParams));
      const cajaIds = cajasQ.rows.map(r=> r.caja_id);
      let itemsRows: any[] = [];
      if(cajaIds.length){
        const itemsParams: any[] = [cajaIds];
        const itemsSede = pushSedeFilter(itemsParams, sedeId);
        const itemsSql =
          `SELECT c.caja_id, aci.rol, ic.rfid, ic.estado, ic.sub_estado, ic.nombre_unidad, m.nombre_modelo
             FROM acond_caja_items aci
             JOIN acond_cajas c ON c.caja_id = aci.caja_id
             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
             JOIN modelos m ON m.modelo_id = ic.modelo_id
            WHERE c.caja_id = ANY($1::int[])${itemsSede}
            ORDER BY c.caja_id DESC, CASE aci.rol WHEN 'vip' THEN 0 WHEN 'tic' THEN 1 ELSE 2 END, ic.rfid`;
        const itemsQ = await withTenant(tenant, (c)=> c.query(itemsSql, itemsParams));
        itemsRows = itemsQ.rows as any[];
      }
      const mapaItems: Record<string, any[]> = {};
      for(const row of itemsRows){
        (mapaItems[row.caja_id] ||= []).push({
          codigo: row.rfid,
          rol: row.rol,
          estado: row.estado,
            sub_estado: row.sub_estado,
          nombre: row.nombre_modelo,
          nombreUnidad: row.nombre_unidad || null
        });
      }
      const nowIso = nowRes.rows[0]?.now;
      const nowMs = nowIso ? new Date(nowIso).getTime() : Date.now();
      const cajasUI = cajasQ.rows.map(r=>{
        let timer=null; let completedAt=null; let endsAt=null;
  if(r.started_at && r.duration_sec){
          const endMs = new Date(r.started_at).getTime() + r.duration_sec*1000;
          endsAt = new Date(endMs).toISOString();
          if(!r.active && endMs <= nowMs) completedAt = endsAt;
          timer = { startsAt: r.started_at, endsAt, completedAt };
        }
        // Derivar estado de la caja basado en sub_estados:
  const items = mapaItems[r.caja_id]||[];
  const cubeComp = items.find((it)=> it.rol==='cube' && it.nombreUnidad);
  const nombreCaja = cubeComp?.nombreUnidad?.trim() || r.lote;
        const anyTransito = items.some(it=> it.sub_estado==='Transito');
        const anyRetorno = items.some(it=> it.sub_estado==='Retorno');
        let estadoCaja = 'Operación';
        if(anyTransito) estadoCaja = 'Transito';
        else if(anyRetorno) estadoCaja = 'Retorno';
        return {
          id: r.caja_id,
          codigoCaja: r.lote,
          nombreCaja,
          estado: estadoCaja,
          orderId: (r as any).order_id ?? null,
          orderNumero: (r as any).order_num ?? null,
          timer,
          componentes: items.map(it=> ({ codigo: it.codigo, tipo: it.rol, nombre: it.nombre, estado: it.estado, sub_estado: it.sub_estado, nombreUnidad: it.nombreUnidad || null }))
        };
      });
      res.json({ ok:true, now: nowIso, cajas: cajasUI });
    } catch(e:any){
      res.status(500).json({ ok:false, error: e.message||'Error operacion data' });
    }
  },

  // Lookup a caja (by component RFID or lote) that is lista para despacho and NOT yet in Operación
  operacionAddLookup: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { code } = req.body as any;
    const val = typeof code === 'string' ? code.trim() : '';
    if(!val) return res.status(400).json({ ok:false, error:'Código requerido' });
    try {
      let caja: any = null;
      if(val.length===24){
        const params: any[] = [val];
        const q = await withTenant(tenant, (c)=> c.query(
          `SELECT c.caja_id, c.lote, c.order_id, o.numero_orden AS order_num
             FROM acond_caja_items aci
             JOIN acond_cajas c ON c.caja_id = aci.caja_id
             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
        LEFT JOIN ordenes o ON o.id = c.order_id
           WHERE aci.rfid=$1
            LIMIT 1`, params));
        if(q.rowCount) caja = q.rows[0];
      }
      if(!caja){
        const params2: any[] = [val];
        const q2 = await withTenant(tenant, (c)=> c.query(
          `SELECT c.caja_id, c.lote, c.order_id, o.numero_orden AS order_num
             FROM acond_cajas c
        LEFT JOIN ordenes o ON o.id = c.order_id
           WHERE c.lote=$1
            LIMIT 1`, params2));
        if(q2.rowCount) caja = q2.rows[0];
      }
      if(!caja) return res.status(404).json({ ok:false, error:'Caja no encontrada' });
      // Obtener items de la caja
      const itemParams: any[] = [caja.caja_id];
      const itemsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT aci.rfid, ic.estado, ic.sub_estado, aci.rol, m.nombre_modelo
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
           JOIN modelos m ON m.modelo_id = ic.modelo_id
          WHERE aci.caja_id=$1`, itemParams));
      const items = itemsQ.rows as any[];
      // Elegibles para mover: sub_estado Lista para Despacho o Listo
      const elegibles = items.filter(i=> i.estado==='Acondicionamiento' && (i.sub_estado==='Lista para Despacho' || i.sub_estado==='Listo'));
      if(!elegibles.length) return res.status(400).json({ ok:false, error:'Caja no está Lista para Despacho' });
      // Incluir timer original de acond (no se modifica al mover a Operación)
      const timerQ = await withTenant(tenant, (c)=> c.query(`SELECT started_at, duration_sec, active FROM acond_caja_timers WHERE caja_id=$1`, [caja.caja_id]));
      let timer=null; let endsAt=null; let completedAt=null;
      if(timerQ.rowCount){
        const t=timerQ.rows[0];
        if(t.started_at && t.duration_sec){
          const endMs = new Date(t.started_at).getTime() + t.duration_sec*1000;
          endsAt = new Date(endMs).toISOString();
          if(!t.active && endMs <= Date.now()) completedAt = endsAt;
          timer = { startsAt: t.started_at, endsAt, completedAt };
        }
      }
  res.json({ ok:true, caja_id: caja.caja_id, lote: caja.lote, order_id: (caja as any).order_id ?? null, order_num: (caja as any).order_num ?? null, total: items.length, elegibles: elegibles.map(e=> e.rfid), roles: elegibles.map(e=> ({ rfid: e.rfid, rol: e.rol })), timer });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error lookup' }); }
  },
  operacionAddMove: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const sedeId = getRequestSedeId(req);
    const { caja_id } = req.body as any;
    const id = Number(caja_id);
    const allowSedeTransferFlag = allowSedeTransferFromValue(req.body?.allowSedeTransfer);
    if(!Number.isFinite(id) || id<=0) return res.status(400).json({ ok:false, error:'caja_id inválido' });
    try {
      const sedeRowsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT ic.rfid, ic.sede_id
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
          WHERE aci.caja_id=$1`,
        [id]
      ));
      if(!sedeRowsQ.rowCount) return res.status(404).json({ ok:false, error:'Caja sin items' });
      const transferRows = (sedeRowsQ.rows as any[]).map((row) => ({ rfid: row.rfid, sede_id: row.sede_id }));
      const transferCheck = await ensureCrossSedeAuthorization(
        req,
        res,
        transferRows,
        sedeId,
        allowSedeTransferFlag,
        { fallbackRfids: transferRows.map((r) => r.rfid) }
      );
      if (transferCheck.blocked) return;

      await runWithSede(tenant, sedeId, async (c)=>{
        const targetSede = transferCheck.targetSede;
        await c.query('BEGIN');
        try {
          const upd = await c.query(
            `UPDATE inventario_credocubes ic
                SET estado='Operación',
                    sub_estado='Transito',
                    zona_id = NULL,
                    seccion_id = NULL,
                    sede_id = COALESCE($2::int, ic.sede_id)
               WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id=$1)
                 AND ic.estado='Acondicionamiento'
                 AND ic.sub_estado IN ('Lista para Despacho','Listo')`, [id, targetSede]);
          await c.query('COMMIT');
          res.json({ ok:true, moved: upd.rowCount });
        } catch(e){ await c.query('ROLLBACK'); throw e; }
      }, { allowCrossSedeTransfer: transferCheck.allowCrossTransfer });
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error moviendo' }); }
  },
  // Nuevo flujo simplificado: escanear un RFID (o lote) de una caja que está en Lista para Despacho y devolver toda la caja con su cronómetro original (acond_caja_timers)
  operacionScan: async (req: Request, res: Response) => {
    const tenant = (req as any).user?.tenant;
    const { code } = req.body as any;
    const val = typeof code === 'string' ? code.trim() : '';
    if(!val) return res.status(400).json({ ok:false, error:'Código requerido' });
    try {
      let cajaRow: any = null;
      if(val.length===24){
        const params: any[] = [val];
        const r = await withTenant(tenant, (c)=> c.query(
          `SELECT c.caja_id, c.lote
             FROM acond_caja_items aci
             JOIN acond_cajas c ON c.caja_id = aci.caja_id
             JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
           WHERE aci.rfid=$1
            LIMIT 1`, params));
        if(r.rowCount) cajaRow = r.rows[0];
      }
      if(!cajaRow){
        const params2: any[] = [val];
        const r2 = await withTenant(tenant, (c)=> c.query(`SELECT caja_id, lote FROM acond_cajas c WHERE lote=$1 LIMIT 1`, params2));
        if(r2.rowCount) cajaRow = r2.rows[0];
      }
      if(!cajaRow) return res.status(404).json({ ok:false, error:'Caja no encontrada' });
      // Obtener items de la caja que estén exactamente en Lista para Despacho
      const itemsParams: any[] = [cajaRow.caja_id];
      const itemsQ = await withTenant(tenant, (c)=> c.query(
        `SELECT aci.rfid, aci.rol, ic.estado, ic.sub_estado, m.nombre_modelo
           FROM acond_caja_items aci
           JOIN inventario_credocubes ic ON ic.rfid = aci.rfid
           JOIN modelos m ON m.modelo_id = ic.modelo_id
          WHERE aci.caja_id=$1`, itemsParams));
      const items = itemsQ.rows.filter(r=> r.estado==='Acondicionamiento' && r.sub_estado==='Lista para Despacho');
      if(!items.length) return res.status(400).json({ ok:false, error:'Caja no está Lista para Despacho' });
      // Cronómetro: reutilizar directamente el timer de acond (acond_caja_timers)
      const timerQ = await withTenant(tenant, (c)=> c.query(
        `SELECT started_at, duration_sec, active FROM acond_caja_timers WHERE caja_id=$1`, [cajaRow.caja_id]));
      let timer=null; let completedAt=null; let endsAt=null;
      const nowQ = await withTenant(tenant, (c)=> c.query<{ now:string }>(`SELECT NOW()::timestamptz AS now`));
      const nowIso = nowQ.rows[0]?.now; const nowMs = nowIso? new Date(nowIso).getTime(): Date.now();
      if(timerQ.rowCount){
        const t=timerQ.rows[0];
        if(t.started_at && t.duration_sec){
          const endMs = new Date(t.started_at).getTime() + t.duration_sec*1000;
          endsAt = new Date(endMs).toISOString();
          if(!t.active && endMs<=nowMs) completedAt = endsAt;
          timer = { startsAt: t.started_at, endsAt, completedAt };
        }
      }
      res.json({ ok:true, caja: {
        id: cajaRow.caja_id,
        lote: cajaRow.lote,
        timer,
        items: items.map(i=> ({ rfid: i.rfid, rol: i.rol }))
      }});
    } catch(e:any){ res.status(500).json({ ok:false, error: e.message||'Error escaneando' }); }
  }
};
