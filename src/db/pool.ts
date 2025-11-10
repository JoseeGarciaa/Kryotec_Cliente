import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';
import { getCurrentSedeContext } from '../utils/sedeContext';
import { getCurrentUserContext } from '../utils/userContext';

type TenantOptions = {
  sedeId?: number;
};

// Single global pool, we can set per-tenant search_path per connection
export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
});

const ensuredSchemas = new Set<string>();
const ensurePromises = new Map<string, Promise<void>>();

async function ensureSedeSyncArtifacts(client: PoolClient, schema: string) {
  if (ensuredSchemas.has(schema)) return;
  if (ensurePromises.has(schema)) {
    await ensurePromises.get(schema);
    return;
  }

  const ensurePromise = (async () => {
    await client.query('BEGIN');
    try {
      await client.query(`
        CREATE OR REPLACE FUNCTION assign_sede_on_update()
        RETURNS trigger AS $$
        DECLARE ctx text;
        BEGIN
          BEGIN
            ctx := current_setting('app.current_sede_id', true);
          EXCEPTION WHEN others THEN
            ctx := NULL;
          END;
          IF ctx IS NOT NULL THEN
            NEW.sede_id := ctx::int;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);

      await client.query(`
        DO $$
        BEGIN
          IF to_regclass('inventario_credocubes') IS NOT NULL AND NOT EXISTS (
            SELECT 1
              FROM pg_trigger
             WHERE tgname = 'tr_inventario_set_sede'
               AND tgrelid = 'inventario_credocubes'::regclass
          ) THEN
            CREATE TRIGGER tr_inventario_set_sede
            BEFORE UPDATE ON inventario_credocubes
            FOR EACH ROW
            EXECUTE FUNCTION assign_sede_on_update();
          END IF;
        END $$;
      `);

      await client.query('COMMIT');
      ensuredSchemas.add(schema);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      ensurePromises.delete(schema);
    }
  })();

  ensurePromises.set(schema, ensurePromise);
  await ensurePromise;
}

export async function withTenant<T>(tenantSchema: string, fn: (client: PoolClient) => Promise<T>, options?: TenantOptions): Promise<T> {
  const client = await pool.connect();
  try {
    // Important: set the schema search path for this session (use set_config to avoid SQL injection)
    await client.query('SELECT set_config($1, $2, false)', ['search_path', `${tenantSchema},public`]);

  const explicitSedeId = options?.sedeId;
  const ctxSedeId = getCurrentSedeContext();
  const sedeId = typeof explicitSedeId === 'number' ? explicitSedeId : ctxSedeId;
  const userId = getCurrentUserContext();
  let resetSede = false;
  let resetUser = false;
    if (typeof sedeId === 'number') {
      await ensureSedeSyncArtifacts(client, tenantSchema);
      await client.query('SELECT set_config($1, $2, false)', ['app.current_sede_id', String(sedeId)]);
      resetSede = true;
    }
    else if (!ensuredSchemas.has(tenantSchema)) {
      await ensureSedeSyncArtifacts(client, tenantSchema);
    }

    if (typeof userId === 'number') {
      await client.query('SELECT set_config($1, $2, false)', ['app.current_user_id', String(userId)]);
      resetUser = true;
    }

    try {
      return await fn(client);
    } finally {
      if (resetSede) {
        await client.query('RESET app.current_sede_id').catch(() => {});
      }
      if (resetUser) {
        await client.query('RESET app.current_user_id').catch(() => {});
      }
    }
  } finally {
    client.release();
  }
}

export async function queryTenant<T extends QueryResultRow = any>(tenantSchema: string, text: string, params?: any[]): Promise<QueryResult<T>> {
  return withTenant(tenantSchema, (client) => client.query<T>(text, params));
}
