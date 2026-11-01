// Prueba de regresión del Mini App: que un nombre venido de Airtable no pueda
// convertirse en HTML dentro del formulario.
//
// Por qué existe. El bot arma la URL del Mini App con ?d=<JSON>, y de ahí salen
// el nombre del subproducto (`sp.n`) y la unidad (`u`). Esos dos valores se
// pegaban dentro de `resumen.innerHTML` sin escapar, así que un "<img
// src=x onerror=...>" escrito en el campo `Subproducto de producción` de
// Airtable se ejecutaba en el webview de quien abriera el formulario — y desde
// ahí se puede llamar a Telegram.WebApp.sendData(), es decir registrar una
// producción falsa firmada por esa persona. Arreglado el 30-oct-2026 con esc().
//
// Las dos últimas pruebas no son de seguridad: verifican que el escapado no
// rompió lo que se ve (la negrita del rendimiento, la unidad, el veredicto de
// límite). Si alguna falla, el fix se pasó de la raya.
//
// Cómo correrla (necesita playwright + un Chromium; en esta máquina vienen
// preinstalados y se alcanzan con NODE_PATH):
//
//   NODE_PATH=/opt/node22/lib/node_modules node pruebas/xss-miniapp.cjs
//
// Para comprobar que la prueba de verdad detecta el bug, correrla contra una
// copia vieja del archivo:
//
//   git show <commit-anterior>:index.html > /tmp/antes.html
//   PAGINA=/tmp/antes.html NODE_PATH=... node pruebas/xss-miniapp.cjs   # 5 fallas

const path = require('path');
const { chromium } = require('playwright');
const PAGE = 'file://' + (process.env.PAGINA || path.join(__dirname, '..', 'index.html'));

const STUB = `
  window.__xss = false;
  window.Telegram = { WebApp: {
    ready(){}, expand(){}, sendData(d){ window.__enviado = d; },
    showAlert(m){ window.__alerta = m; },
    MainButton: { setText(){}, show(){}, hide(){}, onClick(f){ window.__onClick = f; } },
  }};
`;

async function abrir(ctx, datos) {
  const page = await ctx.newPage();
  await page.addInitScript(STUB);
  await page.goto(PAGE + '?d=' + encodeURIComponent(JSON.stringify(datos)));
  return page;
}

// Rellena el input cuyo rótulo (.nombre) empieza con `rotulo`.
async function poner(page, rotulo, valor) {
  const n = await page.evaluate(([rotulo, valor]) => {
    const filas = Array.from(document.querySelectorAll('.row'));
    let tocados = 0;
    for (const f of filas) {
      const nom = f.querySelector('.nombre');
      if (!nom || !nom.textContent.startsWith(rotulo)) continue;
      const i = f.querySelector('input');
      if (!i) continue;
      i.value = valor;
      i.dispatchEvent(new Event('input', { bubbles: true }));
      tocados++;
    }
    return tocados;
  }, [rotulo, valor]);
  if (n === 0) throw new Error('no encontré el campo: ' + rotulo);
}

const resumen = (page) => page.evaluate(() => {
  const c = document.querySelectorAll('.calc');
  const r = c[c.length - 1];
  return { html: r.innerHTML, texto: r.textContent, imgs: r.querySelectorAll('img,script').length };
});

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const fallos = [];
  const ok = (c, m) => { if (!c) fallos.push(m); console.log((c ? 'OK   ' : 'FALLA') + '  ' + m); };

  const PAYLOAD = '<img src=x onerror="window.__xss=true">';

  // 1. proteina / subproducto: nombre hostil en datos.sp.n
  {
    const p = await abrir(ctx, { tipo: 'proteina', t: 'MORRILLO', s: 'PRE-001', p: 'A',
      sp: { k: 'PRE-900', n: PAYLOAD + 'CALDO', lim: { est: 500, min: 400, max: 600 } } });
    await poner(p, 'Nº de recetas', '1');
    await poner(p, 'Peso inicial crudo', '1000');
    await poner(p, 'Peso limpio', '800');
    await poner(p, 'Porciones resultantes', '10');
    await poner(p, PAYLOAD + 'CALDO', '500');
    await p.waitForTimeout(100);
    const r = await resumen(p);
    ok((await p.evaluate(() => window.__xss)) === false, 'sp.n: no se ejecutó el onerror');
    ok(r.imgs === 0, 'sp.n: no se inyectó ningún <img>/<script> en el resumen');
    ok(r.texto.includes(PAYLOAD + 'CALDO'), 'sp.n: el nombre se muestra literal como texto');
    await p.close();
  }

  // 2. receta / unidad hostil en datos.u (cae al fallback de UNIDADES)
  {
    const p = await abrir(ctx, { tipo: 'receta', t: 'SRIRACHA', s: 'PRE-086', u: PAYLOAD,
      lim: { est: 530, min: 450, max: 610 } });
    await poner(p, 'Nº de recetas', '1');
    await poner(p, 'Cantidad producida', '530');
    await p.waitForTimeout(100);
    const r = await resumen(p);
    ok((await p.evaluate(() => window.__xss)) === false, 'datos.u: no se ejecutó el onerror');
    ok(r.imgs === 0, 'datos.u: no se inyectó ningún <img>/<script> en el resumen');
    await p.close();
  }

  // 3. caso normal: nada se rompio
  {
    const p = await abrir(ctx, { tipo: 'proteina', t: 'MORRILLO', s: 'PRE-001', p: 'A',
      sp: { k: 'PRE-900', n: 'CALDO DE BIRRIA', lim: { est: 500, min: 400, max: 600 } } });
    await poner(p, 'Nº de recetas', '1');
    await poner(p, 'Peso inicial crudo', '1000');
    await poner(p, 'Peso limpio', '800');
    await poner(p, 'Porciones resultantes', '10');
    await poner(p, 'CALDO DE BIRRIA', '500');
    await p.waitForTimeout(100);
    const r = await resumen(p);
    ok(r.texto.includes('CALDO DE BIRRIA'), 'normal: el subproducto aparece en el resumen');
    ok(!r.html.includes('&amp;amp;'), 'normal: no hay doble escapado');
    console.log('       resumen proteina: ' + r.texto.trim());
    await p.close();
  }

  {
    const p = await abrir(ctx, { tipo: 'receta', t: 'SRIRACHA', s: 'PRE-086', u: 'g',
      lim: { est: 530, min: 450, max: 610 } });
    await poner(p, 'Nº de recetas', '1');
    await poner(p, 'Cantidad producida', '530');
    await p.waitForTimeout(100);
    const r = await resumen(p);
    ok(r.html.includes('<b>'), 'normal: el <b> del rendimiento sigue en negrita');
    ok(r.texto.includes('530 g por receta'), 'normal: la unidad "g" se muestra bien');
    ok(r.texto.includes('dentro del rango'), 'normal: el veredicto de límite sigue saliendo');
    console.log('       resumen receta:  ' + r.texto.trim());
    await p.close();
  }

  await b.close();
  console.log(fallos.length ? '\n' + fallos.length + ' FALLAS' : '\nTodo en verde');
  process.exit(fallos.length ? 1 : 0);
})();
