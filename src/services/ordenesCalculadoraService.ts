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

type ModeloEvaluado = {
  modelo: CatalogoModelo;
  stockDisponible: number;
  volumenCajaM3: number;
  perItemData: Array<{
    index: number;
    input: CalculadoraProductoNormalizado;
    orientacion: OrientacionResultado | null;
    capacidad: number;
    layout: [number, number, number] | null;
  }>;
  compatibleCompleto: boolean;
};

type CalculadoraMixtaModeloResumen = {
  modelo_id: number;
  modelo_nombre: string;
  cajas_disponibles: number;
  cajas_asignadas: number;
  cajas_restantes: number;
  deficit_cajas: number;
  volumen_caja_m3: number;
};

type CalculadoraMixtaProductoAsignacion = {
  modelo_id: number;
  modelo_nombre: string;
  cajas_usadas: number;
  unidades_asignadas: number;
  capacidad_por_caja: number;
  sobrante_unidades: number;
  orientacion_mm: { largo: number; ancho: number; alto: number } | null;
  layout: { frente: number; profundo: number; alto: number } | null;
};

type CalculadoraMixtaProductoDetalle = {
  codigo: string | null;
  nombre: string | null;
  cantidad: number;
  asignaciones: CalculadoraMixtaProductoAsignacion[];
  cubierto_unidades: number;
  sin_cobertura: number;
};

type CalculadoraMixtaResultado = {
  modelos: CalculadoraMixtaModeloResumen[];
  productos: CalculadoraMixtaProductoDetalle[];
  total_cajas: number;
  total_unidades_sin_cobertura: number;
};

type MixtoResult = {
  items: CalculadoraProductoNormalizado[];
  mix: CalculadoraMixtaResultado;
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

function evaluarModelos(
  modelos: CatalogoModelo[],
  inventario: Map<number, number>,
  items: CalculadoraProductoNormalizado[],
): ModeloEvaluado[] {
  const evaluados: ModeloEvaluado[] = [];

  if (!Array.isArray(modelos) || !modelos.length || !items.length) {
    return evaluados;
  }

  modelos.forEach((modelo) => {
    if (!modelo || typeof modelo.modelo_id !== 'number') return;
    const stockDisponible = inventario.get(modelo.modelo_id) ?? 0;
    if (stockDisponible <= 0) return;

    const dimFrente = Number(modelo.dim_int_frente ?? 0);
    const dimProfundo = Number(modelo.dim_int_profundo ?? 0);
    const dimAlto = Number(modelo.dim_int_alto ?? 0);
    if (dimFrente <= 0 || dimProfundo <= 0 || dimAlto <= 0) return;

    const modeloDims: [number, number, number] = [dimFrente, dimProfundo, dimAlto];
    const perItemData: ModeloEvaluado['perItemData'] = [];
    let compatibleCompleto = true;

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const orientacion = mejorOrientacion(modeloDims, [item.largo_mm, item.ancho_mm, item.alto_mm]);
      if (!orientacion || orientacion.capacidad <= 0) {
        compatibleCompleto = false;
        perItemData.push({
          index,
          input: item,
          orientacion: null,
          capacidad: 0,
          layout: null,
        });
        continue;
      }
      perItemData.push({
        index,
        input: item,
        orientacion,
        capacidad: orientacion.capacidad,
        layout: orientacion.layout,
      });
    }

    if (!perItemData.length) return;

    const volumenCajaM3 = volumenDesdeMm(dimFrente, dimProfundo, dimAlto);
    evaluados.push({
      modelo,
      stockDisponible,
      volumenCajaM3,
      perItemData,
      compatibleCompleto,
    });
  });

  return evaluados;
}

function calcularRecomendaciones(
  modelos: CatalogoModelo[],
  inventario: Map<number, number>,
  items: CalculadoraProductoNormalizado[],
): CalculadoraRecomendacion[] {
  const recomendaciones: CalculadoraRecomendacion[] = [];
  const evaluados = evaluarModelos(modelos, inventario, items);
  if (!evaluados.length) return recomendaciones;

  const volumenTotal = items.reduce((acc, item) => acc + item.volumen_total_m3, 0);

  for (const evaluado of evaluados) {
    if (!evaluado.compatibleCompleto) continue;

    const { modelo, stockDisponible, volumenCajaM3, perItemData } = evaluado;

    const cajasPorItem = perItemData.map((entry) => Math.ceil(entry.input.cantidad / entry.capacidad));
    const cajasPorItemMax = cajasPorItem.reduce((max, value) => Math.max(max, value), 0);

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
      const orient = entry.orientacion as OrientacionResultado;
      const layout = entry.layout as [number, number, number];
      return {
        codigo: entry.input.codigo,
        nombre: entry.input.nombre,
        cantidad: entry.input.cantidad,
        cajas_requeridas: cajasRequeridas,
        capacidad_por_caja: entry.capacidad,
        sobrante_unidades: sobrante,
        orientacion_mm: {
          largo: orient.orientacion[0],
          ancho: orient.orientacion[1],
          alto: orient.orientacion[2],
        },
        layout: {
          frente: layout[0],
          profundo: layout[1],
          alto: layout[2],
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
      modelo_id: modelo.modelo_id!,
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

type CajaAbierta = {
  modeloId: number;
  modeloNombre: string;
  volumenLibre: number;
  volumenTotal: number;
  productos: Map<number, {
    unidades: number;
    orientacion: OrientacionResultado | null;
    layout: [number, number, number] | null;
    capacidad: number;
  }>;
};

function calcularMixta(
  modelos: CatalogoModelo[],
  inventario: Map<number, number>,
  items: CalculadoraProductoNormalizado[],
): CalculadoraMixtaResultado {
  const evaluados = evaluarModelos(modelos, inventario, items);
  if (!evaluados.length) {
    return {
      modelos: [],
      productos: items.map((item) => ({
        codigo: item.codigo ?? null,
        nombre: item.nombre ?? null,
        cantidad: item.cantidad,
        asignaciones: [],
        cubierto_unidades: 0,
        sin_cobertura: item.cantidad,
      })),
      total_cajas: 0,
      total_unidades_sin_cobertura: items.reduce((acc, item) => acc + item.cantidad, 0),
    };
  }

  const inventarioDisponible = new Map<number, number>();
  const infoModelos = new Map<number, {
    evaluado: ModeloEvaluado;
    perItemMap: Map<number, ModeloEvaluado['perItemData'][number]>;
  }>();

  evaluados.forEach((evaluado) => {
    if (evaluado.modelo?.modelo_id == null) return;
    inventarioDisponible.set(evaluado.modelo.modelo_id, evaluado.stockDisponible);
    infoModelos.set(
      evaluado.modelo.modelo_id,
      {
        evaluado,
        perItemMap: new Map(evaluado.perItemData.map((entry) => [entry.index, entry])),
      },
    );
  });

  const cajasAbiertas: CajaAbierta[] = [];
  const resumenModelos = new Map<number, CalculadoraMixtaModeloResumen>();

  const productosDetalles: CalculadoraMixtaProductoDetalle[] = items.map((item) => ({
    codigo: item.codigo ?? null,
    nombre: item.nombre ?? null,
    cantidad: item.cantidad,
    asignaciones: [],
    cubierto_unidades: 0,
    sin_cobertura: item.cantidad,
  }));

  const productoOrden = items
    .map((item, index) => ({ index, volumenUnit: item.volumen_unit_m3, cantidad: item.cantidad }))
    .sort((a, b) => {
      if (b.volumenUnit !== a.volumenUnit) return b.volumenUnit - a.volumenUnit;
      return b.cantidad - a.cantidad;
    });

  const actualizarResumenModelo = (modeloId: number, evaluado: ModeloEvaluado, deltaCajas: number) => {
    let resumen = resumenModelos.get(modeloId);
    if (!resumen) {
      resumen = {
        modelo_id: modeloId,
        modelo_nombre: evaluado.modelo.nombre_modelo,
        cajas_disponibles: evaluado.stockDisponible,
        cajas_asignadas: 0,
        cajas_restantes: evaluado.stockDisponible,
        deficit_cajas: 0,
        volumen_caja_m3: Number(evaluado.volumenCajaM3.toFixed(6)),
      };
      resumenModelos.set(modeloId, resumen);
    }
    resumen.cajas_asignadas += deltaCajas;
    const stockRestante = inventarioDisponible.get(modeloId) ?? 0;
    resumen.cajas_restantes = Math.max(0, stockRestante);
    resumen.deficit_cajas = Math.max(0, resumen.cajas_asignadas - resumen.cajas_disponibles);
  };

  const registrarAsignacion = (
    productoIndex: number,
    modeloId: number,
    modeloNombre: string,
    entry: ModeloEvaluado['perItemData'][number],
    unidades: number,
  ) => {
    const detalle = productosDetalles[productoIndex];
    let asignacion = detalle.asignaciones.find((a) => a.modelo_id === modeloId);
    if (!asignacion) {
      asignacion = {
        modelo_id: modeloId,
        modelo_nombre: modeloNombre,
        cajas_usadas: 0,
        unidades_asignadas: 0,
        capacidad_por_caja: entry.capacidad,
        sobrante_unidades: 0,
        orientacion_mm: entry.orientacion?.orientacion
          ? {
            largo: entry.orientacion.orientacion[0],
            ancho: entry.orientacion.orientacion[1],
            alto: entry.orientacion.orientacion[2],
          }
          : null,
        layout: entry.layout
          ? {
            frente: entry.layout[0],
            profundo: entry.layout[1],
            alto: entry.layout[2],
          }
          : null,
      };
      detalle.asignaciones.push(asignacion);
    }
    asignacion.unidades_asignadas += unidades;
    const cajasEquivalentes = asignacion.capacidad_por_caja > 0
      ? unidades / asignacion.capacidad_por_caja
      : 0;
    asignacion.cajas_usadas = Number((asignacion.cajas_usadas + cajasEquivalentes).toFixed(4));
    asignacion.sobrante_unidades = Math.max(0, Math.round(asignacion.cajas_usadas * asignacion.capacidad_por_caja - asignacion.unidades_asignadas));
    detalle.cubierto_unidades += unidades;
    detalle.sin_cobertura = Math.max(0, detalle.cantidad - detalle.cubierto_unidades);
  };

  productoOrden.forEach(({ index }) => {
    const item = items[index];
    let restante = item.cantidad;
    if (restante <= 0) return;

    const compatibilidad: Array<{
      modeloId: number;
      info: { evaluado: ModeloEvaluado; perItemMap: Map<number, ModeloEvaluado['perItemData'][number]> };
      data: ModeloEvaluado['perItemData'][number];
    }> = [];

    infoModelos.forEach((info, modeloId) => {
      const data = info.perItemMap.get(index);
      if (!data || !data.orientacion || data.capacidad <= 0) return;
      const stock = inventarioDisponible.get(modeloId) ?? 0;
      if (stock <= 0 && !cajasAbiertas.some((caja) => caja.modeloId === modeloId)) return;
      compatibilidad.push({ modeloId, info, data });
    });

    if (!compatibilidad.length) {
      productosDetalles[index].sin_cobertura = restante;
      return;
    }

    const buscarMejorCajaExistente = (): {
      caja: CajaAbierta;
      data: ModeloEvaluado['perItemData'][number];
      unidades: number;
      score: number;
    } | null => {
      let mejorCaja: { caja: CajaAbierta; data: ModeloEvaluado['perItemData'][number]; unidades: number; score: number } | null = null;
      cajasAbiertas.forEach((caja) => {
        const info = infoModelos.get(caja.modeloId);
        if (!info) return;
        const data = info.perItemMap.get(index);
        if (!data || !data.orientacion || data.capacidad <= 0) return;
        const productoCaja = caja.productos.get(index);
        const asignadas = productoCaja?.unidades ?? 0;
        if (asignadas >= data.capacidad) return;
        const volumenLibre = caja.volumenLibre;
        if (volumenLibre <= 0) return;
        const volumenUnit = item.volumen_unit_m3;
        const unidadesPorCapacidad = data.capacidad - asignadas;
        const unidadesPorVolumen = Math.floor(volumenLibre / volumenUnit);
        const unidadesColocables = Math.min(restante, unidadesPorCapacidad, unidadesPorVolumen);
        if (unidadesColocables <= 0) return;
        const leftover = volumenLibre - unidadesColocables * volumenUnit;
        const score = leftover;
        if (!mejorCaja || score < mejorCaja.score) {
          mejorCaja = { caja, data, unidades: unidadesColocables, score };
        }
      });
      return mejorCaja;
    };

    while (restante > 0) {
      const mejorCajaExistente = buscarMejorCajaExistente();
      if (mejorCajaExistente) {
        const { caja, data, unidades } = mejorCajaExistente;
        const productoCaja = caja.productos.get(index);
        const asignadas = productoCaja?.unidades ?? 0;
        caja.productos.set(index, {
          unidades: asignadas + unidades,
          orientacion: data.orientacion,
          layout: data.layout,
          capacidad: data.capacidad,
        });
        caja.volumenLibre = Number((caja.volumenLibre - unidades * item.volumen_unit_m3).toFixed(6));
        registrarAsignacion(index, caja.modeloId, caja.modeloNombre, data, unidades);
        restante -= unidades;
        continue;
      }

      // Abrir nueva caja
      const candidatos = compatibilidad
        .filter(({ modeloId }) => (inventarioDisponible.get(modeloId) ?? 0) > 0)
        .map(({ modeloId, info, data }) => {
          const stock = inventarioDisponible.get(modeloId) ?? 0;
          const volumenCaja = info.evaluado.volumenCajaM3;
          const unidadesPorCapacidad = data.capacidad;
          const unidadesPorVolumen = Math.max(1, Math.floor(volumenCaja / item.volumen_unit_m3));
          const posibles = Math.max(1, Math.min(unidadesPorCapacidad, unidadesPorVolumen));
          const unidadesUtiles = Math.min(restante, posibles);
          const leftover = volumenCaja - unidadesUtiles * item.volumen_unit_m3;
          const usadoAntes = resumenModelos.has(modeloId);
          return {
            modeloId,
            info,
            data,
            stock,
            unidadesUtiles,
            leftover,
            usadoAntes,
          };
        })
        .filter((candidato) => candidato.stock > 0 && candidato.unidadesUtiles > 0)
        .sort((a, b) => {
          if (a.usadoAntes !== b.usadoAntes) return a.usadoAntes ? -1 : 1;
          if (a.unidadesUtiles !== b.unidadesUtiles) return b.unidadesUtiles - a.unidadesUtiles;
          if (a.leftover !== b.leftover) return a.leftover - b.leftover;
          return a.info.evaluado.volumenCajaM3 - b.info.evaluado.volumenCajaM3;
        });

      const seleccionado = candidatos[0];
      if (!seleccionado) {
        break;
      }

      const { modeloId, info, data, unidadesUtiles } = seleccionado;
      inventarioDisponible.set(modeloId, (inventarioDisponible.get(modeloId) ?? 0) - 1);
      const nuevaCaja: CajaAbierta = {
        modeloId,
        modeloNombre: info.evaluado.modelo.nombre_modelo,
        volumenLibre: Number((info.evaluado.volumenCajaM3 - unidadesUtiles * item.volumen_unit_m3).toFixed(6)),
        volumenTotal: info.evaluado.volumenCajaM3,
        productos: new Map([[index, {
          unidades: unidadesUtiles,
          orientacion: data.orientacion,
          layout: data.layout,
          capacidad: data.capacidad,
        }]]),
      };
      cajasAbiertas.push(nuevaCaja);
      registrarAsignacion(index, modeloId, info.evaluado.modelo.nombre_modelo, data, unidadesUtiles);
      actualizarResumenModelo(modeloId, info.evaluado, 1);
      restante -= unidadesUtiles;
    }

    const restantePositivo = Math.max(0, restante);
    const cubierto = item.cantidad - restantePositivo;
    productosDetalles[index].cubierto_unidades = Math.max(0, cubierto);
    productosDetalles[index].sin_cobertura = restantePositivo;
  });

  const modelosResumen = Array.from(resumenModelos.values())
    .sort((a, b) => b.cajas_asignadas - a.cajas_asignadas);

  const totalCajas = modelosResumen.reduce((acc, modelo) => acc + modelo.cajas_asignadas, 0);
  const totalSinCobertura = productosDetalles.reduce((acc, det) => acc + det.sin_cobertura, 0);

  return {
    modelos: modelosResumen,
    productos: productosDetalles,
    total_cajas: totalCajas,
    total_unidades_sin_cobertura: totalSinCobertura,
  };
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

  async calcularMixto(
    tenant: string,
    sedeId: number,
    itemsEntrada: CalculadoraProductoInput[],
  ): Promise<MixtoResult> {
    const items = normalizarItems(itemsEntrada);
    if (!items.length) {
      return {
        items: [],
        mix: {
          modelos: [],
          productos: [],
          total_cajas: 0,
          total_unidades_sin_cobertura: 0,
        },
        total_unidades: 0,
        volumen_total_m3: 0,
      };
    }

    const catalogo = await fetchCatalogo(tenant, sedeId);
    const inventario = construirMapaInventario(catalogo.inventario);
    const mix = calcularMixta(catalogo.modelos, inventario, items);

    const totalUnidades = items.reduce((acc, item) => acc + item.cantidad, 0);
    const volumenTotal = items.reduce((acc, item) => acc + item.volumen_total_m3, 0);

    return {
      items,
      mix,
      total_unidades: totalUnidades,
      volumen_total_m3: Number(volumenTotal.toFixed(6)),
    };
  },
};
