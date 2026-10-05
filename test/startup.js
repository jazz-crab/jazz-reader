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

/** Минимальный CDP-клиент: держит одно соединение, шлёт методы по id. */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connect failed')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (!m.id || !pending.has(m.id)) return;
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error)));
    else res(m.result);
  };
  const send = (method, params) => ready.then(() => new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(method + ': CDP timeout')); }, 15000);
    pending.set(id, {
      res: (r) => { clearTimeout(timer); res(r); },
      rej: (e) => { clearTimeout(timer); rej(e); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  }));
  return {
    send,
    close: () => { try { ws.close(); } catch {} },
    evaluate: (expression) => send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }).then((r) => {
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    }),
  };
}

/** Минимальный CDP-клиент: Runtime.evaluate с returnByValue. */
function evaluate(wsUrl, expression) {
  return cdp(wsUrl).evaluate(expression);
}

(async function main() {
  console.log('== запуск реального окна ==');

  // Файл с формулами: если рендер сломан, .katex в DOM не появится.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazz-reader-startup-'));
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

  // Каталог с двумя вложенными заметками — для проверки дерева.
  const notesDir = path.join(tmpDir, 'notes');
  fs.mkdirSync(path.join(notesDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(notesDir, 'one.md'), '# one\n', 'utf8');
  fs.writeFileSync(path.join(notesDir, 'sub', 'two.md'), '# two\n', 'utf8');
  fs.writeFileSync(path.join(notesDir, 'readme.txt'), 'не md\n', 'utf8');

  const port = await freePort();
  const child = spawn(electron, [
    ROOT,
    '--remote-debugging-port=' + port,
    '--no-sandbox',
    '--disable-gpu',
    // Окно не показываем: тесты не должны выскакивать поверх работы.
    '--jazzreader-hidden',
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

  // ---------------------------------------------------------- вёрстка колонки
  // Регресссия: `.content > *` задавал margin-left/right: auto, а у h1-h6,
  // ul, ol, pre, table, blockquote были свои правила с шорткатом `margin: X 0`,
  // который обнулял центровку. В итоге на широком окне абзацы уезжали в
  // центр колонки, а заголовки и списки оставались у левого края — разъезд
  // около 290px, который был виден в заметке.
  //
  // Проверять надо на ШИРОКОМ окне: при узком (меньше 900px + отступы)
  // max-width не срабатывает, блоки просто занимают всю ширину и баг
  // не проявляется. Поэтому сначала расширяем вьюпорт через CDP.
  console.log('\n== вёрстка колонки (широкое окно) ==');
  const client = cdp(page.webSocketDebuggerUrl);
  try {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1700, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(500);
  } catch (e) {
    console.log('  (не удалось расширить вьюпорт: ' + e.message + ')');
  }

  const layout = JSON.parse(await client.evaluate(`JSON.stringify((() => {
    const c = document.getElementById('content');
    const rows = Array.from(c.children).map((el) => {
      const s = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        left: el.offsetLeft,
        w: el.offsetWidth,
        ml: s.marginLeft,
      };
    });
    // Ширина колонки берётся из настройки, а не из дефолта: проверка живёт
    // на настоящем settings.json, где у человека может стоять своё значение.
    return {
      contentW: c.clientWidth,
      rows,
      colW: parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--content-max-width')) || 0,
    };
  })())`));
  client.close();

  t('вьюпорт действительно широкий', layout.contentW > 1000, 'contentW=' + layout.contentW);

  const lefts = [...new Set(layout.rows.map((r) => r.left))];
  t('все блоки колонки выровнены по левому краю', lefts.length === 1,
    'разные offsetLeft: ' + JSON.stringify(layout.rows.map((r) => r.tag + '@' + r.left + '(ml=' + r.ml + ')')));

  const wide = layout.rows.filter((r) => r.w > 0);
  const maxW = wide.length ? Math.max(...wide.map((r) => r.w)) : 0;
  // Проверяем сам инвариант «блоки не шире заданной колонки», а не дефолтное
  // число: настройка ширины колонки принадлежит пользователю, и проверка
  // падала всякий раз, когда он её менял.
  t('колонка чтения ограничена по ширине (max-width работает)',
    layout.colW > 0 && maxW <= layout.colW,
    'блок ' + maxW + 'px, колонка ' + layout.colW + 'px');

  // Главное: окно не просто существует, а видимо. show:false + регресс
  // titleBarOverlay как раз давали «процесс жив, окна нет».
  // ------------------------------------------------- дерево папок
  // Регресс: renderTree() писал дерево в #paneFiles внутри СКРЫТОГО
  // #workspace (его показывал renderActive только когда открыт файл).
  // Итог: «Папка» визуально ничего не делала, дерево «появлялось» только
  // вместе с первым открытым файлом.
  //
  // Системный диалог выбора папки из теста не открыть, поэтому зовём
  // window.__mdvTest.addFolder() — он идёт через настоящий IPC listMd
  // в главный процесс и читает настоящий каталог с диска.
  console.log('\n== дерево папок ==');
  const c2 = cdp(page.webSocketDebuggerUrl);
  const tree = JSON.parse(await c2.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!window.__mdvTest) return JSON.stringify({ hook: false });
    // Закрываем все вкладки: сценарий «открыл папку, файл ещё не открывал».
    // С открытым файлом #workspace и так виден и баг не проявляется.
    for (const id of [...window.__mdvTest.tabs.keys()]) {
      await window.__mdvTest.closeTab(id);
    }
    await sleep(300);
    const noFileState = {
      workspaceHidden: document.getElementById('workspace').hidden,
      welcomeHidden: document.getElementById('welcome').hidden,
      tabs: document.querySelectorAll('.tab').length,
    };
    await window.__mdvTest.addFolder(__NOTES_DIR__);
    await sleep(300);
    const pane = document.getElementById('paneFiles');
    return JSON.stringify({
      hook: true,
      noFileState,
      welcomeHiddenAfterFolder: document.getElementById('welcome').hidden,
      workspaceHidden: document.getElementById('workspace').hidden,
      welcomeHidden: document.getElementById('welcome').hidden,
      roots: pane.querySelectorAll('.tree-root').length,
      items: pane.querySelectorAll('.tree-item').length,
      groups: pane.querySelectorAll('.tree-grp').length,
      emptyShown: !!pane.querySelector('.tree-empty'),
      svgIcons: pane.querySelectorAll('svg.ico-svg').length,
      rootLabel: (pane.querySelector('.tree-root span') || {}).textContent || null,
    });
  })()`.replace('__NOTES_DIR__', JSON.stringify(notesDir))));
  c2.close();

  t('хук автотестов доступен', tree.hook === true);
  t('до «Папка» не было открыто ни одного файла',
    tree.noFileState && tree.noFileState.workspaceHidden === true
    && tree.noFileState.welcomeHidden === false,
    JSON.stringify(tree.noFileState));
  t('после открытия папки рабочая область показана', tree.workspaceHidden === false,
    'workspaceHidden=' + tree.workspaceHidden);
  t('дерево нарисовано (корни)', tree.roots >= 1, 'roots=' + tree.roots);
  t('после «Папка» на пустой вкладке нет заглушки (видно дерево)',
    tree.welcomeHiddenAfterFolder === true,
    'welcomeHidden=' + tree.welcomeHiddenAfterFolder);
  t('в дереве есть файлы', tree.items >= 2, 'items=' + tree.items);
  t('вложенная папка видна отдельной группой', tree.groups >= 1, 'groups=' + tree.groups);
  t('заглушка «Папка не открыта» исчезла', tree.emptyShown === false);
  t('иконки файлов и папок — SVG', tree.svgIcons >= 2, 'svg=' + tree.svgIcons);
  t('в шапке дерева видно имя папки', /notes/.test(tree.rootLabel || ''), 'label=' + tree.rootLabel);

  t('процесс жив после загрузки', !exited);

  console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL\n');
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('startup.js упал:', e && e.stack || e);
  process.exit(1);
});
