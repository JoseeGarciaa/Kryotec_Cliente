import { QueryResultRow } from 'pg';
import { withTenant } from '../db/pool';

export type ReportKey =
  | 'inventario-sede'
  | 'trazabilidad'
  | 'actividad-operario'
  | 'actividad-sede'
  | 'ordenes-estado'
  | 'ordenes-culminadas'
  | 'auditorias'
  | 'registro-inventario'
  | 'usuarios-sede';

export type ColumnDef = {
  key: string;
  label: string;
  format?: 'text' | 'number' | 'datetime' | 'duration' | 'badge' | 'percent';
};

export type ReportFilters = {
  from?: Date | null;
  to?: Date | null;
  sedeId?: number | null;
  zonaId?: number | null;
  seccionId?: number | null;
  operarioId?: number | null;
  credocube?: string | null;
  orderId?: number | null;
};

export type Pagination = {
  page: number;
  pageSize: number;
};

export type ReportContext = {
  tenant: string;
  filters: ReportFilters;
  pagination: Pagination;
};

export type ReportDataset = {
  columns: ColumnDef[];
  rows: QueryResultRow[];
  meta: {
    total: number;
    page: number;
    pages: number;
    pageSize: number;
  };
  kpis?: Record<string, string | number | null>;
  raw?: Record<string, unknown>;
};

export async function runReport(key: ReportKey, ctx: ReportContext): Promise<ReportDataset> {
  switch (key) {
    case 'inventario-sede':
      return inventarioPorSede(ctx);
    case 'trazabilidad':
      return trazabilidadHistorial(ctx);
    case 'actividad-operario':
      return actividadPorOperario(ctx);
    case 'actividad-sede':
      return actividadPorSede(ctx);
    case 'ordenes-estado':
      return ordenesPorEstado(ctx);
    case 'ordenes-culminadas':
      return ordenesCulminadas(ctx);
    case 'auditorias':
      return auditoriasBitacora(ctx);
    case 'registro-inventario':
      return registroInventario(ctx);
    case 'usuarios-sede':
      return usuariosPorSede(ctx);
    default:
      throw new Error(`Reporte desconocido: ${key}`);
  }
}

// --- Implementaciones internas ---

async function inventarioPorSede(ctx: ReportContext): Promise<ReportDataset> {
  const { tenant, filters } = ctx;
  const { whereClause, params } = buildHistFilters(filters);
  const sql = `
    WITH filtered AS (
      SELECT
        hist.hist_id,
        hist.inventario_id,
        hist.rfid,
        hist.happened_at,
        COALESCE(hist.estado_new, hist.estado_old) AS estado_actual,
        COALESCE(hist.sub_estado_new, hist.sub_estado_old) AS sub_estado_actual,
        COALESCE(hist.sede_id_new, hist.sede_id_old) AS sede_id_actual
      FROM hist_trazabilidad AS hist
      ${whereClause ? `WHERE ${whereClause}` : ''}
    ),
    latest AS (
      SELECT DISTINCT ON (inventario_id)
        inventario_id,
        rfid,
        estado_actual,
        sub_estado_actual,
        sede_id_actual,
        happened_at
      FROM filtered
      ORDER BY inventario_id, happened_at DESC
    )
    SELECT
      l.sede_id_actual AS sede_id,
      s.nombre AS sede_nombre,
      COALESCE(l.estado_actual, 'Sin estado') AS estado,
      COUNT(*)::int AS cantidad,
      MAX(l.happened_at) AS ultimo_movimiento
    FROM latest l
    LEFT JOIN sedes s ON s.sede_id = l.sede_id_actual
    GROUP BY l.sede_id_actual, s.nombre, COALESCE(l.estado_actual, 'Sin estado')
    ORDER BY s.nombre NULLS LAST, estado;
  `;

  const rows = await withTenant(tenant, (client) => client.query(sql, params));
  const grouped = new Map<number | null, {
    sede_id: number | null;
    sede_nombre: string;
    total: number;
    estados: { estado: string; cantidad: number }[];
    ultimo_movimiento: Date | null;
  }>();

  let totalItems = 0;
  let estadosSet = new Set<string>();

  for (const row of rows.rows) {
    const sedeId = (row as any).sede_id as number | null;
    const sedeNombre = (row as any).sede_nombre ?? 'Sin sede';
    const estado = (row as any).estado as string;
    const cantidad = Number((row as any).cantidad) || 0;
    const ultimo = (row as any).ultimo_movimiento instanceof Date ? (row as any).ultimo_movimiento : (row as any).ultimo_movimiento ? new Date((row as any).ultimo_movimiento) : null;

    totalItems += cantidad;
    estadosSet.add(estado);

    if (!grouped.has(sedeId)) {
      grouped.set(sedeId, {
        sede_id: sedeId,
        sede_nombre: sedeNombre,
        total: 0,
        estados: [],
        ultimo_movimiento: ultimo,
      });
    }
    const entry = grouped.get(sedeId)!;
    entry.total += cantidad;
    entry.estados.push({ estado, cantidad });
    if (!entry.ultimo_movimiento || (ultimo && ultimo > entry.ultimo_movimiento)) {
      entry.ultimo_movimiento = ultimo;
    }
  }

  const rowsOut = Array.from(grouped.values()).map((item) => ({
    sede: item.sede_nombre,
    total: item.total,
    estados: item.estados
      .sort((a, b) => b.cantidad - a.cantidad)
      .map((x) => `${x.estado}: ${x.cantidad}`)
      .join(', '),
    ultimo_movimiento: item.ultimo_movimiento ? item.ultimo_movimiento.toISOString() : null,
  }));

  return {
    columns: [
      { key: 'sede', label: 'Sede', format: 'text' },
      { key: 'total', label: 'Inventario total', format: 'number' },
      { key: 'estados', label: 'Estados', format: 'text' },
      { key: 'ultimo_movimiento', label: 'Último movimiento', format: 'datetime' },
    ],
    rows: rowsOut,
    meta: {
      total: rowsOut.length,
      page: 1,
      pages: 1,
      pageSize: rowsOut.length || 1,
    },
    kpis: {
      total_items: totalItems,
      sedes: grouped.size,
      estados_distintos: estadosSet.size,
    },
  };
}

async function trazabilidadHistorial(ctx: ReportContext): Promise<ReportDataset> {
  const { tenant, filters, pagination } = ctx;
  const { whereClause, params } = buildHistFilters(filters);
  const baseSql = `
    FROM hist_trazabilidad hist
    LEFT JOIN sedes sede_new ON sede_new.sede_id = hist.sede_id_new
    LEFT JOIN sedes sede_old ON sede_old.sede_id = hist.sede_id_old
    LEFT JOIN zonas zona_new ON zona_new.zona_id = hist.zona_id_new
    LEFT JOIN zonas zona_old ON zona_old.zona_id = hist.zona_id_old
    LEFT JOIN secciones seccion_new ON seccion_new.seccion_id = hist.seccion_id_new
    LEFT JOIN secciones seccion_old ON seccion_old.seccion_id = hist.seccion_id_old
    LEFT JOIN usuarios usr ON usr.id = hist.usuario_id
    LEFT JOIN ordenes ord ON ord.id = hist.order_id
    LEFT JOIN inventario_credocubes inv ON inv.id = hist.inventario_id
    ${whereClause ? `WHERE ${whereClause}` : ''}
  `;

  const countSql = `SELECT COUNT(*)::int AS total ${baseSql}`;
  const dataSql = `
    SELECT
      hist.hist_id,
      hist.happened_at,
      hist.accion,
      hist.inventario_id,
      hist.rfid,
      COALESCE(hist.estado_old, '-') AS estado_anterior,
      COALESCE(hist.estado_new, '-') AS estado_nuevo,
      COALESCE(hist.sub_estado_old, '-') AS sub_estado_anterior,
      COALESCE(hist.sub_estado_new, '-') AS sub_estado_nuevo,
      COALESCE(zona_new.nombre, zona_old.nombre) AS zona,
      COALESCE(seccion_new.nombre, seccion_old.nombre) AS seccion,
      COALESCE(sede_new.nombre, sede_old.nombre) AS sede,
      hist.fase_id,
      hist.order_id,
      COALESCE(ord.numero_orden, ord.codigo_producto, CONCAT('Orden ', ord.id::text)) AS orden_referencia,
      COALESCE(usr.nombre, usr.correo, CONCAT('Usuario ', usr.id::text)) AS operario,
      inv.nombre_unidad
  ${baseSql}
  ORDER BY hist.happened_at ASC, hist.hist_id ASC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;

  const pageSize = pagination.pageSize;
  const offset = (pagination.page - 1) * pagination.pageSize;
  const total = await withTenant(tenant, (client) => client.query(countSql, params));
  const result = await withTenant(tenant, (client) => client.query(dataSql, [...params, pageSize, offset]));
  const totalRows = total.rows[0]?.total || 0;
  const pages = Math.max(1, Math.ceil(totalRows / pageSize));

  return {
    columns: [
      { key: 'happened_at', label: 'Fecha', format: 'datetime' },
      { key: 'accion', label: 'Acción', format: 'text' },
      { key: 'rfid', label: 'RFID', format: 'text' },
      { key: 'nombre_unidad', label: 'Pieza', format: 'text' },
      { key: 'estado_anterior', label: 'Estado anterior', format: 'text' },
      { key: 'estado_nuevo', label: 'Estado nuevo', format: 'text' },
      { key: 'sub_estado_anterior', label: 'Sub-estado anterior', format: 'text' },
      { key: 'sub_estado_nuevo', label: 'Sub-estado nuevo', format: 'text' },
      { key: 'sede', label: 'Sede', format: 'text' },
      { key: 'zona', label: 'Zona', format: 'text' },
      { key: 'seccion', label: 'Sección', format: 'text' },
      { key: 'orden_referencia', label: 'Orden', format: 'text' },
      { key: 'operario', label: 'Operario', format: 'text' },
    ],
    rows: result.rows,
    meta: {
      total: totalRows,
      page: pagination.page,
      pages,
      pageSize,
    },
  };
}

async function actividadPorOperario(ctx: ReportContext): Promise<ReportDataset> {
  const { tenant, filters, pagination } = ctx;
  if (typeof filters.operarioId === 'number' && Number.isFinite(filters.operarioId)) {
    return actividadOperarioDetalle(ctx);
  }
  const { whereClause, params } = buildHistFilters(filters, { requireUsuario: true });
  const pageSize = pagination.pageSize;
  const offset = (pagination.page - 1) * pageSize;

  const sql = `
    WITH base AS (
      SELECT
        hist.usuario_id,
        hist.fase_id,
        hist.order_id,
        hist.inventario_id,
        hist.happened_at,
        hist.accion,
        COALESCE(hist.sede_id_new, hist.sede_id_old) AS sede_id,
        COALESCE(hist.zona_id_new, hist.zona_id_old) AS zona_id,
        COALESCE(hist.seccion_id_new, hist.seccion_id_old) AS seccion_id,
        COALESCE(hist.estado_new, hist.estado_old) AS estado_actual
      FROM hist_trazabilidad hist
      WHERE hist.usuario_id IS NOT NULL
      ${whereClause ? `AND ${whereClause}` : ''}
    ),
    per_user AS (
      SELECT
        usuario_id,
        COUNT(*)::int AS total_acciones,
        COUNT(DISTINCT inventario_id)::int AS piezas,
        COUNT(DISTINCT order_id)::int AS ordenes,
        MIN(happened_at) AS primer_evento,
        MAX(happened_at) AS ultimo_evento
      FROM base
      GROUP BY usuario_id
    ),
    tat_data AS (
      SELECT
        usuario_id,
        AVG(EXTRACT(EPOCH FROM (last_event - first_event)) / 60.0) AS tat_promedio_min
      FROM (
        SELECT
          usuario_id,
          inventario_id,
          MIN(happened_at) AS first_event,
          MAX(happened_at) AS last_event
        FROM base
        GROUP BY usuario_id, inventario_id
        HAVING COUNT(*) > 1
      ) t
      GROUP BY usuario_id
    ),
    fase_data AS (
      SELECT
        spans.usuario_id,
        spans.fase_id,
        COUNT(*)::int AS acciones,
        AVG(EXTRACT(EPOCH FROM (spans.max_time - spans.min_time)) / 60.0) AS minutos_promedio
      FROM (
        SELECT
          usuario_id,
          fase_id,
          inventario_id,
          MIN(happened_at) AS min_time,
          MAX(happened_at) AS max_time
        FROM base
        WHERE fase_id IS NOT NULL
        GROUP BY usuario_id, fase_id, inventario_id
      ) spans
      GROUP BY spans.usuario_id, spans.fase_id
    ),
    fase_json AS (
      SELECT
        usuario_id,
        json_agg(json_build_object(
          'fase_id', fase_id,
          'acciones', acciones,
          'minutos_promedio', COALESCE(minutos_promedio, 0)
        ) ORDER BY acciones DESC) AS fases
      FROM fase_data
      GROUP BY usuario_id
    ),
    action_counts AS (
      SELECT
        usuario_id,
        accion,
        COUNT(*)::int AS totals
      FROM base
      GROUP BY usuario_id, accion
    ),
    action_json AS (
      SELECT
        usuario_id,
        json_agg(json_build_object(
          'accion', accion,
          'total', totals
        ) ORDER BY totals DESC) AS acciones
      FROM action_counts
      GROUP BY usuario_id
    ),
    location_info AS (
      SELECT
        b.usuario_id,
        array_remove(array_agg(DISTINCT s.nombre), NULL) AS sedes,
        array_remove(array_agg(DISTINCT z.nombre), NULL) AS zonas,
        array_remove(array_agg(DISTINCT sc.nombre), NULL) AS secciones,
        array_remove(array_agg(DISTINCT b.estado_actual), NULL) AS estados
      FROM base b
      LEFT JOIN sedes s ON s.sede_id = b.sede_id
      LEFT JOIN zonas z ON z.zona_id = b.zona_id
      LEFT JOIN secciones sc ON sc.seccion_id = b.seccion_id
      GROUP BY b.usuario_id
    ),
    latest_event AS (
      SELECT DISTINCT ON (b.usuario_id)
        b.usuario_id,
        b.accion AS ultima_accion,
        b.happened_at AS ultimo_evento,
        b.estado_actual,
        b.sede_id,
        b.zona_id,
        b.seccion_id
      FROM base b
      ORDER BY b.usuario_id, b.happened_at DESC
    ),
    latest_event_named AS (
      SELECT
        le.usuario_id,
        le.ultima_accion,
        le.ultimo_evento,
        le.estado_actual,
        s.nombre AS ultima_sede,
        z.nombre AS ultima_zona,
        sc.nombre AS ultima_seccion
      FROM latest_event le
      LEFT JOIN sedes s ON s.sede_id = le.sede_id
      LEFT JOIN zonas z ON z.zona_id = le.zona_id
      LEFT JOIN secciones sc ON sc.seccion_id = le.seccion_id
    ),
    merged AS (
      SELECT
        u.usuario_id,
        u.total_acciones,
        u.piezas,
        u.ordenes,
        u.primer_evento,
        COALESCE(le.ultimo_evento, u.ultimo_evento) AS ultimo_evento,
        COALESCE(t.tat_promedio_min, 0) AS tat_promedio_min,
        COALESCE(f.fases, '[]'::json) AS fases,
        COALESCE(a.acciones, '[]'::json) AS acciones_json,
        li.sedes,
        li.zonas,
        li.secciones,
        li.estados,
        le.ultima_accion,
        le.estado_actual AS ultimo_estado,
        le.ultima_sede,
        le.ultima_zona,
        le.ultima_seccion
      FROM per_user u
      LEFT JOIN tat_data t ON t.usuario_id = u.usuario_id
      LEFT JOIN fase_json f ON f.usuario_id = u.usuario_id
      LEFT JOIN action_json a ON a.usuario_id = u.usuario_id
      LEFT JOIN location_info li ON li.usuario_id = u.usuario_id
      LEFT JOIN latest_event_named le ON le.usuario_id = u.usuario_id
    ),
    total_cte AS (
      SELECT COUNT(*)::int AS total FROM merged
    )
    SELECT m.*, usr.nombre AS operario_nombre, usr.rol AS operario_rol, total_cte.total
    FROM merged m
    LEFT JOIN usuarios usr ON usr.id = m.usuario_id
    CROSS JOIN total_cte
    ORDER BY m.total_acciones DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2};
  `;

  const result = await withTenant(tenant, (client) => client.query(sql, [...params, pageSize, offset]));
  const totalRows = result.rows[0]?.total || 0;
  const pages = Math.max(1, Math.ceil(totalRows / pageSize));
  const rows = result.rows.map((row) => ({
    operario: row.operario_nombre || row.operario_rol || `ID ${row.usuario_id}`,
    total_acciones: Number(row.total_acciones) || 0,
    ordenes: Number(row.ordenes) || 0,
    piezas: Number(row.piezas) || 0,
    tat_promedio_min: Number(row.tat_promedio_min) || 0,
    fases: Array.isArray(row.fases)
      ? row.fases.map((f: any) => `Fase ${f.fase_id ?? 'N/A'}: ${f.acciones} (${Number(f.minutos_promedio || 0).toFixed(1)} min)`).join('; ')
      : '',
    acciones_detalle: Array.isArray(row.acciones_json)
      ? row.acciones_json.map((a: any) => `${a.accion || 'sin acción'}: ${a.total}`).join('; ')
      : '',
    sedes: Array.isArray(row.sedes) && row.sedes.length
      ? row.sedes.join(', ')
      : '',
    zonas: Array.isArray(row.zonas) && row.zonas.length
      ? row.zonas.join(', ')
      : '',
    secciones: Array.isArray(row.secciones) && row.secciones.length
      ? row.secciones.join(', ')
      : '',
    estados: Array.isArray(row.estados) && row.estados.length
      ? row.estados.join(', ')
      : '',
    ultima_accion: row.ultima_accion || '',
    ultimo_estado: row.ultimo_estado || '',
    ultimo_lugar: [row.ultima_sede, row.ultima_zona, row.ultima_seccion].filter(Boolean).join(' · '),
    primer_evento: row.primer_evento,
    ultimo_evento: row.ultimo_evento,
  }));

  return {
    columns: [
      { key: 'operario', label: 'Operario', format: 'text' },
      { key: 'total_acciones', label: 'Acciones', format: 'number' },
      { key: 'ordenes', label: 'Órdenes atendidas', format: 'number' },
      { key: 'piezas', label: 'Piezas', format: 'number' },
      { key: 'tat_promedio_min', label: 'TAT promedio (min)', format: 'duration' },
      { key: 'fases', label: 'Detalle por fase', format: 'text' },
      { key: 'acciones_detalle', label: 'Qué hicieron', format: 'text' },
      { key: 'ultima_accion', label: 'Última acción', format: 'text' },
      { key: 'ultimo_estado', label: 'Estado actual', format: 'text' },
      { key: 'ultimo_lugar', label: 'Dónde (último)', format: 'text' },
      { key: 'sedes', label: 'Sedes visitadas', format: 'text' },
      { key: 'zonas', label: 'Zonas', format: 'text' },
      { key: 'secciones', label: 'Secciones', format: 'text' },
      { key: 'estados', label: 'Estados tocados', format: 'text' },
      { key: 'primer_evento', label: 'Primer evento', format: 'datetime' },
      { key: 'ultimo_evento', label: 'Último evento', format: 'datetime' },
    ],
    rows,
    meta: {
      total: totalRows,
      page: pagination.page,
      pages,
      pageSize,
    },
  };
}

async function actividadOperarioDetalle(ctx: ReportContext): Promise<ReportDataset> {
  const { tenant, filters, pagination } = ctx;
  const { whereClause, params } = buildHistFilters(filters, { requireUsuario: true });
  const filterSql = whereClause ? `WHERE ${whereClause}` : '';
  const pageSize = pagination.pageSize;
  const offset = (pagination.page - 1) * pageSize;

  const baseSql = `
    FROM hist_trazabilidad hist
    LEFT JOIN sedes sede_new ON sede_new.sede_id = hist.sede_id_new
    LEFT JOIN sedes sede_old ON sede_old.sede_id = hist.sede_id_old
    LEFT JOIN zonas zona_new ON zona_new.zona_id = hist.zona_id_new
    LEFT JOIN zonas zona_old ON zona_old.zona_id = hist.zona_id_old
    LEFT JOIN secciones seccion_new ON seccion_new.seccion_id = hist.seccion_id_new
    LEFT JOIN secciones seccion_old ON seccion_old.seccion_id = hist.seccion_id_old
    LEFT JOIN usuarios usr ON usr.id = hist.usuario_id
    LEFT JOIN ordenes ord ON ord.id = hist.order_id
    LEFT JOIN inventario_credocubes inv ON inv.id = hist.inventario_id
    ${filterSql}
  `;

  const countSql = `SELECT COUNT(*)::int AS total ${baseSql}`;
  const dataSql = `
    SELECT
      hist.hist_id,
      hist.happened_at,
      hist.accion,
      hist.rfid,
      COALESCE(hist.estado_old, '-') AS estado_anterior,
      COALESCE(hist.estado_new, '-') AS estado_nuevo,
      COALESCE(hist.sub_estado_old, '-') AS sub_estado_anterior,
      COALESCE(hist.sub_estado_new, '-') AS sub_estado_nuevo,
      COALESCE(zona_new.nombre, zona_old.nombre) AS zona,
      COALESCE(seccion_new.nombre, seccion_old.nombre) AS seccion,
      COALESCE(sede_new.nombre, sede_old.nombre) AS sede,
      hist.order_id,
      COALESCE(ord.numero_orden, ord.codigo_producto, CONCAT('Orden ', ord.id::text)) AS orden_referencia,
      COALESCE(usr.nombre, usr.correo, CONCAT('Usuario ', usr.id::text)) AS operario,
      inv.nombre_unidad
    ${baseSql}
    ORDER BY hist.happened_at ASC, hist.hist_id ASC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;

  const total = await withTenant(tenant, (client) => client.query(countSql, params));
  const result = await withTenant(tenant, (client) => client.query(dataSql, [...params, pageSize, offset]));
  const totalRows = total.rows[0]?.total || 0;
  const pages = Math.max(1, Math.ceil(totalRows / pageSize));
  const distinctCredos = new Set<string>();
  const rows = result.rows.map((row) => {
    if (row.rfid) distinctCredos.add(String(row.rfid));
    return {
      happened_at: row.happened_at,
      accion: row.accion,
      rfid: row.rfid,
      nombre_unidad: row.nombre_unidad,
      estado_anterior: row.estado_anterior,
      estado_nuevo: row.estado_nuevo,
      sub_estado_anterior: row.sub_estado_anterior,
      sub_estado_nuevo: row.sub_estado_nuevo,
      sede: row.sede,
      zona: row.zona,
      seccion: row.seccion,
      orden_referencia: row.orden_referencia,
      operario: row.operario,
    };
  });

  return {
    columns: [
      { key: 'happened_at', label: 'Fecha', format: 'datetime' },
      { key: 'accion', label: 'Acción', format: 'text' },
      { key: 'rfid', label: 'Credocube', format: 'text' },
      { key: 'estado_anterior', label: 'Estado anterior', format: 'text' },
      { key: 'estado_nuevo', label: 'Estado nuevo', format: 'text' },
      { key: 'sub_estado_anterior', label: 'Sub-estado anterior', format: 'text' },
      { key: 'sub_estado_nuevo', label: 'Sub-estado nuevo', format: 'text' },
      { key: 'sede', label: 'Sede', format: 'text' },
      { key: 'zona', label: 'Zona', format: 'text' },
      { key: 'seccion', label: 'Sección', format: 'text' },
      { key: 'orden_referencia', label: 'Orden', format: 'text' },
      { key: 'operario', label: 'Operario', format: 'text' },
      { key: 'nombre_unidad', label: 'Pieza', format: 'text' },
    ],
    rows,
    meta: {
      total: totalRows,
      page: pagination.page,
      pages,
      pageSize,
    },
    kpis: {
      operario: rows[0]?.operario || 'Sin operario',
      total_acciones: totalRows,
      credocubes: distinctCredos.size,
    },
  };
}

async function actividadPorSede(ctx: ReportContext): Promise<ReportDataset> {
  const { tenant, filters, pagination } = ctx;
  const { whereClause, params } = buildHistFilters(filters);
  const pageSize = pagination.pageSize;
  const offset = (pagination.page - 1) * pageSize;

  const sql = `
    WITH base AS (
      SELECT
        hist.hist_id,
        hist.accion,
        hist.order_id,
        hist.happened_at,
        hist.usuario_id,
        COALESCE(hist.sede_id_old, hist.sede_id_new) AS sede_origen,
        hist.sede_id_new AS sede_destino
      FROM hist_trazabilidad hist
      ${whereClause ? `WHERE ${whereClause}` : ''}
    ),
    traslados_emitidos AS (
      SELECT sede_origen AS sede_id, COUNT(*)::int AS emitidos
      FROM base
      WHERE accion = 'move' AND sede_origen IS NOT NULL
      GROUP BY sede_origen
    ),
    traslados_recibidos AS (
      SELECT sede_destino AS sede_id, COUNT(*)::int AS recibidos
      FROM base
      WHERE accion = 'move' AND sede_destino IS NOT NULL
      GROUP BY sede_destino
    ),
    ordenes_hist AS (
      SELECT
        spans.sede_id,
        COUNT(*)::int AS ordenes_en_historial,
        AVG(EXTRACT(EPOCH FROM (spans.fin - spans.inicio)) / 60.0) AS minutos_promedio
      FROM (
        SELECT
          sede_origen AS sede_id,
          order_id,
          MIN(happened_at) AS inicio,
          MAX(happened_at) AS fin
        FROM base
        WHERE order_id IS NOT NULL
        GROUP BY sede_origen, order_id
      ) spans
      GROUP BY spans.sede_id
    ),
    merged AS (
      SELECT
        s.sede_id,
        s.nombre AS sede_nombre,
        COALESCE(em.emitidos, 0) AS traslados_emitidos,
        COALESCE(rec.recibidos, 0) AS traslados_recibidos,
        COALESCE(o.ordenes_en_historial, 0)::int AS ordenes_historial,
        COALESCE(o.minutos_promedio, 0) AS tiempo_promedio
      FROM sedes s
      LEFT JOIN traslados_emitidos em ON em.sede_id = s.sede_id
      LEFT JOIN traslados_recibidos rec ON rec.sede_id = s.sede_id
      LEFT JOIN ordenes_hist o ON o.sede_id = s.sede_id
    ),
    total AS (
      SELECT COUNT(*)::int AS total FROM merged
    )
    SELECT merged.*, total.total
    FROM merged, total
    ORDER BY merged.sede_nombre
    LIMIT $${params.length + 1} OFFSET $${params.length + 2};
  `;

  const result = await withTenant(tenant, (client) => client.query(sql, [...params, pageSize, offset]));
  const totalRows = result.rows[0]?.total || 0;
  const pages = Math.max(1, Math.ceil(totalRows / pageSize));

  return {
    columns: [
      { key: 'sede_nombre', label: 'Sede', format: 'text' },
      { key: 'traslados_emitidos', label: 'Traslados emitidos', format: 'number' },
      { key: 'traslados_recibidos', label: 'Traslados recibidos', format: 'number' },
      { key: 'ordenes_historial', label: 'Órdenes tocadas', format: 'number' },
      { key: 'tiempo_promedio', label: 'Tiempo promedio (min)', format: 'duration' },
    ],
    rows: result.rows,
    meta: {
      total: totalRows,
      page: pagination.page,
      pages,
      pageSize,
    },
  };
}

async function ordenesPorEstado(ctx: ReportContext): Promise<ReportDataset> {
  const { tenant, filters, pagination } = ctx;
  const pageSize = pagination.pageSize;
  const offset = (pagination.page - 1) * pageSize;
  const { whereClause, params } = buildHistFilters(filters);

  const orderConditions: string[] = [];
  if (typeof filters.orderId === 'number' && Number.isFinite(filters.orderId)) {
    params.push(filters.orderId);
    orderConditions.push(`o.id = $${params.length}`);
  }
  const ordersWhere = orderConditions.length ? `WHERE ${orderConditions.join(' AND ')}` : '';

  const sql = `
    WITH hist_base AS (
      SELECT
        hist.order_id,
        hist.fase_id,
        hist.happened_at
      FROM hist_trazabilidad hist
      WHERE hist.order_id IS NOT NULL
      ${whereClause ? `AND ${whereClause}` : ''}
    ),
    per_order AS (
      SELECT
        order_id,
        MIN(happened_at) AS inicio,
        MAX(happened_at) AS fin,
        COUNT(*)::int AS eventos
      FROM hist_base
      GROUP BY order_id
    ),
    fase_spans AS (
      SELECT
        order_id,
        fase_id,
        MIN(happened_at) AS min_time,
        MAX(happened_at) AS max_time
      FROM hist_base
      WHERE fase_id IS NOT NULL
      GROUP BY order_id, fase_id
    ),
    fase_data AS (
      SELECT
        spans.order_id,
        spans.fase_id,
        COUNT(*)::int AS acciones,
        AVG(EXTRACT(EPOCH FROM (spans.max_time - spans.min_time)) / 60.0) AS minutos_promedio
      FROM fase_spans spans
      GROUP BY spans.order_id, spans.fase_id
    ),
    fase_json AS (
      SELECT
        order_id,
        json_agg(json_build_object(
          'fase_id', fase_id,
          'acciones', acciones,
          'minutos_promedio', COALESCE(minutos_promedio, 0)
        ) ORDER BY acciones DESC) AS fases
      FROM fase_data
      GROUP BY order_id
    ),
    final AS (
      SELECT
        o.id,
        o.numero_orden,
        o.codigo_producto,
        o.cantidad,
        o.cliente,
        o.ciudad_destino,
        o.ubicacion_destino,
        o.fecha_generacion,
        o.estado_orden,
        o.habilitada,
        p.inicio,
        p.fin,
        p.eventos,
        CASE
          WHEN p.fin IS NOT NULL AND p.inicio IS NOT NULL
            THEN EXTRACT(EPOCH FROM (p.fin - p.inicio)) / 60.0
          ELSE NULL
        END AS tat_minutos,
        COALESCE(f.fases, '[]'::json) AS fases
      FROM ordenes o
      JOIN per_order p ON p.order_id = o.id
      LEFT JOIN fase_json f ON f.order_id = o.id
      ${ordersWhere}
    )
  SELECT final.*, COUNT(*) OVER() AS total_count
  FROM final
  ORDER BY COALESCE(final.inicio, final.fecha_generacion) ASC,
       COALESCE(final.fin, final.fecha_generacion) ASC,
       final.id ASC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2};
  `;

  const result = await withTenant(tenant, (client) => client.query(sql, [...params, pageSize, offset]));
  const totalRows = result.rows.length ? Number(result.rows[0].total_count || 0) : 0;
  const pages = Math.max(1, Math.ceil(totalRows / pageSize));

  const rows = result.rows.map((row) => ({
    numero_orden: row.numero_orden || `#${row.id}`,
    codigo_producto: row.codigo_producto || '',
    cliente: row.cliente || '',
    cantidad: typeof row.cantidad === 'number' ? Number(row.cantidad) : (row.cantidad ? Number(row.cantidad) : 0),
    ciudad_destino: row.ciudad_destino || '',
    tat_minutos: row.tat_minutos !== null && row.tat_minutos !== undefined ? Number(row.tat_minutos) : 0,
    eventos: Number(row.eventos) || 0,
    inicio: row.inicio,
    fin: row.fin,
    fases: Array.isArray(row.fases)
      ? row.fases.map((f: any) => `Fase ${f.fase_id ?? 'N/A'}: ${f.acciones} (${Number(f.minutos_promedio || 0).toFixed(1)} min)`).join('; ')
      : '',
  }));

  return {
    columns: [
      { key: 'numero_orden', label: 'Orden', format: 'text' },
      { key: 'cliente', label: 'Cliente', format: 'text' },
      { key: 'codigo_producto', label: 'Producto', format: 'text' },
      { key: 'cantidad', label: 'Cantidad', format: 'number' },
      { key: 'ciudad_destino', label: 'Ciudad destino', format: 'text' },
      { key: 'tat_minutos', label: 'TAT (min)', format: 'duration' },
      { key: 'eventos', label: 'Eventos', format: 'number' },
      { key: 'inicio', label: 'Inicio', format: 'datetime' },
      { key: 'fin', label: 'Fin', format: 'datetime' },
      { key: 'fases', label: 'Detalle por fase', format: 'text' },
    ],
    rows,
    meta: {
      total: totalRows,
      page: pagination.page,
      pages,
      pageSize,
    },
  };
}

async function ordenesCulminadas(ctx: ReportContext): Promise<ReportDataset> {
  const base = await ordenesPorEstado(ctx);
  const rows = base.rows.filter((row: any) => row.fin !== null);
  return {
    ...base,
    rows,
    meta: {
      ...base.meta,
      total: rows.length,
      pages: Math.max(1, Math.ceil(rows.length / base.meta.pageSize)),
    },
  };
}

async function auditoriasBitacora(ctx: ReportContext): Promise<ReportDataset> {
  const { tenant, filters, pagination } = ctx;
  const pageSize = pagination.pageSize;
  const offset = (pagination.page - 1) * pageSize;
  const params: any[] = [];
  const conditions: string[] = [];

  if (filters.from instanceof Date && !Number.isNaN(filters.from.getTime())) {
    params.push(filters.from.toISOString());
    conditions.push(`a.fecha >= $${params.length}`);
  }
  if (filters.to instanceof Date && !Number.isNaN(filters.to.getTime())) {
    params.push(filters.to.toISOString().slice(0, 10));
    conditions.push(`a.fecha < ($${params.length}::date + INTERVAL '1 day')`);
  }
  if (typeof filters.sedeId === 'number') {
    params.push(filters.sedeId);
    conditions.push(`ic.sede_id = $${params.length}`);
  }
  if (typeof filters.zonaId === 'number') {
    params.push(filters.zonaId);
    conditions.push(`ic.zona_id = $${params.length}`);
  }
  if (typeof filters.seccionId === 'number') {
    params.push(filters.seccionId);
    conditions.push(`ic.seccion_id = $${params.length}`);
  }
  if (typeof filters.orderId === 'number' && Number.isFinite(filters.orderId)) {
    params.push(filters.orderId);
    conditions.push(`o.id = $${params.length}`);
  }
  if (filters.credocube) {
    const term = `%${filters.credocube.trim()}%`;
    params.push(term);
    conditions.push(`(ic.rfid ILIKE $${params.length} OR ic.numero_orden ILIKE $${params.length})`);
  }

  const whereSQL = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    WITH final AS (
      SELECT
        a.id,
        a.fecha,
        a.auditada,
        a.comentarios,
        a.novedad_id,
        ic.rfid,
  COALESCE(ic.numero_orden, o.numero_orden) AS numero_orden,
        ic.estado,
        ic.sub_estado,
        ic.sede_id,
        ic.zona_id,
        ic.seccion_id,
        s.nombre AS sede_nombre,
        z.nombre AS zona_nombre,
        sc.nombre AS seccion_nombre,
        COALESCE(n.descripcion, n.estado) AS novedad
      FROM auditorias_credocubes a
      JOIN inventario_credocubes ic ON ic.id = a.inventario_id
      LEFT JOIN sedes s ON s.sede_id = ic.sede_id
      LEFT JOIN zonas z ON z.zona_id = ic.zona_id
      LEFT JOIN secciones sc ON sc.seccion_id = ic.seccion_id
      LEFT JOIN inspeccion_novedades n ON n.novedad_id = a.novedad_id
      LEFT JOIN ordenes o ON o.numero_orden = ic.numero_orden
      ${whereSQL}
    )
  SELECT final.*, COUNT(*) OVER() AS total_count
  FROM final
  ORDER BY final.fecha ASC, final.id ASC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2};
  `;

  const result = await withTenant(tenant, (client) => client.query(sql, [...params, pageSize, offset]));
  const totalRows = result.rows.length ? Number(result.rows[0].total_count || 0) : 0;
  const pages = Math.max(1, Math.ceil(totalRows / pageSize));

  const rows = result.rows.map((row) => ({
    fecha: row.fecha,
    rfid: row.rfid,
    numero_orden: row.numero_orden,
    estado: row.estado,
    sub_estado: row.sub_estado,
    auditada: row.auditada ? 'Sí' : 'No',
    novedad: row.novedad || '',
    comentarios: row.comentarios || '',
    sede: row.sede_nombre || '',
    zona: row.zona_nombre || '',
    seccion: row.seccion_nombre || '',
  }));

  return {
    columns: [
      { key: 'fecha', label: 'Fecha', format: 'datetime' },
      { key: 'rfid', label: 'Pieza', format: 'text' },
      { key: 'numero_orden', label: 'Orden', format: 'text' },
      { key: 'estado', label: 'Estado', format: 'text' },
      { key: 'sub_estado', label: 'Sub-estado', format: 'text' },
      { key: 'auditada', label: 'Auditada', format: 'text' },
      { key: 'novedad', label: 'Novedad', format: 'text' },
      { key: 'comentarios', label: 'Comentarios', format: 'text' },
      { key: 'sede', label: 'Sede', format: 'text' },
      { key: 'zona', label: 'Zona', format: 'text' },
      { key: 'seccion', label: 'Sección', format: 'text' },
    ],
    rows,
    meta: {
      total: totalRows,
      page: pagination.page,
      pages,
      pageSize,
    },
  };
}

async function registroInventario(ctx: ReportContext): Promise<ReportDataset> {
  const { tenant, filters, pagination } = ctx;
  const { whereClause, params } = buildHistFilters(filters);
  const pageSize = pagination.pageSize;
  const offset = (pagination.page - 1) * pageSize;

  const sql = `
    WITH base AS (
      SELECT
        hist.hist_id,
        hist.accion,
        hist.happened_at,
        COALESCE(hist.sede_id_new, hist.sede_id_old) AS sede_id,
        COALESCE(hist.zona_id_new, hist.zona_id_old) AS zona_id,
        COALESCE(hist.seccion_id_new, hist.seccion_id_old) AS seccion_id
      FROM hist_trazabilidad hist
      ${whereClause ? `WHERE ${whereClause}` : ''}
    ),
    aggregated AS (
      SELECT
        sede_id,
        zona_id,
        seccion_id,
        SUM(CASE WHEN accion = 'create' THEN 1 ELSE 0 END)::int AS entradas,
        SUM(CASE WHEN accion = 'move' THEN 1 ELSE 0 END)::int AS movimientos,
        SUM(CASE WHEN accion = 'update' THEN 1 ELSE 0 END)::int AS actualizaciones
      FROM base
      GROUP BY sede_id, zona_id, seccion_id
    )
    SELECT
      aggregated.*,
      sedes.nombre AS sede_nombre,
      zonas.nombre AS zona_nombre,
      secciones.nombre AS seccion_nombre
    FROM aggregated
    LEFT JOIN sedes ON sedes.sede_id = aggregated.sede_id
    LEFT JOIN zonas ON zonas.zona_id = aggregated.zona_id
    LEFT JOIN secciones ON secciones.seccion_id = aggregated.seccion_id
    ORDER BY sedes.nombre NULLS LAST, zonas.nombre NULLS LAST
    LIMIT $${params.length + 1} OFFSET $${params.length + 2};
  `;
  const countSql = `SELECT COUNT(*)::int AS total FROM (
    SELECT 1
    FROM hist_trazabilidad hist
    ${whereClause ? `WHERE ${whereClause}` : ''}
    GROUP BY COALESCE(hist.sede_id_new, hist.sede_id_old), COALESCE(hist.zona_id_new, hist.zona_id_old), COALESCE(hist.seccion_id_new, hist.seccion_id_old)
  ) q`;

  const result = await withTenant(tenant, (client) => client.query(sql, [...params, pageSize, offset]));
  const total = await withTenant(tenant, (client) => client.query(countSql, params));
  const totalRows = total.rows[0]?.total || 0;
  const pages = Math.max(1, Math.ceil(totalRows / pageSize));

  return {
    columns: [
      { key: 'sede_nombre', label: 'Sede', format: 'text' },
      { key: 'zona_nombre', label: 'Zona', format: 'text' },
      { key: 'seccion_nombre', label: 'Sección', format: 'text' },
      { key: 'entradas', label: 'Entradas', format: 'number' },
      { key: 'movimientos', label: 'Movimientos', format: 'number' },
      { key: 'actualizaciones', label: 'Actualizaciones', format: 'number' },
    ],
    rows: result.rows,
    meta: {
      total: totalRows,
      page: pagination.page,
      pages,
      pageSize,
    },
  };
}

async function usuariosPorSede(ctx: ReportContext): Promise<ReportDataset> {
  const { tenant, filters } = ctx;
  const sedeFilter = filters.sedeId;
  const sql = `
    SELECT
      s.sede_id,
      s.nombre AS sede_nombre,
      COUNT(*) FILTER (WHERE u.activo) ::int AS activos,
      COUNT(*) FILTER (WHERE NOT COALESCE(u.activo, false)) ::int AS inactivos,
      COUNT(*)::int AS total,
      MIN(u.fecha_creacion) AS primer_registro,
      MAX(u.fecha_creacion) AS ultimo_registro
    FROM usuarios u
    LEFT JOIN sedes s ON s.sede_id = u.sede_id
    ${sedeFilter ? 'WHERE u.sede_id = $1' : ''}
    GROUP BY s.sede_id, s.nombre
    ORDER BY s.nombre NULLS LAST;
  `;
  const params = sedeFilter ? [sedeFilter] : [];
  const result = await withTenant(tenant, (client) => client.query(sql, params));
  return {
    columns: [
      { key: 'sede_nombre', label: 'Sede', format: 'text' },
      { key: 'total', label: 'Total usuarios', format: 'number' },
      { key: 'activos', label: 'Activos', format: 'number' },
      { key: 'inactivos', label: 'Inactivos', format: 'number' },
      { key: 'primer_registro', label: 'Primera alta', format: 'datetime' },
      { key: 'ultimo_registro', label: 'Última alta', format: 'datetime' },
    ],
    rows: result.rows,
    meta: {
      total: result.rows.length,
      page: 1,
      pages: 1,
      pageSize: result.rows.length || 1,
    },
  };
}

// --- Utilidades ---

type FilterOptions = {
  accion?: string;
  requireUsuario?: boolean;
};

function buildHistFilters(filters: ReportFilters, options: FilterOptions = {}) {
  const clauses: string[] = [];
  const params: any[] = [];

  if (options.accion) {
    clauses.push(`hist.accion = $${params.length + 1}`);
    params.push(options.accion);
  }

  if (filters.from instanceof Date && !Number.isNaN(filters.from.getTime())) {
    clauses.push(`hist.happened_at >= $${params.length + 1}`);
    params.push(filters.from.toISOString());
  }

  if (filters.to instanceof Date && !Number.isNaN(filters.to.getTime())) {
    clauses.push(`hist.happened_at <= $${params.length + 1}`);
    params.push(filters.to.toISOString());
  }

  if (typeof filters.sedeId === 'number') {
    clauses.push(`COALESCE(hist.sede_id_new, hist.sede_id_old) = $${params.length + 1}`);
    params.push(filters.sedeId);
  }

  if (typeof filters.zonaId === 'number') {
    clauses.push(`COALESCE(hist.zona_id_new, hist.zona_id_old) = $${params.length + 1}`);
    params.push(filters.zonaId);
  }

  if (typeof filters.seccionId === 'number') {
    clauses.push(`COALESCE(hist.seccion_id_new, hist.seccion_id_old) = $${params.length + 1}`);
    params.push(filters.seccionId);
  }

  if (typeof filters.operarioId === 'number') {
    clauses.push(`hist.usuario_id = $${params.length + 1}`);
    params.push(filters.operarioId);
  } else if (options.requireUsuario) {
    clauses.push('hist.usuario_id IS NOT NULL');
  }

  if (filters.orderId) {
    clauses.push(`hist.order_id = $${params.length + 1}`);
    params.push(filters.orderId);
  }

  if (filters.credocube) {
    const value = filters.credocube.trim();
    if (value.length >= 4) {
      clauses.push(`hist.rfid ILIKE $${params.length + 1}`);
      params.push(`%${value}%`);
    }
  }

  return {
    whereClause: clauses.join(' AND '),
    params,
  };
}
