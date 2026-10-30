# Auditoría de datos y consumos

Qué dato va a dónde, cuánto se queda, quién lo puede ver, y dónde está el
medidor de cada costo.

---

## Primero: la pregunta tal como estaba planteada no da con el gasto

El pedido original era "establecer consumos en el google cloud". El problema es
que en Google Cloud no está el gasto que importa:

| Dónde | Qué se gasta ahí | Cómo se paga |
| --- | --- | --- |
| **Google Cloud (la VM)** | CPU y disco de una máquina que casi no hace nada: el bot espera en un `getUpdates` la mayor parte del tiempo. | Tarifa fija por hora encendida. No sube porque Alicia escriba más. |
| **Inferencia de Claude** | **Acá está el gasto variable.** Cada mensaje de Telegram abre un turno de Claude que lee contexto, llama a Airtable y escribe. | Por tokens. Sube con cada mensaje y con cada hora que la sesión lleva abierta sin reiniciar. |
| **Airtable** | Lecturas y escrituras de registros. | Plan fijo por asiento, con topes de registros y de 5 req/s por base. Más uso no es más plata hasta chocar un tope. |

O sea: un presupuesto con alertas en Google Cloud mediría la parte que no se
mueve. Por eso el medidor que hay que mirar primero es el de inferencia, y la
auditoría de datos se hace sobre el recorrido completo, no sobre la VM.

---

## El recorrido completo

```
Alicia (Telegram)
   │  texto, fotos, documentos
   ▼
Telegram (servidores de Telegram, afuera)
   │  long-poll getUpdates
   ▼
server.ts  ── escribe en disco: inbox/, access.json, bot.pid
   │         ── escribe en el journal: ids y errores
   │  notificación MCP por stdio
   ▼
sesión de Claude Code  ── acá se gasta la inferencia
   │  MCP de Airtable
   ▼
Airtable (nube, afuera)

            y aparte, para los formularios:
server.ts ──► botón web_app con la URL del Mini App + ?d=<JSON>
                 │
                 ▼
            index.html servido como página web pública
                 │  fetch catalogos/*.json
                 ▼
            Telegram.WebApp.sendData() ──► vuelve como mensaje normal
```

## Inventario: qué dato va a dónde

| Dato | De dónde sale | Por dónde pasa | Dónde queda | Hasta cuándo | Quién lo puede ver |
| --- | --- | --- | --- | --- | --- |
| Texto de los mensajes | Telegram | server.ts → notificación MCP → sesión de Claude | En el contexto de la sesión. **No se escribe a disco.** | Hasta que la sesión se reinicia | Quien tenga la sesión o el SSH de la VM |
| Fotos y documentos enviados al bot | Telegram | server.ts los baja con el token | `~/.claude/channels/telegram/inbox/` | **Para siempre: nada los borra** (ver hallazgo 2) | Cualquiera con acceso al `$HOME` del usuario del servicio |
| IDs numéricos de Telegram y códigos de pareo | Telegram | `gate()` en cada mensaje | `~/.claude/channels/telegram/access.json`, permisos 600 | Hasta que se saquen a mano (los pareos pendientes expiran solos) | Dueño del archivo y root |
| Token del bot | BotFather | se lee al arrancar | `~/.claude/channels/telegram/.env`, forzado a 600 | Hasta que se rote | Dueño del archivo y root. **Quien lo tenga es el bot** |
| PID del poller | el proceso | — | `bot.pid` | Se borra al apagar | — |
| IDs, largos y milisegundos | server.ts | stderr | journal de systemd | Lo que diga la rotación del journal (`journalctl --disk-usage`) | Cualquiera con `journalctl` |
| Nombres, SKUs y tolerancias de producción | Airtable | la sesión los pone en `?d=<JSON>` dentro de la URL del Mini App | En la URL: la ve Telegram, el teléfono y los logs de quien sirva la página | Lo que retenga cada uno | Telegram y el hosting de la página |
| Catálogos (`catalogos/*.json`) | Airtable, exportados a mano | el repo | GitHub, repo **público** | Para siempre, con historial | **Cualquiera en internet** (ver hallazgo 1) |
| Pesos, mermas, recetas producidas | el formulario | `sendData()` → mensaje normal → sesión → MCP de Airtable | Airtable | Lo que retenga Airtable | Quien tenga acceso a la base |

### Lo que NO sale

Vale decirlo porque es lo que más se asume mal:

- El texto de los mensajes **no se escribe a disco** en ningún punto de
  `server.ts`. Vive en el contexto de la sesión y en el servidor de Telegram.
- La instrumentación de latencia (PR #1) **no registra texto**: solo ids,
  cantidad de caracteres y milisegundos. Está escrito así a propósito.
- El token del bot nunca llega al navegador ni al Mini App. La página no lo
  necesita y no lo ve.

---

## Tres hallazgos del inventario

### 1. El repositorio es público, y los catálogos están adentro

Verificado hoy contra la API de GitHub: `"private": false`,
`"has_pages": true`. En el repo están versionados:

- `catalogos/menu1.json` — 36 preparaciones con SKU y tolerancias
  (`lim: {est, min, max}`, el rendimiento esperado por receta)
- `catalogos/fruver.json` — 60 frutas y verduras con código

O sea: la lista de SKUs y los rendimientos esperados de producción de El Guapo
son legibles por cualquiera en internet, y quedan en el historial de git aunque
después se saquen.

Esto **no es un bug**: es consecuencia necesaria de cómo funciona el Mini App.
La página necesita el catálogo y no puede traerlo de Airtable (no tiene
credenciales, y no debería tenerlas). Y el repo tiene que ser público para que
GitHub Pages lo sirva sin pagar plan.

Lo que sí es, es una **decisión que conviene tomar a ojos abiertos**. Tres
caminos:

| | Qué implica | Riesgo |
| --- | --- | --- |
| **Dejarlo así** | Cero trabajo. Son nombres de producto y gramajes, no datos personales ni precios ni proveedores. | Un competidor ve el recetario a nivel de rendimiento. El historial de git además muestra cómo cambiaron las tolerancias en el tiempo. |
| **Repo privado + Pages de pago** | El catálogo deja de ser público. | Cuesta plata, y la página sigue sirviendo los JSON a cualquiera que tenga la URL: Pages privado no autentica a los visitantes. Resuelve menos de lo que parece. |
| **Sacar los catálogos del repo** y servirlos desde la VM detrás de algo | Control real sobre quién los lee. | Es la opción con más trabajo: hay que montar y mantener un servidor web, y el Mini App necesita HTTPS válido. |

No pude confirmar desde este contenedor que la URL de Pages esté sirviendo
(la política de red del contenedor bloquea ese host). Un segundo, desde
cualquier navegador: abrir
`https://claudia902105-glitch.github.io/guapito-plugins/catalogos/menu1.json`.
Si muestra el JSON, está público.

### 2. `inbox/` crece para siempre

Cada foto y cada documento que alguien le manda al bot se baja a
`~/.claude/channels/telegram/inbox/` con nombre `<timestamp>-<id>.<ext>`, y
**nada los borra nunca**. No hay límite de tamaño, ni de antigüedad, ni una
tarea de limpieza. Grepear `INBOX_DIR` en `server.ts` da cuatro usos: dos
`mkdirSync` y dos `writeFileSync`. Ningún borrado.

Dos problemas en uno:

- **Dato que se acumula sin que nadie lo decidiera.** Cualquier foto que el
  personal le haya mandado al bot sigue en la VM.
- **Disco.** Es la falla silenciosa clásica: el disco se llena, Claude Code no
  puede escribir y el bot deja de contestar sin un error que apunte a esto.

Medirlo hoy, antes de decidir nada:

```sh
du -sh ~/.claude/channels/telegram/inbox/
ls -1 ~/.claude/channels/telegram/inbox/ | wc -l
df -h ~
```

Si son pocos megas, no hay urgencia pero sí una bomba de tiempo. El arreglo
barato es un `systemd-tmpfiles` o un cron que borre lo de más de N días; el
arreglo correcto es que `server.ts` limpie al arrancar. Lo dejo sin hacer a
propósito: primero hay que ver el número y decidir el N.

### 3. El `?d=` viaja en la URL

El payload del formulario (nombre del producto, SKU, tolerancias) va como query
string de la URL del Mini App. Las URLs se loguean en más lugares que los
cuerpos de los mensajes: las ve Telegram, quedan en el teléfono y pasan por los
logs de quien sirva la página (hoy, GitHub).

Es negocio, no datos personales, y el límite de ~2.048 caracteres de Telegram
ya obligó a sacar los catálogos de la URL (de ahí los `catalogos/*.json`). Lo
anoto para que esté en el inventario, no como algo a arreglar.

---

## Los medidores: dónde está cada número

| Qué medir | Dónde se lee | Se puede hoy |
| --- | --- | --- |
| **Costo de inferencia** (el que importa) | Consola de Anthropic, página de uso, de la cuenta con la que `claude` está autenticado en la VM | Sí |
| Volumen: mensajes y respuestas por día, caracteres por turno | journal del servicio, con la instrumentación del PR #1 | **Depende del PR #1** |
| Cuánto lleva viva la sesión (proxy del contexto acumulado) | `ps -eo pid,etime,cmd \| grep claude` | Sí, y es gratis |
| Costo de la VM | Facturación de Google Cloud | Sí |
| Uso de Airtable | Plan y límites de la base en Airtable | Sí |
| Disco ocupado por `inbox/` y por el journal | `du -sh`, `journalctl --disk-usage` | Sí |

### Lo que no se puede medir desde este repo, y por qué

`server.ts` **no puede ver el costo de un turno**. El turno de Claude pasa en el
proceso padre: el servidor MCP ve entrar el mensaje y ve salir la respuesta, y
en el medio hay una caja negra que incluye el prompt del sistema, el contexto
acumulado, las llamadas a Airtable y sus resultados.

Por eso no hay acá un script que estime dólares. **Se podría** multiplicar
caracteres por un precio por token, y daría un número con aire de exactitud y
equivocado por mucho: lo que domina la cuenta no es el mensaje de Alicia (unas
decenas de tokens) sino el contexto que lo rodea (miles). Un estimador así no
ayudaría a decidir nada.

Lo que sí sirve, y es la división de tareas honesta:

- **El número real** sale de la consola de Anthropic. Es el único lugar donde
  está bien.
- **La explicación del número** sale del volumen local: cuántos turnos por día,
  de qué chat, con cuántos caracteres. Eso contesta "¿por qué subió?" y es lo
  que habilita el PR #1.
- **La palanca más grande no es el volumen, es el reinicio.** Contexto
  acumulado hace que el mismo mensaje cueste más caro el martes que el lunes.
  Un reinicio diario corta eso, y es la línea `RuntimeMaxSec` que quedó
  comentada en el unit de systemd esperando tu decisión. Es también la
  hipótesis sin probar de la lentitud que reportó Alicia: si es contexto, el
  reinicio arregla las dos cosas de una.

---

## Para empezar: cinco comandos

Correr esto en la VM y pegar la salida es suficiente para cerrar la auditoría
con números en vez de suposiciones:

```sh
# 1. Hace cuánto está viva la sesión (la palanca de costo más grande)
ps -eo pid,etime,cmd | grep -i claude | grep -v grep

# 2. Cuánto dato acumulado hay en inbox
du -sh ~/.claude/channels/telegram/inbox/ && ls -1 ~/.claude/channels/telegram/inbox/ | wc -l

# 3. Cuánto queda de disco (la falla silenciosa)
df -h ~

# 4. Cuánto journal hay guardado
journalctl --disk-usage

# 5. Quién tiene acceso hoy
cat ~/.claude/channels/telegram/access.json
```

Y en el navegador, el chequeo del hallazgo 1:
`https://claudia902105-glitch.github.io/guapito-plugins/catalogos/menu1.json`

---

## Decisiones que quedan abiertas

1. **Catálogos públicos** — dejarlo, privado + Pages de pago, o servirlos desde
   la VM. Mi lectura: dejarlo, pero sabiéndolo. El costo de las otras dos no se
   paga con lo que protegen.
2. **Retención de `inbox/`** — hace falta el número del comando 2 para elegir el
   N de días.
3. **Reinicio diario** — es la palanca de costo y la prueba de la hipótesis de
   latencia, al precio de poder cortarle un hilo a Alicia de madrugada.
