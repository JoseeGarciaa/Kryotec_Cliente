import { withTenant } from '../db/pool';

export type CalculadoraProductoInput = {
  codigo: string | null;
  nombre: string | null;
  largo_mm: number;
  ancho_mm: number;
  alto_mm: number;
  cantidad: number;
};

export type CalculadoraProductoNormalizado = CalculadoraProductoInput & {
  volumen_unit_m3: number;
  volumen_total_m3: number;
};

export type CalculadoraDetalleProducto = {
  codigo: string | null;
  nombre: string | null;
  cantidad: number;
  cajas_requeridas: number;
  capacidad_por_caja: number;
  sobrante_unidades: number;
  orientacion_mm: { largo: number; ancho: number; alto: number };
  layout: { frente: number; profundo: number; alto: number };
};

export type CalculadoraRecomendacion = {
  modelo_id: number;
  modelo_nombre: string;
  cajas_requeridas: number;
  cajas_disponibles: number;
  volumen_caja_m3: number;
  volumen_total_productos_m3: number;
  ocupacion_percent: number | null;
  detalles: CalculadoraDetalleProducto[];
  volumen_total_cajas_m3: number;
  volumen_restante_m3: number;
  deficit_cajas: number;
};

type CatalogoProducto = {
  inv_id: number;
  nombre_producto: string | null;
  descripcion_producto: string | null;
  codigo_producto: string | null;
  largo_mm: number | null;
  ancho_mm: number | null;
  alto_mm: number | null;
  cantidad_producto: number | null;
  volumen_total_m3_producto: number | null;
};

type CatalogoModelo = {
  modelo_id: number;
  nombre_modelo: string;
  dim_int_frente: number | null;
  dim_int_profundo: number | null;
  dim_int_alto: number | null;
  volumen_litros: number | null;
};

type InventarioDisponible = {
  modelo_id: number;
  disponibles: number;
};

type CatalogoCalculadora = {
  productos: CatalogoProducto[];
  modelos: CatalogoModelo[];
  inventario: InventarioDisponible[];
};

type RecomendacionResult = {
  items: CalculadoraProductoNormalizado[];
  recomendaciones: CalculadoraRecomendacion[];
  total_unidades: number;
  volumen_total_m3: number;
};

function volumenDesdeMm(largo: number, ancho: number, alto: number): number {
  return (largo * ancho * alto) / 1_000_000_000;
}

function generarOrientaciones(dimensiones: [number, number, number]): [number, number, number][] {
  const [a, b, c] = dimensiones;
  return [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ];
}

type OrientacionResultado = {
  capacidad: number;
  orientacion: [number, number, number];
  layout: [number, number, number];
};

function mejorOrientacion(
  modeloDims: [number, number, number],
  productoDims: [number, number, number],
): OrientacionResultado | null {
  let mejor: OrientacionResultado | null = null;
  for (const orientacion of generarOrientaciones(productoDims)) {
    const [l, p, a] = orientacion;
    if (l <= 0 || p <= 0 || a <= 0) continue;
    const capacidadFrente = Math.floor(modeloDims[0] / l);
    const capacidadProfundo = Math.floor(modeloDims[1] / p);
    const capacidadAlto = Math.floor(modeloDims[2] / a);
    if (capacidadFrente <= 0 || capacidadProfundo <= 0 || capacidadAlto <= 0) continue;
    const capacidad = capacidadFrente * capacidadProfundo * capacidadAlto;
    if (!mejor || capacidad > mejor.capacidad) {
      mejor = {
        capacidad,
        orientacion,
        layout: [capacidadFrente, capacidadProfundo, capacidadAlto],
      };
    }
  }
  return mejor;
}

async function fetchCatalogo(tenant: string, sedeId: number): Promise<CatalogoCalculadora> {
  const [productosQ, modelosQ, inventarioQ] = await Promise.all([
    withTenant(tenant, (client) => client.query<CatalogoProducto>(
      `SELECT inv_id, nombre_producto, descripcion_producto, codigo_producto,
              largo_mm, ancho_mm, alto_mm, cantidad_producto, volumen_total_m3_producto
         FROM productos_calculo
        ORDER BY nombre_producto NULLS LAST, codigo_producto NULLS LAST, inv_id ASC`,
    )),
    withTenant(tenant, (client) => client.query<CatalogoModelo>(
      `SELECT modelo_id, nombre_modelo, dim_int_frente, dim_int_profundo, dim_int_alto, volumen_litros
         FROM modelos
        WHERE dim_int_frente IS NOT NULL
          AND dim_int_profundo IS NOT NULL
          AND dim_int_alto IS NOT NULL
          AND LOWER(TRIM(tipo)) LIKE 'cube%'
        ORDER BY nombre_modelo ASC`,
    )),
    withTenant(tenant, (client) => client.query<InventarioDisponible>(
      `SELECT modelo_id, COUNT(*)::int AS disponibles
         FROM inventario_credocubes
        WHERE sede_id = $1
          AND (activo IS DISTINCT FROM false)
          AND (numero_orden IS NULL OR numero_orden = '')
          AND LOWER(COALESCE(TRIM(estado), '')) = 'en bodega'
          AND COALESCE(TRIM(sub_estado), '') = ''
          AND LOWER(REPLACE(nombre_unidad, ' ', '')) LIKE 'credocube%'
        GROUP BY modelo_id`,
      [sedeId],
    )),
  ]);

  return {
    productos: productosQ.rows,
    modelos: modelosQ.rows,
    inventario: inventarioQ.rows,
  };
}

function normalizarItems(entries: CalculadoraProductoInput[]): CalculadoraProductoNormalizado[] {
  return entries.map((item) => {
    const volumenUnit = volumenDesdeMm(item.largo_mm, item.ancho_mm, item.alto_mm);
    const totalVol = volumenUnit * item.cantidad;
    return {
      ...item,
      volumen_unit_m3: Number(volumenUnit.toFixed(6)),
      volumen_total_m3: Number(totalVol.toFixed(6)),
    };
  });
}

function construirMapaInventario(rows: InventarioDisponible[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of rows) {
    if (!row || typeof row.modelo_id !== 'number') continue;
    const count = typeof row.disponibles === 'number' && Number.isFinite(row.disponibles)
      ? Math.max(0, Math.trunc(row.disponibles))
      : 0;
    map.set(row.modelo_id, count);
  }
  return map;
}

function calcularRecomendaciones(
  modelos: CatalogoModelo[],
  inventario: Map<number, number>,
  items: CalculadoraProductoNormalizado[],
): CalculadoraRecomendacion[] {
  const recomendaciones: CalculadoraRecomendacion[] = [];

  for (const modelo of modelos) {
    if (!modelo || typeof modelo.modelo_id !== 'number') continue;
  const stockDisponible = inventario.get(modelo.modelo_id) ?? 0;
  if (stockDisponible <= 0) continue;

    const dimFrente = Number(modelo.dim_int_frente ?? 0);
    const dimProfundo = Number(modelo.dim_int_profundo ?? 0);
    const dimAlto = Number(modelo.dim_int_alto ?? 0);
    if (dimFrente <= 0 || dimProfundo <= 0 || dimAlto <= 0) continue;

    const modeloDims: [number, number, number] = [dimFrente, dimProfundo, dimAlto];

    const perItemData: Array<{
      input: CalculadoraProductoNormalizado;
      orientacion: OrientacionResultado;
      capacidad: number;
      layout: [number, number, number];
    }> = [];

    let volumenTotal = 0;
    let modeloValido = true;

    for (const item of items) {
      volumenTotal += item.volumen_total_m3;
      const orientacion = mejorOrientacion(modeloDims, [item.largo_mm, item.ancho_mm, item.alto_mm]);
      if (!orientacion || orientacion.capacidad <= 0) {
        modeloValido = false;
        break;
      }
      perItemData.push({
        input: item,
        orientacion,
        capacidad: orientacion.capacidad,
        layout: orientacion.layout,
      });
    }

    if (!modeloValido || !perItemData.length) continue;

    const cajasPorItem = perItemData.map((entry) => Math.ceil(entry.input.cantidad / entry.capacidad));
    const cajasPorItemMax = cajasPorItem.reduce((max, value) => Math.max(max, value), 0);

    const volumenCajaM3 = volumenDesdeMm(dimFrente, dimProfundo, dimAlto);
    const cajasPorVolumen = volumenCajaM3 > 0
      ? Math.max(1, Math.ceil(volumenTotal / volumenCajaM3))
      : Math.max(1, cajasPorItemMax);

  const cajasTotales = Math.max(cajasPorItemMax, cajasPorVolumen);
  if (cajasTotales <= 0) continue;

    const volumenTotalCajas = volumenCajaM3 * cajasTotales;
    const ocupacion = volumenTotalCajas > 0 ? Math.min(1, volumenTotal / volumenTotalCajas) : null;
    const volumenRestante = Math.max(0, volumenTotalCajas - volumenTotal);

    const detalles: CalculadoraDetalleProducto[] = perItemData.map((entry, index) => {
      const cajasRequeridas = cajasPorItem[index];
      const sobrante = Math.max(0, cajasRequeridas * entry.capacidad - entry.input.cantidad);
      return {
        codigo: entry.input.codigo,
        nombre: entry.input.nombre,
        cantidad: entry.input.cantidad,
        cajas_requeridas: cajasRequeridas,
        capacidad_por_caja: entry.capacidad,
        sobrante_unidades: sobrante,
        orientacion_mm: {
          largo: entry.orientacion.orientacion[0],
          ancho: entry.orientacion.orientacion[1],
          alto: entry.orientacion.orientacion[2],
        },
        layout: {
          frente: entry.layout[0],
          profundo: entry.layout[1],
          alto: entry.layout[2],
        },
      };
    });

    let totalCajasDetalle = detalles.reduce((acc, det) => acc + det.cajas_requeridas, 0);
    let exceso = totalCajasDetalle - cajasTotales;
    if (exceso > 0) {
      const reducibles = detalles
        .map((det, index) => ({ det, index, capacidad: perItemData[index].capacidad }))
        .sort((a, b) => a.capacidad - b.capacidad);
      for (const item of reducibles) {
        if (exceso <= 0) break;
        const reducible = Math.min(exceso, item.det.cajas_requeridas);
        if (reducible <= 0) continue;
        item.det.cajas_requeridas -= reducible;
        exceso -= reducible;
      }
      totalCajasDetalle = detalles.reduce((acc, det) => acc + det.cajas_requeridas, 0);
    }

    detalles.forEach((det, index) => {
      const cantidad = perItemData[index].input.cantidad;
      det.sobrante_unidades = Math.max(0, det.cajas_requeridas * det.capacidad_por_caja - cantidad);
    });

  const deficit = cajasTotales > stockDisponible ? cajasTotales - stockDisponible : 0;

    recomendaciones.push({
      modelo_id: modelo.modelo_id,
      modelo_nombre: modelo.nombre_modelo,
      cajas_requeridas: cajasTotales,
      cajas_disponibles: stockDisponible,
      volumen_caja_m3: Number(volumenCajaM3.toFixed(6)),
      volumen_total_productos_m3: Number(volumenTotal.toFixed(6)),
      ocupacion_percent: ocupacion !== null ? Number((ocupacion * 100).toFixed(2)) : null,
      detalles,
      volumen_total_cajas_m3: Number(volumenTotalCajas.toFixed(6)),
      volumen_restante_m3: Number(volumenRestante.toFixed(6)),
      deficit_cajas: deficit,
    });
  }

  recomendaciones.sort((a, b) => {
    if (a.volumen_total_cajas_m3 !== b.volumen_total_cajas_m3) {
      return a.volumen_total_cajas_m3 - b.volumen_total_cajas_m3;
    }
    if (a.volumen_restante_m3 !== b.volumen_restante_m3) {
      return a.volumen_restante_m3 - b.volumen_restante_m3;
    }
    if (a.cajas_requeridas !== b.cajas_requeridas) {
      return a.cajas_requeridas - b.cajas_requeridas;
    }
    const aOcc = a.ocupacion_percent ?? 0;
    const bOcc = b.ocupacion_percent ?? 0;
    if (aOcc !== bOcc) {
      return bOcc - aOcc;
    }
    return a.modelo_nombre.localeCompare(b.modelo_nombre);
  });

  return recomendaciones;
}

export const OrdenesCalculadoraService = {
  async obtenerCatalogo(tenant: string, sedeId: number): Promise<CatalogoCalculadora> {
    return fetchCatalogo(tenant, sedeId);
  },

  async calcular(
    tenant: string,
    sedeId: number,
    itemsEntrada: CalculadoraProductoInput[],
  ): Promise<RecomendacionResult> {
    const items = normalizarItems(itemsEntrada);
    if (!items.length) {
      return { items: [], recomendaciones: [], total_unidades: 0, volumen_total_m3: 0 };
    }

    const catalogo = await fetchCatalogo(tenant, sedeId);
    const inventario = construirMapaInventario(catalogo.inventario);
    const recomendaciones = calcularRecomendaciones(catalogo.modelos, inventario, items);

    const totalUnidades = items.reduce((acc, item) => acc + item.cantidad, 0);
    const volumenTotal = items.reduce((acc, item) => acc + item.volumen_total_m3, 0);

    return {
      items,
      recomendaciones,
      total_unidades: totalUnidades,
      volumen_total_m3: Number(volumenTotal.toFixed(6)),
    };
  },
};
