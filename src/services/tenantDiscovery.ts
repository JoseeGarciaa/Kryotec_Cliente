import { pool, withTenant } from '../db/pool';
import { UsersModel, User } from '../models/User';

export type TenantUserMatch = { tenant: string; user: User };

export async function findUserInAnyTenant(correo: string): Promise<TenantUserMatch[] | null> {
  const { rows } = await pool.query<{ schema_name: string }>(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant\_%' ESCAPE '\\' ORDER BY schema_name"
  );
  console.log('[tenantDiscovery] schemas', rows.map(r=>r.schema_name));

  const matches: TenantUserMatch[] = [];
  for (const r of rows) {
    const tenant = r.schema_name;
    try {
      const user = await withTenant(tenant, (client) => UsersModel.findByCorreo(client, correo));
      if (user) {
        console.log('[tenantDiscovery] found user in', tenant);
        matches.push({ tenant, user });
      }
    } catch (e: any) {
      if (e?.code === '42P01') continue; // undefined_table
      console.error('[tenantDiscovery] error querying tenant', tenant, e.code);
    }
  }

  if (matches.length === 0) return null;
  console.log('[tenantDiscovery] matches ->', matches.map(m=>m.tenant));
  return matches;
}
