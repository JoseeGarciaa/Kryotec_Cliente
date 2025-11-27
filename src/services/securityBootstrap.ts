import { withTenant } from '../db/pool';
import { config } from '../config';

const ensuredTenants = new Set<string>();

export async function ensureSecurityArtifacts(tenant: string | null | undefined): Promise<void> {
  if (!tenant) return;
  if (ensuredTenants.has(tenant)) return;
  await withTenant(tenant, async (client) => {
    await client.query(`
      ALTER TABLE IF EXISTS usuarios
        ADD COLUMN IF NOT EXISTS intentos_fallidos INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS bloqueado_hasta TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS debe_cambiar_contrasena BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS contrasena_cambiada_en TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS sesion_ttl_minutos INTEGER NOT NULL DEFAULT ${config.security.defaultSessionMinutes},
        ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
    `);
    await client.query(`
      UPDATE usuarios
         SET sesion_ttl_minutos = ${config.security.defaultSessionMinutes}
       WHERE sesion_ttl_minutos IS NULL;
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios_password_historial (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        password_hash TEXT NOT NULL,
        cambiado_por INT,
        creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_usuarios_password_historial_usuario ON usuarios_password_historial(usuario_id, creado_en DESC);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios_roles (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        rol TEXT NOT NULL,
        creado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_usuario_rol UNIQUE (usuario_id, rol)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_usuarios_roles_usuario ON usuarios_roles(usuario_id);
    `);
    await client.query(`
      INSERT INTO usuarios_roles (usuario_id, rol)
      SELECT u.id, LOWER(TRIM(u.rol))
        FROM usuarios u
        LEFT JOIN usuarios_roles ur ON ur.usuario_id = u.id
       WHERE ur.id IS NULL
         AND u.rol IS NOT NULL
         AND LENGTH(TRIM(u.rol)) > 0;
    `);
  });
  ensuredTenants.add(tenant);
}
