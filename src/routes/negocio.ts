import { Router } from 'express';
import { sql } from '../db';
import { requireAuth, requireNegocioOwner } from '../middleware/auth';
import { evaluarHorarioActual, getMexicoNow, sincronizarEstadoNegocio } from '../utils/horarios';

const router = Router();

// Toggle abrir / cerrar (cierre manual hoy se reinicia automáticamente al día siguiente según horario)
router.patch('/:id/toggle', requireAuth, requireNegocioOwner, async (req, res) => {
  try {
    const existing = await sql`SELECT * FROM viveres WHERE id = ${req.params.id} LIMIT 1`;
    if (!existing.length) return res.status(404).json({ error: 'Negocio no encontrado' });

    const neg = existing[0];
    const sync = await sincronizarEstadoNegocio(neg);
    const nuevoAbierto = !sync.esta_abierto;
    const mx = getMexicoNow();

    const rows = await sql`
      UPDATE viveres
      SET esta_abierto = ${nuevoAbierto},
          cierre_manual_fecha = ${nuevoAbierto ? null : mx.fechaStr},
          apertura_manual_fecha = ${nuevoAbierto ? mx.fechaStr : null}
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    res.json(rows[0]);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Editar datos del negocio (incluyendo dirección exacta y coordenadas para cálculo de distancias)
const updateNegocioPerfil = async (req: any, res: any) => {
  try {
    const {
      nombre,
      descripcion,
      telefono,
      direccion,
      calle,
      numero_ext,
      numero_int,
      colonia,
      codigo_postal,
      referencias,
      imagen_url,
      banner_url,
      tipo,
      categoria,
      lat,
      lng,
      latitud,
      longitud,
    } = req.body;

    const rawLat = lat ?? latitud;
    const rawLng = lng ?? longitud;
    const latNum = rawLat != null && rawLat !== '' ? Number(rawLat) : null;
    const lngNum = rawLng != null && rawLng !== '' ? Number(rawLng) : null;

    const rows = await sql`
      UPDATE viveres SET
        nombre        = COALESCE(${nombre ?? null}, nombre),
        descripcion   = COALESCE(${descripcion ?? null}, descripcion),
        telefono      = COALESCE(${telefono ?? null}, telefono),
        direccion     = COALESCE(${direccion ?? null}, direccion),
        calle         = COALESCE(${calle ?? null}, calle),
        numero_ext    = COALESCE(${numero_ext ?? null}, numero_ext),
        numero_int    = COALESCE(${numero_int ?? null}, numero_int),
        colonia       = COALESCE(${colonia ?? null}, colonia),
        codigo_postal = COALESCE(${codigo_postal ?? null}, codigo_postal),
        referencias   = COALESCE(${referencias ?? null}, referencias),
        imagen_url    = COALESCE(${imagen_url ?? null}, imagen_url),
        logo_url      = COALESCE(${imagen_url ?? null}, logo_url),
        banner_url    = COALESCE(${banner_url ?? null}, banner_url),
        tipo          = COALESCE(${tipo ?? null}, tipo),
        categoria     = COALESCE(${categoria ?? null}, categoria),
        lat           = COALESCE(${latNum}, lat),
        latitud       = COALESCE(${latNum}, latitud),
        lng           = COALESCE(${lngNum}, lng),
        longitud      = COALESCE(${lngNum}, longitud)
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!rows.length) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(rows[0]);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
};

router.put('/:id', requireAuth, requireNegocioOwner, updateNegocioPerfil);
router.patch('/:id', requireAuth, requireNegocioOwner, updateNegocioPerfil);
router.patch('/:id/perfil', requireAuth, requireNegocioOwner, updateNegocioPerfil);

// Guardar horarios y sincronizar inmediatamente el estado de apertura
router.patch('/:id/horarios', requireAuth, requireNegocioOwner, async (req, res) => {
  try {
    const { horarios } = req.body;
    const evalH = evaluarHorarioActual(horarios);
    const abiertoSegunHorario = evalH.tieneHorarioConfigurado ? evalH.abiertoPorHorario : true;

    const rows = await sql`
      UPDATE viveres SET
        horarios = ${JSON.stringify(horarios)},
        esta_abierto = ${abiertoSegunHorario},
        cierre_manual_fecha = NULL,
        apertura_manual_fecha = NULL
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    res.json(rows[0]);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Cambiar estado abierto/cerrado directo
router.patch('/:id/estado', requireAuth, requireNegocioOwner, async (req, res) => {
  try {
    const { abierto } = req.body;
    const mx = getMexicoNow();
    const rows = await sql`
      UPDATE viveres SET
        esta_abierto = ${abierto},
        cierre_manual_fecha = ${abierto ? null : mx.fechaStr},
        apertura_manual_fecha = ${abierto ? mx.fechaStr : null}
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    res.json(rows[0]);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Cambiar aceptando_pedidos (modo ocupado)
router.patch('/:id/ocupado', requireAuth, requireNegocioOwner, async (req, res) => {
  try {
    const { aceptando } = req.body;
    const rows = await sql`
      UPDATE viveres SET aceptando_pedidos = ${aceptando}
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    res.json(rows[0]);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Estadísticas avanzadas del negocio (requiere propietario)
router.get('/:id/stats', requireAuth, requireNegocioOwner, async (req, res) => {
  try {
    const id = req.params.id
    const pedidos = await sql`
      SELECT id, total, costo_envio, status, items, creado_en, rating_negocio, aspectos_negocio
      FROM pedidos
      WHERE negocio_id = ${id}
      ORDER BY creado_en DESC
    `

    const entregados = pedidos.filter((p: any) => p.status === 'entregado')
    const cancelados = pedidos.filter((p: any) => p.status === 'cancelado')

    const cfgRows = await sql`SELECT clave, valor FROM app_config WHERE clave IN ('comision_pct','envio_minimo')`
    const cfg: Record<string, number> = {}
    cfgRows.forEach((r: any) => { cfg[r.clave] = parseFloat(r.valor) })
    const comisionPct = (cfg.comision_pct ?? 18) / 100
    const envioDefault = cfg.envio_minimo ?? 25

    const calcNeto = (p: any) => {
      const subtotal = Math.max(0, Number(p.total) - Number(p.costo_envio ?? envioDefault))
      return subtotal * (1 - comisionPct)
    }

    // Ingresos por día — últimos 7 días
    const hoy = new Date()
    const ingresosPorDia: { fecha: string; label: string; ingresos: number; pedidos: number }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(hoy)
      d.setDate(hoy.getDate() - i)
      const fechaStr = d.toISOString().split('T')[0]
      const label = d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric' })
      const delDia = entregados.filter((p: any) => p.creado_en?.startsWith(fechaStr))
      ingresosPorDia.push({
        fecha: fechaStr,
        label,
        ingresos: Math.round(delDia.reduce((s: number, p: any) => s + calcNeto(p), 0) * 100) / 100,
        pedidos: delDia.length,
      })
    }

    // Productos más vendidos
    const conteoProductos: Record<string, { nombre: string; cantidad: number; ingresos: number }> = {}
    entregados.forEach((p: any) => {
      const items = Array.isArray(p.items) ? p.items : []
      items.forEach((it: any) => {
        const key = it.nombre || it.id
        if (!conteoProductos[key]) conteoProductos[key] = { nombre: key, cantidad: 0, ingresos: 0 }
        conteoProductos[key].cantidad += Number(it.cantidad || 1)
        conteoProductos[key].ingresos += Number(it.precio || 0) * Number(it.cantidad || 1)
      })
    })
    const topProductos = Object.values(conteoProductos)
      .sort((a, b) => b.cantidad - a.cantidad)
      .slice(0, 5)

    // Horas pico (distribución 0-23)
    const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, pedidos: 0 }))
    entregados.forEach((p: any) => {
      const h = new Date(p.creado_en).getHours()
      if (h >= 0 && h < 24) porHora[h].pedidos++
    })

    // Tasa de cancelación y ticket promedio
    const totalPedidos = pedidos.length
    const tasaCancelacion = totalPedidos > 0 ? Math.round((cancelados.length / totalPedidos) * 100) : 0
    const ticketPromedio = entregados.length > 0
      ? Math.round((entregados.reduce((s: number, p: any) => s + calcNeto(p), 0) / entregados.length) * 100) / 100
      : 0

    // Conteo de aspectos calificados por clientes
    const conteoAspectos: Record<string, number> = {}
    let totalCalificados = 0
    pedidos.forEach((p: any) => {
      if (p.rating_negocio != null) totalCalificados++
      if (Array.isArray(p.aspectos_negocio)) {
        p.aspectos_negocio.forEach((asp: string) => {
          if (asp) conteoAspectos[asp] = (conteoAspectos[asp] || 0) + 1
        })
      }
    })

    res.json({
      ingresosPorDia,
      topProductos,
      porHora,
      tasaCancelacion,
      ticketPromedio,
      totalEntregados: entregados.length,
      totalCancelados: cancelados.length,
      totalCalificados,
      aspectos: conteoAspectos,
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

export default router;
