import { Request, Response } from 'express';
import ExcelJS from 'exceljs';
import { withTenant } from '../db/pool';
import { resolveTenant } from '../middleware/tenant';
import { getRequestSedeId } from '../utils/sede';
import { getCurrentUserContext } from '../utils/userContext';
import {
  OrdenesCalculadoraService,
  CalculadoraProductoInput,
  CalculadoraProductoNormalizado,
  CalculadoraRecomendacion,
} from '../services/ordenesCalculadoraService';
async function ensureProductosCalculo(
  tenant: string,
  items: CalculadoraProductoNormalizado[],
): Promise<void> {
  if (!items.length) return;
  const candidatos = items.filter((item) => item && typeof item.codigo === 'string' && item.codigo.trim().length);
  if (!candidatos.length) return;

  await withTenant(tenant, async (client) => {
    for (const item of candidatos) {
      const codigo = item.codigo ? item.codigo.trim() : '';
      if (!codigo) continue;
      const nombre = item.nombre ? item.nombre.trim() : null;
      await client.query(
        `INSERT INTO productos_calculo (
           descripcion_producto,
           nombre_producto,
           codigo_producto,
           largo_mm,
           ancho_mm,
           alto_mm,
           cantidad_producto,
           volumen_total_m3_producto
         )
         SELECT payload.descripcion_producto,
                payload.nombre_producto,
                payload.codigo_producto,
                payload.largo_mm,
                payload.ancho_mm,
                payload.alto_mm,
                payload.cantidad_producto,
                payload.volumen_total_m3_producto
           FROM (
             SELECT $1::varchar(200)  AS descripcion_producto,
                    $2::varchar(100)  AS nombre_producto,
                    $3::varchar(100)  AS codigo_producto,
                    $4::numeric(12,2) AS largo_mm,
                    $5::numeric(12,2) AS ancho_mm,
                    $6::numeric(12,2) AS alto_mm,
                    $7::bigint        AS cantidad_producto,
                    $8::numeric(18,10) AS volumen_total_m3_producto
           ) AS payload
          WHERE NOT EXISTS (
            SELECT 1
              FROM productos_calculo pc
             WHERE LOWER(pc.codigo_producto) = LOWER(payload.codigo_producto)
          )`,
        [
          nombre,
          nombre,
          codigo,
          item.largo_mm,
          item.ancho_mm,
          item.alto_mm,
          item.cantidad,
          item.volumen_total_m3,
        ],
      );
    }
  });
}

type OrdenState = 'all' | 'active' | 'inactive';

type ParsedOrder = {
  numero: string;
  codigo: string | null;
  cantidad: number | null;
  ciudad: string | null;
  ubicacion: string | null;
  cliente: string | null;
  row: number;
};

type ImportIssue = { row: number; message: string };

type ProductoImportIssue = { row: number; message: string };

type ProductoImportEntry = {
  row: number;
  codigo: string | null;
  nombre: string | null;
  descripcion: string | null;
  largo_mm: number;
  ancho_mm: number;
  alto_mm: number;
  cantidad: number;
  volumen_total_m3: number;
};

type UploadedFile = {
  buffer: Buffer;
  originalname: string;
};

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const TEMPLATE_COLUMNS = [
  { header: 'numero_orden', key: 'numero_orden', width: 22 },
  { header: 'codigo_producto', key: 'codigo_producto', width: 22 },
  { header: 'cantidad', key: 'cantidad', width: 12 },
  { header: 'ciudad_destino', key: 'ciudad_destino', width: 20 },
  { header: 'direccion_destino', key: 'ubicacion_destino', width: 24 },
  { header: 'cliente', key: 'cliente', width: 24 },
];

const PRODUCT_TEMPLATE_COLUMNS = [
  { header: 'codigo_producto', key: 'codigo_producto', width: 26 },
  { header: 'nombre_producto', key: 'nombre_producto', width: 28 },
  { header: 'descripcion_producto', key: 'descripcion_producto', width: 34 },
  { header: 'largo_mm', key: 'largo_mm', width: 14 },
  { header: 'ancho_mm', key: 'ancho_mm', width: 14 },
  { header: 'alto_mm', key: 'alto_mm', width: 14 },
  { header: 'cantidad_producto', key: 'cantidad_producto', width: 14 },
];

const ORDER_PAGE_SIZE_OPTIONS = [5, 10, 15, 20] as const;
const DEFAULT_ORDER_PAGE_SIZE = 10;

type FetchOrdersOptions = {
  page?: number;
  limit?: number;
  sedeId?: number | null;
};

type FetchOrdersResult = {
  items: any[];
  total: number;
  page: number;
  limit: number;
  pages: number;
};

function parseState(raw: string): OrdenState {
  const value = raw.toLowerCase();
  if (['activa', 'activas', 'active', 'true'].includes(value)) return 'active';
  if (['inhabilitada', 'inhabilitadas', 'inactive', 'false', 'inhabilitado', 'inhabilitados'].includes(value)) return 'inactive';
  return 'all';
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const num = Number(value.trim());
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function ensureDateParts(parts: LocalDateParts): boolean {
  const { year, month, day, hour, minute, second } = parts;
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  const maxDay = new Date(year, month, 0).getDate();
  if (!Number.isInteger(day) || day < 1 || day > maxDay) return false;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return false;
  if (!Number.isInteger(second) || second < 0 || second > 59) return false;
  return true;
}

function localPartsToUtcIso(parts: LocalDateParts, offsetMinutes: number | null | undefined): string {
  const offset = Number.isFinite(offsetMinutes) ? Number(offsetMinutes) : 0;
  const utcMillis = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) + offset * 60000;
  return new Date(utcMillis).toISOString();
}

function parseLocalIso(localIso: string, offsetMinutes: number | null): string | null {
  const match = localIso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const parts: LocalDateParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || '0'),
  };
  if (!ensureDateParts(parts)) return null;
  return localPartsToUtcIso(parts, offsetMinutes);
}

async function ensureOrdenesArtifacts(tenant: string): Promise<void> {
  await withTenant(tenant, async (client) => {
    await client.query(`CREATE TABLE IF NOT EXISTS ordenes (
      id serial PRIMARY KEY,
      numero_orden text NOT NULL,
      codigo_producto text,
      cantidad integer,
      ciudad_destino text,
      ubicacion_destino text,
      cliente text,
      fecha_generacion timestamptz DEFAULT NOW() NOT NULL,
      estado_orden boolean DEFAULT true,
      habilitada boolean NOT NULL DEFAULT true,
      estado text DEFAULT 'borrador' NOT NULL,
      modelo_sugerido_id integer,
      cantidad_modelos integer,
      productos jsonb,
      volumen_total_m3 numeric(18,6),
      sede_origen_id integer,
      created_by integer
    )`);
    await client.query('ALTER TABLE IF EXISTS inventario_credocubes DROP CONSTRAINT IF EXISTS fk_inv_numero_orden');
    await client.query('ALTER TABLE IF EXISTS inventario_credocubes DROP CONSTRAINT IF EXISTS inventario_credocubes_numero_orden_fkey');
    await client.query('ALTER TABLE IF EXISTS ordenes DROP CONSTRAINT IF EXISTS ordenes_numero_orden_key');
  await client.query("ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS estado text DEFAULT 'borrador' NOT NULL");
  await client.query('ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS modelo_sugerido_id integer');
  await client.query('ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS cantidad_modelos integer');
  await client.query('ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS productos jsonb');
  await client.query('ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS volumen_total_m3 numeric(18,6)');
  await client.query('ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS sede_origen_id integer');
  await client.query('ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS created_by integer');
    await client.query(`DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_schema = current_schema()
           AND table_name = 'ordenes'
           AND constraint_name = 'ordenes_cantidad_modelos_check'
      ) THEN
        ALTER TABLE ordenes
          ADD CONSTRAINT ordenes_cantidad_modelos_check
          CHECK (cantidad_modelos IS NULL OR cantidad_modelos >= 0);
      END IF;
    END $$;`);
    await client.query(`CREATE INDEX IF NOT EXISTS ordenes_fecha_generacion_idx ON ordenes(fecha_generacion)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ordenes_numero_orden_idx ON ordenes(numero_orden)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ordenes_sede_origen_idx ON ordenes(sede_origen_id)`);
    await client.query(`DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_schema = current_schema()
           AND table_name = 'ordenes'
           AND constraint_name = 'ordenes_sede_origen_id_fkey'
      ) THEN
        BEGIN
          ALTER TABLE ordenes
            ADD CONSTRAINT ordenes_sede_origen_id_fkey
            FOREIGN KEY (sede_origen_id) REFERENCES sedes(sede_id) ON DELETE SET NULL;
        EXCEPTION WHEN others THEN
        END;
      END IF;
    END $$;`);
  });
}

async function fetchOrders(
  tenant: string,
  state: OrdenState,
  options: FetchOrdersOptions = {},
): Promise<FetchOrdersResult> {
  const requestedPage = Number(options.page ?? 1);
  const requestedLimit = Number(options.limit ?? DEFAULT_ORDER_PAGE_SIZE);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
  const rawLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : DEFAULT_ORDER_PAGE_SIZE;
  const limit = Math.min(200, Math.max(5, rawLimit));
  const sedeId = typeof options.sedeId === 'number' ? options.sedeId : options.sedeId ?? null;

  const filters: string[] = [];
  const params: Array<number | string | null> = [];

  if (state === 'active') {
    filters.push('(COALESCE(o.estado_orden, true) AND COALESCE(o.habilitada, true))');
  } else if (state === 'inactive') {
    filters.push('(o.estado_orden = false OR COALESCE(o.habilitada, true) = false)');
  }

  if (typeof sedeId === 'number' && Number.isFinite(sedeId)) {
    params.push(sedeId);
    filters.push(`o.sede_origen_id = $${params.length}`);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const countSql = `SELECT COUNT(*)::int AS total FROM ordenes o ${where}`;
  const limitIndex = params.length + 1;
  const offsetIndex = params.length + 2;
  const listSql = `SELECT
         o.id,
         o.numero_orden,
         o.codigo_producto,
         o.cantidad,
         o.ciudad_destino,
         o.ubicacion_destino,
         o.cliente,
         o.fecha_generacion,
         o.estado_orden,
         o.habilitada,
         o.sede_origen_id,
         o.created_by,
         o.modelo_sugerido_id,
         o.cantidad_modelos,
         m.nombre_modelo AS modelo_sugerido_nombre
       FROM ordenes o
       LEFT JOIN modelos m ON m.modelo_id = o.modelo_sugerido_id
       ${where}
      ORDER BY o.id DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}`;

  const { total, items, currentPage, pages } = await withTenant(tenant, async (client) => {
    const countRes = await client.query(countSql, params);
    const totalRows = countRes.rows[0]?.total || 0;
    const totalPages = Math.max(1, Math.ceil(totalRows / limit) || 1);
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * limit;
    const listParams = [...params, limit, offset];
    const listRes = await client.query(listSql, listParams);
    return {
      total: totalRows,
      items: listRes.rows,
      currentPage: safePage,
      pages: totalPages,
    };
  });

  return {
    items,
    total,
    page: currentPage,
    limit,
    pages,
  };
}

function cleanString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function cellText(row: ExcelJS.Row, index: number): string {
  const cell = row.getCell(index);
  if (typeof cell.text === 'string') {
    return cell.text.trim();
  }
  const value = cell.value as any;
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && typeof value.text === 'string') return value.text.trim();
  return '';
}

function parsePositiveInteger(value: ExcelJS.CellValue): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const rounded = Math.round(value);
    return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    const rounded = Math.round(parsed);
    return Number.isFinite(parsed) && rounded > 0 ? rounded : null;
  }
  if (value instanceof Date) return null;
  if (typeof value === 'object' && value && 'text' in value) {
    return parsePositiveInteger((value as any).text);
  }
  return null;
}


function isRowEmptyGeneric(row: ExcelJS.Row, totalColumns: number): boolean {
  for (let i = 1; i <= totalColumns; i += 1) {
    if (cellText(row, i)) return false;
  }
  return true;
}

function isRowEmpty(row: ExcelJS.Row): boolean {
  return isRowEmptyGeneric(row, TEMPLATE_COLUMNS.length);
}

function parsePositiveDecimal(value: ExcelJS.CellValue): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Number(value.toFixed(2)) : null;
  }
  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '.').trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(2)) : null;
  }
  if (value instanceof Date) return null;
  if (typeof value === 'object' && value && 'text' in value) {
    return parsePositiveDecimal((value as any).text);
  }
  return null;
}

function volumenDesdeDimensiones(largo: number, ancho: number, alto: number): number {
  return (largo * ancho * alto) / 1_000_000_000;
}

function parseCalculatorItems(raw: unknown): CalculadoraProductoInput[] {
  if (!Array.isArray(raw)) {
    throw new Error('Los productos deben enviarse como un arreglo.');
  }
  if (raw.length === 0) {
    throw new Error('Agrega al menos un producto para calcular recomendaciones.');
  }
  if (raw.length > 25) {
    throw new Error('El máximo permitido es de 25 productos por cálculo.');
  }

  const items: CalculadoraProductoInput[] = [];
  const errores: string[] = [];

  raw.forEach((entry, index) => {
    const src = entry as any;
    const codigoRaw = typeof src?.codigo === 'string' ? src.codigo : typeof src?.codigo_producto === 'string' ? src.codigo_producto : null;
    const codigo = codigoRaw ? codigoRaw.trim().slice(0, 120) : null;
    const nombreRaw = typeof src?.nombre === 'string' ? src.nombre : typeof src?.nombre_producto === 'string' ? src.nombre_producto : typeof src?.descripcion === 'string' ? src.descripcion : null;
    const nombre = nombreRaw ? nombreRaw.trim().slice(0, 160) : null;

    const largoRaw = src?.largo_mm ?? src?.largo ?? src?.largoMm ?? src?.length_mm ?? src?.longitud_mm;
    const anchoRaw = src?.ancho_mm ?? src?.ancho ?? src?.anchoMm ?? src?.width_mm ?? src?.frente_mm;
    const altoRaw = src?.alto_mm ?? src?.alto ?? src?.altoMm ?? src?.height_mm ?? src?.profundo_mm;

    const largo = Number(largoRaw);
    const ancho = Number(anchoRaw);
    const alto = Number(altoRaw);
    const cantidadVal = Number(src?.cantidad ?? src?.cantidad_producto ?? src?.qty);

    const problemas: string[] = [];
    if (!Number.isFinite(largo) || largo <= 0) problemas.push('largo');
    if (!Number.isFinite(ancho) || ancho <= 0) problemas.push('ancho');
    if (!Number.isFinite(alto) || alto <= 0) problemas.push('alto');
    if (!Number.isFinite(cantidadVal) || cantidadVal <= 0) problemas.push('cantidad');

    if (problemas.length > 0) {
      errores.push(`Producto ${index + 1}: revisa ${problemas.join(', ')}.`);
      return;
    }

    if (largo > 100_000 || ancho > 100_000 || alto > 100_000) {
      errores.push(`Producto ${index + 1}: dimensiones no pueden exceder 100.000 mm.`);
      return;
    }

    const cantidad = Math.max(1, Math.round(cantidadVal));
    if (cantidad > 50_000) {
      errores.push(`Producto ${index + 1}: la cantidad supera el máximo permitido (50.000).`);
      return;
    }

    const normalizado: CalculadoraProductoInput = {
      codigo,
      nombre,
      largo_mm: Number(largo.toFixed(2)),
      ancho_mm: Number(ancho.toFixed(2)),
      alto_mm: Number(alto.toFixed(2)),
      cantidad,
    };

    items.push(normalizado);
  });

  if (items.length === 0) {
    throw new Error(errores[0] || 'No se encontraron productos válidos.');
  }
  if (errores.length > 0) {
    throw new Error(errores.join(' '));
  }

  return items;
}

export const OrdenesController = {
  index: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).send('Tenant no especificado');
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const sedeId = getRequestSedeId(req);

    const stateFilter = parseState(((req.query.state ?? '') as string).toString());
    const pageRaw = (req.query.page ?? '1') as string;
    const limitRaw = (req.query.limit ?? DEFAULT_ORDER_PAGE_SIZE) as string;
    const requestedPage = Number(pageRaw);
    const requestedLimit = Number(limitRaw);
    try {
      await ensureOrdenesArtifacts(tenant);
      const result = await fetchOrders(tenant, stateFilter, {
        page: requestedPage,
        limit: requestedLimit,
        sedeId,
      });
      res.render('ordenes/index', {
        title: 'Órdenes',
        items: result.items,
        stateFilter,
        sedeId,
        page: result.page,
        pages: result.pages,
        limit: result.limit,
        total: result.total,
        pageSizeOptions: ORDER_PAGE_SIZE_OPTIONS,
      });
    } catch (e: any) {
      res.render('ordenes/index', {
        title: 'Órdenes',
        items: [],
        stateFilter,
        sedeId,
        error: e?.message || 'Error cargando órdenes',
        page: 1,
        pages: 1,
        limit: DEFAULT_ORDER_PAGE_SIZE,
        total: 0,
        pageSizeOptions: ORDER_PAGE_SIZE_OPTIONS,
      });
    }
  },

  listJson: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const sedeId = getRequestSedeId(req);
    try {
      await ensureOrdenesArtifacts(tenant);
      const result = await fetchOrders(tenant, 'active', {
        page: Number((req.query.page ?? '1') as string),
        limit: Number((req.query.limit ?? 200) as string),
        sedeId,
      });
      return res.json({
        ok: true,
        items: result.items,
        sedeId,
        total: result.total,
        page: result.page,
        pages: result.pages,
        limit: result.limit,
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || 'Error listando órdenes' });
    }
  },

  downloadTemplate: async (_req: Request, res: Response) => {
    const workbook = new ExcelJS.Workbook();
    const now = new Date();
    workbook.created = now;
    workbook.modified = now;

    const ordersSheet = workbook.addWorksheet('Órdenes');
    ordersSheet.properties.defaultRowHeight = 20;
    ordersSheet.views = [{ state: 'frozen', ySplit: 1 }];
    ordersSheet.columns = TEMPLATE_COLUMNS.map((column) => ({ ...column }));

    const headerRow = ordersSheet.getRow(1);
    headerRow.values = TEMPLATE_COLUMNS.map((column) => column.header);
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1D4ED8' },
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF1E3A8A' } },
        left: { style: 'thin', color: { argb: 'FF1E3A8A' } },
        bottom: { style: 'thin', color: { argb: 'FF1E3A8A' } },
        right: { style: 'thin', color: { argb: 'FF1E3A8A' } },
      };
    });

    ordersSheet.autoFilter = {
      from: 'A1',
      to: 'F1',
    };

    TEMPLATE_COLUMNS.forEach((column, index) => {
      const col = ordersSheet.getColumn(index + 1);
      if (column.width) col.width = column.width + 4;
    });

    ordersSheet.getColumn('cantidad').numFmt = '#,##0';
    ordersSheet.getColumn('cantidad').alignment = { horizontal: 'right' };
    (ordersSheet as any).dataValidations.add('C2:C1048576', {
      type: 'whole',
      operator: 'greaterThan',
      allowBlank: true,
      showInputMessage: true,
      promptTitle: 'Cantidad',
      prompt: 'Ingresa un entero positivo.',
      formulae: [0],
    });

    const guideSheet = workbook.addWorksheet('Guía');
    guideSheet.columns = [
      { key: 'col1', width: 24 },
      { key: 'col2', width: 64 },
    ];
    guideSheet.getColumn(1).alignment = { vertical: 'middle', horizontal: 'left' };
    guideSheet.getColumn(2).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };

    guideSheet.mergeCells('A1:B1');
    const titleCell = guideSheet.getCell('A1');
    titleCell.value = 'Guía rápida para la carga masiva de órdenes';
    titleCell.font = { bold: true, size: 16, color: { argb: 'FF0F172A' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0F2FE' } };
    guideSheet.getRow(1).height = 30;

    const steps = [
      'Ingresa la información en la hoja "Órdenes" a partir de la celda A2. Cada fila corresponde a una nueva orden.',
      'Conserva el encabezado y el orden de las columnas. Si no necesitas un dato, deja la celda vacía.',
  'La columna "numero_orden" es obligatoria. Puedes repetir el mismo número para registrar varios productos asociados a la misma orden.',
  'La columna "cantidad" acepta solo números enteros positivos. El formato se aplica automáticamente.',
  'La fecha de generación se asigna automáticamente durante la importación. No necesitas agregarla.',
  'Guarda el archivo en formato XLSX y súbelo desde la opción "Importar Excel" en la plataforma.',
    ];

    steps.forEach((text, index) => {
      const rowIndex = index + 3;
      const labelCell = guideSheet.getCell(`A${rowIndex}`);
      labelCell.value = `Paso ${index + 1}`;
      labelCell.font = { bold: true, color: { argb: 'FF1D4ED8' } };
      const textCell = guideSheet.getCell(`B${rowIndex}`);
      textCell.value = text;
    });

    const legendStart = steps.length + 5;
    const legendHeader = guideSheet.getRow(legendStart);
      legendHeader.values = ['Columna', 'Descripción'];
    legendHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    legendHeader.alignment = { horizontal: 'center', vertical: 'middle' };
    legendHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
    legendHeader.height = 24;

    const legendRows: Array<[string, string]> = [
      ['numero_orden', 'Identificador de la orden. Obligatorio. Puedes repetirlo si deseas separar productos por fila.'],
      ['codigo_producto', 'SKU o referencia interna del producto. Opcional.'],
      ['cantidad', 'Cantidad solicitada. Solo números enteros mayores a cero.'],
  ['ciudad_destino', 'Ciudad o municipio donde se entregará la orden.'],
  ['direccion_destino', 'Dirección exacta, centro logístico o sede destino.'],
  ['cliente', 'Nombre o razón social del cliente asociado.'],
    ];

    legendRows.forEach(([columnName, description], index) => {
      const row = guideSheet.getRow(legendStart + index + 1);
        row.values = [columnName, description];
      row.getCell(2).alignment = { wrapText: true };
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          left: { style: 'thin', color: { argb: 'FFCBD5F5' } },
          bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          right: { style: 'thin', color: { argb: 'FFCBD5F5' } },
        };
      });
      row.getCell(1).font = { bold: true, color: { argb: 'FF111827' } };
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_ordenes.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  },

  downloadProductosTemplate: async (_req: Request, res: Response) => {
    const workbook = new ExcelJS.Workbook();
    const now = new Date();
    workbook.created = now;
    workbook.modified = now;

    const sheet = workbook.addWorksheet('Productos');
    sheet.properties.defaultRowHeight = 20;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.columns = PRODUCT_TEMPLATE_COLUMNS.map((col) => ({ ...col }));

    const header = sheet.getRow(1);
    header.values = PRODUCT_TEMPLATE_COLUMNS.map((col) => col.header);
    header.height = 28;
    header.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E3A8A' },
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF1E40AF' } },
        left: { style: 'thin', color: { argb: 'FF1E40AF' } },
        bottom: { style: 'thin', color: { argb: 'FF1E40AF' } },
        right: { style: 'thin', color: { argb: 'FF1E40AF' } },
      };
    });

    sheet.autoFilter = { from: 'A1', to: 'G1' };

    ['D', 'E', 'F'].forEach((colKey) => {
      const column = sheet.getColumn(colKey);
      column.numFmt = '#,##0.00';
      column.alignment = { horizontal: 'right' };
    });
    const quantityCol = sheet.getColumn('G');
    quantityCol.numFmt = '#,##0';
    quantityCol.alignment = { horizontal: 'right' };
    (sheet as any).dataValidations.add('G2:G1048576', {
      type: 'whole',
      operator: 'greaterThan',
      allowBlank: true,
      showInputMessage: true,
      promptTitle: 'Cantidad por defecto',
      prompt: 'Ingresa un entero positivo. Si se deja vacío, el valor será 1.',
      formulae: [0],
    });

    const guide = workbook.addWorksheet('Guía');
    guide.columns = [
      { key: 'col1', width: 28 },
      { key: 'col2', width: 72 },
    ];
    guide.mergeCells('A1:B1');
    const guideTitle = guide.getCell('A1');
    guideTitle.value = 'Carga masiva de productos para la calculadora';
    guideTitle.font = { bold: true, size: 16, color: { argb: 'FF0F172A' } };
    guideTitle.alignment = { horizontal: 'center', vertical: 'middle' };
    guideTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
    guide.getRow(1).height = 30;

    const pasos = [
      'Completa los datos en la hoja "Productos" a partir de la celda A2. Cada fila representa una referencia temporal para la calculadora.',
      'Las dimensiones deben indicarse en milímetros (mm) y siempre deben ser mayores a cero.',
      'Si aún no cuentas con un código interno, deja la columna vacía; podrás editarlo más adelante.',
      'La columna "cantidad_producto" define la cantidad sugerida que se prellenará al importar (valor por defecto 1).',
      'Guarda el archivo en formato XLSX y usa la opción "Importar productos" para agregar estas referencias a la tabla inferior. Recuerda que no se guardan en la base de datos hasta que confirmes una orden.',
    ];

    pasos.forEach((texto, index) => {
      const rowIndex = index + 3;
      guide.getCell(`A${rowIndex}`).value = `Paso ${index + 1}`;
      guide.getCell(`A${rowIndex}`).font = { bold: true, color: { argb: 'FF1D4ED8' } };
      const cell = guide.getCell(`B${rowIndex}`);
      cell.value = texto;
      cell.alignment = { wrapText: true };
    });

    const legendStart = pasos.length + 5;
    const legendHeaderRow = guide.getRow(legendStart);
    legendHeaderRow.values = ['Columna', 'Descripción'];
    legendHeaderRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    legendHeaderRow.alignment = { horizontal: 'center', vertical: 'middle' };
    legendHeaderRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } };
    legendHeaderRow.height = 24;

    const legendData: Array<[string, string]> = [
      ['codigo_producto', 'Identificador interno o SKU (opcional). Si se indica, ayudará a reconocer la referencia al crear la orden.'],
      ['nombre_producto', 'Nombre principal del producto.'],
      ['descripcion_producto', 'Descripción o notas adicionales (opcional).'],
      ['largo_mm', 'Largo interno del producto en milímetros.'],
      ['ancho_mm', 'Ancho interno del producto en milímetros.'],
      ['alto_mm', 'Alto interno del producto en milímetros.'],
      ['cantidad_producto', 'Cantidad sugerida que se mostrará en la calculadora (entero positivo).'],
    ];

    legendData.forEach(([colName, description], idx) => {
      const row = guide.getRow(legendStart + idx + 1);
      row.values = [colName, description];
      row.getCell(2).alignment = { wrapText: true };
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        };
      });
      row.getCell(1).font = { bold: true, color: { argb: 'FF111827' } };
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_productos_calculadora.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  },

  create: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const sedeId = getRequestSedeId(req);
    if (!sedeId) {
      const message = 'El usuario no tiene una sede asignada.';
      if ((req.headers['content-type'] || '').includes('application/json')) {
        return res.status(403).json({ ok: false, error: message });
      }
      return res.status(403).send(message);
    }
    const createdBy = getCurrentUserContext();
    const {
      numero_orden,
      codigo_producto,
      cantidad,
      ciudad_destino,
      ubicacion_destino,
      cliente,
    } = (req.body || {}) as any;

    const num = cleanString(numero_orden);
    if (!num) {
      return res.status(400).json({ ok: false, error: 'El número de orden es requerido' });
    }

    const cod = cleanString(codigo_producto);
    let cant: number | null = null;
    if (cantidad !== undefined && cantidad !== null && String(cantidad).trim() !== '') {
      const parsed = Number(cantidad);
      if (Number.isFinite(parsed) && parsed > 0) {
        cant = Math.round(parsed);
      } else {
        return res.status(400).json({ ok: false, error: 'La cantidad debe ser un número positivo' });
      }
    }
    const cdd = cleanString(ciudad_destino);
    const ubc = cleanString(ubicacion_destino);
    const cli = cleanString(cliente);
    const clientOffsetRaw = (req.body || {}).clientTzOffset;
    const clientOffsetMinutes = toNumber(clientOffsetRaw);
    const clientLocalNowRaw = (req.body || {}).clientLocalNow;
    const clientNowIso = typeof clientLocalNowRaw === 'string'
      ? parseLocalIso(clientLocalNowRaw.trim(), clientOffsetMinutes)
      : null;
    const createdAtIso = clientNowIso ?? new Date().toISOString();

    try {
      await ensureOrdenesArtifacts(tenant);
      await withTenant(tenant, (client) => client.query(
        `INSERT INTO ordenes (numero_orden, codigo_producto, cantidad, ciudad_destino, ubicacion_destino, cliente, fecha_generacion, sede_origen_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          num,
          cod,
          cant,
          cdd,
          ubc,
          cli,
          createdAtIso,
          sedeId,
          createdBy,
        ]
      ));
      if ((req.headers['content-type'] || '').includes('application/json')) {
        return res.json({ ok: true });
      }
      return res.redirect('/ordenes');
    } catch (e: any) {
      if ((req.headers['content-type'] || '').includes('application/json')) {
        return res.status(500).json({ ok: false, error: e?.message || 'Error creando orden' });
      }
      return res.status(500).send(e?.message || 'Error creando orden');
    }
  },

  update: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const sedeId = getRequestSedeId(req);
    if (!sedeId) {
      const message = 'El usuario no tiene una sede asignada.';
      if ((req.headers['content-type'] || '').includes('application/json')) {
        return res.status(403).json({ ok: false, error: message });
      }
      return res.status(403).send(message);
    }
    const {
      id,
      numero_orden,
      codigo_producto,
      cantidad,
      ciudad_destino,
      ubicacion_destino,
      cliente,
    } = (req.body || {}) as any;
    const orderId = Number(id);
    if (!Number.isFinite(orderId) || orderId <= 0) {
      return res.status(400).json({ ok: false, error: 'ID inválido' });
    }
    const num = cleanString(numero_orden);
    const cod = cleanString(codigo_producto);
    let cant: number | null = null;
    if (cantidad !== undefined && cantidad !== null && String(cantidad).trim() !== '') {
      const parsed = Number(cantidad);
      if (Number.isFinite(parsed) && parsed > 0) {
        cant = Math.round(parsed);
      } else {
        return res.status(400).json({ ok: false, error: 'La cantidad debe ser un número positivo' });
      }
    }
    const cdd = cleanString(ciudad_destino);
    const ubc = cleanString(ubicacion_destino);
    const cli = cleanString(cliente);

    try {
      await ensureOrdenesArtifacts(tenant);
      const result = await withTenant(tenant, (client) => client.query(
        `UPDATE ordenes SET
             numero_orden = COALESCE($2, numero_orden),
             codigo_producto = $3,
             cantidad = $4,
             ciudad_destino = $5,
             ubicacion_destino = $6,
             cliente = $7,
             sede_origen_id = COALESCE(sede_origen_id, $8)
           WHERE id = $1 AND (sede_origen_id = $8 OR sede_origen_id IS NULL)`,
        [
          orderId,
          num,
          cod,
          cant,
          cdd,
          ubc,
          cli,
          sedeId,
        ]
      ));
      if (result.rowCount === 0) {
        const message = 'No se encontró la orden en tu sede.';
        if ((req.headers['content-type'] || '').includes('application/json')) {
          return res.status(404).json({ ok: false, error: message });
        }
        return res.status(404).send(message);
      }
      if ((req.headers['content-type'] || '').includes('application/json')) {
        return res.json({ ok: true });
      }
      return res.redirect('/ordenes');
    } catch (e: any) {
      if ((req.headers['content-type'] || '').includes('application/json')) {
        return res.status(500).json({ ok: false, error: e?.message || 'Error actualizando orden' });
      }
      return res.status(500).send(e?.message || 'Error actualizando orden');
    }
  },

  toggleState: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const sedeId = getRequestSedeId(req);
    if (!sedeId) {
      return res.status(403).json({ ok: false, error: 'El usuario no tiene una sede asignada.' });
    }
    const { id, habilitada } = (req.body || {}) as any;
    const orderId = Number(id);
    if (!Number.isFinite(orderId) || orderId <= 0) {
      return res.status(400).json({ ok: false, error: 'ID inválido' });
    }
    const parseDesired = (value: any): boolean | null => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
      }
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'si', 'on', 'habilitada', 'habilitado', 'activo', 'activa', 'enable', 'enabled'].includes(normalized)) {
          return true;
        }
        if (['0', 'false', 'no', 'off', 'inhabilitada', 'inhabilitado', 'inactivo', 'inactiva', 'disabled', 'disable'].includes(normalized)) {
          return false;
        }
      }
      return null;
    };
    const desired = parseDesired(habilitada);
    if (desired === null) {
      return res.status(400).json({ ok: false, error: 'Valor "habilitada" inválido' });
    }
    try {
      await ensureOrdenesArtifacts(tenant);
      const result = await withTenant(tenant, (client) => client.query(
        `UPDATE ordenes
            SET habilitada = $3,
                estado_orden = CASE WHEN $3 THEN true ELSE false END
          WHERE id = $1 AND (sede_origen_id = $2 OR sede_origen_id IS NULL)
          RETURNING id, numero_orden, habilitada, estado_orden`,
        [orderId, sedeId, desired]
      ));
      if (result.rowCount === 0) {
        return res.status(404).json({ ok: false, error: 'No se encontró la orden en tu sede.' });
      }
      const { habilitada: enabled, estado_orden: estadoOrden } = result.rows[0] as { habilitada: boolean; estado_orden: boolean };
      return res.json({ ok: true, habilitada: enabled !== false, estado_orden: estadoOrden !== false });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || 'Error cambiando el estado de la orden' });
    }
  },

  remove: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const sedeId = getRequestSedeId(req);
    if (!sedeId) {
      const message = 'El usuario no tiene una sede asignada.';
      if ((req.headers['content-type'] || '').includes('application/json')) {
        return res.status(403).json({ ok: false, error: message });
      }
      return res.status(403).send(message);
    }
    const { id } = (req.body || {}) as any;
    const orderId = Number(id);
    if (!Number.isFinite(orderId) || orderId <= 0) {
      return res.status(400).json({ ok: false, error: 'ID inválido' });
    }
    try {
      await ensureOrdenesArtifacts(tenant);
      const deletedCount = await withTenant(tenant, async (client) => {
        await client.query(`ALTER TABLE acond_cajas ADD COLUMN IF NOT EXISTS order_id integer`);
        await client.query(`DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = 'acond_cajas'::regclass
               AND conname = 'acond_cajas_order_id_fkey'
          ) THEN
            BEGIN
              ALTER TABLE acond_cajas
                ADD CONSTRAINT acond_cajas_order_id_fkey
                FOREIGN KEY (order_id) REFERENCES ordenes(id) ON DELETE SET NULL;
            EXCEPTION WHEN others THEN
            END;
          END IF;
        END $$;`);
        const deletion = await client.query(`DELETE FROM ordenes WHERE id = $1 AND (sede_origen_id = $2 OR sede_origen_id IS NULL)`, [orderId, sedeId]);
        return deletion.rowCount;
      });
      if (deletedCount === 0) {
        const message = 'No se encontró la orden en tu sede.';
        if ((req.headers['content-type'] || '').includes('application/json')) {
          return res.status(404).json({ ok: false, error: message });
        }
        return res.status(404).send(message);
      }
      if ((req.headers['content-type'] || '').includes('application/json')) {
        return res.json({ ok: true });
      }
      return res.redirect('/ordenes');
    } catch (e: any) {
      if ((req.headers['content-type'] || '').includes('application/json')) {
        return res.status(500).json({ ok: false, error: e?.message || 'Error eliminando orden' });
      }
      return res.status(500).send(e?.message || 'Error eliminando orden');
    }
  },

  importExcel: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const sedeId = getRequestSedeId(req);
    if (!sedeId) {
      return res.status(403).json({ ok: false, error: 'El usuario no tiene una sede asignada.' });
    }
    const createdBy = getCurrentUserContext();
    const file = (req as Request & { file?: UploadedFile }).file;
    if (!file || !file.buffer) {
      return res.status(400).json({ ok: false, error: 'No se recibió archivo' });
    }
    if (!file.originalname.toLowerCase().endsWith('.xlsx')) {
      return res.status(400).json({ ok: false, error: 'Solo se permiten archivos .xlsx' });
    }

    try {
      const clientOffsetRaw = (req.body as any)?.clientTzOffset;
      const clientOffsetMinutes = toNumber(clientOffsetRaw);
      const clientLocalNowRaw = (req.body as any)?.clientLocalNow;
      const clientNowIso = typeof clientLocalNowRaw === 'string'
        ? parseLocalIso(clientLocalNowRaw.trim(), clientOffsetMinutes)
        : null;
      const defaultTimestampIso = clientNowIso ?? new Date().toISOString();

      const workbook = new ExcelJS.Workbook();
      const rawBuffer = file.buffer;
      const arrayBuffer = rawBuffer.buffer.slice(
        rawBuffer.byteOffset,
        rawBuffer.byteOffset + rawBuffer.byteLength,
      );
      await workbook.xlsx.load(arrayBuffer as ArrayBuffer);
      const sheet = workbook.getWorksheet('Órdenes') || workbook.worksheets[0];
      if (!sheet) {
        return res.status(400).json({ ok: false, error: 'La plantilla no contiene hojas' });
      }

      const headerRow = sheet.getRow(1);
      const headerMap = new Map<string, number>();
      headerRow.eachCell((_cell, colNumber) => {
        const text = cellText(headerRow, colNumber).toLowerCase();
        if (text) headerMap.set(text, colNumber);
      });
      const resolveColumn = (aliases: string[], fallback: number) => {
        for (const alias of aliases) {
          const idx = headerMap.get(alias.toLowerCase());
          if (typeof idx === 'number' && idx > 0) return idx;
        }
        return fallback;
      };
      const colNumero = resolveColumn(['numero_orden'], 1);
      const colCodigo = resolveColumn(['codigo_producto'], 2);
      const colCantidad = resolveColumn(['cantidad'], 3);
      const colCiudad = resolveColumn(['ciudad_destino'], 4);
      const colDireccion = resolveColumn(['direccion_destino', 'ubicacion_destino'], 5);
      const colCliente = resolveColumn(['cliente'], 6);

      const entries: ParsedOrder[] = [];
      const issues: ImportIssue[] = [];

      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // encabezado
        if (isRowEmpty(row)) return;

  const numero = cellText(row, colNumero);
        if (!numero) {
          issues.push({ row: rowNumber, message: 'numero_orden es obligatorio' });
          return;
        }
  const cantidadCell = row.getCell(colCantidad);
        const cantidadText = cantidadCell.text?.trim() ?? '';
        let cantidad: number | null = null;
        if (cantidadText !== '') {
          const parsedCantidad = parsePositiveInteger(cantidadCell.value);
          if (parsedCantidad === null) {
            issues.push({ row: rowNumber, message: 'cantidad inválida' });
            return;
          }
          cantidad = parsedCantidad;
        }

        entries.push({
          numero,
          codigo: cleanString(cellText(row, colCodigo)),
          cantidad,
          ciudad: cleanString(cellText(row, colCiudad)),
          ubicacion: cleanString(cellText(row, colDireccion)),
          cliente: cleanString(cellText(row, colCliente)),
          row: rowNumber,
        });
      });

      if (entries.length === 0) {
        return res.status(400).json({ ok: false, error: 'No se encontraron registros válidos en la plantilla', issues });
      }
      if (entries.length > 2000) {
        return res.status(400).json({ ok: false, error: 'La carga máxima es de 2000 órdenes por archivo' });
      }

      await ensureOrdenesArtifacts(tenant);

      const numeros = entries.map((x) => x.numero);
      const existingRows = numeros.length > 0
        ? await withTenant(tenant, (client) => client.query(
            'SELECT numero_orden, sede_origen_id FROM ordenes WHERE numero_orden = ANY($1::text[])',
            [numeros]
          ))
        : { rows: [] };

      const existing = new Set<string>();
      const blocked = new Set<string>();
      for (const row of (existingRows.rows as Array<{ numero_orden: string; sede_origen_id: number | null }>)) {
        const numero = String(row.numero_orden);
        const rowSede = row.sede_origen_id === null ? null : Number(row.sede_origen_id);
        if (rowSede !== null && rowSede !== sedeId) {
          blocked.add(numero);
        } else {
          existing.add(numero);
        }
      }

      if (blocked.size > 0) {
        entries.forEach((entry) => {
          if (blocked.has(entry.numero)) {
            issues.push({ row: entry.row, message: 'La orden pertenece a otra sede y no puede modificarse.' });
          }
        });
      }

      const allowedEntries = entries.filter((entry) => !blocked.has(entry.numero));
      if (allowedEntries.length === 0) {
        return res.status(400).json({ ok: false, error: 'No se encontraron registros válidos para tu sede.', issues });
      }

      let inserted = 0;
      let duplicates = 0;

      await withTenant(tenant, async (client) => {
        await client.query('BEGIN');
        try {
          for (const entry of allowedEntries) {
            const alreadyExisted = existing.has(entry.numero);
            await client.query(
              `INSERT INTO ordenes (numero_orden, codigo_producto, cantidad, ciudad_destino, ubicacion_destino, cliente, fecha_generacion, sede_origen_id, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                entry.numero,
                entry.codigo,
                entry.cantidad,
                entry.ciudad,
                entry.ubicacion,
                entry.cliente,
                defaultTimestampIso,
                sedeId,
                createdBy,
              ]
            );
            if (alreadyExisted) {
              duplicates += 1;
            }
            inserted += 1;
            existing.add(entry.numero);
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });

      return res.json({
        ok: true,
        summary: {
          processed: allowedEntries.length,
          inserted,
          duplicates,
          issues,
        },
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || 'Error procesando el archivo' });
    }
  },

  importProductosExcel: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;

    const file = (req as Request & { file?: UploadedFile }).file;
    if (!file || !file.buffer) {
      return res.status(400).json({ ok: false, error: 'No se recibió archivo' });
    }
    if (!file.originalname.toLowerCase().endsWith('.xlsx')) {
      return res.status(400).json({ ok: false, error: 'Solo se permiten archivos .xlsx' });
    }

    try {
      const workbook = new ExcelJS.Workbook();
      const rawBuffer = file.buffer;
      const arrayBuffer = rawBuffer.buffer.slice(
        rawBuffer.byteOffset,
        rawBuffer.byteOffset + rawBuffer.byteLength,
      );
      await workbook.xlsx.load(arrayBuffer as ArrayBuffer);

      const sheet = workbook.getWorksheet('Productos') || workbook.worksheets[0];
      if (!sheet) {
        return res.status(400).json({ ok: false, error: 'La plantilla no contiene hojas válidas' });
      }

      const entries: ProductoImportEntry[] = [];
      const issues: ProductoImportIssue[] = [];

      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        if (isRowEmptyGeneric(row, PRODUCT_TEMPLATE_COLUMNS.length)) return;

        const codigo = cleanString(cellText(row, 1));
        const nombreRaw = cleanString(cellText(row, 2));
        const descripcionRaw = cleanString(cellText(row, 3));

        const largo = parsePositiveDecimal(row.getCell(4).value);
        const ancho = parsePositiveDecimal(row.getCell(5).value);
        const alto = parsePositiveDecimal(row.getCell(6).value);

        const cantidadCell = row.getCell(7);
        const cantidadParsed = parsePositiveInteger(cantidadCell.value);
        const cantidad = cantidadParsed ?? 1;

        const errores: string[] = [];
        if (!largo) errores.push('largo_mm');
        if (!ancho) errores.push('ancho_mm');
        if (!alto) errores.push('alto_mm');
        if (cantidadParsed === null && cantidadCell.value !== null && cantidadCell.value !== undefined && cantidadCell.value !== '') {
          errores.push('cantidad_producto');
        }

        if (errores.length) {
          issues.push({ row: rowNumber, message: `Valores inválidos en ${errores.join(', ')}` });
          return;
        }

        const nombre = nombreRaw ? nombreRaw.slice(0, 160) : null;
        const descripcion = descripcionRaw ? descripcionRaw.slice(0, 220) : nombre;
        const codigoSanitized = codigo ? codigo.slice(0, 120) : null;

        const largoVal = Number(largo!.toFixed(2));
        const anchoVal = Number(ancho!.toFixed(2));
        const altoVal = Number(alto!.toFixed(2));
        if (largoVal > 100_000 || anchoVal > 100_000 || altoVal > 100_000) {
          issues.push({ row: rowNumber, message: 'Las dimensiones no pueden exceder 100.000 mm.' });
          return;
        }
        if (cantidad > 50_000) {
          issues.push({ row: rowNumber, message: 'La cantidad supera el máximo permitido (50.000).' });
          return;
        }
        const volumenUnit = volumenDesdeDimensiones(largoVal, anchoVal, altoVal);
        const volumenTotal = volumenUnit * cantidad;

        entries.push({
          row: rowNumber,
          codigo: codigoSanitized,
          nombre,
          descripcion,
          largo_mm: largoVal,
          ancho_mm: anchoVal,
          alto_mm: altoVal,
          cantidad,
          volumen_total_m3: Number(volumenTotal.toFixed(6)),
        });
      });

      if (entries.length === 0) {
        const baseError = issues.length
          ? 'No se encontraron filas válidas en la plantilla.'
          : 'Agrega al menos un producto en la plantilla.';
        return res.status(400).json({ ok: false, error: baseError, issues });
      }
      if (entries.length > 25) {
        return res.status(400).json({ ok: false, error: 'El máximo permitido es de 25 productos por importación.' });
      }

      return res.json({
        ok: true,
        items: entries,
        summary: {
          processed: entries.length,
          issues,
        },
      });
    } catch (error: any) {
      return res.status(500).json({ ok: false, error: error?.message || 'Error procesando el archivo' });
    }
  },

  calculadoraView: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).send('Tenant no especificado');
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const sedeId = getRequestSedeId(req);

    if (!sedeId) {
      return res.status(403).render('ordenes/calculadora', {
        title: 'Calculadora de órdenes',
        productos: [],
        modelos: [],
        sedeId: null,
        error: 'Tu usuario no tiene una sede asignada. Comunícate con el administrador para continuar.',
      });
    }

    try {
      const catalogo = await OrdenesCalculadoraService.obtenerCatalogo(tenant, sedeId);
      const inventarioMap = new Map<number, number>();
      catalogo.inventario.forEach((row: { modelo_id: number | null; disponibles: number | null }) => {
        if (row && typeof row.modelo_id === 'number') {
          const count = typeof row.disponibles === 'number' && Number.isFinite(row.disponibles)
            ? Math.max(0, Math.trunc(row.disponibles))
            : 0;
          inventarioMap.set(row.modelo_id, count);
        }
      });

      const productos = catalogo.productos.map((p: {
        inv_id: number | null;
        nombre_producto: string | null;
        descripcion_producto: string | null;
        codigo_producto: string | null;
        largo_mm: number | null;
        ancho_mm: number | null;
        alto_mm: number | null;
        cantidad_producto: number | null;
        volumen_total_m3_producto: number | null;
      }) => ({
        id: Number(p.inv_id),
        nombre: p.nombre_producto,
        descripcion: p.descripcion_producto,
        codigo: p.codigo_producto,
        largo_mm: p.largo_mm !== null && p.largo_mm !== undefined ? Number(p.largo_mm) : null,
        ancho_mm: p.ancho_mm !== null && p.ancho_mm !== undefined ? Number(p.ancho_mm) : null,
        alto_mm: p.alto_mm !== null && p.alto_mm !== undefined ? Number(p.alto_mm) : null,
        cantidad: p.cantidad_producto !== null && p.cantidad_producto !== undefined ? Number(p.cantidad_producto) : 1,
        volumen_total_m3: p.volumen_total_m3_producto !== null && p.volumen_total_m3_producto !== undefined ? Number(p.volumen_total_m3_producto) : null,
      }));

      const modelos = catalogo.modelos.map((m: {
        modelo_id: number | null;
        nombre_modelo: string;
        dim_int_frente: number | null;
        dim_int_profundo: number | null;
        dim_int_alto: number | null;
        volumen_litros: number | null;
      }) => ({
        id: Number(m.modelo_id),
        nombre: m.nombre_modelo,
        dim_int_frente: m.dim_int_frente !== null && m.dim_int_frente !== undefined ? Number(m.dim_int_frente) : null,
        dim_int_profundo: m.dim_int_profundo !== null && m.dim_int_profundo !== undefined ? Number(m.dim_int_profundo) : null,
        dim_int_alto: m.dim_int_alto !== null && m.dim_int_alto !== undefined ? Number(m.dim_int_alto) : null,
        volumen_litros: m.volumen_litros !== null && m.volumen_litros !== undefined ? Number(m.volumen_litros) : null,
        disponibles: inventarioMap.get(Number(m.modelo_id)) || 0,
      }));

      return res.render('ordenes/calculadora', {
        title: 'Calculadora de órdenes',
        productos,
        modelos,
        sedeId,
        error: null,
      });
    } catch (error: any) {
      console.error('[Ordenes][calculadoraView] error', error);
      return res.status(500).render('ordenes/calculadora', {
        title: 'Calculadora de órdenes',
        productos: [],
        modelos: [],
        sedeId,
        error: error?.message || 'No fue posible cargar la información inicial.',
      });
    }
  },

  calculadoraEliminarCatalogo: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const rawId = typeof req.params?.id === 'string' ? req.params.id : (req.body as any)?.id;
    const invId = Number(rawId);
    if (!Number.isFinite(invId) || invId <= 0) {
      return res.status(400).json({ ok: false, error: 'Identificador de catálogo inválido.' });
    }

    try {
      const deleted = await withTenant(tenant, (client) =>
        client.query<{ inv_id: number }>(
          'DELETE FROM productos_calculo WHERE inv_id = $1 RETURNING inv_id',
          [invId],
        ),
      );
      if (!deleted.rowCount) {
        return res.status(404).json({ ok: false, error: 'La referencia ya no existe.' });
      }
      return res.json({ ok: true, id: invId });
    } catch (error: any) {
      console.error('[Ordenes][calculadoraEliminarCatalogo]', error);
      return res.status(500).json({ ok: false, error: 'No fue posible eliminar la referencia.' });
    }
  },

  calculadoraRecomendar: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const sedeId = getRequestSedeId(req);
    if (!sedeId) {
      return res.status(403).json({ ok: false, error: 'El usuario no tiene una sede asignada.' });
    }

    try {
      const items = parseCalculatorItems((req.body as any)?.items);
      const result = await OrdenesCalculadoraService.calcular(tenant, sedeId, items);
      return res.json({
        ok: true,
        items: result.items,
        recomendaciones: result.recomendaciones,
        resumen: {
          total_unidades: result.total_unidades,
          volumen_total_m3: result.volumen_total_m3,
        },
      });
    } catch (error: any) {
      const message = error?.message || 'No fue posible generar recomendaciones.';
      const status = message.includes('producto') || message.includes('agrega') ? 400 : 500;
      return res.status(status).json({ ok: false, error: message });
    }
  },

  calculadoraRecomendarMixto: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const sedeId = getRequestSedeId(req);
    if (!sedeId) {
      return res.status(403).json({ ok: false, error: 'El usuario no tiene una sede asignada.' });
    }

    try {
      const items = parseCalculatorItems((req.body as any)?.items);
      const result = await OrdenesCalculadoraService.calcularMixto(tenant, sedeId, items);
      return res.json({
        ok: true,
        items: result.items,
        mix: result.mix,
        resumen: {
          total_unidades: result.total_unidades,
          volumen_total_m3: result.volumen_total_m3,
        },
      });
    } catch (error: any) {
      const message = error?.message || 'No fue posible generar la recomendación mixta.';
      const status = message.includes('producto') || message.includes('agrega') ? 400 : 500;
      return res.status(status).json({ ok: false, error: message });
    }
  },

  calculadoraCrearOrden: async (req: Request, res: Response) => {
    const t = (req as any).user?.tenant || resolveTenant(req);
    if (!t) return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
    const tenant = String(t).startsWith('tenant_') ? String(t) : `tenant_${t}`;
    const sedeId = getRequestSedeId(req);
    if (!sedeId) {
      return res.status(403).json({ ok: false, error: 'El usuario no tiene una sede asignada.' });
    }
    const createdBy = getCurrentUserContext();

    try {
      const body = req.body as any;
      const items = parseCalculatorItems(body?.items);
      const mezclaRaw = body?.mezcla;
      const isMixRequest = mezclaRaw && typeof mezclaRaw === 'object';
      const modeloIdRaw = body?.modeloId ?? body?.modelo_id;
      const parsedModeloId = Number(modeloIdRaw);
      if (!isMixRequest && (!Number.isFinite(parsedModeloId) || parsedModeloId <= 0)) {
        return res.status(400).json({ ok: false, error: 'Selecciona un modelo válido.' });
      }
      const modeloId = Number.isFinite(parsedModeloId) && parsedModeloId > 0 ? parsedModeloId : null;

      const numeroOrdenRaw = typeof body?.numeroOrden === 'string'
        ? body.numeroOrden.trim()
        : typeof body?.numero_orden === 'string'
          ? body.numero_orden.trim()
          : '';
      if (!numeroOrdenRaw) {
        return res.status(400).json({ ok: false, error: 'El número de orden es obligatorio.' });
      }
      if (numeroOrdenRaw.length > 80) {
        return res.status(400).json({ ok: false, error: 'El número de orden no puede superar 80 caracteres.' });
      }

      const clienteRaw = typeof body?.cliente === 'string' ? body.cliente : typeof body?.cliente_nombre === 'string' ? body.cliente_nombre : null;
      const cliente = clienteRaw ? clienteRaw.trim().slice(0, 160) : null;
      const ciudadRaw = typeof body?.ciudadDestino === 'string' ? body.ciudadDestino : typeof body?.ciudad_destino === 'string' ? body.ciudad_destino : null;
      const ciudad = ciudadRaw ? ciudadRaw.trim().slice(0, 120) : null;
      const ubicacionRaw = typeof body?.ubicacionDestino === 'string' ? body.ubicacionDestino : typeof body?.ubicacion_destino === 'string' ? body.ubicacion_destino : null;
      const ubicacion = ubicacionRaw ? ubicacionRaw.trim().slice(0, 180) : null;
      const calculadoEnIso = new Date().toISOString();
      let totalUnidades = 0;
      let volumenTotalM3 = 0;
      let cantidadModelos = 0;
      let codigoProducto: string | null = null;
      let productosPayload: any = null;
      let modeloSugeridoId: number | null = null;

      if (isMixRequest) {
        const mixResult = await OrdenesCalculadoraService.calcularMixto(tenant, sedeId, items);
        await ensureProductosCalculo(tenant, mixResult.items);
        const mix = mixResult.mix;
        const modelosAsignados = Array.isArray(mix?.modelos)
          ? mix.modelos.filter((modelo: any) => modelo && Number(modelo.cajas_asignadas) > 0)
          : [];
        if (!modelosAsignados.length) {
          return res.status(409).json({ ok: false, error: 'La recomendación mixta ya no está disponible.' });
        }
        const shortage = modelosAsignados.find((modelo: any) => Number(modelo.cajas_asignadas) > Number(modelo.cajas_disponibles || 0));
        if (shortage) {
          return res.status(409).json({ ok: false, error: `Stock insuficiente para ${shortage.modelo_nombre}.` });
        }

        totalUnidades = mixResult.total_unidades;
        volumenTotalM3 = mixResult.volumen_total_m3;
        const totalCajas = Number(mix?.total_cajas || 0);
        const sumCajas = modelosAsignados.reduce((acc: number, modelo: any) => acc + Number(modelo.cajas_asignadas || 0), 0);
        cantidadModelos = totalCajas > 0 ? totalCajas : sumCajas;
        if (cantidadModelos <= 0) {
          return res.status(409).json({ ok: false, error: 'La combinación mixta ya no tiene cajas asignadas.' });
        }

        const etiquetaModelos = modelosAsignados
          .map((modelo: any) => {
            const cajas = Number(modelo.cajas_asignadas || 0);
            if (!cajas) return '';
            return `${cajas} x ${modelo.modelo_nombre}`.trim();
          })
          .filter((texto: string) => texto.length > 0);
        if (etiquetaModelos.length) {
          const base = etiquetaModelos.slice(0, 3).join(', ');
          codigoProducto = etiquetaModelos.length > 3 ? `${base}, ...` : base;
        } else {
          codigoProducto = 'Mezcla CredoCube';
        }

        productosPayload = {
          items: mixResult.items,
          mezcla: mix,
          calculado_en: calculadoEnIso,
          modo: 'mix',
        };
        modeloSugeridoId = null;
      } else {
        const result = await OrdenesCalculadoraService.calcular(tenant, sedeId, items);
        await ensureProductosCalculo(tenant, result.items);
        const recomendacion = result.recomendaciones.find((r: CalculadoraRecomendacion) => r.modelo_id === modeloId);
        if (!recomendacion) {
          return res.status(409).json({ ok: false, error: 'La recomendación seleccionada ya no está disponible.' });
        }
        if (recomendacion.cajas_requeridas > recomendacion.cajas_disponibles) {
          return res.status(409).json({ ok: false, error: 'Stock insuficiente para la sede actual.' });
        }

        totalUnidades = result.total_unidades;
        volumenTotalM3 = result.volumen_total_m3;
        cantidadModelos = recomendacion.cajas_requeridas;
        modeloSugeridoId = recomendacion.modelo_id;

        const uniqueCodes = Array.from(new Set(
          result.items
            .map((item) => (item.codigo ? item.codigo.trim() : ''))
            .filter((codigo) => codigo.length),
        ));
        if (uniqueCodes.length === 0) {
          codigoProducto = recomendacion.modelo_nombre ? recomendacion.modelo_nombre.trim() : null;
        } else {
          const joined = uniqueCodes.slice(0, 3).join(', ');
          codigoProducto = uniqueCodes.length > 3 ? `${joined}, ...` : joined;
        }

        productosPayload = {
          items: result.items,
          recomendacion,
          calculado_en: calculadoEnIso,
          modo: 'standard',
        };
      }

      const clientOffsetRaw = body?.clientTzOffset;
      const clientOffsetMinutes = toNumber(clientOffsetRaw);
      const clientLocalNowRaw = typeof body?.clientLocalNow === 'string' ? body.clientLocalNow.trim() : null;
      const clientNowIso = clientLocalNowRaw ? parseLocalIso(clientLocalNowRaw, clientOffsetMinutes) : null;
      const fechaGeneracion = clientNowIso ?? new Date().toISOString();

      try {
        const insert = await withTenant(tenant, (client) => client.query(
          `INSERT INTO ordenes (
             numero_orden,
             codigo_producto,
             cantidad,
             ciudad_destino,
             ubicacion_destino,
             cliente,
             fecha_generacion,
             modelo_sugerido_id,
             cantidad_modelos,
             productos,
             volumen_total_m3,
             sede_origen_id,
             created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING id`,
          [
            numeroOrdenRaw,
            codigoProducto,
              totalUnidades,
            ciudad,
            ubicacion,
            cliente,
            fechaGeneracion,
              modeloSugeridoId,
              cantidadModelos,
              JSON.stringify(productosPayload),
              volumenTotalM3,
            sedeId,
            createdBy,
          ],
        ));

        return res.json({ ok: true, orderId: insert.rows[0]?.id ?? null, numeroOrden: numeroOrdenRaw });
      } catch (errorInsert: any) {
        if (errorInsert?.code === '23505') {
          return res.status(409).json({ ok: false, error: 'El número de orden ya existe.' });
        }
        throw errorInsert;
      }
    } catch (error: any) {
      const message = error?.message || 'No fue posible crear la orden recomendada.';
      const status = message.includes('producto') || message.includes('orden') ? 400 : 500;
      return res.status(status).json({ ok: false, error: message });
    }
  },
};

