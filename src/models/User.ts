import { PoolClient } from 'pg';

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
};

export const UsersModel = {
  async findByCorreo(client: PoolClient, correo: string): Promise<User | null> {
    const { rows } = await client.query<User>(
      'SELECT id, nombre, correo, telefono, "password" as password, rol, activo, fecha_creacion, ultimo_ingreso FROM usuarios WHERE correo = $1 LIMIT 1',
      [correo]
    );
    return rows[0] || null;
  },

  async touchUltimoIngreso(client: PoolClient, id: number): Promise<void> {
    await client.query('UPDATE usuarios SET ultimo_ingreso = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  },
  
  async findById(client: PoolClient, id: number): Promise<User | null> {
    const { rows } = await client.query<User>(
      'SELECT id, nombre, correo, telefono, "password" as password, rol, activo, fecha_creacion, ultimo_ingreso FROM usuarios WHERE id = $1 LIMIT 1',
      [id]
    );
    return rows[0] || null;
  },

  async listAll(client: PoolClient): Promise<User[]> {
    const { rows } = await client.query<User>(
      'SELECT id, nombre, correo, telefono, "password" as password, rol, activo, fecha_creacion, ultimo_ingreso FROM usuarios ORDER BY id ASC'
    );
    return rows;
  },

  async create(client: PoolClient, data: { nombre: string; correo: string; telefono?: string | null; password: string; rol: string; activo: boolean }): Promise<User> {
    const { rows } = await client.query<User>(
      `INSERT INTO usuarios (nombre, correo, telefono, "password", rol, activo, fecha_creacion)
       VALUES ($1,$2,$3,$4,$5,$6, CURRENT_TIMESTAMP)
       RETURNING id, nombre, correo, telefono, "password" as password, rol, activo, fecha_creacion, ultimo_ingreso`,
      [data.nombre, data.correo, data.telefono || null, data.password, data.rol, data.activo]
    );
    return rows[0];
  },

  async update(client: PoolClient, id: number, data: { nombre: string; correo: string; telefono?: string | null; password?: string | null; rol: string; activo: boolean }): Promise<User | null> {
    const existing = await this.findById(client, id);
    if (!existing) return null;
    const newPassword = data.password ? data.password : existing.password; // already hashed outside
    const { rows } = await client.query<User>(
      `UPDATE usuarios
       SET nombre = $1, correo = $2, telefono = $3, "password" = $4, rol = $5, activo = $6
       WHERE id = $7
       RETURNING id, nombre, correo, telefono, "password" as password, rol, activo, fecha_creacion, ultimo_ingreso`,
      [data.nombre, data.correo, data.telefono || null, newPassword, data.rol, data.activo, id]
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
};
