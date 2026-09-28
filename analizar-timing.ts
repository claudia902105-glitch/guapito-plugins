#!/usr/bin/env bun
/**
 * Lee las líneas `telegram timing {...}` que emite server.ts con
 * TELEGRAM_TIMING=1 y las convierte en un veredicto: qué tramo se está
 * comiendo el tiempo.
 *
 * Implementa el Paso 4 de DIAGNOSTICO.md para no tener que leer JSON a ojo.
 *
 * Uso — según cómo esté lanzado el bot en el servidor:
 *
 *   journalctl -u <servicio> --since "-2h" | bun analizar-timing.ts
 *   bun analizar-timing.ts < /ruta/al/log
 *   tail -n 5000 /ruta/al/log | bun analizar-timing.ts
 *
 * Ignora cualquier línea que no sea de timing, así que se le puede tirar el
 * log completo sin filtrar.
 */

// Marca el archivo como módulo. Bun lo corre igual sin esto, pero sin un import
// o export tsc rechaza el `await` de nivel superior que usa leerEntrada().
export {}

type Registro = Record<string, unknown>

// Umbrales de DIAGNOSTICO.md. `sospechoso` es el valor desde el cual el tramo
// deja de ser ruido y merece mirarse.
const TRAMOS = [
  { campo: 'lag_telegram_ms', etiqueta: 'Telegram → servidor', sospechoso: 5000 },
  { campo: 'gate_ms', etiqueta: 'lecturas access.json', sospechoso: 100 },
  { campo: 'turno_claude_ms', etiqueta: 'turno de Claude (inferencia + Airtable)', sospechoso: Infinity },
  { campo: 'validacion_ms', etiqueta: 'chequeo de adjuntos', sospechoso: 500 },
  { campo: 'envio_telegram_ms', etiqueta: 'servidor → Telegram', sospechoso: 3000 },
] as const

function percentil(ordenados: number[], p: number): number {
  if (ordenados.length === 0) return NaN
  // Índice más cercano; con pocas muestras no vale la pena interpolar.
  const i = Math.min(ordenados.length - 1, Math.max(0, Math.round((ordenados.length - 1) * p)))
  return ordenados[i]!
}

function ms(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`
}

async function leerEntrada(): Promise<string> {
  const trozos: Uint8Array[] = []
  for await (const t of Bun.stdin.stream()) trozos.push(t)
  return new TextDecoder().decode(await new Blob(trozos).arrayBuffer())
}

const entrada = await leerEntrada()

const registros: Registro[] = []
for (const linea of entrada.split('\n')) {
  // La línea puede venir con prefijo de journalctl/docker por delante, así que
  // se busca el marcador en cualquier posición en vez de anclarlo al inicio.
  const i = linea.indexOf('telegram timing ')
  if (i === -1) continue
  try {
    const obj = JSON.parse(linea.slice(i + 'telegram timing '.length))
    if (obj && typeof obj === 'object') registros.push(obj as Registro)
  } catch {
    // Línea truncada por rotación de log o por el límite del lector. Se saltea.
  }
}

if (registros.length === 0) {
  console.log(
    'No se encontró ninguna línea de timing.\n\n' +
      'Revisar, en este orden:\n' +
      '  1. ¿El proceso está corriendo con TELEGRAM_TIMING=1?\n' +
      '     Requiere reiniciarlo: la variable se lee al arrancar.\n' +
      '  2. ¿El stderr del proceso llega a este log?\n' +
      '     DIAGNOSTICO.md tiene la tabla de dónde buscarlo según cómo esté lanzado.\n' +
      '  3. ¿Hubo mensajes reales en la ventana de tiempo que se le pasó?\n' +
      '     Sin tráfico no hay nada que medir.',
  )
  process.exit(0)
}

const respuestas = registros.filter(r => r.evento === 'reply').length
const entradas = registros.filter(r => r.evento === 'inbound').length

const plural = (n: number, sing: string, plur: string) => `${n} ${n === 1 ? sing : plur}`

console.log(
  `Muestras: ${plural(entradas, 'mensaje entrante', 'mensajes entrantes')}, ` +
    `${plural(respuestas, 'respuesta', 'respuestas')}\n`,
)

// Medianas por tramo, para el veredicto y para la tabla.
const medianas = new Map<string, number>()

console.log('Tramo                                    mediana      p90        máx     n')
console.log('─'.repeat(78))

for (const { campo, etiqueta, sospechoso } of TRAMOS) {
  const valores = registros
    .map(r => r[campo])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b)

  if (valores.length === 0) {
    console.log(`${etiqueta.padEnd(40)} ${'sin datos'.padStart(10)}`)
    continue
  }

  const mediana = percentil(valores, 0.5)
  medianas.set(campo, mediana)

  const alerta = mediana > sospechoso ? '  ← sobre el umbral' : ''
  console.log(
    `${etiqueta.padEnd(40)} ${ms(mediana).padStart(10)} ${ms(percentil(valores, 0.9)).padStart(10)} ` +
      `${ms(valores[valores.length - 1]!).padStart(10)} ${String(valores.length).padStart(5)}${alerta}`,
  )
}

// ── Veredicto ────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(78))

const turno = medianas.get('turno_claude_ms')

if (turno == null) {
  console.log(
    'VEREDICTO: no se puede concluir.\n\n' +
      'Hay líneas de timing pero ninguna con turno_claude_ms. Eso pasa cuando el\n' +
      'log solo tiene eventos `inbound` — el bot recibió mensajes pero no llamó a\n' +
      'reply en esa ventana, o Claude no contestó. Ampliar la ventana de tiempo.',
  )
  process.exit(0)
}

// El total percibido por la persona es la suma de los tramos medidos. No incluye
// la entrega final de Telegram a su teléfono, que no podemos ver desde acá.
const total = TRAMOS.reduce((acc, { campo }) => acc + (medianas.get(campo) ?? 0), 0)
const proporcionTurno = total > 0 ? turno / total : 0

console.log(`Latencia típica de punta a punta: ${ms(total)}`)
console.log(`De eso, el turno de Claude: ${ms(turno)} (${Math.round(proporcionTurno * 100)}%)\n`)

const infraSospechosa = TRAMOS.filter(
  ({ campo, sospechoso }) => (medianas.get(campo) ?? 0) > sospechoso,
)

if (proporcionTurno >= 0.7) {
  console.log(
    'VEREDICTO: el problema NO está en este repo.\n\n' +
      'El turno de Claude domina. Optimizar server.ts no va a mover la aguja, y\n' +
      'tampoco tiene sentido tocar Airtable todavía: no sabemos si el tiempo se va\n' +
      'en inferencia o en round trips. Pasar al Paso 5 de DIAGNOSTICO.md, en orden:\n\n' +
      '  1. Contexto acumulado — reiniciar la sesión de Claude y volver a medir lo\n' +
      '     mismo. Si este número cae fuerte, era esto, y la solución es reiniciar\n' +
      '     periódicamente. Es el chequeo más barato y el más probable.\n' +
      '  2. Round trips de Airtable — recién si reiniciar no cambió nada.\n' +
      '  3. Cola serial — cruzar los turnos altos con mensajes de otras personas.',
  )
} else if (infraSospechosa.length > 0) {
  console.log(
    'VEREDICTO: hay un tramo de infraestructura por encima de su umbral.\n\n' +
      infraSospechosa
        .map(({ campo, etiqueta }) => `  • ${etiqueta}: ${ms(medianas.get(campo)!)}`)
        .join('\n') +
      '\n\nlag_telegram_ms o envio_telegram_ms altos → red de la VM (egress, DNS,\n' +
      'saturación). gate_ms o validacion_ms altos → disco o CPU de la VM, que\n' +
      'suele venir de una instancia demasiado chica. Nada que ver con Airtable\n' +
      'ni con la sesión.',
  )
} else {
  console.log(
    'VEREDICTO: ningún tramo destaca.\n\n' +
      'El turno de Claude no domina y ningún tramo de infra pasa su umbral. Dos\n' +
      'lecturas posibles, y conviene no elegir todavía:\n\n' +
      '  • La latencia real es aceptable y lo que empeoró es la PERCEPCIÓN. Ver la\n' +
      '    nota final de DIAGNOSTICO.md: el indicador "escribiendo…" se manda una\n' +
      '    sola vez y Telegram lo expira a los ~5 s.\n' +
      '  • La ventana medida no incluyó los momentos lentos. Volver a medir en el\n' +
      '    horario en que Alicia se queja, no en una prueba aislada.',
  )
}

if (respuestas < 10) {
  console.log(
    `\nADVERTENCIA: solo ${plural(respuestas, 'respuesta', 'respuestas')} en la muestra.` +
      '\nEl veredicto es frágil con tan pocos datos — juntar 10-15 mensajes en' +
      '\nhorario normal de uso.',
  )
}
