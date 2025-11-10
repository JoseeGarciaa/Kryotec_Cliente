import { Request, Response } from 'express';
import ExcelJS from 'exceljs';
import { resolveTenant } from '../middleware/tenant';
import { withTenant } from '../db/pool';
import { runReport, ReportContext, ReportFilters, ReportKey, ColumnDef } from '../services/reportesService';

const REPORT_KEYS: ReportKey[] = [
  'inventario-sede',
  'trazabilidad',
  'actividad-operario',
  'actividad-sede',
  'ordenes-estado',
  'ordenes-culminadas',
  'auditorias',
  'registro-inventario',
  'usuarios-sede',
];

const EXPORT_MAX_ROWS = 100_000;

type ComboData = {
  sedes: Array<{ sede_id: number; nombre: string }>;
  zonas: Array<{ zona_id: number; nombre: string; sede_id: number }>;
  secciones: Array<{ seccion_id: number; nombre: string; zona_id: number }>;
  usuarios: Array<{ id: number; nombre: string; rol: string | null }>;
};

function parseNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseFilters(req: Request): ReportFilters {
  const { query } = req;
  const from = parseDate(query.from);
  const to = parseDate(query.to);
  const sedeId = parseNumber(query.sedeId ?? query.sede_id);
  const zonaId = parseNumber(query.zonaId ?? query.zona_id);
  const seccionId = parseNumber(query.seccionId ?? query.seccion_id);
  const operarioId = parseNumber(query.operarioId ?? query.operario_id);
  const orderId = parseNumber(query.orderId ?? query.order_id);
  const credocube = typeof query.credocube === 'string'
    ? query.credocube
    : typeof query.credok === 'string'
      ? query.credok
      : null;
  return {
    from,
    to,
    sedeId,
    zonaId,
    seccionId,
    operarioId,
    orderId,
    credocube: credocube ? credocube.trim() : null,
  };
}

function parsePagination(req: Request) {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const limitRaw = parseInt(String(req.query.limit ?? req.query.pageSize ?? 50), 10);
  const pageSize = Math.min(500, Math.max(10, Number.isFinite(limitRaw) ? limitRaw : 50));
  return { page, pageSize };
}

function ensureReportKey(value: string): ReportKey {
  if (!REPORT_KEYS.includes(value as ReportKey)) {
    throw new Error('Reporte inválido');
  }
  return value as ReportKey;
}

async function loadComboData(tenant: string): Promise<ComboData> {
  return withTenant(tenant, async (client) => {
    const [sedesQ, zonasQ, seccionesQ, usuariosQ] = await Promise.all([
      client.query('SELECT sede_id, nombre FROM sedes ORDER BY nombre ASC'),
      client.query('SELECT zona_id, nombre, sede_id FROM zonas ORDER BY nombre ASC'),
      client.query('SELECT seccion_id, nombre, zona_id FROM secciones ORDER BY nombre ASC'),
      client.query('SELECT id, nombre, rol FROM usuarios ORDER BY nombre ASC'),
    ]);
    return {
      sedes: sedesQ.rows.map((r) => ({ sede_id: Number(r.sede_id), nombre: r.nombre as string })),
      zonas: zonasQ.rows.map((r) => ({ zona_id: Number(r.zona_id), nombre: r.nombre as string, sede_id: Number(r.sede_id) })),
      secciones: seccionesQ.rows.map((r) => ({ seccion_id: Number(r.seccion_id), nombre: r.nombre as string, zona_id: Number(r.zona_id) })),
      usuarios: usuariosQ.rows.map((r) => ({ id: Number(r.id), nombre: r.nombre as string, rol: r.rol ?? null })),
    };
  });
}

function formatDateInput(value: Date | null | undefined): string {
  if (!value) return '';
  try {
    return value.toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.join('; ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function prepareExcelValue(value: unknown, format?: ColumnDef['format']): unknown {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.join(', ');

  if (format === 'datetime') {
    if (value instanceof Date) return value;
    if (typeof value === 'string') {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }

  if (format === 'number' || format === 'percent' || format === 'duration') {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const numeric = Number(value.replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(numeric)) return numeric;
    }
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return value;
}

export const ReportesController = {
  async view(req: Request, res: Response) {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const tRaw = u?.tenant || resolveTenant(req);
    const tenant = tRaw ? (String(tRaw).startsWith('tenant_') ? String(tRaw) : `tenant_${tRaw}`) : null;
    if (!tenant) {
      return res.status(400).send('Tenant no especificado');
    }

    try {
      const combos = await loadComboData(tenant);
      const filters = parseFilters(req);
      const initial = {
        from: formatDateInput(filters.from ?? null),
        to: formatDateInput(filters.to ?? null),
        sedeId: filters.sedeId,
        zonaId: filters.zonaId,
        seccionId: filters.seccionId,
        operarioId: filters.operarioId,
        orderId: filters.orderId,
        credocube: filters.credocube ?? '',
      };

      return res.render('reportes/index', {
        title: 'Reportes Operativos',
        combos,
        initial,
      });
    } catch (error) {
      console.error('[Reportes][view] error', error);
      return res.status(500).render('reportes/index', {
        title: 'Reportes Operativos',
        combos: { sedes: [], zonas: [], secciones: [], usuarios: [] },
        initial: {},
        error: 'No fue posible cargar los catálogos para los filtros.',
      });
    }
  },

  async data(req: Request, res: Response) {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const tRaw = u?.tenant || resolveTenant(req);
    const tenant = tRaw ? (String(tRaw).startsWith('tenant_') ? String(tRaw) : `tenant_${tRaw}`) : null;
    if (!tenant) {
      return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
    }

    try {
      const key = ensureReportKey(String(req.params.key));
      const filters = parseFilters(req);
      const pagination = parsePagination(req);
      const context: ReportContext = { tenant, filters, pagination };
      const dataset = await runReport(key, context);
      return res.json({ ok: true, report: key, ...dataset });
    } catch (error: any) {
      console.error('[Reportes][data] error', error);
      return res.status(500).json({ ok: false, error: error?.message || 'Error generando reporte' });
    }
  },

  async export(req: Request, res: Response) {
    const u: any = (res.locals as any).user || (req as any).user || {};
    const tRaw = u?.tenant || resolveTenant(req);
    const tenant = tRaw ? (String(tRaw).startsWith('tenant_') ? String(tRaw) : `tenant_${tRaw}`) : null;
    if (!tenant) {
      return res.status(400).json({ ok: false, error: 'Tenant no especificado' });
    }

    const format = String(req.params.format || 'csv').toLowerCase();
    if (!['csv', 'xlsx'].includes(format)) {
      return res.status(400).json({ ok: false, error: 'Formato no soportado' });
    }

    try {
      const key = ensureReportKey(String(req.params.key));
      const filters = parseFilters(req);
      let dataset = await runReport(key, { tenant, filters, pagination: { page: 1, pageSize: EXPORT_MAX_ROWS } });
      if (dataset.meta.total > dataset.rows.length && dataset.meta.total <= EXPORT_MAX_ROWS * 5) {
        dataset = await runReport(key, { tenant, filters, pagination: { page: 1, pageSize: Math.min(dataset.meta.total, EXPORT_MAX_ROWS * 5) } });
      }

      const filename = `${key}-${new Date().toISOString().slice(0, 10)}.${format}`;
      if (format === 'csv') {
        const header = dataset.columns.map((c) => c.label);
        const csvLines = [header.join(',')];
        for (const row of dataset.rows) {
          const line = dataset.columns.map((col) => {
            const raw = (row as any)[col.key];
            const value = normalizeValue(raw);
            if (value.includes(',') || value.includes('"') || value.includes('\n')) {
              return '"' + value.replace(/"/g, '""') + '"';
            }
            return value;
          });
          csvLines.push(line.join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(csvLines.join('\n'));
      }

      const workbook = new ExcelJS.Workbook();
      workbook.created = new Date();
      workbook.modified = new Date();

      const sheet = workbook.addWorksheet('Reporte', {
        properties: { defaultRowHeight: 18 },
        views: [{ state: 'frozen', ySplit: 1 }],
      });

      sheet.columns = dataset.columns.map((col) => ({
        header: col.label,
        key: col.key,
        width: Math.max(16, Math.min(48, col.label.length + 6)),
      }));

      dataset.rows.forEach((row) => {
        const rowData: Record<string, unknown> = {};
        for (const col of dataset.columns) {
          rowData[col.key] = prepareExcelValue((row as any)[col.key], col.format);
        }
        sheet.addRow(rowData);
      });

      const headerRow = sheet.getRow(1);
      headerRow.height = 22;
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FF4B5563' } },
          bottom: { style: 'thin', color: { argb: 'FF4B5563' } },
          left: { style: 'thin', color: { argb: 'FF4B5563' } },
          right: { style: 'thin', color: { argb: 'FF4B5563' } },
        };
      });

      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        row.eachCell((cell) => {
          cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
          cell.border = {
            top: { style: 'hair', color: { argb: 'FFE5E7EB' } },
            bottom: { style: 'hair', color: { argb: 'FFD1D5DB' } },
            left: { style: 'hair', color: { argb: 'FFE5E7EB' } },
            right: { style: 'hair', color: { argb: 'FFE5E7EB' } },
          };
        });
        if (rowNumber % 2 === 0) {
          row.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
          });
        }
      });

      dataset.columns.forEach((col, idx) => {
        const column = sheet.getColumn(idx + 1);
        let maxLength = col.label.length;
        column.eachCell({ includeEmpty: true }, (cell) => {
          const value = cell.value;
          const text = value === null || value === undefined ? '' : String(value);
          maxLength = Math.max(maxLength, text.length);
        });
        column.width = Math.max(12, Math.min(60, maxLength + 4));

        if (col.format === 'number') {
          column.numFmt = '#,##0.00';
          column.eachCell({ includeEmpty: true }, (cell) => {
            cell.alignment = { ...(cell.alignment || {}), horizontal: 'right' };
          });
        }
        if (col.format === 'percent') {
          column.numFmt = '0.00%';
          column.eachCell({ includeEmpty: true }, (cell) => {
            cell.alignment = { ...(cell.alignment || {}), horizontal: 'right' };
          });
        }
        if (col.format === 'duration') {
          column.eachCell({ includeEmpty: true }, (cell) => {
            cell.alignment = { ...(cell.alignment || {}), horizontal: 'right' };
          });
        }
        if (col.format === 'datetime') {
          column.numFmt = 'dd/mm/yyyy hh:mm';
        }
      });

      sheet.getColumn(1).eachCell({ includeEmpty: true }, (cell) => {
        cell.alignment = { ...(cell.alignment || {}), horizontal: 'left' };
      });
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(Buffer.from(buffer));
    } catch (error: any) {
      console.error('[Reportes][export] error', error);
      return res.status(500).json({ ok: false, error: error?.message || 'Error exportando reporte' });
    }
  },
};
