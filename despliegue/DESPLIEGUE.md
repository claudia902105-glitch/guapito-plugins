# Dejar el bot definitivo en el servidor de Google

Tres cosas hacen que un bot sea "definitivo", y ninguna es escribir más código:

1. **Versiones fijas** — que reinstalar no cambie lo que corre.
2. **Arranque supervisado** — que se levante solo al rebootear y después de un
   crash, sin que nadie entre por SSH.
3. **Una verificación que se pueda correr** — que se pueda demostrar que quedó
   bien, en vez de suponerlo.

Este documento es para hacerlas en ese orden. Los pasos 0 y 3 no son relleno:
el 0 es lo que permite volver atrás y el 3 es lo que distingue "lo desplegué"
de "funciona".

---

## Lo primero que hay que entender (y que rompe la idea obvia)

La idea obvia sería un servicio de systemd que corra `bun server.ts`. **No
funciona, y falla en silencio.**

`server.ts` es un servidor MCP por **stdio**: habla por stdin/stdout con una
sesión de Claude Code, y tiene un watchdog que lo apaga en cuanto stdin se
cierra o cambia de padre (está al final de `server.ts`, puesto a propósito para
que no quede un bot zombie reteniendo el token). Bajo systemd stdin es
`/dev/null`, así que el watchdog dispara en el primer tick y el proceso se mata
solo. No hay error llamativo: el bot simplemente no contesta.

Lo que hay que mantener vivo es **la sesión de Claude Code**. Ella levanta el
servidor MCP como proceso hijo:

```
systemd → script (pseudo-TTY) → claude --channels … → bun server.ts → Telegram
```

Y de ahí sale el segundo problema. `claude --channels` **necesita una terminal
de verdad**. Lanzado sin TTY se cae a los 15-20 segundos con
`Input must be provided either through stdin or as a prompt argument`. Está
reportado dos veces y ninguno de los dos tickets tiene fix publicado:

- [anthropics/claude-code#40726](https://github.com/anthropics/claude-code/issues/40726)
  — exactamente este caso: `--channels` bajo systemd, sin TTY, muere a los
  15-20 s. Cerrado como duplicado, no como resuelto.
- [anthropics/claude-code#36001](https://github.com/anthropics/claude-code/issues/36001)
  — la causa de fondo: la interfaz de terminal de Claude Code pide *raw mode*
  sobre stdin y falla cuando stdin es una tubería. Cerrado por inactividad,
  "not planned".

Por eso el unit de este repo envuelve el comando en `script`, que le da un
pseudo-TTY. Es la opción que mejor se deja supervisar; **no está garantizada**,
y el Paso 3 está diseñado para detectar en 2 minutos si no alcanzó. Si no
alcanza, el Plan B (tmux) está al final.

---

## Paso 0 — Anotar qué hay HOY, antes de tocar nada

Sin esto no hay vuelta atrás, y además hace falta para el paso 1: fijar
versiones significa elegir *cuáles*, y la respuesta correcta depende de qué
está corriendo ahora mismo.

```sh
cd ~/guapito-plugins        # o donde esté el repo

# Qué commit está desplegado
git rev-parse --short HEAD && git status --short

# Qué versiones de las dos dependencias están realmente instaladas
cat node_modules/@modelcontextprotocol/sdk/package.json | grep '"version"'
cat node_modules/grammy/package.json | grep '"version"'

# Qué runtime y qué CLI
bun --version
claude --version
which claude

# Cómo arranca hoy la sesión (el comando exacto, con el nombre del plugin)
ps -ef | grep -i 'claude\|bun server' | grep -v grep
history | grep -- '--channels' | tail -5

# Hace cuánto está viva la sesión. Esto responde solo la pregunta de
# septiembre: si lleva días, la lentitud de Alicia puede ser contexto
# acumulado y nada más.
ps -eo pid,etime,cmd | grep -i claude | grep -v grep
```

Guardá esa salida en un archivo antes de seguir. Es el único punto de retorno.

---

## Paso 1 — Versiones fijas

### El problema

`package.json` pedía `"@modelcontextprotocol/sdk": "^1.0.0"`. El `^` quiere
decir "cualquier 1.x". Hoy un `bun install` limpio trae la **1.32.2**. O sea:
el `start` del repo corre `bun install` en cada arranque, y cada arranque podía
traer una versión distinta de la anterior sin que nadie lo pidiera. Un bot que
cambia de dependencias solo no es definitivo, es una lotería.

### El arreglo, y las tres formas de hacerlo

| | Qué hace | Riesgo |
| --- | --- | --- |
| **A. Solo lockfile** | `bun.lock` versionado fija todo, incluidas las dependencias de las dependencias. | Si alguien borra el lockfile o corre `bun update`, el `^1.0.0` vuelve a abrirse. |
| **B. Lockfile + versiones exactas** (lo que quedó hecho) | Además `package.json` dice `1.32.2` y `1.46.0`, sin `^`. Reproducible incluso sin lockfile. | Las actualizaciones pasan a ser manuales. Un parche de seguridad de grammy **no llega solo**: hay que subirlo a mano. |
| **C. Dejarlo como estaba** | Nada. | Cada reinicio puede traer una versión nueva. Es lo que ya estaba pasando. |

Quedó **B**, más `--frozen-lockfile` en el script `start`: si alguien edita
`package.json` sin regenerar el lockfile, el bot **no arranca** y lo dice. Falla
ruidosa en vez de deriva silenciosa.

### El riesgo concreto de este paso — leerlo antes de desplegar

Las versiones que quedaron fijadas (SDK **1.32.2**, grammy **1.46.0**) son las
que resuelve un install limpio hoy. **Puede que el servidor esté corriendo
otras**, probablemente más viejas. Si es así, este despliegue no es solo "fijar
versiones": es también **actualizar** el SDK, quizá por varias decenas de
versiones menores, justo mientras se investiga una lentitud.

Eso confunde el diagnóstico: si después del despliegue el bot va distinto, no
se sabrá si fue el cambio de versión o algo más.

El Paso 0 dice qué hay instalado. Según eso:

- **Si coincide** con 1.32.2 / 1.46.0 → listo, este despliegue no cambia nada
  de dependencias.
- **Si no coincide** → hay dos caminos, y es una decisión, no un detalle:
  - *Fijar lo que ya corre* (conservador): poner en `package.json` las versiones
    del Paso 0, correr `bun install`, versionar ese lockfile. El despliegue no
    altera comportamiento. Es lo que yo elegiría si el objetivo inmediato es
    entender la lentitud.
  - *Fijar lo nuevo* (lo que está commiteado): se gana estar al día, se paga con
    una variable más en el diagnóstico.

---

## Paso 2 — Instalar el servicio

```sh
cd ~/guapito-plugins
git fetch origin && git checkout <la rama o el tag que vayas a dejar fijo>
bun install --frozen-lockfile        # debe terminar sin tocar el lockfile

# Editar las 4 líneas marcadas EDITAR en el unit (usuario, directorio, PATH y
# el comando con el nombre exacto del plugin) y copiarlo:
sudo cp despliegue/guapito-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
```

**Antes de arrancarlo, bajar la sesión que está viva.** El token de Telegram
admite un solo consumidor: dos sesiones a la vez dan `409 Conflict` y el bot
deja de contestar a las dos.

```sh
tmux ls                 # si está en tmux
tmux kill-session -t <la que sea>
ps -ef | grep claude | grep -v grep     # confirmar que no quedó nada
```

Recién ahora:

```sh
sudo systemctl enable --now guapito-bot
```

---

## Paso 3 — Verificar (2 minutos, y son los que importan)

Los tres chequeos buscan tres fallas distintas. El primero es el que atrapa el
problema del TTY.

**1. Que sobreviva los 20 segundos.** La caída por falta de TTY pasa a los
15-20 s, así que un `systemctl status` inmediato diría "active" y mentiría.

```sh
sleep 45 && systemctl status guapito-bot --no-pager
```

Tiene que decir `active (running)` y el contador de reinicios en 0. Si dice
`activating (auto-restart)` o el contador sube, el pseudo-TTY no alcanzó: ir al
Plan B.

**2. Que el canal esté conectado.** Que el proceso viva no quiere decir que el
bot escuche. Si el nombre del plugin en `ExecStart` está mal, la sesión arranca
sin canal y no hay error.

```sh
journalctl -u guapito-bot --since "-2min" | grep -i 'telegram\|channel'
```

Y la prueba de verdad: **escribirle al bot desde Telegram** y ver que contesta.

**3. Que sobreviva un reboot.** Es la mitad del sentido de usar systemd y es lo
que no se prueba casi nunca.

```sh
sudo reboot
# al volver:
systemctl status guapito-bot --no-pager && sleep 45 && systemctl is-active guapito-bot
```

### Y de paso, cerrar el diagnóstico de septiembre

> **Esto depende del PR #1**, que todavía no está mergeado. La
> instrumentación (`TELEGRAM_TIMING`) y el analizador (`analizar-timing.ts`)
> viven ahí, no en esta rama. El unit ya trae la variable puesta: hasta que el
> PR entre, no hace nada ni rompe nada. Si querés medir la latencia en el mismo
> despliegue, mergeá el PR #1 **antes** del Paso 2.

El unit ya trae `TELEGRAM_TIMING=1`. Después de unas horas de uso normal:

```sh
cd ~/guapito-plugins
journalctl -u guapito-bot --since "-4h" | bun analizar-timing.ts
```
Devuelve el veredicto directo — qué tramo se está comiendo el tiempo — sin
tener que leer JSON a mano. Hacen falta al menos 10 respuestas reales para que
el promedio signifique algo.

---

## Paso 4 — Volver atrás

```sh
sudo systemctl disable --now guapito-bot
cd ~/guapito-plugins
git checkout <el commit del Paso 0>
bun install
tmux new-session -d -s guapito '<el comando del Paso 0>'
```

---

## Plan B — tmux, si el pseudo-TTY no alcanzó

tmux da una terminal real y es la variante con más evidencia de que funciona.
Lo que se pierde es supervisión: systemd ve al cliente de tmux, no a la sesión,
así que `Restart=always` deja de ser confiable y hay que mirar `tmux ls` para
saber si sigue viva.

En el unit, reemplazar el bloque `ExecStart` por:

```ini
Type=forking
ExecStart=/usr/bin/tmux new-session -d -s guapito "claude --channels plugin:telegram@claude-plugins-official"
ExecStop=/usr/bin/tmux kill-session -t guapito
```

Ventaja práctica de este plan: `tmux attach -t guapito` muestra la sesión por
dentro, que es justo lo que no se puede ver con `script`.

---

## Lo que este documento NO resuelve

Decirlo explícito para que no se descubra tarde:

- **Autenticación.** `claude` necesita su login (claude.ai o clave de Console)
  en el `$HOME` del usuario del servicio. Si el servicio corre como un usuario
  distinto del que hizo el login a mano, arranca y no autentica. El Paso 0 pide
  el usuario actual por esto.
- **Confianza del directorio.** En el primer arranque en un directorio nuevo,
  Claude Code pregunta si confía en él — y una pregunta interactiva bajo
  systemd cuelga el arranque. Si pasa, el journal lo muestra;
  `CLAUDE_TRUST_WORKSPACE=1` en el unit lo saltea.
- **`--channels` es research preview.** Los flags y el protocolo pueden cambiar
  entre versiones de Claude Code. Fijar las dependencias del plugin no fija
  eso. Conviene anotar en el Paso 0 qué `claude --version` quedó funcionando.
- **Cuánto cuesta tener esto prendido.** Es el ítem (2), y va aparte en
  `CONSUMOS.md`.
