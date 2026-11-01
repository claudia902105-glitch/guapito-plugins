# Protección del sistema

Qué se arregló, qué se revisó y quedó bien, y las dos decisiones que no son
mías.

---

## Arreglado

### 1. Inyección de HTML en el Mini App (lo único que era un bug)

El bot arma la URL del formulario con `?d=<JSON>`. De ahí salían dos valores
que se pegaban dentro de `resumen.innerHTML` **sin escapar**:

- `sp.n` — el nombre del subproducto, que el bot toma del campo
  `Subproducto de producción` de Airtable (modo proteína)
- `u` — la unidad. `UNIDADES` funciona como lista blanca, pero el *fallback*
  era el valor crudo del payload, así que una unidad que no fuera `g` ni `und`
  llegaba tal cual (modo receta)

**Qué permitía.** Escribir `<img src=x onerror="...">` en ese campo de Airtable
y que el navegador lo ejecute dentro del webview de quien abra el formulario.
Desde ahí se puede llamar a `Telegram.WebApp.sendData(...)`, que es la vía por
la que el formulario manda datos: o sea, **registrar una producción falsa
firmada por la persona que abrió el formulario**.

**Qué no permitía.** Robar el token del bot: el token no vive en la página y la
página no lo necesita. El riesgo es de **integridad del dato**, no de
credenciales.

**Probabilidad: baja.** Hay que poder escribir en Airtable para disparar esto,
y quien puede escribir en Airtable ya puede meter datos falsos directamente,
por la puerta de adelante. Lo que agrega es alcance: el payload malicioso se
ejecuta en el teléfono de otra persona y queda firmado con su nombre.

**Arreglo:** un helper `esc()` al lado de `miles()`, aplicado en los dos
lugares. En el modo proteína se escapa **solo el nombre** — el `vv.txt` del
veredicto de límite es HTML a propósito y tiene que seguir siéndolo.

**Prueba de regresión:** `pruebas/xss-miniapp.cjs` maneja el formulario en un
Chromium sin cabeza con un payload hostil y verifica las dos mitades: que no se
ejecute nada, y que el escapado no haya roto lo que se ve (la negrita del
rendimiento, la unidad, el veredicto). Contra el `index.html` anterior da 5
fallas; contra el actual, verde.

```sh
NODE_PATH=/opt/node22/lib/node_modules node pruebas/xss-miniapp.cjs
```

### 2. Los patrones de mención, acotados

`mentionPatterns` son expresiones regulares que se compilaban **en cada mensaje**
y se corrían contra el texto completo, sobre el loop de polling, que es de un
solo hilo: el tiempo que tarda una, lo esperan todos los demás chats.

Ahora cada patrón se compila una vez y se prueba solo contra los primeros 1000
caracteres. Medido en node 22, contra una tira de `a`:

| Patrón | Texto | Antes | Ahora |
| --- | --- | --- | --- |
| `a*a*b` (cuadrático) | 4000 chars | 9466 ms | 167 ms |
| `(a\|a)*b` (exponencial) | 28 chars | 2659 ms | igual: el tope no ayuda |

Dicho con precisión, porque la diferencia es grande: el tope convierte el
accidente cuadrático —el común— en algo imperceptible, y contra un patrón
exponencial **no sirve de nada**. En JavaScript no hay forma síncrona de
ponerle un límite de tiempo a una regex.

Así que el control de verdad está antes: no poner patrones con cuantificadores
anidados ni alternancias ambiguas. Queda avisado en ACCESS.md. Y conviene ser
claro sobre la forma del problema: **el patrón lo pone la operadora, no
Telegram**. Es un arma que apunta a los propios pies, no un agujero que alguien
de afuera pueda abrir solo.

---

## Revisado y está bien

Vale listarlo: la mitad del valor de una revisión es saber qué ya se miró.

| Qué | Veredicto |
| --- | --- |
| Los otros 7 `innerHTML` de `index.html` | Seguros. Líneas 197, 254 y 518 son texto fijo; 271 usa la tabla `UNIDADES`, no el payload; 1250 asigna `''`; 1693 y 1908 solo reciben números por `miles()`/`redondear()`. |
| El autocompletado de mermas | Seguro: usa `textContent`, no `innerHTML`. |
| Los nombres en las filas del formulario | Seguros: `filaSimple()` y `filaSalsa()` hacen `n.textContent = nombre`. |
| El token del bot | `~/.claude/channels/telegram/.env`, forzado a 600 al arrancar. Nunca llega al navegador. |
| Envío de archivos | `assertSendable()` se niega a mandar cualquier cosa bajo el directorio de estado salvo `inbox/`: la allowlist y el `.env` no se pueden exfiltrar pidiéndole al bot que los mande. |
| Nombres de archivo subidos | `safeName()` saca `[<>\[\]\r\n;]`. |
| Todas las herramientas de salida | Pasan por `assertAllowedChat()`. |
| Mutaciones de acceso vía chat | Imposibles por diseño: el skill `/telegram:access` solo actúa sobre pedidos tipeados en la terminal, justamente porque un mensaje de Telegram puede traer inyección de prompt. |

---

## Decisión abierta 1 — quién puede aprobar permisos desde Telegram

**Esto es lo más importante de este documento.**

Cuando la sesión de Claude necesita permiso para usar una herramienta, el bot
manda botones de Allow/Deny a Telegram. El chequeo de quién puede tocarlos es
este (`bot.on('callback_query:data')`):

```ts
if (!access.allowFrom.includes(senderId)) { /* Not authorized */ }
```

O sea: **cualquiera que esté en la allowlist de DMs puede aprobar cualquier
permiso de herramienta.** La misma lista que habilita a usar el bot habilita a
decir sí a lo que la sesión pida ejecutar. Lo mismo vale por la vía de texto
(`y <código>` / `n <código>`).

Si en `allowFrom` está solo vos, no hay nada que decidir. Si están Alicia y
otras personas de cocina —que es el caso probable, porque es lo que les permite
usar el formulario— entonces **usar el bot y administrar la máquina son hoy el
mismo permiso**. Alicia no tiene por qué saber qué está aprobando, y el prompt
que le llega no se lo explica en esos términos.

Para ver quién está hoy:

```sh
cat ~/.claude/channels/telegram/access.json
```

Tres caminos:

| | Qué implica | Riesgo |
| --- | --- | --- |
| **Dejarlo así** | Cero trabajo. Si el bot queda con pocos permisos pedidos, casi no aparece. | Una persona de cocina puede aprobar una acción que no entiende. No hay registro de quién aprobó qué más allá del journal. |
| **Separar las listas** — una `allowFrom` para usar el bot y una `approveFrom` para aprobar permisos | Es el arreglo correcto: devuelve la decisión a quien corresponde. | Toca `server.ts`, `ACCESS.md` y el skill. No es enorme, pero es un cambio de superficie de configuración y conviene que vaya en su propio PR. |
| **Apagar la aprobación por Telegram** | Lo más seguro y lo más simple. | Cada permiso hay que aprobarlo por SSH. Si nadie está mirando, el bot se queda esperando y para Alicia parece que no contesta. |

Mi lectura: si en `allowFrom` hay más de una persona, la segunda opción vale el
PR. Pero el dato que decide es la salida de ese `cat`, y ese dato no lo tengo.

---

## Decisión abierta 2 — `TELEGRAM_STATE_DIR` vacío rompe el arranque

Menor, y preexistente. En la línea 60, `STATE_DIR` se resuelve con `??`, que
atrapa `undefined` pero **no** la cadena vacía. Si en el unit de systemd queda
`Environment=TELEGRAM_STATE_DIR=` (fácil de dejar así al editar), el arranque
muere con `ENOENT: no such file or directory, mkdir` y el mensaje no dice por
qué.

No lo toqué: es un arreglo de dos caracteres pero está fuera de lo que se pidió,
y mezclarlo con el resto hace más difícil ver qué cambió. Lo anoto porque el
unit nuevo es exactamente la situación donde aparecería.

---

## Lo que queda sin cubrir

- **El dato que ya está en Airtable.** Nada de esto valida lo que se escribió
  antes. Si el arreglo del punto 1 llegó tarde, se vería en los registros, no
  en el código.
- **Retención de `inbox/`.** Está en `CONSUMOS.md`, hallazgo 2.
- **Los catálogos públicos.** Está en `CONSUMOS.md`, hallazgo 1. No es una falla
  de código, es una decisión sobre qué queda a la vista.
