import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';

// Single global pool, we can set per-tenant search_path per connection
export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
});

export async function withTenant<T>(tenantSchema: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
  // Important: set the schema search path for this session (use set_config to avoid SQL injection)
  await client.query('SELECT set_config($1, $2, false)', ['search_path', `${tenantSchema},public`]);
    const result = await fn(client);
    return result;
  } finally {
    client.release();
  }
}

export async function queryTenant<T extends QueryResultRow = any>(tenantSchema: string, text: string, params?: any[]): Promise<QueryResult<T>> {
  return withTenant(tenantSchema, (client) => client.query<T>(text, params));
}
