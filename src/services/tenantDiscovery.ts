import { pool, withTenant } from '../db/pool';
import { UsersModel, User } from '../models/User';

export type TenantUserMatch = { tenant: string; user: User };

export async function findUserInAnyTenant(correo: string): Promise<TenantUserMatch[] | null> {
  const { rows } = await pool.query<{ schema_name: string }>(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant\_%' ESCAPE '\\' ORDER BY schema_name"
  );

  const matches: TenantUserMatch[] = [];
  for (const r of rows) {
    const tenant = r.schema_name;
    try {
      const user = await withTenant(tenant, (client) => UsersModel.findByCorreo(client, correo));
      if (user) matches.push({ tenant, user });
    } catch (e: any) {
      // ignore schemas without usuarios or other non-fatal errors
      if (e?.code === '42P01') continue; // undefined_table
    }
  }

  if (matches.length === 0) return null;
  return matches;
}
