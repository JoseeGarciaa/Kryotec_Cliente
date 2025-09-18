import { PoolClient } from 'pg';

export type AuditoriaRow = {
  id: number;
  inventario_id: number | null;
  novedad_id: number | null;
  comentarios: string | null;
  auditada: boolean;
  fecha: Date;
  // Joined fields (nullable)
  rfid: string | null;
  lote: string | null;
  estado: string | null;
  sub_estado: string | null;
  numero_orden: string | null;
  nov_tipo: string | null;
  nov_severidad: string | null;
  nov_estado: string | null;
  nov_descripcion: string | null;
  nov_inhabilita: boolean | null;
};

export const AuditoriaModel = {
  async ensureTable(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS auditorias_credocubes (
        id SERIAL PRIMARY KEY,
        inventario_id INTEGER NULL,
        novedad_id INTEGER NULL,
        comentarios TEXT NULL,
        auditada BOOLEAN NOT NULL DEFAULT FALSE,
        fecha TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_auditorias_fecha ON auditorias_credocubes (fecha DESC);
      CREATE INDEX IF NOT EXISTS idx_auditorias_auditada ON auditorias_credocubes (auditada, fecha DESC);
      CREATE INDEX IF NOT EXISTS idx_auditorias_inv ON auditorias_credocubes (inventario_id);
      CREATE INDEX IF NOT EXISTS idx_auditorias_nov ON auditorias_credocubes (novedad_id);
    `);
  },

  async list(
    client: PoolClient,
    opts: {
      page: number;
      limit: number;
      q?: string | null;
      auditada?: boolean | null;
      fromDate?: string | null; // ISO date (yyyy-mm-dd)
      toDate?: string | null;   // ISO date (yyyy-mm-dd)
    }
  ): Promise<{ items: AuditoriaRow[]; total: number }>{
    await this.ensureTable(client);
    const params: any[] = [];
    const where: string[] = [];

    if (opts.q && opts.q.trim()) {
      const v = `%${opts.q.trim()}%`;
      params.push(v, v, v);
      where.push(`(ic.rfid ILIKE $${params.length-2} OR ic.lote ILIKE $${params.length-1} OR ic.numero_orden ILIKE $${params.length})`);
    }
    if (typeof opts.auditada === 'boolean') {
      params.push(opts.auditada);
      where.push(`a.auditada = $${params.length}`);
    }
    if (opts.fromDate) {
      params.push(opts.fromDate);
      where.push(`a.fecha >= $${params.length}`);
    }
    if (opts.toDate) {
      // Include whole day by adding 1 day and using < next day
      params.push(opts.toDate);
      where.push(`a.fecha < ($${params.length}::date + INTERVAL '1 day')`);
    }

    const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const offset = (opts.page - 1) * opts.limit;

    const rowsRes = await client.query<AuditoriaRow>(
      `SELECT
          a.id, a.inventario_id, a.novedad_id, a.comentarios, a.auditada, a.fecha,
          ic.rfid, ic.lote, ic.estado, ic.sub_estado, ic.numero_orden,
          n.tipo AS nov_tipo, n.severidad AS nov_severidad, n.estado AS nov_estado,
          n.descripcion AS nov_descripcion, n.inhabilita AS nov_inhabilita
       FROM auditorias_credocubes a
       LEFT JOIN inventario_credocubes ic ON ic.id = a.inventario_id
       LEFT JOIN inspeccion_novedades n ON n.novedad_id = a.novedad_id
       ${whereSQL}
       ORDER BY a.fecha DESC, a.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, opts.limit, offset]
    );

    const totalRes = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM auditorias_credocubes a
         LEFT JOIN inventario_credocubes ic ON ic.id = a.inventario_id
         LEFT JOIN inspeccion_novedades n ON n.novedad_id = a.novedad_id
         ${whereSQL}`,
      params
    );

    return { items: rowsRes.rows, total: Number(totalRes.rows[0]?.count || 0) };
  },

  async markAudited(client: PoolClient, id: number, auditada: boolean, comentarios?: string | null): Promise<void> {
    await this.ensureTable(client);
    const fields: string[] = ['auditada'];
    const params: any[] = [auditada];
    if (typeof comentarios === 'string') {
      fields.push('comentarios');
      params.push(comentarios);
    }
    params.push(id);
    await client.query(`UPDATE auditorias_credocubes SET ${fields.map((f,i)=>`${f} = $${i+1}`).join(', ')} WHERE id = $${params.length}`, params);
  },

  async update(client: PoolClient, id: number, data: { comentarios?: string | null; auditada?: boolean }): Promise<void> {
    await this.ensureTable(client);
    const sets: string[] = [];
    const params: any[] = [];
    if (typeof data.comentarios === 'string') { sets.push(`comentarios = $${params.length+1}`); params.push(data.comentarios); }
    if (typeof data.auditada === 'boolean') { sets.push(`auditada = $${params.length+1}`); params.push(data.auditada); }
    if (!sets.length) return; // nothing to update
    params.push(id);
    await client.query(`UPDATE auditorias_credocubes SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  },

  async remove(client: PoolClient, id: number): Promise<void> {
    await this.ensureTable(client);
    await client.query(`DELETE FROM auditorias_credocubes WHERE id = $1`, [id]);
  }
};

export type InventarioLight = {
  id: number;
  rfid: string | null;
  lote: string | null;
  numero_orden: string | null;
  estado: string | null;
  sub_estado: string | null;
};

export const AuditoriaExtras = {
  async create(
    client: PoolClient,
    data: { inventarioId: number; comentarios?: string | null; novedadId?: number | null; auditada?: boolean }
  ): Promise<number> {
    await AuditoriaModel.ensureTable(client);
    const res = await client.query<{ id: number }>(
      `INSERT INTO auditorias_credocubes (inventario_id, novedad_id, comentarios, auditada)
       VALUES ($1, $2, $3, COALESCE($4, false))
       RETURNING id`,
      [data.inventarioId, data.novedadId ?? null, data.comentarios ?? null, typeof data.auditada === 'boolean' ? data.auditada : null]
    );
    return res.rows[0]?.id || 0;
  },

  async searchInventario(client: PoolClient, q: string, limit = 20): Promise<InventarioLight[]> {
    const term = `%${q.trim()}%`;
    const res = await client.query<InventarioLight>(
      `SELECT id, rfid, lote, numero_orden, estado, sub_estado
         FROM inventario_credocubes
        WHERE ($1 = '' OR rfid ILIKE $2 OR lote ILIKE $2 OR numero_orden ILIKE $2)
        ORDER BY id DESC
        LIMIT $3`,
      [q.trim() === '' ? '' : 'x', term, limit]
    );
    return res.rows;
  }
};
