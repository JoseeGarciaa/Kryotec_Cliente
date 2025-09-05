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
};
