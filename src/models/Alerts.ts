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
    // Crear tabla/índices en el esquema activo (search_path seteado por withTenant)
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
      CREATE INDEX IF NOT EXISTS idx_alertas_resuelta_fecha ON alertas (resuelta, fecha_creacion DESC);
      CREATE INDEX IF NOT EXISTS idx_alertas_tipo ON alertas (tipo_alerta);
    `);
  },

  // Instala función y trigger para notificar cambios de estado/subestado en inventario_credocubes
  async ensureStateChangeTrigger(client: PoolClient): Promise<void> {
    try {
      await client.query(`
        DO $do$
        DECLARE
          fn_exists boolean := EXISTS (
            SELECT 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = 'f_alert_estado_cambiado'
              AND n.nspname = current_schema()
          );
          rel regclass := to_regclass('inventario_credocubes');
          trg_exists boolean := FALSE;
        BEGIN
          IF rel IS NOT NULL THEN
            SELECT EXISTS (
              SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid = rel AND t.tgname = 'trg_alert_estado_cambiado'
            ) INTO trg_exists;
          END IF;

          IF NOT fn_exists THEN
            -- Crear la función en el esquema actual
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

          IF rel IS NOT NULL AND NOT trg_exists THEN
            -- Instalar trigger en la tabla específica (segura ante re-ejecuciones)
            EXECUTE format(
              $$CREATE TRIGGER trg_alert_estado_cambiado
                AFTER UPDATE ON %s
                FOR EACH ROW
                EXECUTE FUNCTION f_alert_estado_cambiado()$$,
              rel::text
            );
          END IF;
        END
        $do$;
      `);
    } catch {
      // Ignorar errores (por roles sin privilegios de CREATE); el sistema sigue operando
    }
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
