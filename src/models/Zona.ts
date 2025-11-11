import { PoolClient } from 'pg';

export type ZonaRecord = {
  zona_id: number;
  sede_id: number;
  nombre: string;
  activa: boolean;
};

export type SeccionRecord = {
  seccion_id: number;
  zona_id: number;
  nombre: string;
  activa: boolean;
};

export type ZonaWithSecciones = ZonaRecord & {
  secciones: SeccionRecord[];
};

export type CreateZonaInput = {
  sede_id: number;
  nombre: string;
  activa?: boolean;
};

export type UpdateZonaInput = {
  nombre?: string;
  activa?: boolean;
};

export type CreateSeccionInput = {
  zona_id: number;
  nombre: string;
  activa?: boolean;
};

export type UpdateSeccionInput = {
  nombre?: string;
  activa?: boolean;
};

const mapZona = (row: any): ZonaRecord => ({
  zona_id: Number(row.zona_id),
  sede_id: Number(row.sede_id),
  nombre: row.nombre,
  activa: row.activa !== false,
});

const mapSeccion = (row: any): SeccionRecord => ({
  seccion_id: Number(row.seccion_id),
  zona_id: Number(row.zona_id),
  nombre: row.nombre,
  activa: row.activa !== false,
});

export const ZonasModel = {
  async listAll(client: PoolClient): Promise<Array<ZonaRecord & { sede_nombre: string }>> {
    const { rows } = await client.query(
      `SELECT z.zona_id, z.sede_id, z.nombre, z.activa, s.nombre AS sede_nombre
         FROM zonas z
         JOIN sedes s ON s.sede_id = z.sede_id
        ORDER BY s.nombre ASC, z.nombre ASC`
    );
    return rows.map((r) => ({ ...mapZona(r), sede_nombre: r.sede_nombre as string }));
  },

  async listBySede(client: PoolClient, sedeId: number): Promise<ZonaWithSecciones[]> {
    const { rows: zonasRows } = await client.query(
      `SELECT zona_id, sede_id, nombre, activa
         FROM zonas
        WHERE sede_id = $1
        ORDER BY nombre ASC`,
      [sedeId]
    );
    if (!zonasRows.length) return [];
    const zonaIds = zonasRows.map((z) => z.zona_id);
    const { rows: seccionesRows } = await client.query(
      `SELECT seccion_id, zona_id, nombre, activa
         FROM secciones
        WHERE zona_id = ANY($1::int[])
        ORDER BY nombre ASC`,
      [zonaIds]
    );
    const sectionsByZona = new Map<number, SeccionRecord[]>();
    for (const row of seccionesRows) {
      const sec = mapSeccion(row);
      const group = sectionsByZona.get(sec.zona_id) || [];
      group.push(sec);
      sectionsByZona.set(sec.zona_id, group);
    }
    return zonasRows.map((row) => ({
      ...mapZona(row),
      secciones: sectionsByZona.get(Number(row.zona_id)) || [],
    }));
  },

  async findZonaById(client: PoolClient, zonaId: number): Promise<ZonaRecord | null> {
    const { rows } = await client.query(
      `SELECT zona_id, sede_id, nombre, activa
         FROM zonas
        WHERE zona_id = $1
        LIMIT 1`,
      [zonaId]
    );
    return rows[0] ? mapZona(rows[0]) : null;
  },

  async findSeccionById(client: PoolClient, seccionId: number): Promise<(SeccionRecord & { sede_id: number }) | null> {
    const { rows } = await client.query(
      `SELECT sc.seccion_id, sc.zona_id, sc.nombre, sc.activa, z.sede_id
         FROM secciones sc
         JOIN zonas z ON z.zona_id = sc.zona_id
        WHERE sc.seccion_id = $1
        LIMIT 1`,
      [seccionId]
    );
    if (!rows[0]) return null;
    const row = rows[0];
    return {
      ...mapSeccion(row),
      sede_id: Number(row.sede_id),
    };
  },

  async createZona(client: PoolClient, data: CreateZonaInput): Promise<ZonaRecord> {
    const { rows } = await client.query(
      `INSERT INTO zonas (sede_id, nombre, activa)
       VALUES ($1, $2, COALESCE($3, TRUE))
       RETURNING zona_id, sede_id, nombre, activa`,
      [data.sede_id, data.nombre, data.activa ?? true]
    );
    return mapZona(rows[0]);
  },

  async updateZona(client: PoolClient, zonaId: number, data: UpdateZonaInput): Promise<ZonaRecord | null> {
    const fields: string[] = [];
    const params: any[] = [];
    if (data.nombre !== undefined) {
      params.push(data.nombre);
      fields.push(`nombre = $${params.length}`);
    }
    if (data.activa !== undefined) {
      params.push(data.activa);
      fields.push(`activa = $${params.length}`);
    }
    if (!fields.length) {
      return this.findZonaById(client, zonaId);
    }
    params.push(zonaId);
    const { rows } = await client.query(
      `UPDATE zonas
          SET ${fields.join(', ')}
        WHERE zona_id = $${params.length}
        RETURNING zona_id, sede_id, nombre, activa`,
      params
    );
    return rows[0] ? mapZona(rows[0]) : null;
  },

  async removeZona(client: PoolClient, zonaId: number): Promise<{ removed: boolean; secciones: number; inventario: number }> {
    const seccionesQ = await client.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM secciones WHERE zona_id = $1`,
      [zonaId]
    );
    const secciones = seccionesQ.rows[0]?.cnt ?? 0;
    let inventario = 0;
    if (secciones === 0) {
      const invQ = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM inventario_credocubes WHERE zona_id = $1`,
        [zonaId]
      );
      inventario = invQ.rows[0]?.cnt ?? 0;
    }
    if (secciones > 0 || inventario > 0) {
      return { removed: false, secciones, inventario };
    }
    const { rowCount } = await client.query('DELETE FROM zonas WHERE zona_id = $1', [zonaId]);
    return { removed: (rowCount ?? 0) > 0, secciones: 0, inventario: 0 };
  },

  async createSeccion(client: PoolClient, data: CreateSeccionInput): Promise<SeccionRecord> {
    const { rows } = await client.query(
      `INSERT INTO secciones (zona_id, nombre, activa)
       VALUES ($1, $2, COALESCE($3, TRUE))
       RETURNING seccion_id, zona_id, nombre, activa`,
      [data.zona_id, data.nombre, data.activa ?? true]
    );
    return mapSeccion(rows[0]);
  },

  async updateSeccion(client: PoolClient, seccionId: number, data: UpdateSeccionInput): Promise<SeccionRecord | null> {
    const fields: string[] = [];
    const params: any[] = [];
    if (data.nombre !== undefined) {
      params.push(data.nombre);
      fields.push(`nombre = $${params.length}`);
    }
    if (data.activa !== undefined) {
      params.push(data.activa);
      fields.push(`activa = $${params.length}`);
    }
    if (!fields.length) {
      const found = await this.findSeccionById(client, seccionId);
      return found ? mapSeccion(found) : null;
    }
    params.push(seccionId);
    const { rows } = await client.query(
      `UPDATE secciones
          SET ${fields.join(', ')}
        WHERE seccion_id = $${params.length}
        RETURNING seccion_id, zona_id, nombre, activa`,
      params
    );
    return rows[0] ? mapSeccion(rows[0]) : null;
  },

  async removeSeccion(client: PoolClient, seccionId: number): Promise<{ removed: boolean; inUse: number }> {
    const ref1 = await client.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM inventario_credocubes WHERE seccion_id = $1`,
      [seccionId]
    );
    const totalRefs = ref1.rows[0]?.cnt ?? 0;
    if (totalRefs > 0) {
      return { removed: false, inUse: totalRefs };
    }
    const { rowCount } = await client.query('DELETE FROM secciones WHERE seccion_id = $1', [seccionId]);
    return { removed: (rowCount ?? 0) > 0, inUse: 0 };
  },
};
