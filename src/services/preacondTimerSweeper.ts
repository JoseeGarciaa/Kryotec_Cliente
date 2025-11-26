import { pool, withTenant } from '../db/pool';
import { AlertsModel } from '../models/Alerts';

const LOG_PREFIX = '[preacond-sweeper]';
const ensuredTenants = new Set<string>();
let running = false;
let intervalHandle: NodeJS.Timeout | null = null;
let startupHandle: NodeJS.Timeout | null = null;

const sections = new Set(['congelamiento', 'atemperamiento']);

type ExpiredTimerRow = {
  rfid: string;
  section: 'congelamiento' | 'atemperamiento';
  completed_at: Date | string | null;
};

type TenantRow = { schema_name: string };

async function listTenants(): Promise<string[]> {
  const { rows } = await pool.query<TenantRow>(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant\\_%' ESCAPE '\\' ORDER BY schema_name"
  );
  return rows.map((row) => row.schema_name);
}

async function ensureTenantSetup(tenant: string): Promise<void> {
  if (ensuredTenants.has(tenant)) return;
  await withTenant(tenant, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS preacond_timers (
        section text PRIMARY KEY,
        started_at timestamptz,
        duration_sec integer,
        lote text,
        active boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS preacond_item_timers (
        rfid text NOT NULL,
        section text NOT NULL,
        started_at timestamptz,
        duration_sec integer,
        lote text,
        active boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        completed_at timestamptz,
        PRIMARY KEY (rfid, section)
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS preacond_item_timers_rfid_idx ON preacond_item_timers(rfid)');
    await client.query('ALTER TABLE preacond_timers ADD COLUMN IF NOT EXISTS lote text');
    await client.query('ALTER TABLE preacond_item_timers ADD COLUMN IF NOT EXISTS completed_at timestamptz');
  });
  ensuredTenants.add(tenant);
}

async function sweepTenant(tenant: string): Promise<number> {
  await ensureTenantSetup(tenant);
  return withTenant(tenant, async (client) => {
    await client.query('BEGIN');
    try {
      const expired = await client.query<ExpiredTimerRow>(
        `SELECT pit.rfid,
                pit.section,
                (pit.started_at + pit.duration_sec * INTERVAL '1 second') AS completed_at
           FROM preacond_item_timers pit
          WHERE pit.active = true
            AND pit.started_at IS NOT NULL
            AND pit.duration_sec IS NOT NULL
            AND (pit.started_at + pit.duration_sec * INTERVAL '1 second') <= NOW()
            AND pit.section IN ('congelamiento','atemperamiento')
          FOR UPDATE SKIP LOCKED`
      );

      if (expired.rowCount === 0) {
        await client.query('COMMIT');
        return 0;
      }

      const rows = expired.rows.filter((row) => sections.has(row.section));
      if (!rows.length) {
        await client.query('COMMIT');
        return 0;
      }

      const rfids = rows.map((row) => row.rfid);
      const sectionsList = rows.map((row) => row.section);
      const now = new Date();
      const completedAt = rows.map((row) => {
        if (row.completed_at instanceof Date) return row.completed_at;
        if (typeof row.completed_at === 'string') {
          const parsed = new Date(row.completed_at);
          if (Number.isFinite(parsed.getTime())) return parsed;
        }
        return now;
      });

      await client.query(
        `UPDATE inventario_credocubes ic
            SET sub_estado = CASE WHEN exp.section = 'congelamiento' THEN 'Congelado' ELSE 'Atemperado' END
          FROM UNNEST($1::text[], $2::text[]) AS exp(rfid, section)
         WHERE ic.rfid = exp.rfid`,
        [rfids, sectionsList]
      );

      await client.query(
        `UPDATE preacond_item_timers pit
            SET completed_at = CASE
                                  WHEN pit.completed_at IS NOT NULL THEN pit.completed_at
                                  ELSE exp.completed_at
                                END,
                started_at = NULL,
                duration_sec = NULL,
                active = false,
                updated_at = COALESCE(exp.completed_at, NOW())
          FROM UNNEST($1::text[], $2::text[], $3::timestamptz[]) AS exp(rfid, section, completed_at)
         WHERE pit.rfid = exp.rfid AND pit.section = exp.section`,
        [rfids, sectionsList, completedAt]
      );

      const loteRows = await client.query<{ rfid: string; lote: string | null }>(
        `SELECT ic.rfid, ic.lote
           FROM inventario_credocubes ic
          WHERE ic.rfid = ANY($1::text[])`,
        [rfids]
      );
      const loteMap = new Map<string, string | null>();
      for (const row of loteRows.rows) {
        loteMap.set(row.rfid, row.lote);
      }

      for (const row of rows) {
        const nextState = row.section === 'congelamiento' ? 'Congelado' : 'Atemperado';
        const lote = (loteMap.get(row.rfid) || '').trim() || null;
        try {
          await AlertsModel.createOrIncrementPreacondGroup(client, {
            tipo_alerta: `inventario:preacond:${nextState.toLowerCase()}`,
            lote,
            nextState,
            delta: 1,
          });
        } catch (alertErr) {
          console.warn(`${LOG_PREFIX} alert creation failed`, alertErr);
        }
      }

      await client.query('COMMIT');
      return rows.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const tenants = await listTenants();
    for (const tenant of tenants) {
      try {
        const processed = await sweepTenant(tenant);
        if (processed > 0) {
          console.log(`${LOG_PREFIX} completed ${processed} timer(s) in ${tenant}`);
        }
      } catch (tenantErr) {
        console.error(`${LOG_PREFIX} tenant ${tenant} sweep failed`, tenantErr);
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} sweep failed`, err);
  } finally {
    running = false;
  }
}

export function startPreacondTimerSweeper(): void {
  if (process.env.PREACOND_SWEEPER_DISABLED === '1' || process.env.NODE_ENV === 'test') {
    console.log(`${LOG_PREFIX} disabled`);
    return;
  }
  if (intervalHandle) return;

  const intervalMs = Math.max(15000, Number(process.env.PREACOND_SWEEPER_INTERVAL_MS || 60000));
  const initialDelay = Math.max(5000, Number(process.env.PREACOND_SWEEPER_INITIAL_DELAY_MS || 10000));

  const safeTick = () => {
    tick().catch((err) => console.error(`${LOG_PREFIX} unhandled error`, err));
  };

  startupHandle = setTimeout(() => {
    safeTick();
    intervalHandle = setInterval(safeTick, intervalMs);
    intervalHandle.unref?.();
  }, initialDelay);
  startupHandle.unref?.();
}

export function stopPreacondTimerSweeper(): void {
  if (startupHandle) {
    clearTimeout(startupHandle);
    startupHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  running = false;
}
