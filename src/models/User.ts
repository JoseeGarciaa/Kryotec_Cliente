import { PoolClient } from 'pg';
import { config } from '../config';
import { normalizeRoleName } from '../middleware/roles';

export type User = {
  id: number;
  nombre: string;
  correo: string;
  telefono?: string | null;
  password: string; // hashed
  rol: string;
  roles: string[];
  activo: boolean;
  fecha_creacion: Date;
  ultimo_ingreso: Date | null;
  sede_id: number | null;
  sede_nombre: string | null;
  intentos_fallidos: number;
  bloqueado_hasta: Date | null;
  debe_cambiar_contrasena: boolean;
  contrasena_cambiada_en: Date | null;
  sesion_ttl_minutos: number;
  session_version: number;
};

type BaseUserInput = {
  nombre: string;
  correo: string;
  telefono?: string | null;
  password?: string | null; // already hashed when provided
  rol: string;
  roles?: string[] | null;
  activo: boolean;
  sede_id?: number | null;
  sesion_ttl_minutos?: number | null;
  debe_cambiar_contrasena?: boolean;
};

const ROLE_PRIORITY = ['super_admin', 'admin', 'acondicionador', 'operador', 'bodeguero', 'inspeccionador'] as const;
const CANONICAL_ROLE_SET = new Set<string>(ROLE_PRIORITY as unknown as string[]);

function normalizeRoleToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = normalizeRoleName(raw);
  if (!normalized) return null;
  if (normalized === 'administrador') return 'admin';
  if (normalized === 'preacond') return 'acondicionador';
  if (normalized === 'operacion') return 'operador';
  if (normalized === 'bodega') return 'bodeguero';
  if (normalized === 'inspeccion') return 'inspeccionador';
  return CANONICAL_ROLE_SET.has(normalized) ? normalized : null;
}

function normalizeRoleList(raw: unknown): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const pushToken = (token: unknown) => {
    const normalized = normalizeRoleToken(token);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  };
  if (Array.isArray(raw)) {
    raw.forEach(pushToken);
    return result;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return result;
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          parsed.forEach(pushToken);
          return result;
        }
      } catch {}
    }
    if (trimmed.includes(',')) {
      trimmed.split(',').forEach(pushToken);
      return result;
    }
    pushToken(trimmed);
    return result;
  }
  if (raw !== undefined) pushToken(raw);
  return result;
}

function pickPrimaryRole(roles: string[]): string {
  for (const key of ROLE_PRIORITY) {
    if (roles.includes(key)) return key;
  }
  return roles[0] || 'acondicionador';
}

function orderRoles(roles: string[], primary: string): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const queue = [primary, ...roles];
  for (const role of queue) {
    if (!role || !CANONICAL_ROLE_SET.has(role)) continue;
    if (seen.has(role)) continue;
    seen.add(role);
    ordered.push(role);
  }
  if (!ordered.length) ordered.push('acondicionador');
  return ordered;
}

function hydrateUserRow(row: any): User {
  const rawRoles = Array.isArray(row?.roles) ? row.roles : normalizeRoleList(row?.roles);
  const normalizedRoles = Array.isArray(row?.roles) ? normalizeRoleList(row.roles) : rawRoles;
  const normalizedColumnRole = normalizeRoleToken(row?.rol);
  const rolesList = normalizedRoles.length ? normalizedRoles.slice() : [];
  if (normalizedColumnRole) {
    if (!rolesList.includes(normalizedColumnRole)) rolesList.push(normalizedColumnRole);
  }
  const primary = pickPrimaryRole(rolesList);
  const finalRoles = orderRoles(rolesList, primary);
  return {
    id: row.id,
    nombre: row.nombre,
    correo: row.correo,
    telefono: row.telefono,
    password: row.password,
    rol: primary,
    roles: finalRoles,
    activo: row.activo,
    fecha_creacion: row.fecha_creacion,
    ultimo_ingreso: row.ultimo_ingreso,
    sede_id: row.sede_id,
    sede_nombre: row.sede_nombre,
    intentos_fallidos: row.intentos_fallidos,
    bloqueado_hasta: row.bloqueado_hasta,
    debe_cambiar_contrasena: row.debe_cambiar_contrasena,
    contrasena_cambiada_en: row.contrasena_cambiada_en,
    sesion_ttl_minutos: row.sesion_ttl_minutos,
    session_version: row.session_version,
  };
}

export const UsersModel = {
  async findByCorreo(client: PoolClient, correo: string): Promise<User | null> {
    const normalizedCorreo = typeof correo === 'string'
      ? correo.trim().toLowerCase()
      : String(correo ?? '').trim().toLowerCase();
    if (!normalizedCorreo) return null;
    const { rows } = await client.query<User>(
      `SELECT
         u.id,
         u.nombre,
         u.correo,
         u.telefono,
         u."password" AS password,
         u.rol,
         (SELECT ARRAY_AGG(r.rol ORDER BY LOWER(TRIM(r.rol))) FROM usuarios_roles r WHERE r.usuario_id = u.id) AS roles,
         u.activo,
         u.fecha_creacion,
         u.ultimo_ingreso,
         u.sede_id,
      s.nombre AS sede_nombre,
      COALESCE(u.intentos_fallidos, 0) AS intentos_fallidos,
      u.bloqueado_hasta,
      COALESCE(u.debe_cambiar_contrasena, true) AS debe_cambiar_contrasena,
      u.contrasena_cambiada_en,
  COALESCE(u.sesion_ttl_minutos, ${config.security.defaultSessionMinutes}) AS sesion_ttl_minutos,
      COALESCE(u.session_version, 0) AS session_version
       FROM usuarios u
  LEFT JOIN sedes s ON s.sede_id = u.sede_id
      WHERE LOWER(TRIM(u.correo)) = $1
      LIMIT 1`,
      [normalizedCorreo]
    );
    return rows[0] ? hydrateUserRow(rows[0]) : null;
  },

  async touchUltimoIngreso(client: PoolClient, id: number): Promise<void> {
    await client.query('UPDATE usuarios SET ultimo_ingreso = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  },
  
  async findById(client: PoolClient, id: number): Promise<User | null> {
    const { rows } = await client.query<User>(
      `SELECT
         u.id,
         u.nombre,
         u.correo,
         u.telefono,
         u."password" AS password,
         u.rol,
         (SELECT ARRAY_AGG(r.rol ORDER BY LOWER(TRIM(r.rol))) FROM usuarios_roles r WHERE r.usuario_id = u.id) AS roles,
         u.activo,
         u.fecha_creacion,
         u.ultimo_ingreso,
         u.sede_id,
      s.nombre AS sede_nombre,
      COALESCE(u.intentos_fallidos, 0) AS intentos_fallidos,
      u.bloqueado_hasta,
      COALESCE(u.debe_cambiar_contrasena, true) AS debe_cambiar_contrasena,
      u.contrasena_cambiada_en,
  COALESCE(u.sesion_ttl_minutos, ${config.security.defaultSessionMinutes}) AS sesion_ttl_minutos,
      COALESCE(u.session_version, 0) AS session_version
       FROM usuarios u
  LEFT JOIN sedes s ON s.sede_id = u.sede_id
      WHERE u.id = $1
      LIMIT 1`,
      [id]
    );
    return rows[0] ? hydrateUserRow(rows[0]) : null;
  },

  async listAll(client: PoolClient): Promise<User[]> {
    const { rows } = await client.query<User>(
      `SELECT
         u.id,
         u.nombre,
         u.correo,
         u.telefono,
         u."password" AS password,
         u.rol,
         (SELECT ARRAY_AGG(r.rol ORDER BY LOWER(TRIM(r.rol))) FROM usuarios_roles r WHERE r.usuario_id = u.id) AS roles,
         u.activo,
         u.fecha_creacion,
         u.ultimo_ingreso,
         u.sede_id,
      s.nombre AS sede_nombre,
      COALESCE(u.intentos_fallidos, 0) AS intentos_fallidos,
      u.bloqueado_hasta,
      COALESCE(u.debe_cambiar_contrasena, true) AS debe_cambiar_contrasena,
      u.contrasena_cambiada_en,
  COALESCE(u.sesion_ttl_minutos, ${config.security.defaultSessionMinutes}) AS sesion_ttl_minutos,
      COALESCE(u.session_version, 0) AS session_version
       FROM usuarios u
  LEFT JOIN sedes s ON s.sede_id = u.sede_id
      ORDER BY u.id ASC`
    );
    return rows.map(hydrateUserRow);
  },

  async create(client: PoolClient, data: BaseUserInput & { password: string }): Promise<User> {
    let rolesList = normalizeRoleList(data.roles ?? []);
    if (!rolesList.length) rolesList = normalizeRoleList(data.rol);
    if (!rolesList.length) rolesList = ['acondicionador'];
    const primaryRole = pickPrimaryRole(rolesList);
    const finalRoles = orderRoles(rolesList, primaryRole);

    await client.query('BEGIN');
    try {
      const { rows } = await client.query(
        `INSERT INTO usuarios (nombre, correo, telefono, "password", rol, activo, fecha_creacion, sede_id, sesion_ttl_minutos, debe_cambiar_contrasena)
         VALUES ($1,$2,$3,$4,$5,$6, CURRENT_TIMESTAMP, $7, COALESCE($8, ${config.security.defaultSessionMinutes}), COALESCE($9, true))
             RETURNING id` ,
        [
          data.nombre,
          data.correo,
          data.telefono || null,
          data.password,
          primaryRole,
          data.activo,
          data.sede_id ?? null,
          data.sesion_ttl_minutos ?? null,
          data.debe_cambiar_contrasena ?? true,
        ]
      );
      const inserted = rows[0];
      if (!inserted) {
        await client.query('ROLLBACK');
        throw new Error('No se pudo crear el usuario');
      }
      const userId = inserted.id;
      await client.query('DELETE FROM usuarios_roles WHERE usuario_id = $1', [userId]);
      for (const role of finalRoles) {
        await client.query(
          `INSERT INTO usuarios_roles (usuario_id, rol)
           VALUES ($1, $2)
           ON CONFLICT (usuario_id, rol) DO NOTHING`,
          [userId, role]
        );
      }
      const hydrated = await this.findById(client, userId);
      await client.query('COMMIT');
      if (!hydrated) throw new Error('No se pudo recuperar el usuario creado');
      return hydrated;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  },

  async update(client: PoolClient, id: number, data: BaseUserInput): Promise<User | null> {
    const existing = await this.findById(client, id);
    if (!existing) return null;
    let rolesList = normalizeRoleList(data.roles ?? existing.roles);
    if (!rolesList.length) rolesList = normalizeRoleList(data.rol);
    if (!rolesList.length) rolesList = ['acondicionador'];
    const primaryRole = pickPrimaryRole(rolesList);
    const finalRoles = orderRoles(rolesList, primaryRole);
    const newPassword = data.password ? data.password : existing.password; // already hashed outside

    await client.query('BEGIN');
    try {
      const { rows } = await client.query(
        `UPDATE usuarios
           SET nombre = $1,
               correo = $2,
               telefono = $3,
               "password" = $4,
               rol = $5,
               activo = $6,
               sede_id = $7,
               sesion_ttl_minutos = COALESCE($8, sesion_ttl_minutos),
               debe_cambiar_contrasena = COALESCE($9, debe_cambiar_contrasena)
         WHERE id = $10
         RETURNING id`,
        [
          data.nombre,
          data.correo,
          data.telefono || null,
          newPassword,
          primaryRole,
          data.activo,
          data.sede_id ?? null,
          data.sesion_ttl_minutos ?? null,
          data.debe_cambiar_contrasena ?? null,
          id,
        ]
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('DELETE FROM usuarios_roles WHERE usuario_id = $1', [id]);
      for (const role of finalRoles) {
        await client.query(
          `INSERT INTO usuarios_roles (usuario_id, rol)
             VALUES ($1, $2)
           ON CONFLICT (usuario_id, rol) DO NOTHING`,
          [id, role]
        );
      }
      const hydrated = await this.findById(client, id);
      await client.query('COMMIT');
      return hydrated;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  },

  async setActivo(client: PoolClient, id: number, activo: boolean): Promise<void> {
    await client.query('UPDATE usuarios SET activo = $1 WHERE id = $2', [activo, id]);
  },

  async remove(client: PoolClient, id: number): Promise<void> {
    await client.query('DELETE FROM usuarios WHERE id = $1', [id]);
  },

  /** Cuenta el total de usuarios cuyo rol es admin/administrador (case-insensitive) */
  async countAdmins(client: PoolClient): Promise<number> {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(DISTINCT u.id)::text AS count
         FROM usuarios u
    LEFT JOIN usuarios_roles ur ON ur.usuario_id = u.id
        WHERE u.sede_id IS NULL
           OR LOWER(u.rol) IN ('admin','administrador','super_admin','superadmin','super administrador','super admin')
           OR LOWER(ur.rol) IN ('admin','administrador','super_admin','superadmin','super administrador','super admin')`
    );
    return parseInt(rows[0]?.count || '0', 10);
  },

  /** Cuenta administradores activos */
  async countActiveAdmins(client: PoolClient): Promise<number> {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(DISTINCT u.id)::text AS count
         FROM usuarios u
    LEFT JOIN usuarios_roles ur ON ur.usuario_id = u.id
        WHERE u.activo = TRUE
          AND (
                u.sede_id IS NULL
             OR LOWER(u.rol) IN ('admin','administrador','super_admin','superadmin','super administrador','super admin')
             OR LOWER(ur.rol) IN ('admin','administrador','super_admin','superadmin','super administrador','super admin')
          )`
    );
    return parseInt(rows[0]?.count || '0', 10);
  },

  async registerFailedLogin(client: PoolClient, id: number, maxAttempts: number, lockMinutes: number): Promise<{ attempts: number; lockedUntil: Date | null }> {
    const { rows } = await client.query<{ intentos_fallidos: number; bloqueado_hasta: Date | null }>(
      `UPDATE usuarios
         SET intentos_fallidos = COALESCE(intentos_fallidos, 0) + 1,
             bloqueado_hasta = CASE
               WHEN COALESCE(intentos_fallidos, 0) + 1 >= $2 THEN (CURRENT_TIMESTAMP + ($3 || ' minutes')::interval)
               ELSE bloqueado_hasta
             END
       WHERE id = $1
       RETURNING intentos_fallidos, bloqueado_hasta`,
      [id, maxAttempts, lockMinutes]
    );
    return { attempts: rows[0]?.intentos_fallidos || 0, lockedUntil: rows[0]?.bloqueado_hasta || null };
  },

  async resetLoginState(client: PoolClient, id: number): Promise<void> {
    await client.query(
      `UPDATE usuarios
          SET intentos_fallidos = 0,
              bloqueado_hasta = NULL
        WHERE id = $1`,
      [id]
    );
  },

  async bumpSessionVersion(client: PoolClient, id: number): Promise<number> {
    const { rows } = await client.query<{ session_version: number }>(
      `UPDATE usuarios
          SET session_version = COALESCE(session_version, 0) + 1
        WHERE id = $1
      RETURNING session_version`,
      [id]
    );
    return rows[0]?.session_version ?? 0;
  },

  async getSecuritySnapshot(client: PoolClient, id: number): Promise<{
    activo: boolean;
    debe_cambiar_contrasena: boolean;
    bloqueado_hasta: Date | null;
    session_version: number;
    sesion_ttl_minutos: number;
    contrasena_cambiada_en: Date | null;
    fecha_creacion: Date;
  } | null> {
    const { rows } = await client.query(
      `SELECT
         activo,
         COALESCE(debe_cambiar_contrasena, true) AS debe_cambiar_contrasena,
         bloqueado_hasta,
         COALESCE(session_version, 0) AS session_version,
         COALESCE(sesion_ttl_minutos, ${config.security.defaultSessionMinutes}) AS sesion_ttl_minutos,
         contrasena_cambiada_en,
         fecha_creacion
       FROM usuarios
      WHERE id = $1
      LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  },

  async markPasswordChange(client: PoolClient, id: number, hashedPassword: string, changedBy?: number | null): Promise<number> {
    await client.query(
      `UPDATE usuarios
          SET "password" = $2,
              contrasena_cambiada_en = CURRENT_TIMESTAMP,
              debe_cambiar_contrasena = false,
              intentos_fallidos = 0,
              bloqueado_hasta = NULL
        WHERE id = $1`,
      [id, hashedPassword]
    );
    await client.query(
      `INSERT INTO usuarios_password_historial (usuario_id, password_hash, cambiado_por)
       VALUES ($1, $2, $3)`,
      [id, hashedPassword, changedBy ?? null]
    );
    return this.bumpSessionVersion(client, id);
  },

  async forcePasswordReset(client: PoolClient, id: number): Promise<void> {
    await client.query(
      `UPDATE usuarios
          SET debe_cambiar_contrasena = true,
              contrasena_cambiada_en = NULL
        WHERE id = $1`,
      [id]
    );
  },

  async getRecentPasswordHashes(client: PoolClient, id: number, limit = 5): Promise<string[]> {
    const { rows } = await client.query<{ password_hash: string }>(
      `SELECT password_hash
         FROM usuarios_password_historial
        WHERE usuario_id = $1
        ORDER BY creado_en DESC
        LIMIT $2`,
      [id, Math.max(1, limit)]
    );
    return rows.map(r => r.password_hash);
  },

  async logLogin(client: PoolClient, entry: {
    usuarioId: number;
    correo: string;
    nombre?: string | null;
    rol?: string | null;
    roles?: string[] | null;
    tenantSchema?: string | null;
    sedeId?: number | null;
    sedeNombre?: string | null;
  }): Promise<void> {
    const payload = {
      usuarioId: entry.usuarioId,
      correo: entry.correo,
      nombre: entry.nombre ?? null,
      rol: entry.rol ?? null,
      roles: entry.roles && entry.roles.length ? entry.roles : null,
      tenantSchema: entry.tenantSchema ?? null,
      sedeId: entry.sedeId ?? null,
      sedeNombre: entry.sedeNombre ?? null,
    };
    await client.query(
      `INSERT INTO usuarios_login_historial (
         usuario_id,
         correo,
         nombre,
         rol,
         roles,
         tenant_schema,
         sede_id,
         sede_nombre
       )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        payload.usuarioId,
        payload.correo,
        payload.nombre,
        payload.rol,
        payload.roles,
        payload.tenantSchema,
        payload.sedeId,
        payload.sedeNombre,
      ]
    );
  },
};
