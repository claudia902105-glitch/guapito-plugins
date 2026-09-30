# Diagnóstico de lentitud

Guía para ubicar **dónde** se va el tiempo cuando el bot tarda en responder,
antes de cambiar nada. El objetivo de este documento es que la decisión de qué
optimizar se tome sobre números, no sobre la sospecha de la vez pasada.

## La cadena completa

```
Alicia → Telegram → [1] long-poll (grammy)        ─┐
                  → [2] gate() + notificación      ├─ este servidor
                  → [3] ⬛ turno de Claude Code ⬛  ← caja negra
                        └─ inferencia + Airtable MCP
                  → [4] tool reply → sendMessage   ─┐
                  → [5] Telegram → Alicia           ┘ este servidor
```

Los tramos 1, 2, 4 y 5 son de este repo. El tramo 3 no: es la sesión de Claude
Code y sus otros servidores MCP. La instrumentación mide los tramos propios y
deja el 3 como un solo número — con eso alcanza para saber **de qué lado**
está el problema, que es la pregunta que hay que contestar primero.

## Paso 1 — Encender la medición

```sh
TELEGRAM_TIMING=1
```

Apagada (por defecto) el comportamiento es idéntico al de siempre. Encendida,
cada mensaje escribe dos líneas JSON a **stderr**. No registra el texto de los
mensajes: solo ids, largos en caracteres y milisegundos.

Dónde caen esas líneas depende de cómo esté lanzado el proceso en el servidor:

| Lanzado como | Dónde leer |
| --- | --- |
| servicio systemd | `journalctl -u <servicio> -f \| grep "telegram timing"` |
| tmux / screen | el scrollback de la ventana |
| `nohup ... > log 2>&1` | ese archivo |
| plugin de Claude Code | el stderr del MCP lo captura Claude Code |

**Determinar esto es parte del paso 1.** Si no sabemos dónde sale el stderr
hoy, tampoco vamos a poder leer nada.

## Paso 2 — Anotar el estado de partida

Antes de juntar mediciones, registrar:

- **Hace cuánto corre la sesión de Claude sin reiniciarse.** Si la lentitud es
  por contexto acumulado, este dato es la mitad de la respuesta.
- **Cuánta gente usa el bot.** Una sola sesión procesa turnos en serie: si dos
  personas escriben a la vez, la segunda hace fila.
- **CPU y RAM de la VM** mientras el bot responde (`top`, `free -m`).

## Paso 3 — Juntar 10-15 mensajes reales

En horario normal de uso, no en una prueba aislada. Las líneas se ven así:

```
telegram timing {"evento":"inbound","chat":"123","lag_telegram_ms":420,"gate_ms":2,...}
telegram timing {"evento":"reply","chat":"123","turno_claude_ms":24800,"validacion_ms":1,"envio_telegram_ms":310,...}
```

## Paso 4 — Leer los números

Hay un script que hace esta lectura y devuelve el veredicto directamente, así
que no hace falta interpretar el JSON a ojo:

```sh
journalctl -u <servicio> --since "-2h" | bun analizar-timing.ts
bun analizar-timing.ts < /ruta/al/log
```

Ignora las líneas que no son de timing, así que se le puede tirar el log
completo sin filtrar. Lo que sigue es la tabla que aplica por dentro, para
poder discutir el resultado en vez de confiar en él.

| Campo | Qué mide | Normal | Sospechoso |
| --- | --- | --- | --- |
| `lag_telegram_ms` | Telegram → este proceso | < 1500 ms | > 5000 ms sostenido |
| `gate_ms` | lecturas de `access.json` | < 5 ms | > 100 ms |
| `turno_claude_ms` | **inferencia + Airtable + todo el turno** | — | domina el total |
| `validacion_ms` | chequeo de adjuntos | < 10 ms | > 500 ms sin archivos |
| `envio_telegram_ms` | salida hacia Telegram | 100-600 ms | > 3000 ms |

`lag_telegram_ms` sale del reloj de Telegram, con resolución de **un segundo** y
desfase respecto al reloj del servidor: ±1000 ms, negativo incluido, es ruido
esperable, no un hallazgo.

### Árbol de decisión

- **`turno_claude_ms` es el 70%+ del total** → el problema **no está en este
  repo**. Optimizar `server.ts` no va a mover la aguja. Pasar al paso 5.
- **`lag_telegram_ms` o `envio_telegram_ms` altos** → red de la VM de Google
  (egress, DNS, saturación). Nada que ver con Airtable ni con la sesión.
- **`gate_ms` o `validacion_ms` altos** → disco o CPU de la VM. Suele venir con
  una instancia demasiado chica para lo que se le pide.

## Paso 5 — Solo si el turno de Claude es el culpable

Recién acá tiene sentido abrir la caja negra, y en este orden:

1. **Contexto acumulado.** Reiniciar la sesión y volver a medir los mismos
   mensajes. Si `turno_claude_ms` cae fuerte, era esto: la respuesta es
   reiniciar periódicamente, no tocar Airtable.
2. **Round trips de Airtable.** El protocolo pide encadenar `search_bases` →
   `list_tables_for_base` → `get_table_schema` → `list_records`, y cada eslabón
   es un turno completo de inferencia. Si el bot arma los catálogos del
   formulario en cada mensaje, ahí hay round trips que se pueden cachear.
3. **Cola serial.** Correlacionar los `turno_claude_ms` altos con mensajes de
   otras personas en la misma ventana de tiempo.

## Nota aparte: lentitud real vs. lentitud percibida

Son dos problemas distintos y conviene no mezclarlos.

El indicador "escribiendo…" se manda **una sola vez** por mensaje entrante
(`server.ts`, en `handleInbound`). Telegram lo expira a los ~5 segundos. Si un
turno tarda 25 s, la persona ve "escribiendo…" 5 segundos y después 20 segundos
de silencio: se percibe como que el bot se colgó, no como que está trabajando.

Repetir el `sendChatAction` cada ~4 s hasta que salga la respuesta no hace al
bot más rápido, pero cambia lo que se siente. Es una decisión separada de este
diagnóstico y no está incluida en este cambio.
