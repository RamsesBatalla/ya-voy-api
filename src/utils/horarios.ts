import { sql } from "../db";

const DIAS_SEMANA = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"] as const;

export interface MexicoNow {
  fechaStr: string; // YYYY-MM-DD in America/Mexico_City
  dayIndex: number; // 0 (Dom) - 6 (Sab)
  diaKey: string;
  ayerKey: string;
  hours: number;
  minutes: number;
  minActual: number;
}

export function getMexicoNow(date: Date = new Date()): MexicoNow {
  // Usar Intl.DateTimeFormat con America/Mexico_City para obtener hora exacta en México sin depender del TZ del servidor
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }

  const year = map.year || "2026";
  const month = map.month || "01";
  const day = map.day || "01";
  const fechaStr = `${year}-${month}-${day}`;

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayIndex = weekdayMap[map.weekday] ?? date.getDay();
  let hours = parseInt(map.hour || "0", 10);
  if (hours === 24) hours = 0;
  const minutes = parseInt(map.minute || "0", 10);
  const minActual = hours * 60 + minutes;

  const diaKey = DIAS_SEMANA[dayIndex];
  const ayerKey = DIAS_SEMANA[(dayIndex + 6) % 7];

  return {
    fechaStr,
    dayIndex,
    diaKey,
    ayerKey,
    hours,
    minutes,
    minActual,
  };
}

function parseMinutos(hhmm?: string): number | null {
  if (!hhmm || typeof hhmm !== "string" || !hhmm.includes(":")) return null;
  const [hStr, mStr] = hhmm.trim().split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function normalizarHorarios(rawHorarios: any): Record<string, any> | null {
  if (!rawHorarios) return null;
  let obj = rawHorarios;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;
  return obj;
}

export function evaluarHorarioActual(rawHorarios: any, mx: MexicoNow = getMexicoNow()): {
  tieneHorarioConfigurado: boolean;
  abiertoPorHorario: boolean;
  horarioHoy: { abierto?: boolean; desde?: string; hasta?: string } | null;
} {
  const horarios = normalizarHorarios(rawHorarios);
  if (!horarios) {
    return { tieneHorarioConfigurado: false, abiertoPorHorario: true, horarioHoy: null };
  }

  // Verificar si viene de turno nocturno del día anterior (ej. 18:00 a 02:00)
  const horarioAyer = horarios[mx.ayerKey];
  if (horarioAyer && horarioAyer.abierto) {
    const desdeAyer = parseMinutos(horarioAyer.desde);
    const hastaAyer = parseMinutos(horarioAyer.hasta);
    if (desdeAyer !== null && hastaAyer !== null && hastaAyer < desdeAyer && hastaAyer > 0) {
      if (mx.minActual <= hastaAyer) {
        return {
          tieneHorarioConfigurado: true,
          abiertoPorHorario: true,
          horarioHoy: horarioAyer,
        };
      }
    }
  }

  const horarioHoy = horarios[mx.diaKey] || null;
  if (!horarioHoy) {
    return { tieneHorarioConfigurado: true, abiertoPorHorario: true, horarioHoy: null };
  }

  if (horarioHoy.abierto === false) {
    return { tieneHorarioConfigurado: true, abiertoPorHorario: false, horarioHoy };
  }

  const minDesde = parseMinutos(horarioHoy.desde);
  const minHasta = parseMinutos(horarioHoy.hasta);
  if (minDesde === null || minHasta === null) {
    return { tieneHorarioConfigurado: true, abiertoPorHorario: Boolean(horarioHoy.abierto), horarioHoy };
  }

  let dentroDeHorario = false;
  if (minHasta === 0 && minDesde > 0) {
    // 00:00 como medianoche al final del día (24:00 = 1440 min)
    dentroDeHorario = mx.minActual >= minDesde && mx.minActual <= 1440;
  } else if (minHasta > minDesde) {
    dentroDeHorario = mx.minActual >= minDesde && mx.minActual <= minHasta;
  } else if (minHasta < minDesde) {
    // Cruza medianoche (ej. 14:00 a 02:00)
    dentroDeHorario = mx.minActual >= minDesde || mx.minActual <= minHasta;
  } else {
    // minHasta === minDesde (24 horas)
    dentroDeHorario = true;
  }

  return {
    tieneHorarioConfigurado: true,
    abiertoPorHorario: dentroDeHorario,
    horarioHoy,
  };
}

/**
 * Calcula el estado real de apertura de un negocio considerando:
 * 1. Si cerró manualmente hoy (`cierre_manual_fecha === mx.fechaStr`), permanece cerrado hoy.
 * 2. Si `cierre_manual_fecha` era de un día anterior, se limpia y vuelve a regir su horario configurado.
 * 3. Si abrió manualmente hoy (`apertura_manual_fecha === mx.fechaStr`), permanece abierto hoy.
 * 4. De lo contrario, si tiene horario configurado, rige el horario configurado en hora de México.
 */
export async function sincronizarEstadoNegocio(negocio: any, mx: MexicoNow = getMexicoNow()): Promise<{
  esta_abierto: boolean;
  cierre_manual_hoy: boolean;
  horarioHoy: { abierto?: boolean; desde?: string; hasta?: string } | null;
  mensajeCierre?: string;
}> {
  if (!negocio) {
    return { esta_abierto: false, cierre_manual_hoy: false, horarioHoy: null };
  }

  const evalH = evaluarHorarioActual(negocio.horarios, mx);
  const cierreManualFecha = negocio.cierre_manual_fecha ? String(negocio.cierre_manual_fecha).trim() : null;
  const aperturaManualFecha = negocio.apertura_manual_fecha ? String(negocio.apertura_manual_fecha).trim() : null;

  // Caso 1: Cerró manualmente HOY -> se respeta el cierre manual por el resto del día
  if (cierreManualFecha === mx.fechaStr) {
    if (negocio.esta_abierto !== false && negocio.id) {
      await sql`UPDATE viveres SET esta_abierto = false WHERE id = ${negocio.id}`.catch(() => {});
    }
    return {
      esta_abierto: false,
      cierre_manual_hoy: true,
      horarioHoy: evalH.horarioHoy,
      mensajeCierre: "Este restaurante cerró temporalmente por hoy",
    };
  }

  // Caso 2: Tenía un cierre manual de un día anterior -> ya es otro día, limpiar cierre_manual_fecha
  let cierreExpirado = false;
  if (cierreManualFecha && cierreManualFecha !== mx.fechaStr) {
    cierreExpirado = true;
  }

  // Caso 3: Si tiene horarios configurados, el horario del día determina si está abierto
  // (a menos que haya abierto manualmente hoy fuera de horario)
  if (evalH.tieneHorarioConfigurado) {
    let abiertoFinal = evalH.abiertoPorHorario;
    if (!abiertoFinal && aperturaManualFecha === mx.fechaStr && negocio.esta_abierto === true) {
      abiertoFinal = true;
    }

    if ((cierreExpirado || negocio.esta_abierto !== abiertoFinal) && negocio.id) {
      await sql`
        UPDATE viveres
        SET esta_abierto = ${abiertoFinal},
            cierre_manual_fecha = NULL
        WHERE id = ${negocio.id}
      `.catch(() => {});
    }

    let mensajeCierre: string | undefined;
    if (!abiertoFinal) {
      if (evalH.horarioHoy?.abierto === false) {
        mensajeCierre = "Este restaurante no abre el día de hoy";
      } else if (evalH.horarioHoy?.desde && evalH.horarioHoy?.hasta) {
        mensajeCierre = `Este restaurante atiende hoy de ${evalH.horarioHoy.desde} a ${evalH.horarioHoy.hasta}`;
      } else {
        mensajeCierre = "Este restaurante está cerrado en este momento";
      }
    }

    return {
      esta_abierto: abiertoFinal,
      cierre_manual_hoy: false,
      horarioHoy: evalH.horarioHoy,
      mensajeCierre,
    };
  }

  // Caso 4: No tiene horarios configurados -> usar bandera esta_abierto (si el cierre manual expiró, reabrir)
  const abiertoSinHorario = cierreExpirado ? true : negocio.esta_abierto !== false;
  if (cierreExpirado && negocio.id) {
    await sql`UPDATE viveres SET esta_abierto = ${abiertoSinHorario}, cierre_manual_fecha = NULL WHERE id = ${negocio.id}`.catch(() => {});
  }

  return {
    esta_abierto: abiertoSinHorario,
    cierre_manual_hoy: false,
    horarioHoy: null,
    mensajeCierre: abiertoSinHorario ? undefined : "Este restaurante está cerrado en este momento",
  };
}
