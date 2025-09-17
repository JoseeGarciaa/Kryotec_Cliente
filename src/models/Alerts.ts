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

    // Disparador de trazabilidad: crear alerta en cada cambio de estado/sub_estado
    // Idempotente: crea la función/trigger solo si no existen en el esquema actual
    await client.query(`DO $$
    DECLARE
      fn_exists boolean := EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'f_alert_estado_cambiado' AND n.nspname = current_schema()
      );
      tbl_exists boolean := EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'inventario_credocubes' AND n.nspname = current_schema()
      );
      trg_exists boolean := EXISTS (
        SELECT 1
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE t.tgname = 'trg_alert_estado_cambiado'
           AND c.relname = 'inventario_credocubes'
           AND n.nspname = current_schema()
      );
    BEGIN
      IF NOT fn_exists THEN
        EXECUTE $$
        CREATE FUNCTION f_alert_estado_cambiado() RETURNS trigger AS $$
        BEGIN
          IF (NEW.estado IS DISTINCT FROM OLD.estado) OR (NEW.sub_estado IS DISTINCT FROM OLD.sub_estado) THEN
            INSERT INTO alertas (inventario_id, tipo_alerta, descripcion, fecha_creacion, resuelta)
            VALUES (
              NEW.id,
              'inventario:estado_cambiado',
              CONCAT('RFID ', COALESCE(NEW.rfid,''), ' | ',
                     'estado ', COALESCE(OLD.estado,'(null)'), '/', COALESCE(OLD.sub_estado,'(null)'),
                     ' → ', COALESCE(NEW.estado,'(null)'), '/', COALESCE(NEW.sub_estado,'(null)')),
              NOW(), FALSE
            );
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        $$;
      END IF;

      IF tbl_exists AND NOT trg_exists THEN
        EXECUTE $$
        CREATE TRIGGER trg_alert_estado_cambiado
        AFTER UPDATE ON inventario_credocubes
        FOR EACH ROW
        EXECUTE FUNCTION f_alert_estado_cambiado();
        $$;
      END IF;
    END $$;`);
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
