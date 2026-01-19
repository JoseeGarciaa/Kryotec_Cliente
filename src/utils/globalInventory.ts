import { pool, withTenant } from '../db/pool';

export type RfidTenantStatus = { tenant: string; activo: boolean | null; estado: string | null };

type TenantRow = { schema_name: string };

type StatusMap = Record<string, RfidTenantStatus[]>;

async function listTenantSchemas(): Promise<string[]> {
  const { rows } = await pool.query<TenantRow>(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant\\_%' ESCAPE '\\' ORDER BY schema_name"
  );
  return rows.map((row) => row.schema_name);
}

export async function findRfidStatusesAcrossTenants(rfids: string[], currentTenant: string): Promise<StatusMap> {
  const normalized = Array.from(
    new Set(
      rfids
        .map((r) => String(r || '').trim())
        .filter((r) => r.length > 0)
    )
  );
  if (normalized.length === 0) return {};

  const tenants = (await listTenantSchemas()).filter((t) => t !== currentTenant);
  const statusMap: StatusMap = {};

  await Promise.all(
    tenants.map(async (tenant) => {
      try {
        const { rows } = await withTenant(tenant, (client) =>
          client.query<{ rfid: string; activo: boolean | null; estado: string | null }>(
            'SELECT rfid, activo, estado FROM inventario_credocubes WHERE rfid = ANY($1::text[])',
            [normalized]
          )
        );
        for (const row of rows) {
          const key = String(row.rfid || '').trim();
          if (!key) continue;
          if (!statusMap[key]) statusMap[key] = [];
          statusMap[key].push({ tenant, activo: row.activo, estado: row.estado });
        }
      } catch (e: any) {
        // Ignore tenants without the table; log other errors for observability
        if (e?.code === '42P01') return;
        console.error('[global-inventory-check] tenant', tenant, 'error', e?.code || e?.message || e);
      }
    })
  );

  return statusMap;
}
