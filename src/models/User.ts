import { PoolClient } from 'pg';
import { config } from '../config';

export type User = {
  id: number;
  nombre: string;
  correo: string;
  telefono?: string | null;
  password: string; // hashed
  rol: string;
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
  activo: boolean;
  sede_id?: number | null;
  sesion_ttl_minutos?: number | null;
  debe_cambiar_contrasena?: boolean;
};

export const UsersModel = {
  async findByCorreo(client: PoolClient, correo: string): Promise<User | null> {
    const { rows } = await client.query<User>(
      `SELECT
         u.id,
         u.nombre,
         u.correo,
         u.telefono,
         u."password" AS password,
         u.rol,
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
      WHERE u.correo = $1
      LIMIT 1`,
      [correo]
    );
    return rows[0] || null;
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
    return rows[0] || null;
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
    return rows;
  },

  async create(client: PoolClient, data: BaseUserInput & { password: string }): Promise<User> {
    const { rows } = await client.query<User>(
  `INSERT INTO usuarios (nombre, correo, telefono, "password", rol, activo, fecha_creacion, sede_id, sesion_ttl_minutos, debe_cambiar_contrasena)
   VALUES ($1,$2,$3,$4,$5,$6, CURRENT_TIMESTAMP, $7, COALESCE($8, ${config.security.defaultSessionMinutes}), COALESCE($9, true))
       RETURNING id, nombre, correo, telefono, "password" as password, rol, activo, fecha_creacion, ultimo_ingreso, sede_id,
                 (SELECT nombre FROM sedes WHERE sede_id = usuarios.sede_id) AS sede_nombre,
                 COALESCE(intentos_fallidos,0) AS intentos_fallidos,
                 bloqueado_hasta,
                 COALESCE(debe_cambiar_contrasena,true) AS debe_cambiar_contrasena,
                 contrasena_cambiada_en,
                 COALESCE(sesion_ttl_minutos, ${config.security.defaultSessionMinutes}) AS sesion_ttl_minutos,
                 COALESCE(session_version,0) AS session_version` ,
      [data.nombre, data.correo, data.telefono || null, data.password, data.rol, data.activo, data.sede_id ?? null, data.sesion_ttl_minutos ?? null, data.debe_cambiar_contrasena ?? true]
    );
    return rows[0];
  },

  async update(client: PoolClient, id: number, data: BaseUserInput): Promise<User | null> {
    const existing = await this.findById(client, id);
    if (!existing) return null;
    const newPassword = data.password ? data.password : existing.password; // already hashed outside
    const { rows } = await client.query<User>(
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
       RETURNING id, nombre, correo, telefono, "password" as password, rol, activo, fecha_creacion, ultimo_ingreso, sede_id,
                 (SELECT nombre FROM sedes WHERE sede_id = usuarios.sede_id) AS sede_nombre,
                 COALESCE(intentos_fallidos,0) AS intentos_fallidos,
                 bloqueado_hasta,
                 COALESCE(debe_cambiar_contrasena,true) AS debe_cambiar_contrasena,
                 contrasena_cambiada_en,
                 COALESCE(sesion_ttl_minutos, ${config.security.defaultSessionMinutes}) AS sesion_ttl_minutos,
                 COALESCE(session_version,0) AS session_version`,
      [
        data.nombre,
        data.correo,
        data.telefono || null,
        newPassword,
        data.rol,
        data.activo,
        data.sede_id ?? null,
        data.sesion_ttl_minutos ?? null,
        data.debe_cambiar_contrasena ?? null,
        id,
      ]
    );
    return rows[0] || null;
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
      `SELECT COUNT(*)::text AS count FROM usuarios WHERE LOWER(rol) IN ('admin','administrador')`
    );
    return parseInt(rows[0]?.count || '0', 10);
  },

  /** Cuenta administradores activos */
  async countActiveAdmins(client: PoolClient): Promise<number> {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM usuarios WHERE activo = true AND LOWER(rol) IN ('admin','administrador')`
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
};
