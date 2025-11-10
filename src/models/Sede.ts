import { PoolClient } from 'pg';

export type Sede = {
  sede_id: number;
  nombre: string;
  codigo?: string | null;
  activo?: boolean | null;
};

type CreateSedeInput = {
  nombre: string;
  codigo?: string | null;
  activa?: boolean | null;
};

export const SedesModel = {
  async listAll(client: PoolClient): Promise<Sede[]> {
    const { rows } = await client.query<Sede>(
      `SELECT sede_id, nombre, codigo, activa AS activo
         FROM sedes
        ORDER BY nombre ASC`
    );
    return rows;
  },

  async findById(client: PoolClient, sedeId: number): Promise<Sede | null> {
    const { rows } = await client.query<Sede>(
      `SELECT sede_id, nombre, codigo, activa AS activo
         FROM sedes
        WHERE sede_id = $1
        LIMIT 1`,
      [sedeId]
    );
    return rows[0] || null;
  },

  async create(client: PoolClient, data: CreateSedeInput): Promise<Sede> {
    const { rows } = await client.query<Sede>(
      `INSERT INTO sedes (nombre, codigo, activa)
       VALUES ($1, $2, COALESCE($3, TRUE))
       RETURNING sede_id, nombre, codigo, activa AS activo`,
      [data.nombre, data.codigo ?? null, data.activa ?? true]
    );
    return rows[0];
  },
};
