import { pool, withTenant } from '../db/pool';

const LOG_PREFIX = '[acond-sweeper]';
const ensuredTenants = new Set<string>();
let running = false;
let intervalHandle: NodeJS.Timeout | null = null;
let startupHandle: NodeJS.Timeout | null = null;

type TenantRow = { schema_name: string };
type ExpiredTimerRow = {
  caja_id: number;
  lote: string | null;
  completed_at: Date | string | null;
};

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
      CREATE TABLE IF NOT EXISTS acond_cajas (
        caja_id serial PRIMARY KEY,
        lote text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS acond_caja_items (
        caja_id int NOT NULL REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
        rfid text NOT NULL,
        rol text NOT NULL CHECK (rol IN ('cube','vip','tic')),
        PRIMARY KEY (caja_id, rfid)
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS acond_caja_items_rfid_idx ON acond_caja_items(rfid)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS acond_caja_timers (
        caja_id int PRIMARY KEY REFERENCES acond_cajas(caja_id) ON DELETE CASCADE,
        started_at timestamptz,
        duration_sec integer,
        active boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);
  });
  ensuredTenants.add(tenant);
}

async function sweepTenant(tenant: string): Promise<number> {
  await ensureTenantSetup(tenant);
  return withTenant(tenant, async (client) => {
    await client.query('BEGIN');
    try {
      const expired = await client.query<ExpiredTimerRow>(
        `SELECT act.caja_id,
                c.lote,
                (act.started_at + act.duration_sec * INTERVAL '1 second') AS completed_at
           FROM acond_caja_timers act
           JOIN acond_cajas c ON c.caja_id = act.caja_id
          WHERE act.active = true
            AND act.started_at IS NOT NULL
            AND act.duration_sec IS NOT NULL
            AND (act.started_at + act.duration_sec * INTERVAL '1 second') <= NOW()
          FOR UPDATE SKIP LOCKED`
      );

      if (expired.rowCount === 0) {
        await client.query('COMMIT');
        return 0;
      }

      const cajaIds = expired.rows.map((row) => row.caja_id);

      await client.query(
        `UPDATE acond_caja_timers act
            SET active = false,
                updated_at = NOW()
          WHERE act.caja_id = ANY($1::int[])`,
        [cajaIds]
      );

      let totalMoved = 0;
      for (const row of expired.rows) {
        const cajaId = row.caja_id;
        const lote = (row.lote || '').trim();

        if (lote) {
          await client.query(
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
               WHERE aci.rfid IS NULL`,
            [lote, cajaId]
          );
        }

        const upd = await client.query(
          `UPDATE inventario_credocubes ic
              SET sub_estado = 'Ensamblado'
             WHERE ic.rfid IN (SELECT rfid FROM acond_caja_items WHERE caja_id = $1)
               AND ic.estado = 'Acondicionamiento'
               AND ic.sub_estado = 'Ensamblaje'`,
          [cajaId]
        );
        totalMoved += upd.rowCount || 0;
      }

      await client.query('COMMIT');
      return totalMoved;
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
          console.log(`${LOG_PREFIX} marked ${processed} item(s) Ensamblado in ${tenant}`);
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

export function startAcondTimerSweeper(): void {
  if (process.env.ACOND_SWEEPER_DISABLED === '1' || process.env.NODE_ENV === 'test') {
    console.log(`${LOG_PREFIX} disabled`);
    return;
  }
  if (intervalHandle) return;

  const intervalMs = Math.max(15000, Number(process.env.ACOND_SWEEPER_INTERVAL_MS || 60000));
  const initialDelay = Math.max(5000, Number(process.env.ACOND_SWEEPER_INITIAL_DELAY_MS || 10000));

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

export function stopAcondTimerSweeper(): void {
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
