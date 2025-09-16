import { PoolClient } from 'pg';

export type Alert = {
  id: number;
  inventario_id: number | null;
  tipo_alerta: string;
  descripcion: string | null;
  fecha_creacion: Date;
  resuelta: boolean;
  fecha_resolucion: Date | null;
};

export const AlertsModel = {
  async ensureTable(client: PoolClient): Promise<void> {
    // Crea la tabla en el esquema activo (search_path ya está seteado por withTenant)
    await client.query(`
      CREATE TABLE IF NOT EXISTS alertas (
        id SERIAL PRIMARY KEY,
        inventario_id INTEGER NULL,
        tipo_alerta TEXT NOT NULL,
        descripcion TEXT NULL,
        fecha_creacion TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
        resuelta BOOLEAN NOT NULL DEFAULT FALSE,
        fecha_resolucion TIMESTAMP WITHOUT TIME ZONE NULL
      );
    `);
    // Índices útiles
    await client.query(`CREATE INDEX IF NOT EXISTS alertas_resuelta_idx ON alertas (resuelta);`);
    await client.query(`CREATE INDEX IF NOT EXISTS alertas_fecha_idx ON alertas (fecha_creacion);`);
  },
  async list(
    client: PoolClient,
    opts: { page: number; limit: number; likePatterns?: string[] }
  ): Promise<{ items: Alert[]; total: number }> {
    await this.ensureTable(client);
    const offset = (opts.page - 1) * opts.limit;
    const whereParts: string[] = [];
    const params: any[] = [];
    if (opts.likePatterns && opts.likePatterns.length > 0) {
      const base = params.length;
      const wh = opts.likePatterns.map((_, i) => `tipo_alerta ILIKE $${base + i + 1}`);
      whereParts.push('(' + wh.join(' OR ') + ')');
      params.push(...opts.likePatterns);
    }
    const whereSQL = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';
    const { rows } = await client.query<Alert>(
      `SELECT id, inventario_id, tipo_alerta, descripcion, fecha_creacion, resuelta, fecha_resolucion
       FROM alertas
       ${whereSQL}
       ORDER BY resuelta ASC, fecha_creacion DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, opts.limit, offset]
    );
    const totalRes = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM alertas ${whereSQL}`,
      params
    );
    const total = Number(totalRes.rows[0]?.count || 0);
    return { items: rows, total };
  },

  async resolve(client: PoolClient, id: number): Promise<void> {
    await this.ensureTable(client);
    await client.query(
      `UPDATE alertas SET resuelta = TRUE, fecha_resolucion = NOW() WHERE id = $1`,
      [id]
    );
  },

  async create(
    client: PoolClient,
    data: { inventario_id?: number | null; tipo_alerta: string; descripcion?: string | null }
  ): Promise<void> {
    await this.ensureTable(client);
    await client.query(
      `INSERT INTO alertas (inventario_id, tipo_alerta, descripcion, fecha_creacion, resuelta)
       VALUES ($1, $2, $3, NOW(), FALSE)`,
      [data.inventario_id ?? null, data.tipo_alerta, data.descripcion ?? null]
    );
  },
};
