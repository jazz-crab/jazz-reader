'use strict';
/*
 * Регрессия на «тихий» запуск: главный процесс поднимается, окно создаётся,
 * контент реально отрисован.
 *
 * Именно этот тест ловит баг, из-за которого portable-exe с MDView
 * «запускался и молчал»: setTitleBarOverlay() бросал исключение внутри
 * app.whenReady().then() без catch, окно не создавалось, процесс висел
 * бесконечно — и все тесты проходили, потому что renderMd/KaTeX проверялись
 * в Node, а main.js на Windows вообще никто не запускал.
 *
 * Тест чёрный: поднимаем настоящий Electron, цепляемся к нему по CDP и смотрим
 * на живой DOM. Работает на Windows/macOS; на Linux нужен xvfb (xvfb-run -a).
 *
 *   node test/startup.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const electron = require('electron');   // строка с путём к electron.exe / electron

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function waitForPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* ещё не поднялся */ }
    await sleep(300);
  }
  return null;
}

/** Минимальный CDP-клиент: Runtime.evaluate с returnByValue. */
function evaluate(wsUrl, expression) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} ; rej(new Error('CDP timeout')); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (m.result && m.result.exceptionDetails) rej(new Error(JSON.stringify(m.result.exceptionDetails)));
      else res(m.result.result.value);
    };
    ws.onerror = (e) => { clearTimeout(timer); rej(new Error('CDP error: ' + (e.message || 'unknown'))); };
  });
}

(async function main() {
  console.log('== запуск реального окна ==');

  // Файл с формулами: если рендер сломан, .katex в DOM не появится.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdview-startup-'));
  const sample = path.join(tmpDir, 'sample.md');
  fs.writeFileSync(sample, [
    '# Заголовок',
    '',
    'Инлайн $E = mc^2$ и блок:',
    '',
    '$$',
    '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
    '$$',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
  ].join('\n'), 'utf8');

  const port = await freePort();
  const child = spawn(electron, [
    ROOT,
    '--remote-debugging-port=' + port,
    '--no-sandbox',
    '--disable-gpu',
    sample,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString(); });
  child.stdout.on('data', (b) => { stderr += b.toString(); });

  const cleanup = () => {
    try { child.kill(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', cleanup);

  let exited = false;
  child.on('exit', () => { exited = true; });

  const page = await waitForPage(port, 25000);

  t('процесс не упал сразу', !exited || !!page, exited ? 'вышел сразу:\n' + stderr.slice(-800) : '');

  if (!page) {
    t('окно создано и страница загрузилась', false,
      'CDP не ответил за 25 c — окна нет. Процесс жив: ' + !exited
      + ' (типичный «тихий» запуск: процесс висит, окно не создано)\n' + stderr.slice(-800));
    console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL\n');
    cleanup();
    process.exit(1);
  }

  t('окно создано и страница загрузилась', true);

  // Страница может ещё быть на about:blank — ждём, пока renderer дойдёт до
  // нашего index.html и догрузит файл.
  const PROBE = `JSON.stringify((() => {
    const content = document.getElementById('content');
    const html = content ? content.innerHTML : '';
    return {
      url: location.href,
      title: document.title,
      ready: document.readyState,
      tabbar: !!document.getElementById('tabbar'),
      content: html,
      // Для проверки «сырой LaTeX не утёк» берём видимый текст без
      // MathML-аннотаций: KaTeX кладёт исходник в <annotation>, и он законно
      // попадает в textContent (на этом работает копирование формул).
      // В innerHTML исходник тоже есть — в атрибуте data-tex.
      text: (() => {
        const c = content && content.cloneNode(true);
        if (!c) return '';
        c.querySelectorAll('annotation').forEach((n) => n.remove());
        return c.textContent;
      })(),
      katex: document.querySelectorAll('.katex').length,
      mathErr: document.querySelectorAll('.mdv-math-error').length,
      leftovers: (html.match(/MDVMATH/g) || []).length,
      tables: document.querySelectorAll('table').length,
      h1: document.querySelectorAll('h1').length,
      api: typeof window.mdv,
      katexLib: typeof window.katex,
      markedLib: typeof window.marked,
    };
  })())`;

  let d = null;
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    d = JSON.parse(await evaluate(page.webSocketDebuggerUrl, PROBE));
    if (d.ready === 'complete' && /sample\.md/.test(d.title)) break;
    if (exited) break;
    await sleep(400);
  }

  t('renderer догрузил файл (readyState complete)', d.ready === 'complete',
    'ready=' + d.ready + ' url=' + d.url);
  t('заголовок окна содержит имя файла', /sample\.md/.test(d.title), 'title=' + d.title);
  t('каркас интерфейса на месте (поле вкладок)', d.tabbar === true);
  t('bridge window.mdv доступен', d.api === 'object', 'typeof=' + d.api);
  t('marked загрузился', d.markedLib === 'object', 'typeof=' + d.markedLib);
  t('katex загрузился', d.katexLib === 'object', 'typeof=' + d.katexLib);

  t('markdown отрисован (h1)', d.h1 >= 1, 'h1=' + d.h1);
  t('таблица отрисована', d.tables >= 1, 'tables=' + d.tables);
  t('формулы отрисованы KaTeX', d.katex >= 2, 'katex=' + d.katex);
  t('ошибок KaTeX нет', d.mathErr === 0, 'mathErr=' + d.mathErr);
  t('плейсхолдеры все заменены', d.leftovers === 0, 'leftovers=' + d.leftovers);
  t('сырой LaTeX не утёк в видимый текст', !/\\frac|\\int|\\sqrt|\\infty/.test(d.text),
    'text=' + JSON.stringify(d.text.slice(0, 200)));
  t('формулы отрисованы глифами, а не буквами', /[∫∞√π]/.test(d.text),
    'text=' + JSON.stringify(d.text.slice(0, 200)));
  t('исходник TeX сохранён в data-tex', /\\frac/.test(d.content));

  // Главное: окно не просто существует, а видимо. show:false + регресс
  // titleBarOverlay как раз давали «процесс жив, окна нет».
  t('процесс жив после загрузки', !exited);

  console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL\n');
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('startup.js упал:', e && e.stack || e);
  process.exit(1);
});
