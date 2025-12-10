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
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios_login_historial (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        correo TEXT NOT NULL,
        nombre TEXT,
        rol TEXT,
        roles TEXT[],
        tenant_schema TEXT,
        sede_id INT,
        sede_nombre TEXT,
        login_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      ALTER TABLE usuarios_login_historial
        ADD COLUMN IF NOT EXISTS nombre TEXT,
        ADD COLUMN IF NOT EXISTS sede_id INT,
        ADD COLUMN IF NOT EXISTS sede_nombre TEXT;
    `);
    await client.query(`
      ALTER TABLE usuarios_login_historial
        DROP COLUMN IF EXISTS ip_origen,
        DROP COLUMN IF EXISTS user_agent;
    `);
    await client.query(`
      UPDATE usuarios_login_historial hist
         SET nombre = COALESCE(hist.nombre, u.nombre),
             sede_id = COALESCE(hist.sede_id, u.sede_id),
             sede_nombre = COALESCE(hist.sede_nombre, s.nombre)
        FROM usuarios u
        LEFT JOIN sedes s ON s.sede_id = u.sede_id
       WHERE hist.usuario_id = u.id
         AND (
               hist.nombre IS NULL
            OR hist.sede_id IS NULL
            OR hist.sede_nombre IS NULL
         );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_usuarios_login_historial_usuario ON usuarios_login_historial(usuario_id, login_en DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_usuarios_login_historial_login_en ON usuarios_login_historial(login_en DESC);
    `);
  });
  ensuredTenants.add(tenant);
}
