import { withTenant } from '../src/db/pool';

async function main() {
  try {
    const res = await withTenant('tenant_basev2', (client) =>
      client.query("SELECT pg_get_functiondef('tenant_basev2.prevent_cross_sede_transfer'::regproc) AS def")
    );
    console.log(res.rows?.[0]?.def || 'No definition found');
  } catch (err) {
    console.error('Error fetching function definition', err);
  } finally {
    process.exit(0);
  }
}

main();
