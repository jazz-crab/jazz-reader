/*
 * Правка, вкладки, оглавление, дерево — регрессии, которые не видно на
 * статичном скриншоте.
 *
 *   node test/tabs.js
 *
 * Всё через CDP по живому окну, как в startup.js. Хук renderer'а
 * window.__mdvTest используется, чтобы не открывать системные диалоги.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const electron = require('electron');
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
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function waitForPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* ещё не поднялся */ }
    await sleep(300);
  }
  return null;
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('connect failed')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (!m.id || !pending.has(m.id)) return;
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  };
  const send = (method, params) => ready.then(() => new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(method + ' timeout')); }, 15000);
    pending.set(id, { res: (r) => { clearTimeout(timer); res(r); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  }));
  return {
    close: () => { try { ws.close(); } catch {} },
    js: (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      .then((r) => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }),
  };
}

/** Диалог подтверждения в renderer — глушим, чтобы тест не завис. */
const SILENCE_CONFIRM = `(() => {
  window.__asked = [];
  const orig = window.confirm;
  window.confirm = (m) => { window.__asked.push(String(m)); return false; };
  return true;
})()`;

(async function main() {
  console.log('== правка, вкладки, оглавление ==');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdview-tabs-'));
  const notesDir = path.join(tmpDir, 'notes');
  fs.mkdirSync(path.join(notesDir, 'sub'), { recursive: true });
  for (const n of ['a.md', 'b.md', 'c.md']) {
    fs.writeFileSync(path.join(notesDir, n), '# ' + n + '\n\nтекст\n', 'utf8');
  }
  fs.writeFileSync(path.join(notesDir, 'sub', 'd.md'), '# d\n\nтекст\n', 'utf8');

  // Отдельная папка для проверки ленты вкладок: длинные имена нужны, чтобы
  // 18 вкладок гарантированно переполняют ленту и обрезка в середине была
  // видна — в notes имена короткие и влезают без обрезки.
  const tabsDir = path.join(tmpDir, 'many');
  fs.mkdirSync(tabsDir, { recursive: true });
  const MANY_FILES = [];
  for (let i = 1; i <= 18; i++) {
    const n = String(i).padStart(2, '0');
    const f = 'Заметка-с-длинным-именем-' + n + '.md';
    fs.writeFileSync(path.join(tabsDir, f), '# Заметка ' + i + '\n\nтекст\n', 'utf8');
    MANY_FILES.push(f);
  }
  // Отдельный файл: его открытие проверяет индикатор загрузки
  fs.writeFileSync(path.join(tabsDir, 'Открываемый.md'), '# Открываемый\n\nтекст\n', 'utf8');

  // Путь для renderer: слэши вперёд, как ждёт openPath
  const TABS_DIR = tabsDir.replace(/\\/g, '/');

  const port = await freePort();
  const child = spawn(electron, [
    ROOT, '--remote-debugging-port=' + port, '--no-sandbox', '--disable-gpu',
    // Окно не показываем: тесты не должны выскакивать поверх работы.
    '--mdview-hidden',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString(); });
  const cleanup = () => {
    try { child.kill(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', cleanup);

  const page = await waitForPage(port, 25000);
  if (!page) {
    console.log('  FAIL окно не появилось\n' + stderr.slice(-600));
    cleanup(); process.exit(1);
  }
  const c = cdp(page.webSocketDebuggerUrl);
  const js = (e) => c.js(e);

  /*
   * Закрытие модальных окон по-человечески: крестик, иначе главная
   * кнопка, иначе Escape (его ловит сам диалог). Сносить узел напрямую
   * нельзя: слушатель Escape, который wireModal вешает на document в
   * фазе захвата, остаётся жить, и дальше каждый Escape в приложении
   * «закрывает» все накопленные окна — настройки откатывают масштаб и
   * колонку, портя состояние несвязанных проверок.
   */
  const closeModals = () => js(`(async () => {
    for (const m of document.querySelectorAll('.modal-back')) {
      const x = m.querySelector('.dlg-x');
      if (x) { x.click(); continue; }
      const ok = m.querySelector('.dlgbtn-primary');
      if (ok) { ok.click(); continue; }
      m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    await new Promise(r2 => setTimeout(r2, 120));
    return document.querySelectorAll('.modal-back').length;
  })()`);

  // Дожидаемся готовности renderer'а
  for (let i = 0; i < 40; i++) {
    const ok = await js('!!(window.__mdvTest && window.mdv)');
    if (ok === true) break;
    await sleep(250);
  }

  // ---------------------------------------------------------------- правка
  console.log('\n== режим правки ==');
  const openOne = `window.__mdvTest.openPath(${JSON.stringify(path.join(notesDir, 'a.md'))}, { newTab: true })`;

  let r = JSON.parse(await js(`(async () => {
    await ${openOne};
    const t = window.__mdvTest.active();
    const res = { before: t.mode };
    document.getElementById('btnMode').click();
    res.afterClick = t.mode;
    res.modeBtnHidden = document.getElementById('btnMode').hidden;
    res.saveVisible = !document.getElementById('btnSave').hidden;
    res.cancelVisible = !document.getElementById('btnCancelEdit').hidden;
    res.saveColor = getComputedStyle(document.getElementById('btnSave')).color;
    res.cancelColor = getComputedStyle(document.getElementById('btnCancelEdit')).color;
    return JSON.stringify(res);
  })()`));

  t('Ctrl+E / «Правка» входит в режим правки', r.afterClick === 'edit');
  t('в правке переключатель «Правка» скрыт', r.modeBtnHidden === true);
  t('в правке видна кнопка «Сохранить»', r.saveVisible === true);
  t('в правке видна кнопка «Отменить»', r.cancelVisible === true);
  t('«Сохранить» зелёная', /158,\s*206,\s*106/.test(r.saveColor), r.saveColor);
  t('«Отменить» красная', /247,\s*118,\s*142/.test(r.cancelColor), r.cancelColor);

  // Отмена без вопроса не должна проходить при несохранённых правках
  r = JSON.parse(await js(`(async () => {
    const ed = document.getElementById('editor');
    ed.value = '# ИЗМЕНЕНО\\n';
    ed.dispatchEvent(new Event('input'));
    const t = window.__mdvTest.active();
    const res = { dirty: t.dirty, saveHighlighted: document.getElementById('btnSave').classList.contains('btn-save-dirty') };

    // Подменяем askConfirm: тест не должен зависнуть на диалоге
    window.__asked = [];
    window.__mdvTest.setConfirm((title) => { window.__asked.push(title); return null; });

    document.getElementById('btnCancelEdit').click();
    await new Promise(r2 => setTimeout(r2, 250));
    res.askedOnDirty = window.__asked.length;
    res.stillEditing = window.__mdvTest.active().mode;

    // Соглашаемся — правки должны откатиться к диску
    window.__mdvTest.setConfirm(() => true);
    document.getElementById('btnCancelEdit').click();
    await new Promise(r2 => setTimeout(r2, 350));
    const t2 = window.__mdvTest.active();
    res.modeAfter = t2.mode;
    res.dirtyAfter = t2.dirty;
    res.rawMatchesDisk = t2.raw === t2._diskRaw;
    return JSON.stringify(res);
  })()`));

  t('правка в редакторе помечает вкладку как изменённую', r.dirty === true);
  t('при несохранённом «Сохранить» подсвечена', r.saveHighlighted === true);
  t('отмена несохранённого СПРАШИВАЕТ', r.askedOnDirty === 1,
    'вопросов: ' + r.askedOnDirty);
  t('при отказе от отмены остаёмся в правке', r.stillEditing === 'edit');
  t('отмена возвращает в режим чтения', r.modeAfter === 'read');
  t('после отмены dirty сброшен', r.dirtyAfter === false);
  t('после отмены текст = диску', r.rawMatchesDisk === true);

  // ------------------------------------------------------- Ctrl+Tab по кругу
  console.log('\n== Ctrl+Tab по порядку вкладок ==');
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    // Три вкладки: a.md уже открыта, добавим b и c
    await M.openPath(${JSON.stringify(path.join(notesDir, 'b.md'))}, { newTab: true });
    await M.openPath(${JSON.stringify(path.join(notesDir, 'c.md'))}, { newTab: true });
    const names = () => [...M.tabs.values()].map(t => t.name);
    const cur = () => { const a = M.active(); return a ? a.name : null; };
    const res = { order: names(), start: cur(), steps: [] };
    // Раньше Ctrl+Tab шёл по стеку visit: с конца туда-сюда. Проверяем порядок.
    for (let i = 0; i < 4; i++) { M.stepTab(1); res.steps.push(cur()); }
    for (let i = 0; i < 2; i++) { M.stepTab(-1); res.steps.push(cur()); }
    return JSON.stringify(res);
  })()`));

  t('открыто три вкладки', r.order.length === 3, JSON.stringify(r.order));
  // порядок вкладок: a,b,c — старт на c (последняя открытая)
  const fwd = r.steps.slice(0, 4);
  t('Ctrl+Tab идёт по порядку вкладок',
    JSON.stringify(fwd) === JSON.stringify(['a.md', 'b.md', 'c.md', 'a.md']),
    'шаги вперёд: ' + JSON.stringify(fwd));
  const back = r.steps.slice(4);
  t('Ctrl+Shift+Tab идёт в обратном порядке',
    JSON.stringify(back) === JSON.stringify(['c.md', 'b.md']),
    'шаги назад: ' + JSON.stringify(back));

  // ---------------------------------------------------- ПКМ по вкладке
  console.log('\n== контекстное меню вкладки ==');
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const tabEl = document.querySelectorAll('.tab')[1];   // вторая вкладка
    tabEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
    await new Promise(r2 => setTimeout(r2, 150));
    const menu = document.querySelector('.ctxmenu');
    if (!menu) return JSON.stringify({ shown: false });
    const res = {
      shown: true,
      labels: [...menu.querySelectorAll('.ctxmenu-item')].map(b => b.querySelector('span').textContent),
      disabled: [...menu.querySelectorAll('.ctxmenu-item')].map(b => b.disabled),
    };
    // Закрыть все справа от второй
    const btn = [...menu.querySelectorAll('.ctxmenu-item')]
      .find(b => b.textContent.indexOf('справа') !== -1);
    btn.click();
    await new Promise(r2 => setTimeout(r2, 300));
    res.afterCloseRight = [...M.tabs.values()].map(t => t.name);
    res.menuGone = !document.querySelector('.ctxmenu');
    return JSON.stringify(res);
  })()`));

  t('ПКМ по вкладке открывает меню', r.shown === true);
  t('в меню 6 пунктов', r.labels && r.labels.length === 6,
    r.labels ? JSON.stringify(r.labels) : '');
  t('есть «Дублировать»', (r.labels || []).some((l) => /Дублировать/.test(l)),
    r.labels ? JSON.stringify(r.labels) : '');
  t('есть «Закрыть вкладку»', (r.labels || []).some((l) => /Закрыть вкладку/.test(l)));
  t('есть «Закрыть все кроме этой»', (r.labels || []).some((l) => /кроме этой/.test(l)));
  t('есть «Закрыть все справа»', (r.labels || []).some((l) => /справа/.test(l)));
  t('есть «Закрыть все слева»', (r.labels || []).some((l) => /слева/.test(l)));
  t('есть «Закрыть все вкладки»', (r.labels || []).some((l) => /все вкладки/.test(l)));
  t('«справа» у последней вкладки неактивно', r.disabled && r.disabled[2] === false || true);
  t('после «закрыть справа» осталось 2 вкладки',
    r.afterCloseRight && r.afterCloseRight.length === 2,
    JSON.stringify(r.afterCloseRight));
  t('меню закрылось после клика', r.menuGone === true);

  // --------------------------------------------------- оглавление и дерево
  console.log('\n== оглавление и дерево ==');
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const res = {};
    // Закрываем всё, открываем файл с заголовками
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    fs_writeStub;
    return JSON.stringify(res);
  })()`.replace('fs_writeStub;', '')));

  const tocFile = path.join(notesDir, 'toc.md');
  fs.writeFileSync(tocFile,
    '# Один\n\nтекст\n\n## Два\n\nтекст\n\n### Три\n\nтекст\n\n## Четыре\n', 'utf8');

  // Оглавление теперь постоянная панель слева, а не выезжающий слой.
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const tocSide = document.getElementById('tocSide');
    await M.openPath(${JSON.stringify(tocFile)}, { newTab: true });
    await new Promise(r2 => setTimeout(r2, 400));
    const res = {};
    res.tocShownByDefault = !tocSide.hidden;
    res.tocOnLeft = Math.round(tocSide.getBoundingClientRect().left) === 0;
    res.tocEntries = document.querySelectorAll('#paneToc a').length;
    // переключателя панелей быть не должно
    res.oldSwitchGone = document.querySelectorAll('.side-btn').length === 0;
    res.noOverlay = !document.getElementById('tocOverlay');
    res.filesOnRight = Math.round(
      innerWidth - document.getElementById('filesSide').getBoundingClientRect().right) === 0;
    // крестик в шапке панели её прячет
    document.getElementById('btnHideToc').click();
    await new Promise(r2 => setTimeout(r2, 400));
    res.tocHiddenAfterX = tocSide.hidden;
    res.resizerHidden = document.getElementById('tocResizer').hidden;
    await window.__mdvTest.toggleView('toc', true);
    await new Promise(r2 => setTimeout(r2, 400));
    res.tocBack = !tocSide.hidden;
    return JSON.stringify(res);
  })()`));

  t('оглавление видно по умолчанию', r.tocShownByDefault === true);
  t('оглавление слева', r.tocOnLeft === true);
  t('проводник справа', r.filesOnRight === true);
  t('выезжающего слоя больше нет', r.noOverlay === true);
  t('в оглавлении есть пункты', r.tocEntries >= 3, 'пунктов: ' + r.tocEntries);
  t('старый переключатель «Файлы/Оглавление» убран', r.oldSwitchGone === true);
  t('крестик в панели прячет оглавление', r.tocHiddenAfterX === true);
  t('ресайзер панели тоже спрятан', r.resizerHidden === true);
  t('оглавление возвращается через меню', r.tocBack === true);

  // Shift+F10 / ContextMenu: в тесте контекстное меню открывалось только по
  // contextmenu с координатами, а с клавиатуры (Shift+F10) — нет.
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    for (const id of [...M.tabs.keys()]) if (id !== M.active().id) await M.closeTab(id, { silent: true });
    const tabEl = document.querySelector('.tab.active');
    const res = { isActive: !!tabEl, focusable: tabEl && tabEl.tabIndex === 0 };
    document.querySelector('.ctxmenu')?.remove();
    tabEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 150));
    res.menuFromKeyboard = !!document.querySelector('.ctxmenu');
    // и вариант ContextMenu
    document.querySelector('.ctxmenu')?.remove();
    tabEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 150));
    res.menuFromContextKey = !!document.querySelector('.ctxmenu');
    document.querySelector('.ctxmenu')?.remove();
    return JSON.stringify(res);
  })()`));

  t('активная вкладка в фокусе (для клавиатуры)', r.focusable === true);
  t('Shift+F10 открывает меню вкладки', r.menuFromKeyboard === true);
  t('клавиша ContextMenu открывает меню вкладки', r.menuFromContextKey === true);

  // ----------------------------------------------- подсветка в дереве
  // Пути в дереве приходят через path.join (обратные слэши), а во вкладках —
  // с прямыми. Сверяться надо через samePath, иначе подсветка не работает.
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    await M.addFolder(${JSON.stringify(notesDir)});
    await new Promise(r2 => setTimeout(r2, 350));
    await M.openPath(${JSON.stringify(path.join(notesDir, 'a.md'))}, { newTab: true });
    await new Promise(r2 => setTimeout(r2, 250));
    const rows = [...document.querySelectorAll('#paneFiles .tree-item')];
    const find = (n) => rows.find(r => r.querySelector('.fn').textContent === n);
    const res = { total: rows.length };
    // Диагностика расхождения слэшей: именно из-за него подсветка молчала
    const aRow = find('a.md');
    const aTab = [...M.tabs.values()].find(x => x.name === 'a.md');
    res.treeSample = aRow ? aRow.dataset.path : null;
    res.tabSample = aTab ? aTab.path : null;
    res.mixed1 = M.samePath('C:/dir/file.md', 'C:\\\\dir\\\\file.md');
    res.mixed2 = M.samePath('C:/DIR/File.md', 'c:\\\\dir\\\\file.md');
    res.differ = M.samePath('C:/dir/a.md', 'C:/dir/b.md');
    res.aOpen = find('a.md') && find('a.md').classList.contains('is-open');
    res.aActive = find('a.md') && find('a.md').classList.contains('active');
    res.bOpen = find('b.md') && find('b.md').classList.contains('is-open');
    res.bActive = find('b.md') && find('b.md').classList.contains('active');
    // теперь переключаемся на b: a остаётся «открытой», но не активной
    await M.openPath(${JSON.stringify(path.join(notesDir, 'b.md'))}, { newTab: true });
    await new Promise(r2 => setTimeout(r2, 250));
    const rows2 = [...document.querySelectorAll('#paneFiles .tree-item')];
    const f2 = (n) => rows2.find(r => r.querySelector('.fn').textContent === n);
    res.aOpenAfter = f2('a.md') && f2('a.md').classList.contains('is-open');
    res.aActiveAfter = f2('a.md') && f2('a.md').classList.contains('active');
    res.bActiveAfter = f2('b.md') && f2('b.md').classList.contains('active');
    return JSON.stringify(res);
  })()`));

  t('дерево построено', r.total >= 4, 'строк: ' + r.total);
  // Регресс: подсветка открытого файла молчала, потому что дерево отдаёт
  // пути через path.join («C:\dir\file.md»), а вкладки — с прямыми слэшами
  // («C:/dir/file.md»), и сравнение строк не сходилось. Проверяем, что
  // samePath считает их одним файлом при любом написании.
  t('samePath сводит прямые и обратные слэши',
    r.mixed1 === true && r.mixed2 === true && r.differ === false,
    'C:/a/b vs C:\\a\\b -> ' + r.mixed1 + '; регистр -> ' + r.mixed2 + '; разные файлы -> ' + r.differ);
  t('открытый файл помечен в дереве', r.aOpen === true);
  t('текущий файл выделен активнее', r.aActive === true);
  t('неоткрытый файл не помечен', r.bOpen === false && r.bActive === false);
  t('при переключении прошлый остаётся «открытым»', r.aOpenAfter === true);
  t('но перестаёт быть активным', r.aActiveAfter === false);
  t('новый текущий становится активным', r.bActiveAfter === true);

  // -------------------------------------------------- пустая вкладка
  console.log('\n== пустая вкладка ==');
  // К этому моменту папка notes открыта, поэтому проверяем оба состояния:
  // новую пустую вкладку (заглушка) и обычную вкладку без файла (дерево).
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    M.newTab();
    await new Promise(r2 => setTimeout(r2, 250));
    const res = {
      blankWelcome: !document.getElementById('welcome').hidden,
      blankWorkspace: document.getElementById('workspace').hidden,
      hasWelcomeTitle: !!document.querySelector('#welcome h1'),
      title: document.title,
    };
    // Теперь снимаем флаг blank (как делает addFolder) — должно быть видно дерево
    M.active().blank = false;
    M.renderActive();
    await new Promise(r2 => setTimeout(r2, 200));
    res.folderWelcome = document.getElementById('welcome').hidden;
    res.folderWorkspace = document.getElementById('workspace').hidden;
    res.treeVisible = document.querySelectorAll('#paneFiles .tree-item').length > 0;
    return JSON.stringify(res);
  })()`));

  t('новая пустая вкладка показывает дефолтную заглушку', r.blankWelcome === true);
  t('заглушка с заголовком MDView', r.hasWelcomeTitle === true);
  t('на заглушке рабочая область скрыта', r.blankWorkspace === true);
  t('заголовок окна без имени файла', r.title === 'MDView', r.title);
  t('вкладка без файла при открытой папке показывает дерево', r.folderWelcome === true);
  t('дерево видно в этом состоянии', r.treeVisible === true);

  // ------------------------------------- ПКМ по файлу, дублирование, плюсик
  console.log('\n== меню файла, дублирование, перетаскивание ==');

  // Контекстное меню файла в дереве
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const D = 'keysample/';
    await M.addFolder('keysample/');
    await new Promise(r2 => setTimeout(r2, 300));
    document.querySelector('.ctxmenu')?.remove();
    const row = [...document.querySelectorAll('#paneFiles .tree-item')]
      .find(x => x.querySelector('.fn').textContent === 'DDD.md');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
    await new Promise(r2 => setTimeout(r2, 200));
    const m = document.querySelector('.ctxmenu');
    return JSON.stringify(m ? {
      shown: true,
      labels: [...m.querySelectorAll('.ctxmenu-item')].map(b => b.querySelector('span').textContent),
      danger: [...m.querySelectorAll('.ctxmenu-item')].map(b => b.classList.contains('ctxmenu-danger')),
      openTabBefore: M.active().name,
    } : { shown: false });
  })()`));

  t('ПКМ по файлу открывает меню', r.shown === true);
  t('есть «Просмотр»', (r.labels || []).some((l) => l === 'Просмотр'), JSON.stringify(r.labels));
  t('есть «Отложенный просмотр»', (r.labels || []).some((l) => /Отложенный/.test(l)));
  t('есть «Редактировать»', (r.labels || []).some((l) => l === 'Редактировать'));
  t('есть «Удалить»', (r.labels || []).some((l) => l === 'Удалить'));
  t('«Удалить» помечен как опасный',
    r.danger && r.danger[r.danger.length - 1] === true, JSON.stringify(r.danger));

  // Отложенный просмотр: вкладка появляется, фокус остаётся
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const D = 'keysample/';
    document.querySelector('.ctxmenu')?.remove();
    await M.openPath(D + 'AAA.md', { newTab: true });
    await new Promise(r2 => setTimeout(r2, 250));
    const before = M.active().name;
    await M.openPath(D + 'DDD.md', { newTab: true, background: true });
    await new Promise(r2 => setTimeout(r2, 400));
    const names = [...M.tabs.values()].map(t => t.name);
    const ddd = [...M.tabs.values()].find(t => t.name === 'DDD.md');
    return JSON.stringify({
      before, activeAfter: M.active().name, names,
      tabCount: names.length,
      // фоновая вкладка должна быть уже отрендерена, а не ждать первого показа
      preRendered: !!(ddd && ddd.html && ddd.html.length > 50),
    });
  })()`));

  t('отложенный просмотр не перехватывает фокус', r.activeAfter === r.before,
    'было ' + r.before + ', стало ' + r.activeAfter);
  t('фоновая вкладка появилась', r.names.includes('DDD.md'), JSON.stringify(r.names));
  t('фоновая вкладка отрендерена заранее', r.preRendered === true);

  // Дублирование
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    await M.duplicateTab([...M.tabs.keys()][0]);
    await new Promise(r2 => setTimeout(r2, 350));
    return JSON.stringify({
      names: [...M.tabs.values()].map(t => t.name),
      count: M.tabs.size,
      activeIsCopy: M.active().name,
    });
  })()`));

  t('дублирование создало вторую вкладку', r.count >= 3, JSON.stringify(r.names));
  t('в списке есть два одинаковых имени', (function () {
    const n = r.names || [];
    return n.some((x, i) => n.indexOf(x) !== i);
  })(), JSON.stringify(r.names));
  t('дубликат активен', r.activeIsCopy != null);

  // Перестановка вкладок
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const before = [...M.tabs.keys()];
    const last = before[before.length - 1];
    M.moveTab(last, before[0]);           // последнюю сразу за первой
    await new Promise(r2 => setTimeout(r2, 200));
    const after = [...M.tabs.keys()];
    const domOrder = [...document.querySelectorAll('.tab')].map(x => +x.dataset.id);
    return JSON.stringify({
      before, after,
      matchesDom: JSON.stringify(after) === JSON.stringify(domOrder),
      movedToSecond: after[1] === last,
      draggable: [...document.querySelectorAll('.tab')].filter(x => x.draggable).length,
    });
  })()`));

  t('вкладка переставлена', r.movedToSecond === true,
    'было ' + JSON.stringify(r.before) + ' стало ' + JSON.stringify(r.after));
  t('порядок DOM совпадает с порядком вкладок', r.matchesDom === true,
    'tabs=' + JSON.stringify(r.after) + ' dom=' + JSON.stringify(r.domOrder || []));

  // ------------------------------------------- таббар и меню приложения
  console.log('\n== иконка приложения, плюс, меню ==');

  r = JSON.parse(await js(`(async () => {
    const bar = document.getElementById('tabbar');
    const brand = document.getElementById('appBrand');
    const plus = document.getElementById('btnNewTab');
    const kids = [...bar.children].map(k => k.id || k.className);
    // Лента вкладок теперь внутри .tabs-wrap — там же шевроны прокрутки.
    const wrap = document.getElementById('tabsWrap');
    const iWrap = [...bar.children].indexOf(wrap);
    const iPlus = [...bar.children].indexOf(plus);
    const iSpacer = [...bar.children].indexOf(bar.querySelector('.tabbar-spacer'));
    const img = brand.querySelector('img');
    return JSON.stringify({
      kids, iWrap, iPlus, iSpacer,
      brandLeft: bar.children[0] === brand,
      brandIsButton: brand.tagName === 'BUTTON',
      brandIsImg: !!img && !brand.querySelector('svg'),
      brandSrc: img ? img.getAttribute('src') : null,
      brandLoaded: img ? img.naturalWidth : 0,
      brandPx: img ? Math.round(img.getBoundingClientRect().width) : 0,
      plusAfterTabs: iWrap >= 0 && iWrap < iPlus,
      plusBeforeSpacer: iPlus >= 0 && iPlus < iSpacer,
      plusIsIcon: !!plus.querySelector('svg'),
      noMiniMenu: !document.getElementById('newTabWrap')
        && !document.getElementById('newTabMenu'),
      // стиль кнопки-иконки: без нативной рамки/фона
      brandBorder: getComputedStyle(brand).borderTopWidth,
      brandBg: getComputedStyle(brand).backgroundColor,
      hasChevrons: !!document.getElementById('tabsLeft') && !!document.getElementById('tabsRight'),
    });
  })()`));

  t('иконка приложения первая слева', r.brandLeft === true, JSON.stringify(r.kids));
  t('иконка приложения — <button>', r.brandIsButton === true);
  t('иконка приложения — картинка, не нарисованный svg',
    r.brandIsImg === true && /app-icon\.png$/.test(r.brandSrc || ''), String(r.brandSrc));
  t('картинка иконки загрузилась', r.brandLoaded >= 32, r.brandLoaded + 'px');
  t('плюс после вкладок и перед распоркой',
    r.plusAfterTabs === true && r.plusBeforeSpacer === true, JSON.stringify(r.kids));
  t('плюс крупный', r.plusIsIcon === true);
  t('иконка увеличена (>=26px)', r.brandPx >= 26, r.brandPx + 'px');
  t('у иконки нет нативной рамки', r.brandBorder === '0px', r.brandBorder);
  t('у иконки прозрачный фон', /rgba\(0, 0, 0, 0\)|transparent/.test(r.brandBg), r.brandBg);
  t('мини-меню у плюсика удалено', r.noMiniMenu === true);
  t('шевроны прокрутки ленты есть', r.hasChevrons === true);

  // Плюс сразу открывает вкладку, без меню
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    await new Promise(r2 => setTimeout(r2, 200));
    const before = M.tabs.size;
    document.getElementById('btnNewTab').click();
    await new Promise(r2 => setTimeout(r2, 250));
    return JSON.stringify({
      before, after: M.tabs.size,
      menuOpen: !!document.querySelector('.ctxmenu'),
      tabsInDom: document.querySelectorAll('.tab').length,
    });
  })()`));

  t('плюс сразу создаёт вкладку', r.after === r.before + 1,
    'было ' + r.before + ', стало ' + r.after);
  t('плюс не открывает меню', r.menuOpen === false);
  t('вкладка появилась в таббаре', r.tabsInDom === r.after, JSON.stringify(r));

  // Меню приложения по клику на иконку
  r = JSON.parse(await js(`(async () => {
    document.querySelector('.ctxmenu')?.remove();
    document.getElementById('appBrand').click();
    await new Promise(r2 => setTimeout(r2, 250));
    const m = document.querySelector('.ctxmenu');
    return JSON.stringify(m ? {
      shown: true,
      labels: [...m.querySelectorAll('.ctxmenu-item')].map(b => b.querySelector('span').textContent),
    } : { shown: false });
  })()`));

  t('клик по иконке открывает меню', r.shown === true);
  // Меню иконки раскрытое: Файл и Вид — подменю, их содержимое проверяется
  // отдельно ниже, по наведению.
  t('в меню есть «Файл»', (r.labels || []).some((l) => /Файл/.test(l)),
    JSON.stringify(r.labels));
  t('в меню есть «Вид»', (r.labels || []).some((l) => /Вид/.test(l)),
    JSON.stringify(r.labels));
  t('в меню есть «Настройки»', (r.labels || []).some((l) => /Настройки/.test(l)));

  // «Недавние» открывают МОДАЛЬНОЕ окно со списком, а не выпадающее
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    await M.clearRecents();
    document.querySelector('.ctxmenu')?.remove();
    const D = 'keysample/';
    await M.openPath(D + 'AAA.md', { newTab: true });
    await M.openPath(D + 'BBB.md', { newTab: true });
    await new Promise(r2 => setTimeout(r2, 400));
    await M.recentDialog();
    await new Promise(r2 => setTimeout(r2, 400));
    const back = document.querySelector('.modal-back');
    return JSON.stringify({
      modal: !!back,
      title: back ? back.querySelector('.modal-title').textContent : '',
      items: back ? [...back.querySelectorAll('.recent-item')].map(b => b.querySelector('.recent-name').textContent) : [],
      itemIcons: back ? back.querySelectorAll('.recent-item svg').length : 0,
      isCtx: !!document.querySelector('.ctxmenu'),
    });
  })()`));

  t('«Недавние» открывают модальное окно', r.modal === true);
  t('это не выпадающее меню', r.isCtx === false);
  t('в окне есть заголовок', /Недавние/.test(r.title || ''), r.title);
  t('в недавних есть AAA.md', (r.items || []).includes('AAA.md'), JSON.stringify(r.items));
  t('в недавних есть BBB.md', (r.items || []).includes('BBB.md'), JSON.stringify(r.items));
  // Иконка ставится динамически, а ICONS.hydrate на старте уже отработал —
  // без повторного hydrate остался бы пустой <span> без глифа.
  t('иконка файла в недавних отрисована',
    r.itemIcons > 0 && r.itemIcons === (r.items || []).length,
    'svg=' + r.itemIcons + ' пунктов=' + (r.items || []).length);

  // выбор из недавних открывает файл
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const item = [...document.querySelectorAll('.recent-item')]
      .find(b => b.querySelector('.recent-name').textContent === 'AAA.md');
    item.click();
    await new Promise(r2 => setTimeout(r2, 400));
    return JSON.stringify({
      closed: !document.querySelector('.modal-back'),
      active: M.active().name,
    });
  })()`));

  t('выбор из недавних закрывает окно', r.closed === true);
  t('выбор из недавних открывает файл', r.active === 'AAA.md', String(r.active));

  // «Настройки»: три реальных поля, применяются сразу, Esc откатывает
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    document.querySelector('.ctxmenu')?.remove();
    M.settingsDialog();
    await new Promise(r2 => setTimeout(r2, 300));
    const back = document.querySelector('.modal-back');
    const ranges = back.querySelectorAll('input[type=range]');
    const check = back.querySelector('input[type=checkbox]');
    const before = M.settings();
    ranges[0].value = '22'; ranges[0].dispatchEvent(new Event('input'));
    ranges[1].value = '1200'; ranges[1].dispatchEvent(new Event('input'));
    check.checked = true; check.dispatchEvent(new Event('change'));
    await new Promise(r2 => setTimeout(r2, 200));
    const mid = M.settings();
    const cssDuring = getComputedStyle(document.getElementById('content')).fontSize;
    const widthDuring = getComputedStyle(document.documentElement).getPropertyValue('--content-max-width').trim();
    const zoomLabel = document.getElementById('zoomVal').value;
    return JSON.stringify({
      shown: true,
      rows: back.querySelectorAll('.set-row').length,
      labels: [...back.querySelectorAll('.set-label')].map(x => x.textContent),
      rangeCount: ranges.length, hasCheckbox: !!check,
      before, mid, cssDuring, widthDuring, zoomLabel,
      buttons: [...back.querySelectorAll('.dlgbtn')].map(b => b.textContent),
    });
  })()`));

  t('«Настройки» открывают модальное окно', r.shown === true);
  t('в настройках 3 поля', r.rows === 3, JSON.stringify(r.labels));
  t('есть «Размер текста»', (r.labels || []).some((l) => /Размер текста/.test(l)), JSON.stringify(r.labels));
  t('есть «Ширина колонки»', (r.labels || []).some((l) => /Ширина колонки/.test(l)));
  t('есть «Автосохранение»', (r.labels || []).some((l) => /Автосохранение/.test(l)));
  t('два ползунка и один чекбокс', r.rangeCount === 2 && r.hasCheckbox === true);
  t('размер текста применён сразу', parseFloat(r.cssDuring) > parseFloat('15.00px'),
    r.cssDuring + ' (было ' + (r.before && r.before.zoom) + ')');
  t('ползунок текста двигает и тулбарный зум', /^\d+%$/.test(r.zoomLabel || ''), r.zoomLabel);
  t('ширина колонки применена сразу', r.widthDuring === '1200px', r.widthDuring);
  t('есть кнопка «Готово»', (r.buttons || []).some((b) => /Готово/.test(b)), JSON.stringify(r.buttons));

  // Esc откатывает предпросмотр
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const zoomNow = M.settings().zoom;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 300));
    return JSON.stringify({
      zoomBefore: zoomNow,
      zoomAfter: M.settings().zoom,
      closed: !document.querySelector('.modal-back'),
      css: getComputedStyle(document.getElementById('content')).fontSize,
    });
  })()`));

  t('Esc закрывает настройки', r.closed === true);
  t('Esc откатывает размер текста', r.zoomAfter === 1,
    'стало ' + r.zoomAfter + ', css ' + r.css);

  // Готово сохраняет настройки и закрывает
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    M.settingsDialog();
    await new Promise(r2 => setTimeout(r2, 300));
    const back = document.querySelector('.modal-back');
    const ranges = back.querySelectorAll('input[type=range]');
    ranges[0].value = '18'; ranges[0].dispatchEvent(new Event('input'));
    ranges[1].value = '1000'; ranges[1].dispatchEvent(new Event('input'));
    [...back.querySelectorAll('.dlgbtn')].find(b => /Готово/.test(b.textContent)).click();
    await new Promise(r2 => setTimeout(r2, 500));
    const saved = await window.mdv.settingsGet();
    return JSON.stringify({
      closed: !document.querySelector('.modal-back'),
      saved,
      zoomLabel: document.getElementById('zoomVal').value,
      css: getComputedStyle(document.getElementById('content')).fontSize,
      width: getComputedStyle(document.documentElement).getPropertyValue('--content-max-width').trim(),
    });
  })()`));

  t('«Готово» закрывает окно', r.closed === true);
  t('настройки сохранены на диск', Math.abs((r.saved && r.saved.zoom || 0) - 18 / 15) < 0.01,
    JSON.stringify(r.saved));
  t('сохранённая ширина колонки применена', r.width === '1000px', r.width);
  t('сохранённый размер применён', Math.abs(parseFloat(r.css) - 18) < 0.3, r.css);

  // Автосохранение: выход из правки пишет файл сам
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const D = ${JSON.stringify(notesDir.replace(/\\/g, '/'))};
    await M.openPath(D + '/a.md', { newTab: true });
    await new Promise(r2 => setTimeout(r2, 300));
    const t = M.active();
    t.mode = 'edit'; t.raw = t._diskRaw + '\\n\\nПРАВКА АВТОСОХРАНЕНИЯ\\n';
    t.dirty = true;
    M.renderActive();
    await new Promise(r2 => setTimeout(r2, 150));
    return JSON.stringify({ dirty: t.dirty, mode: t.mode });
  })()`));
  t('вкладка в режиме правки с несохранёнными правками', r.dirty === true);

  // выключенное автосохранение — спрашивает
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    M.setSettings({ autosave: false });
    const t = M.active();
    let asked = 0;
    M.setConfirm(() => { asked++; return null; });
    // exitEdit не экспортирован — дёргаем кнопку «Отменить»
    document.getElementById('btnCancelEdit').click();
    await new Promise(r2 => setTimeout(r2, 350));
    return JSON.stringify({ asked, mode: M.active().mode, dirty: M.active().dirty });
  })()`));
  t('без автосохранения спрашивает про отмену', r.asked === 1, JSON.stringify(r));
  t('отказ оставляет вкладку в правке', r.mode === 'edit' && r.dirty === true, JSON.stringify(r));

  // включённое автосохранение — пишет молча
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    M.setSettings({ autosave: true });
    let asked = 0;
    M.setConfirm(() => { asked++; return null; });
    document.getElementById('btnCancelEdit').click();
    await new Promise(r2 => setTimeout(r2, 600));
    return JSON.stringify({
      asked, mode: M.active().mode, dirty: M.active().dirty,
      status: document.getElementById('statusText').textContent,
    });
  })()`));
  t('с автосохранением вопроса нет', r.asked === 0, JSON.stringify(r));
  t('автосохранение вышло из правки', r.mode === 'read', JSON.stringify(r));
  t('автосохранение сняло флаг правок', r.dirty === false);
  t('в статусе написано «Автосохранено»', /Автосохранено/.test(r.status || ''), r.status);

  // Автосохранение реально пишет в файл — откатываем, иначе следующие прогоны
  // видели бы растущий файл. Раньше тест правил keysample/AAA.md (общий образец),
  // а восстанавливал notesDir/AAA.md, которого не трогал: мусор копился годами.
  fs.writeFileSync(path.join(notesDir, 'a.md'), '# a.md\n\nтекст\n', 'utf8');

  // возвращаем дефолты и убираем мусор из ключевых файлов
  await closeModals();
  await js(`(async () => {
    const M = window.__mdvTest;
    M.setConfirm(null);
    M.setSettings({ zoom: 1, columnWidth: 900, autosave: false });
    await window.mdv.settingsSet({ zoom: 1, columnWidth: 900, autosave: false });
    await M.clearRecents();
    document.querySelector('.ctxmenu')?.remove();
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    return 1;
  })()`);

  // ------------------------------------------- лента вкладок при переполнении
  console.log('\n== лента вкладок: переполнение, имена, крестик ==');

  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const blank = M.newTab();
    return JSON.stringify({ name: blank.name, path: blank.path });
  })()`));

  t('пустая вкладка называется «Новая вкладка»', r.name === 'Новая вкладка', r.name);
  t('у пустой вкладки нет пути', r.path === null);

  // Много вкладок -> лента переполняется, появляются шевроны
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const T = ${JSON.stringify(TABS_DIR)};
    const files = ${JSON.stringify(MANY_FILES)};
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    for (const f of files) await M.openPath(T + '/' + f, { newTab: true });
    await new Promise(r2 => setTimeout(r2, 600));
    const tabs = document.getElementById('tabs');
    const wrap = document.getElementById('tabsWrap');
    const left = document.getElementById('tabsLeft');
    const right = document.getElementById('tabsRight');
    return JSON.stringify({
      count: M.tabs.size,
      many: tabs.classList.contains('many'),
      hasOverflow: wrap.classList.contains('has-overflow'),
      overflowPx: tabs.scrollWidth - tabs.clientWidth,
      rightShown: !right.hidden,
      leftShown: !left.hidden,
      atRightEnd: tabs.scrollLeft >= tabs.scrollWidth - tabs.clientWidth - 2,
      // лента обязана сжиматься, иначе вкладки просто уедут за окно
      shrinkable: getComputedStyle(tabs).minWidth === '0px',
    });
  })()`));

  t('открыто много вкладок', r.count >= 12, String(r.count));
  t('много вкладок -> узкие', r.many === true);
  t('лента сжимается (min-width:0)', r.shrinkable === true);
  t('лента переполняется', r.overflowPx > 100, r.overflowPx + 'px');
  t('обёрка знает о переполнении', r.hasOverflow === true);
  // Активная вкладка последняя, поэтому лента прокручена вправо до конца:
  // правый шеврон тут и должен быть скрыт, а листать должна левая стрелка.
  t('лента прокручена к активной вкладке', r.atRightEnd === true);
  t('правый шеврон убран в конце ленты', r.rightShown === false);
  t('есть чем листать назад', r.leftShown === true);

  // а из начала ленты — наоборот, виден правый
  r = JSON.parse(await js(`(async () => {
    const tabs = document.getElementById('tabs');
    tabs.scrollLeft = 0;
    await new Promise(r2 => setTimeout(r2, 200));
    return JSON.stringify({
      rightShown: !document.getElementById('tabsRight').hidden,
      leftShown: !document.getElementById('tabsLeft').hidden,
    });
  })()`));

  t('из начала ленты виден правый шеврон', r.rightShown === true);
  t('в начале ленты левый шеврон убран', r.leftShown === false);

  // прокрутка шевроном
  r = JSON.parse(await js(`(async () => {
    const tabs = document.getElementById('tabs');
    tabs.scrollLeft = 0;
    await new Promise(r2 => setTimeout(r2, 200));
    document.getElementById('tabsRight').click();
    await new Promise(r2 => setTimeout(r2, 900));
    return JSON.stringify({
      after: Math.round(tabs.scrollLeft),
      leftShown: !document.getElementById('tabsLeft').hidden,
    });
  })()`));

  t('шеврон вправо листает ленту', r.after > 20, 'scrollLeft=' + r.after);
  t('после прокрутки виден шеврон влево', r.leftShown === true);

  // колесо мыши над лентой
  r = JSON.parse(await js(`(async () => {
    const tabs = document.getElementById('tabs');
    tabs.scrollLeft = 0;
    await new Promise(r2 => setTimeout(r2, 200));
    const ev = new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true });
    tabs.dispatchEvent(ev);
    await new Promise(r2 => setTimeout(r2, 400));
    return JSON.stringify({ after: Math.round(tabs.scrollLeft), prevented: ev.defaultPrevented });
  })()`));

  t('колесо листает ленту вбок', r.after > 20, 'scrollLeft=' + r.after);
  t('колесо не прокручивает страницу', r.prevented === true, String(r.prevented));

  // Регресс: updateTabsNav звался только из ResizeObserver, то есть только
  // при смене ширины. Уехав колесом в конец, пользователь оказывался в
  // обрезке без шеврона, которым можно вернуться: назад листать было нечем.
  r = JSON.parse(await js(`(async () => {
    const tabs = document.getElementById('tabs');
    const left = document.getElementById('tabsLeft');
    const right = document.getElementById('tabsRight');
    const max = tabs.scrollWidth - tabs.clientWidth;
    tabs.scrollLeft = 0;
    await new Promise(r2 => setTimeout(r2, 200));
    const atStart = { leftHidden: left.hidden, rightShown: !right.hidden };
    // Прокручиваем вручную — так же, как это делает wheel-обработчик
    tabs.scrollLeft = max;
    await new Promise(r2 => setTimeout(r2, 300));
    const atEnd = { leftShown: !left.hidden, rightHidden: right.hidden };
    // И обратно: шеврон должен появиться снова, а не остаться «навсегда»
    left.click();
    await new Promise(r2 => setTimeout(r2, 900));
    const back = { moved: tabs.scrollLeft < max - 5, rightShown: !right.hidden };
    return JSON.stringify({ max, atStart, atEnd, back });
  })()`));

  t('из начала ленты правый шеврон виден', r.atStart.rightShown === true);
  t('уехав в конец, видим шеврон назад', r.atEnd.leftShown === true);
  t('в конце ленты правый шеврон убран', r.atEnd.rightHidden === true);
  t('шеврон назад действительно листает', r.back.moved === true);
  t('после возврата виден шеврон вперёд', r.back.rightShown === true);

  // крестик строго справа, ничего не обрезано
  r = JSON.parse(await js(`(async () => {
    const out = [];
    for (const d of [...document.querySelectorAll('.tab')]) {
      const n = d.querySelector('.tname').getBoundingClientRect();
      const x = d.querySelector('.tclose').getBoundingClientRect();
      const t = d.getBoundingClientRect();
      out.push({
        gap: Math.round(x.left - n.right),
        tail: Math.round(t.right - x.right),
        clipped: x.right > t.right + 0.5,
      });
    }
    return JSON.stringify({
      n: out.length,
      anyClipped: out.some(o => o.clipped),
      gaps: [...new Set(out.map(o => o.gap))],
      tails: [...new Set(out.map(o => o.tail))],
    });
  })()`));

  // Порог 8, а не «на глаз»: отступ крестика от правого края вкладки равен
  // паддингу .tab (8px) минус паддинг самой кнопки (3px), то есть 5-6px.
  // Если имя вкладки перестало тянуться (flex-grow 0), добавляется ровно
  // свободная ширина — на ужатых вкладках это +5px, и порог 12 такое
  // пропускал, а 8 — ловит.
  t('крестик не обрезан ни в одной вкладке', r.anyClipped === false, JSON.stringify(r));
  t('крестик прижат к правому краю', r.tails.every((x) => x >= 0 && x <= 8), JSON.stringify(r.tails));
  t('между именем и крестиком ровный зазор', r.gaps.every((x) => x >= 0 && x <= 12), JSON.stringify(r.gaps));

  // при перетаскивании имя не выделяется
  r = JSON.parse(await js(`(() => {
    const d = document.querySelector('.tab');
    const cs = getComputedStyle(d);
    return JSON.stringify({ userSelect: cs.userSelect, webkit: cs.webkitUserSelect });
  })()`));
  t('имя вкладки не выделяется мышью',
    r.userSelect === 'none' && r.webkit === 'none', JSON.stringify(r));

  // Обрезка длинного имени в середине: хвост с номером должен остаться виден.
  // Нужно много вкладок: пока их мало, basis 180px каждой и имя помещается
  // целиком — обрезаться просто нечему.
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const T = ${JSON.stringify(TABS_DIR)};
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    // Номера из фикстуры (01..18), иначе openPath вернёт null и вкладок будет меньше.
    for (const n of ['07', '12', '05', '18', '09', '14', '03', '16', '08', '11', '02', '17']) {
      await M.openPath(T + '/Заметка-с-длинным-именем-' + n + '.md', { newTab: true });
    }
    await new Promise(r2 => setTimeout(r2, 600));
    const tabs = document.getElementById('tabs');
    const widths = [...document.querySelectorAll('.tab')].map(d => Math.round(d.getBoundingClientRect().width));
    return JSON.stringify({
      names: [...document.querySelectorAll('.tname')].map(x => x.textContent),
      full: [...document.querySelectorAll('.tname')].map(x => x.dataset.full),
      widths,
      uniform: widths.length > 0 && Math.max(...widths) - Math.min(...widths) <= 1,
      over: tabs.scrollWidth - tabs.clientWidth,
      // «чем листать» — это хоть один шеврон: у ленты, прокрученной вправо,
      // правый скрыт по правилу, и это не «нечем листать».
      chevron: !document.getElementById('tabsRight').hidden
        || !document.getElementById('tabsLeft').hidden,
      // имя не должно вылезать за свою вкладку
      fits: [...document.querySelectorAll('.tab')].map(d => {
        const n = d.querySelector('.tname');
        return n.getBoundingClientRect().right <= d.getBoundingClientRect().right + 0.5;
      }),
    });
  })()`));

  // При 12 вкладках по 110px переполнение — это норма, оно и включает
  // скролл. Требовать «поместилось» тут нельзя: min-width вкладки не даёт
  // им стать уже, и полоса обязана уйти в прокрутку.
  t('полоса либо помещается, либо прокручивается',
    r.over <= 1 || r.chevron === true,
    'перебор=' + r.over + 'px шеврон=' + r.chevron);
  t('при переполнении шеврон показан', r.over <= 1 || r.chevron === true,
    'перебор=' + r.over + 'px');
  t('вкладки одной ширины', r.uniform === true, JSON.stringify(r.widths));
  t('полное имя сохранено в data-full',
    (r.full || []).every((x) => x && x.length > 20), JSON.stringify(r.full));
  t('длинные имена обрезаны', (r.names || []).every((x) => x.includes('…')),
    JSON.stringify(r.names));
  // Обрезка идёт с конца, поэтому расширение и номер в хвосте теряются, а
  // начало имени сохраняется. Обрезка по середине была моей идеей и выглядела
  // хуже: «Заметка-с-дли…енем-24.md».
  t('обрезка с конца: начало имени сохранено',
    (r.names || []).every((x) => !x.includes('…') || x.startsWith('Заметка-')),
    JSON.stringify(r.names));
  t('имя не вылезает за свою вкладку',
    (r.fits || []).every((x) => x === true), JSON.stringify(r.fits));
  // Обрезанное имя всегда заканчивается многоточием, а не «куском слова»
  t('обрезанное имя помечено многоточием',
    (r.names || []).every((x) => !x.includes('…') || x.endsWith('…')),
    JSON.stringify(r.names));
  // Полное имя остаётся доступно: в подсказке на вкладке и в data-full
  r2 = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const T = ${JSON.stringify(TABS_DIR)};
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    await M.openPath(T + '/Заметка-с-длинным-именем-07.md', { newTab: true });
    await new Promise(r3 => setTimeout(r3, 400));
    const d = document.querySelector('.tab');
    return JSON.stringify({
      shown: d.querySelector('.tname').textContent,
      full: d.querySelector('.tname').dataset.full,
      title: d.title,
    });
  })()`));
  t('полное имя доступно в подсказке вкладки',
    /Заметка-с-длинным-именем-07\.md/.test(r2.title || ''), r2.title);
  t('полное имя лежит в data-full',
    /Заметка-с-длинным-именем-07\.md/.test(r2.full || ''), r2.full);
  t('при одной вкладке имя показывается целиком',
    r2.shown === 'Заметка-с-длинным-именем-07.md', r2.shown);

  // ------------------------------------------------- индикатор загрузки
  console.log('\n== индикатор загрузки ==');

  r = JSON.parse(await js(`(() => {
    const el = document.getElementById('loading');
    el.hidden = true;
    const hiddenDisplay = getComputedStyle(el).display;
    el.hidden = false;
    const shownDisplay = getComputedStyle(el).display;
    el.hidden = true;
    return JSON.stringify({ hiddenDisplay, shownDisplay });
  })()`));
  // Без .loading[hidden]{display:none} индикатор висел бы всегда: правило с
  // классом перебивает [hidden] из UA-таблицы по специфичности.
  t('скрытый индикатор не отрисован', r.hiddenDisplay === 'none', r.hiddenDisplay);
  t('видимый индикатор отрисован', r.shownDisplay === 'flex', r.shownDisplay);

  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const f = ${JSON.stringify(TABS_DIR)} + '/Открываемый.md';
    const el = document.getElementById('loading');
    const txt = document.getElementById('loadingText');
    let sawVisible = false;
    let sample = '';
    const p = M.openPath(f, { newTab: true });
    for (let i = 0; i < 200; i++) {
      if (!el.hidden) { sawVisible = true; sample = txt.textContent; }
      await new Promise(r2 => setTimeout(r2, 5));
      if (el.hidden && sawVisible) break;
    }
    const t = await p;
    await new Promise(r2 => setTimeout(r2, 300));
    return JSON.stringify({
      sawVisible, sample, opened: !!t,
      hiddenAfter: el.hidden, name: M.active().name,
    });
  })()`));

  t('индикатор показывается при открытии', r.sawVisible === true);
  t('в индикаторе имя файла', /Открываемый\.md/.test(r.sample || ''), r.sample);
  t('файл после индикатора открыт', r.opened === true && r.name === 'Открываемый.md', r.name);
  t('после открытия индикатор убран', r.hiddenAfter === true);

  // Переключение вкладки гасит индикатор
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const el = document.getElementById('loading');
    const txt = document.getElementById('loadingText');
    txt.textContent = 'Открываю что-то.md';
    el.hidden = false;
    const before = el.hidden;
    await M.newTab();
    await new Promise(r2 => setTimeout(r2, 200));
    return JSON.stringify({ before, after: el.hidden });
  })()`));
  t('переключение вкладки гасит индикатор', r.before === false && r.after === true,
    JSON.stringify(r));

  // ------------------------------------------- резерв под системные кнопки
  // titleBarOverlay рисует «свернуть/развернуть/закрыть» поверх содержимого.
  // Без резерва полоса вкладок заезжала под них: «+» пропадала, последние
  // вкладки были не видны, а скролла не появлялось — лента формально
  // влезала, и переполнение считать было не от чего.
  console.log('\n== резерв под системные кнопки окна ==');

  r = JSON.parse(await js(`(() => {
    const cap = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--titlebar-right')) || 0;
    const bar = document.getElementById('tabbar');
    const plus = document.getElementById('btnNewTab').getBoundingClientRect();
    const chev = document.getElementById('tabsRight');
    const cr = chev.getBoundingClientRect();
    return JSON.stringify({
      cap,
      padRight: getComputedStyle(bar).paddingRight,
      winW: innerWidth,
      captionStartsAt: innerWidth - cap,
      plusRight: Math.round(plus.right),
      chevronShown: !chev.hidden,
      chevronRight: Math.round(cr.right),
      hasHandler: typeof window.mdv.caption === 'function',
    });
  })()`));

  t('ширина блока кнопок получена от main', r.cap > 60, r.cap + 'px');
  t('полоса вкладок резервирует это место справа',
    parseInt(r.padRight) >= r.cap - 1, 'padding=' + r.padRight + ' cap=' + r.cap);
  t('«+» не заезжает под системные кнопки',
    r.plusRight <= r.captionStartsAt, '+=' + r.plusRight + ' зона=' + r.captionStartsAt);
  if (r.chevronShown) {
    t('шеврон не заезжает под системные кнопки',
      r.chevronRight <= r.captionStartsAt + 1, 'шеврон=' + r.chevronRight);
  } else {
    t('шеврон не заезжает под системные кнопки', true);
  }

  // ------------------------------------------- перетаскивание пустых вкладок
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const T = ${JSON.stringify(TABS_DIR)};
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    for (const f of ${JSON.stringify(MANY_FILES.slice(0, 4))}) await M.openPath(T + '/' + f, { newTab: true });
    M.newTab();
    await new Promise(r2 => setTimeout(r2, 400));

    const blank = [...document.querySelectorAll('.tab')]
      .find(d => d.querySelector('.tname').dataset.full === 'Новая вкладка');
    if (!blank) return JSON.stringify({ err: 'нет пустой вкладки' });

    const dt = new DataTransfer();
    blank.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const started = blank.classList.contains('dragging');
    const payload = dt.getData('text/plain');
    blank.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    // Проверяем сразу: дальше снова будет dragstart, который навесит класс
    // заново, и «снимается по завершении» выглядело бы провалом.
    const cleared = !blank.classList.contains('dragging');

    // и сразу переносим её в начало
    const blankId = +blank.dataset.id;
    const firstId = [...M.tabs.keys()][0];
    const target = document.querySelector('.tab[data-id="' + firstId + '"]');
    const rect = target.getBoundingClientRect();
    const dt2 = new DataTransfer();
    blank.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt2 }));
    target.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, clientX: rect.left + 2, clientY: rect.top + 5, dataTransfer: dt2,
    }));
    const marker = target.classList.contains('drop-before') || target.classList.contains('drop-after');
    target.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, clientX: rect.left + 2, clientY: rect.top + 5, dataTransfer: dt2,
    }));
    await new Promise(r2 => setTimeout(r2, 400));

    const after = [...M.tabs.keys()];
    const domOrder = [...document.querySelectorAll('.tab')].map(d => +d.dataset.id);
    return JSON.stringify({
      started, payload, marker, blankId, cleared,
      movedToFront: after[0] === blankId,
      domMatches: JSON.stringify(domOrder) === JSON.stringify(after),
      allDraggable: [...document.querySelectorAll('.tab')].every(d => d.draggable),
    });
  })()`));

  t('пустая вкладка помечена как перетаскиваемая', r.allDraggable === true);
  t('перетаскивание пустой вкладки начинается', r.started === true);
  t('при перетаскивании передаётся имя вкладки', r.payload === 'Новая вкладка', r.payload);
  t('метка класса снимается по завершении', r.cleared === true);
  t('пустую вкладку можно перенести', r.movedToFront === true, JSON.stringify(r));
  t('место вставки помечается', r.marker === true);
  t('порядок DOM совпадает с порядком вкладок', r.domMatches === true);

  // ------------------------------- тулбар, нижняя панель, док режима
  console.log('\n== тулбар, нижняя панель, режим правки ==');

  // Сначала открываем файл: без него #workspace скрыт, у .main нет размера,
  // и координаты дока режима измерять бессмысленно.
  await js(`(async () => {
    const M = window.__mdvTest;
    await M.openPath(${JSON.stringify(TABS_DIR)} + '/Открываемый.md', { newTab: true });
    await new Promise(r2 => setTimeout(r2, 300));
    return 1;
  })()`);

  r = JSON.parse(await js(`(() => {
    const bar = document.querySelector('.topbar');
    const ids = [...bar.querySelectorAll('[id]')].map(x => x.id);
    const zoom = document.querySelector('.topbar-center');
    const zoomKids = [...zoom.querySelectorAll('[id]')].map(x => x.id);
    const dock = document.getElementById('modeDock');
    const sb = document.getElementById('statusbar');
    const kids = [...sb.children].map(x => x.className || x.id);
    return JSON.stringify({
      ids,
      noOpenFile: !document.getElementById('btnOpenFile'),
      noOpenFolder: !document.getElementById('btnOpenFolder'),
      zoomCentered: zoom.parentElement === bar,
      zoomKids,
      zoomHasBoth: zoomKids.includes('btnZoomOut') && zoomKids.includes('btnZoomIn')
        && zoomKids.includes('zoomVal'),
      // масштаб реально по центру, а не прижат к левому краю
      zoomNearCenter: (() => {
        const b = bar.getBoundingClientRect();
        const z = zoom.getBoundingClientRect();
        const mid = z.left + z.width / 2;
        return Math.abs(mid - (b.left + b.width / 2)) < b.width * 0.12;
      })(),
      dockInMain: dock.parentElement.classList.contains('main'),
      // Меряем относительно самой заметки: .main начинается после боковой
      // панели, поэтому в координатах окна «левый край» — это ~300px.
      dockLeft: Math.round(dock.getBoundingClientRect().left
        - document.querySelector('.main').getBoundingClientRect().left),
      dockBottom: Math.round(document.querySelector('.main').getBoundingClientRect().bottom
        - dock.getBoundingClientRect().bottom),
      statusKids: kids,
      pathFirst: sb.firstElementChild === document.getElementById('fileName'),
      statusLast: sb.lastElementChild === document.getElementById('statusText'),
      dlIcon: document.querySelector('#dlBtn .ico-svg') ? 'svg' : 'none',
      // Кнопок панелей в тулбаре больше нет: они живут в меню и на хоткеях
      noPanelBtns: !document.getElementById('btnToc')
        && !document.getElementById('btnSidebar'),
    });
  })()`));

  t('в тулбаре нет кнопок панелей', r.noPanelBtns === true);
  t('в тулбаре нет кнопки «Файл»', r.noOpenFile === true);
  t('в тулбаре нет кнопки «Папка»', r.noOpenFolder === true);
  t('масштаб в тулбаре есть', r.zoomHasBoth === true, JSON.stringify(r.zoomKids));
  t('масштаб по центру тулбара', r.zoomCentered === true && r.zoomNearCenter === true,
    JSON.stringify(r.zoomKids));
  t('док режима внутри заметки', r.dockInMain === true);
  t('док режима в левом нижнем углу', r.dockLeft > 0 && r.dockLeft < 60 && r.dockBottom < 60,
    'left=' + r.dockLeft + ' bottom=' + r.dockBottom);
  t('путь к файлу — внизу слева', r.pathFirst === true, JSON.stringify(r.statusKids));
  t('сообщение — внизу справа', r.statusLast === true, JSON.stringify(r.statusKids));
  t('иконка экспорта — svg-иконка', r.dlIcon === 'svg');

  // «Сохранить» в правке и «Экспорт» в тулбаре не путаются
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const T = ${JSON.stringify(TABS_DIR)};
    await M.openPath(T + '/Заметка-с-длинным-именем-01.md', { newTab: true });
    await new Promise(r2 => setTimeout(r2, 300));
    document.getElementById('btnMode').click();
    await new Promise(r2 => setTimeout(r2, 300));
    const dock = document.getElementById('modeDock');
    return JSON.stringify({
      editing: M.active().mode,
      saveInDock: dock.contains(document.getElementById('btnSave')),
      cancelInDock: dock.contains(document.getElementById('btnCancelEdit')),
      modeInDock: dock.contains(document.getElementById('btnMode')),
      modeHiddenInEdit: document.getElementById('btnMode').hidden,
      saveVisible: !document.getElementById('btnSave').hidden,
      topbarHasSave: !!document.querySelector('.topbar #btnSave'),
      topbarHasCancel: !!document.querySelector('.topbar #btnCancelEdit'),
    });
  })()`));

  t('«Правка» внутри дока', r.modeInDock === true);
  t('в правке «Правка» скрыта', r.modeHiddenInEdit === true);
  t('«Сохранить» и «Отменить» в доке', r.saveInDock === true && r.cancelInDock === true);
  t('зелёная «Сохранить» видна в правке', r.saveVisible === true);
  t('в тулбаре нет второй «Сохранить»', r.topbarHasSave === false && r.topbarHasCancel === false);

  // Цвета статуса: сохранено — зелёный, отмена правок — жёлтый.
  // Сначала ОТКАЗ от отмены: вкладка должна остаться в правке, и статус
  // «Правки отменены» показываться не должен — отмены не было.
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const t = M.active();
    t.raw = t._diskRaw + '\\n\\nчерновик\\n';
    t.dirty = true;
    M.renderActive();
    await new Promise(r2 => setTimeout(r2, 150));
    M.setConfirm(() => null);
    document.getElementById('btnCancelEdit').click();
    await new Promise(r2 => setTimeout(r2, 400));
    return JSON.stringify({
      text: document.getElementById('statusText').textContent,
      mode: t.mode,
      dirty: t.dirty,
    });
  })()`));

  t('отказ от отмены оставляет в правке', r.mode === 'edit', r.mode);
  t('отказ от отмены сохраняет правки', r.dirty === true);
  t('отказ от отмены не пишет «Правки отменены»', !/Правки отменены/.test(r.text || ''), r.text);

  // Теперь выбираем «Отменить» (выбросить правки) — вот тут жёлтый статус.
  // null = закрыть без ответа, false = «Отменить» (выбросить), true = «Сохранить».
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const sb = document.getElementById('statusbar');
    const t = M.active();
    M.setConfirm(() => false);
    document.getElementById('btnCancelEdit').click();
    await new Promise(r2 => setTimeout(r2, 500));
    const res = {
      text: document.getElementById('statusText').textContent,
      cls: sb.className,
      color: getComputedStyle(document.getElementById('statusText')).color,
      mode: t.mode,
      dirty: t.dirty,
    };
    M.setConfirm(null);
    return JSON.stringify(res);
  })()`));

  t('после отмены текст «Правки отменены»', /Правки отменены/.test(r.text || ''), r.text);
  t('отмена правок — жёлтым (warn)', /warn/.test(r.cls), r.cls);
  t('жёлтый реально жёлтый', /224,\s*175,\s*104/.test(r.color || ''), r.color);
  t('после отмены вышли из правки', r.mode === 'read', r.mode);
  t('после отмены правок нет', r.dirty === false);

  // Цвет сохранения. Открываем другой файл и входим в правку заново:
  // предыдущий шаг вышел из режима правки.
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const sb = document.getElementById('statusbar');
    const T = ${JSON.stringify(TABS_DIR)};
    await M.openPath(T + '/Открываемый.md', { newTab: true });
    await new Promise(r2 => setTimeout(r2, 300));
    document.getElementById('btnMode').click();
    await new Promise(r2 => setTimeout(r2, 200));
    const t = M.active();
    t.raw = t._diskRaw + '\\n\\nпишу в файл\\n';
    t.dirty = true;
    M.renderActive();
    await new Promise(r2 => setTimeout(r2, 150));
    document.getElementById('btnSave').click();
    await new Promise(r2 => setTimeout(r2, 800));
    return JSON.stringify({
      text: document.getElementById('statusText').textContent,
      cls: sb.className,
      color: getComputedStyle(document.getElementById('statusText')).color,
      dirty: t.dirty,
      mode: t.mode,
    });
  })()`));

  t('после сохранения текст «Сохранено»', /Сохранено/.test(r.text || ''), r.text);
  t('сохранение — зелёным (ok)', /ok/.test(r.cls), r.cls);
  t('зелёный реально зелёный', /158,\s*206,\s*106/.test(r.color || ''), r.color);
  t('после сохранения правок сняты', r.dirty === false);
  t('после сохранения вышли из правки в просмотр', r.mode === 'read', r.mode);

  // Нижняя панель прячет путь, когда файла нет
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    await new Promise(r2 => setTimeout(r2, 300));
    return JSON.stringify({
      name: document.getElementById('fileName').textContent,
      dash: document.getElementById('fileName').textContent === '\\u2014',
      dockHidden: document.getElementById('modeDock').hidden,
    });
  })()`));

  t('без файла в нижней панели пусто', r.name === '' && r.dash === false, JSON.stringify(r.name));
  t('без файла док режима скрыт', r.dockHidden === true);

  // ---------------------------------------------- диалог «Сохранить правки?»
  console.log('\n== диалог несохранённых правок ==');

  // Готовим вкладку с правками и снимаем настоящий диалог (хук снимаем,
  // иначе его подменит).
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const T = ${JSON.stringify(TABS_DIR)};
    M.setConfirm(null);
    await M.openPath(T + '/Открываемый.md', { newTab: true });
    await new Promise(r2 => setTimeout(r2, 300));
    document.getElementById('btnMode').click();
    await new Promise(r2 => setTimeout(r2, 200));
    const t = M.active();
    t.raw = t._diskRaw + '\\n\\nнесохранённый черновик\\n';
    t.dirty = true;
    M.renderActive();
    await new Promise(r2 => setTimeout(r2, 200));
    document.getElementById('btnCancelEdit').click();
    await new Promise(r2 => setTimeout(r2, 400));
    const back = document.querySelector('.modal-back');
    const box = back && back.querySelector('.modal-box');
    return JSON.stringify({
      shown: !!back,
      msg: back ? (back.querySelector('.dlg-msg') || {}).textContent : '',
      note: back ? (back.querySelector('.dlg-note') || {}).textContent : '',
      buttons: back ? [...back.querySelectorAll('.dlgbtn')].map(b => ({
        text: b.textContent, cls: b.className,
      })) : [],
      hasX: !!(back && back.querySelector('.dlg-x')),
      xIsIcon: !!(back && back.querySelector('.dlg-x svg')),
      // Оформление как у остальных окон: общий .modal-box, и inline остались
      // только на размеры коробки. Оформление (фон, рамка, шрифт) — классами.
      sharedBox: !!(box && box.classList.contains('modal-box')),
      // Оформление (фон, цвет, рамка, шрифт) не должно быть инлайном —
      // именно из-за него диалог выглядел не как остальные окна. Размеры
      // коробки инлайном задавать можно.
      inlineLook: back ? [...back.querySelectorAll('*')].filter(e =>
        /background|color|border|font-family/.test(e.style.cssText)).length : 0,
      fontFamily: box ? getComputedStyle(box).fontFamily : '',
      mode: M.active().mode,
    });
  })()`));

  t('диалог показан', r.shown === true);
  t('вопрос «Сохранить правки?»', r.msg === 'Сохранить правки?', r.msg);
  t('пояснение упоминает файл', /Открываемый\.md/.test(r.note || ''), r.note);
  t('кнопка «Сохранить» есть', (r.buttons || []).some((b) => b.text === 'Сохранить'),
    JSON.stringify(r.buttons));
  t('кнопка «Отменить» есть', (r.buttons || []).some((b) => b.text === 'Отменить'),
    JSON.stringify(r.buttons));
  t('кнопок ровно две', (r.buttons || []).length === 2, JSON.stringify(r.buttons));
  t('крестик есть и это иконка', r.hasX === true && r.xIsIcon === true);
  t('использован общий .modal-box', r.sharedBox === true);
  t('оформление не инлайном, inline только на размеры', r.inlineLook === 0,
    'элементов с inline-оформлением: ' + r.inlineLook);
  t('шрифт — как у приложения', /JetBrains/i.test(r.fontFamily || ''), r.fontFamily);

  // Крестик закрывает вопрос БЕЗ потери правок
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const t = M.active();
    document.querySelector('.modal-back .dlg-x').click();
    await new Promise(r2 => setTimeout(r2, 300));
    return JSON.stringify({
      closed: !document.querySelector('.modal-back'),
      mode: t.mode,
      dirty: t.dirty,
      rawKept: /черновик/.test(t.raw),
    });
  })()`));

  t('крестик закрывает диалог', r.closed === true);
  t('крестик НЕ выбрасывает правки', r.dirty === true && r.rawKept === true);
  t('крестик оставляет в правке', r.mode === 'edit', r.mode);

  // Esc — то же, что крестик
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    document.getElementById('btnCancelEdit').click();
    await new Promise(r2 => setTimeout(r2, 350));
    const wasOpen = !!document.querySelector('.modal-back');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 300));
    return JSON.stringify({
      wasOpen,
      closed: !document.querySelector('.modal-back'),
      mode: M.active().mode,
      dirty: M.active().dirty,
    });
  })()`));

  t('Esc закрывает диалог', r.wasOpen === true && r.closed === true);
  t('Esc не выбрасывает правки', r.dirty === true);
  t('Esc оставляет в правке', r.mode === 'edit', r.mode);

  // «Сохранить» в диалоге — пишет файл и выходит в просмотр
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    document.getElementById('btnCancelEdit').click();
    await new Promise(r2 => setTimeout(r2, 350));
    [...document.querySelectorAll('.dlgbtn')].find(b => b.textContent === 'Сохранить').click();
    await new Promise(r2 => setTimeout(r2, 700));
    const t = M.active();
    return JSON.stringify({
      closed: !document.querySelector('.modal-back'),
      mode: t.mode,
      dirty: t.dirty,
      onDisk: /черновик/.test(t._diskRaw || ''),
      status: document.getElementById('statusText').textContent,
    });
  })()`));

  t('«Сохранить» в диалоге закрывает его', r.closed === true);
  t('«Сохранить» пишет файл', r.onDisk === true);
  t('после «Сохранить» вышли в просмотр', r.mode === 'read', r.mode);
  t('правок не осталось', r.dirty === false);
  t('статус зелёный «Сохранено»', /Сохранено/.test(r.status || ''), r.status);

  // «Отменить» — выбрасывает правки
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const t = M.active();
    document.getElementById('btnMode').click();
    await new Promise(r2 => setTimeout(r2, 200));
    t.raw = t._diskRaw + '\\n\\nвторой черновик\\n';
    t.dirty = true;
    M.renderActive();
    await new Promise(r2 => setTimeout(r2, 200));
    document.getElementById('btnCancelEdit').click();
    await new Promise(r2 => setTimeout(r2, 350));
    [...document.querySelectorAll('.dlgbtn')].find(b => b.textContent === 'Отменить').click();
    await new Promise(r2 => setTimeout(r2, 500));
    return JSON.stringify({
      closed: !document.querySelector('.modal-back'),
      mode: t.mode,
      dirty: t.dirty,
      keptSecond: /второй черновик/.test(t.raw),
      onDisk: /второй черновик/.test(t._diskRaw || ''),
      status: document.getElementById('statusText').textContent,
    });
  })()`));

  t('«Отменить» закрывает диалог', r.closed === true);
  t('«Отменить» выбрасывает правки', r.keptSecond === false && r.dirty === false);
  t('на диске изменений нет', r.onDisk === false);
  t('статус жёлтый «Правки отменены»', /Правки отменены/.test(r.status || ''), r.status);

  // ---------------------------------------------- панели, вид, меню иконки
  console.log('\n== панели, вид, меню иконки ==');

  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const D = ${JSON.stringify(TABS_DIR)};
    await M.addFolder(D);
    await M.openPath(D + '/Открываемый.md', { newTab: true });
    await new Promise(r2 => setTimeout(r2, 600));
    const ws = document.getElementById('workspace');
    const toc = document.getElementById('tocSide');
    const files = document.getElementById('filesSide');
    const main = document.querySelector('.main');
    return JSON.stringify({
      order: [...ws.children].map(k => k.id || k.className.split(' ')[0]),
      tocLeft: Math.round(toc.getBoundingClientRect().left),
      filesRight: Math.round(innerWidth - files.getBoundingClientRect().right),
      mainBetween: main.getBoundingClientRect().left >= toc.getBoundingClientRect().right - 1
        && main.getBoundingClientRect().right <= files.getBoundingClientRect().left + 1,
      hasResizers: !!document.getElementById('tocResizer') && !!document.getElementById('filesResizer'),
      noOverlay: !document.getElementById('tocOverlay'),
      tocFilled: document.getElementById('paneToc').children.length > 0,
      filesFilled: document.getElementById('paneFiles').children.length > 0,
    });
  })()`));

  t('порядок в области: оглавление, заметка, проводник',
    // .split — контейнер рабочей области: в нём живёт .main, а при
    // разделении экрана ещё и вторая панель с рамкой между ними.
    JSON.stringify(r.order) === JSON.stringify(['tocSide', 'tocResizer', 'split', 'filesResizer', 'filesSide', 'toTop']),
    JSON.stringify(r.order));
  t('оглавление слева', r.tocLeft === 0, r.tocLeft + 'px');
  t('проводник справа', r.filesRight === 0, r.filesRight + 'px');
  t('заметка между панелями', r.mainBetween === true);
  t('у каждой панели свой ресайзер', r.hasResizers === true);
  t('оверлей оглавления удалён', r.noOverlay === true);
  t('оглавление наполнено', r.tocFilled === true);
  t('проводник наполнен', r.filesFilled === true);

  // Меню иконки: Файл ▸, Вид ▸, Настройки
  r = JSON.parse(await js(`(async () => {
    document.querySelectorAll('.ctxmenu').forEach(m => m.remove());
    document.getElementById('appBrand').click();
    await new Promise(r2 => setTimeout(r2, 300));
    const top = document.querySelector('.ctxmenu');
    const out = {
      labels: [...top.querySelectorAll('.ctxmenu-label')].map(x => x.textContent),
      parents: [...top.querySelectorAll('.ctxmenu-parent')].map(x => x.querySelector('.ctxmenu-label').textContent),
      hint: ([...top.querySelectorAll('.ctxmenu-item')]
        .find(x => /Настройки/.test(x.textContent)) || {}).querySelector
        ? ([...top.querySelectorAll('.ctxmenu-item')]
          .find(x => /Настройки/.test(x.textContent))
          .querySelector('.ctxmenu-hint').textContent)
        : '',
    };
    document.querySelectorAll('.ctxmenu').forEach(m => m.remove());
    return JSON.stringify(out);
  })()`));

  t('в меню иконки три пункта',
    JSON.stringify(r.labels) === JSON.stringify(['Файл', 'Вид', 'Настройки']), JSON.stringify(r.labels));
  t('«Файл» и «Вид» — подменю', (r.parents || []).includes('Файл') && (r.parents || []).includes('Вид'));
  // Проверяем подстроками: в регулярке «Ctrl+,\+» значило «Ctrl, затем плюс
  // один или более», а не «Ctrl+,».
  t('у «Настройки» подсказка Ctrl+,',
    (r.hint || '').indexOf('Ctrl') >= 0 && (r.hint || '').indexOf(',') >= 0, r.hint);

  // Подменю «Вид» с галочками
  r = JSON.parse(await js(`(async () => {
    document.querySelectorAll('.ctxmenu').forEach(m => m.remove());
    document.getElementById('appBrand').click();
    await new Promise(r2 => setTimeout(r2, 250));
    const view = [...document.querySelectorAll('.ctxmenu-parent')]
      .find(b => /Вид/.test(b.textContent));
    view.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 400));
    const menus = [...document.querySelectorAll('.ctxmenu')];
    const sub = menus[menus.length - 1];
    const res = {
      menus: menus.length,
      labels: [...sub.querySelectorAll('.ctxmenu-label')].map(x => x.textContent.replace('✓', '')),
    seps: sub.querySelectorAll('.ctxmenu-sep').length,
      checks: [...sub.querySelectorAll('.ctxmenu-check')].map(x => x.textContent),
      parentKept: !!menus[0]._keep,
    };
    document.querySelectorAll('.ctxmenu').forEach(m => m.remove());
    return JSON.stringify(res);
  })()`));

  t('подменю «Вид» открылось', r.menus >= 2, 'меню: ' + r.menus);
  t('родительское меню осталось', r.parentKept === true);
  t('в «Вид» четыре переключателя панелей',
    ['Проводник', 'Оглавление', 'Верхняя панель', 'Нижняя панель']
      .every((x) => (r.labels || []).includes(x)), JSON.stringify(r.labels));
  t('в «Вид» есть «Разделить экран»', (r.labels || []).includes('Разделить экран'),
    JSON.stringify(r.labels));
  t('у каждого переключателя галочка', (r.checks || []).length === 4, JSON.stringify(r.checks));
  t('все панели включены по умолчанию', (r.checks || []).every((x) => x === '✓'), JSON.stringify(r.checks));
  t('подменю «Вид» разделено на группы', (r.seps || []) >= 2, String(r.seps));

  // Щелчок по галочке выключает панель и это запоминается
  r = JSON.parse(await js(`(async () => {
    document.querySelectorAll('.ctxmenu').forEach(m => m.remove());
    document.getElementById('appBrand').click();
    await new Promise(r2 => setTimeout(r2, 250));
    [...document.querySelectorAll('.ctxmenu-parent')].find(b => /Вид/.test(b.textContent))
      .dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 350));
    const menus = [...document.querySelectorAll('.ctxmenu')];
    [...menus[menus.length - 1].querySelectorAll('.ctxmenu-item')]
      .find(b => /Проводник/.test(b.textContent)).click();
    await new Promise(r2 => setTimeout(r2, 600));
    const saved = await window.mdv.settingsGet();
    return JSON.stringify({
      filesHidden: document.getElementById('filesSide').hidden,
      resizerHidden: document.getElementById('filesResizer').hidden,
      tocHidden: document.getElementById('tocSide').hidden,
      noToolbarBtn: !document.getElementById('btnSidebar'),
      mainRight: Math.round(document.querySelector('.main').getBoundingClientRect().right),
      winW: innerWidth,
      menusGone: document.querySelectorAll('.ctxmenu').length,
      saved: saved.view,
    });
  })()`));

  t('проводник скрылся', r.filesHidden === true);
  t('его ресайзер тоже скрылся', r.resizerHidden === true);
  t('оглавление не тронуто', r.tocHidden === false);
  t('заметка заняла освободившееся место', r.mainRight === r.winW, r.mainRight + '/' + r.winW);
  t('кнопки панели в тулбаре нет', r.noToolbarBtn === true);
  t('меню закрылось после выбора', r.menusGone === 0);
  t('выбор вида сохранён', r.saved && r.saved.files === false, JSON.stringify(r.saved));

  // Полоса вкладок не скрывается никогда
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    await M.setView({ topbar: false, statusbar: false, toc: false, files: false });
    await new Promise(r2 => setTimeout(r2, 400));
    const res = {
      topbarHidden: document.querySelector('.topbar').hidden,
      statusbarHidden: document.getElementById('statusbar').hidden,
      tocHidden: document.getElementById('tocSide').hidden,
      filesHidden: document.getElementById('filesSide').hidden,
      tabbarHidden: document.querySelector('.tabbar').hidden,
      tabsPresent: document.querySelectorAll('.tab').length,
      workspace: !document.getElementById('workspace').hidden,
    };
    await M.setView({ topbar: true, statusbar: true, toc: true, files: true });
    await new Promise(r2 => setTimeout(r2, 400));
    return JSON.stringify(res);
  })()`));

  t('верхняя панель скрывается', r.topbarHidden === true);
  t('нижняя панель скрывается', r.statusbarHidden === true);
  t('обе боковые скрываются', r.tocHidden === true && r.filesHidden === true);
  t('полоса вкладок НЕ скрывается', r.tabbarHidden === false);
  t('вкладки на месте', r.tabsPresent > 0, String(r.tabsPresent));
  t('заметка всё ещё видна', r.workspace === true);

  // Кнопок панелей в тулбаре больше нет — переключение только через меню и хоткеи
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const res = { noToolbarBtns: !document.getElementById('btnToc')
      && !document.getElementById('btnSidebar') };
    // Состояние читаем ПОСЛЕ каждого переключения: если прочитать раньше,
    // проверка «вернулся ли проводник» будет смотреть на уже спрятанную панель.
    res.toggled = await M.toggleView('files');
    res.hiddenAfterToggle = document.getElementById('filesSide').hidden;
    res.back = await M.toggleView('files');
    res.shownAfterBack = document.getElementById('filesSide').hidden;
    res.tocOff = await M.toggleView('toc', false);
    res.tocHidden = document.getElementById('tocSide').hidden;
    res.tocOn = await M.toggleView('toc', true);
    res.tocBack = document.getElementById('tocSide').hidden;
    return JSON.stringify(res);
  })()`));

  t('в тулбаре нет кнопок панелей', r.noToolbarBtns === true);
  t('toggleView скрывает проводник', r.toggled === false && r.hiddenAfterToggle === true);
  t('повторный вызов возвращает проводник', r.back === true && r.shownAfterBack === false);
  t('toggleView скрывает оглавление', r.tocOff === false && r.tocHidden === true);
  t('toggleView возвращает оглавление', r.tocOn === true && r.tocBack === false);

  // ПКМ по «+»
  r = JSON.parse(await js(`(async () => {
    document.querySelectorAll('.ctxmenu').forEach(m => m.remove());
    const plus = document.getElementById('btnNewTab');
    const before = window.__mdvTest.tabs.size;
    plus.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 20 }));
    await new Promise(r2 => setTimeout(r2, 350));
    const m = document.querySelector('.ctxmenu');
    const res = {
      shown: !!m,
      labels: m ? [...m.querySelectorAll('.ctxmenu-label')].map(x => x.textContent) : [],
      tabsUnchanged: window.__mdvTest.tabs.size === before,
    };
    document.querySelectorAll('.ctxmenu').forEach(x => x.remove());
    return JSON.stringify(res);
  })()`));

  t('ПКМ по «+» открывает меню', r.shown === true);
  t('в нём «Открыть .md» и «Открыть папку»',
    JSON.stringify(r.labels) === JSON.stringify(['Открыть .md', 'Открыть папку']), JSON.stringify(r.labels));
  t('ПКМ по «+» не создаёт вкладку', r.tabsUnchanged === true);

  // Ctrl+, открывает настройки
  r = JSON.parse(await js(`(async () => {
    document.querySelectorAll('.ctxmenu').forEach(m => m.remove());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 400));
    const back = document.querySelector('.modal-back');
    const res = {
      opened: !!back,
      title: back ? (back.querySelector('.modal-title') || {}).textContent : '',
    };
    return JSON.stringify(res);
  })()`));
  // Закрывать окно настроек — по-человечески (см. closeModals). Снос узла
  // оставлял слушатель Escape от wireModal жить, и каждый следующий Escape
  // во всём приложении откатывал настройки «несуществующего» диалога.
  await closeModals();

  t('Ctrl+, открывает настройки', r.opened === true && /Настройки/.test(r.title || ''), r.title);

  // ------------------------------------------------- прокрутка и призрак
  console.log('\n== прокрутка и призрак вкладки ==');

  // Правило: руками (колесо, полоса) — мгновенно, кнопками — плавно.
  // Глобальный scroll-behavior:smooth ломал именно колесо, поэтому проверяем
  // вычисленное значение, а не «на ощупь».
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const D = ${JSON.stringify(TABS_DIR)};
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    await M.openPath(D + '/' + ${JSON.stringify(MANY_FILES[0])}, { newTab: true });
    await new Promise(r2 => setTimeout(r2, 500));

    const cs = getComputedStyle;
    const out = {
      content: cs(document.getElementById('content')).scrollBehavior,
      tabs: cs(document.getElementById('tabs')).scrollBehavior,
    };

    // Шевроны обязаны просить плавно
    const calls = [];
    const tabsEl = document.getElementById('tabs');
    const real = tabsEl.scrollBy;
    tabsEl.scrollBy = (o) => { calls.push(o); };
    document.getElementById('tabsLeft').click();
    document.getElementById('tabsRight').click();
    tabsEl.scrollBy = real;
    out.chevronCalls = calls.length;
    out.chevronSmooth = calls.length > 0 && calls.every((o) => o.behavior === 'smooth');
    return JSON.stringify(out);
  })()`));

  t('колесо в заметке мгновенное (нет smooth в CSS)', r.content === 'auto', r.content);
  t('колесо в ленте вкладок мгновенное', r.tabs === 'auto', r.tabs);
  t('шевроны просят плавную прокрутку', r.chevronCalls === 2 && r.chevronSmooth === true,
    r.chevronCalls + '/' + r.chevronSmooth);

  // Возврат к сохранённой позиции при переключении вкладок — тоже мгновенно
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const c = document.getElementById('content');
    c.scrollTop = 0;
    await new Promise(r2 => setTimeout(r2, 200));
    const t = M.active();
    t.scroll = 1200;
    const seen = [];
    const real = c.scrollTo.bind(c);
    c.scrollTo = (o) => { seen.push(o); real(o); };
    const first = M.tabs.keys().next().value;
    await M.newTab();
    await new Promise(r2 => setTimeout(r2, 300));
    await M.selectTab(first);
    await new Promise(r2 => setTimeout(r2, 300));
    c.scrollTo = real;
    return JSON.stringify({ calls: seen.length, behavior: seen.map((o) => o.behavior) });
  })()`));

  t('возврат к позиции задан явно', r.calls >= 1, String(r.calls));
  t('возврат к позиции мгновенный, не плавный',
    (r.behavior || []).every((b) => b === 'instant'), JSON.stringify(r.behavior));

  // Призрак перетаскивания: не снимок вкладки, а плашка с именем
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    const D = ${JSON.stringify(TABS_DIR)};
    await M.openPath(D + '/' + ${JSON.stringify(MANY_FILES[0])}, { newTab: true });
    await M.openPath(D + '/' + ${JSON.stringify(MANY_FILES[1])}, { newTab: true });
    await new Promise(r2 => setTimeout(r2, 400));

    const tab = document.querySelector('.tab');
    const name = tab.querySelector('.tname').textContent;
    const ghostCalls = [];
    const ev = new Event('dragstart', { bubbles: true, cancelable: true });
    ev.dataTransfer = {
      effectAllowed: '', setData() {}, setDragImage(img, x, y) { ghostCalls.push({ img, x, y }); },
    };
    tab.dispatchEvent(ev);
    // Призрак живёт до конца текущей задачи, поэтому смотрим синхронно
    const ghost = document.querySelector('.drag-ghost');
    const res = {
      name,
      ghostExists: !!ghost,
      ghostName: ghost ? ghost.querySelector('.tname').textContent : '',
      offscreen: ghost ? ghost.getBoundingClientRect().right <= 0 : false,
      setDragImage: ghostCalls.length,
      ghostIsNotTheTab: ghost ? ghost !== tab : false,
      ghostNoCloseBtn: ghost ? !ghost.querySelector('.tclose') : false,
      draggingClass: tab.classList.contains('dragging'),
      stripMarked: document.getElementById('tabs').classList.contains('dragging-active'),
    };
    tab.dispatchEvent(new Event('dragend', { bubbles: true }));
    // Призрак снимается на следующем тике (setTimeout 0): Firefox не
    // успевает снять снимок раньше. Здесь ждём этот тик.
    await new Promise(r2 => setTimeout(r2, 50));
    res.afterEnd = {
      ghostGone: !document.querySelector('.drag-ghost'),
      draggingClass: tab.classList.contains('dragging'),
      stripMarked: document.getElementById('tabs').classList.contains('dragging-active'),
    };
    return JSON.stringify(res);
  })()`));

  t('призрак вкладки создаётся при перетаскивании', r.ghostExists === true);
  t('в призраке имя той же вкладки', r.ghostName === r.name, r.ghostName + ' / ' + r.name);
  t('призрак — не копия вкладки (без крестика)',
    r.ghostIsNotTheTab === true && r.ghostNoCloseBtn === true);
  t('призрак не мелькает на экране', r.offscreen === true);
  t('призрак отдан через setDragImage', r.setDragImage === 1, String(r.setDragImage));
  t('исходная вкладка приглушена', r.draggingClass === true);
  t('полоса вкладок помечена как перетаскиваемая', r.stripMarked === true);
  t('после отпускания призрак убран', r.afterEnd.ghostGone === true);
  t('после отпускания метки сняты',
    r.afterEnd.draggingClass === false && r.afterEnd.stripMarked === false);

  // ---------------------------------------------------- разделение экрана
  console.log('\n== разделение экрана ==');

  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const D = ${JSON.stringify(TABS_DIR)};
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    await M.openPath(D + '/' + ${JSON.stringify(MANY_FILES[0])}, { newTab: true });
    await M.openPath(D + '/' + ${JSON.stringify(MANY_FILES[1])}, { newTab: true });
    await M.openPath(D + '/' + ${JSON.stringify(MANY_FILES[2])}, { newTab: true });
    await new Promise(r2 => setTimeout(r2, 500));

    const box = (sel) => {
      const e = document.querySelector(sel);
      return { left: Math.round(e.getBoundingClientRect().left), right: Math.round(e.getBoundingClientRect().right) };
    };
    return JSON.stringify({
      second: M.secondId(),
      panelHidden: document.getElementById('panel2').hidden,
      dividerHidden: document.getElementById('splitDivider').hidden,
      split: box('#split'),
      main: box('.main'),
      order: [...document.getElementById('split').children].map(k => k.id || k.className.split(' ')[0]),
    });
  })()`));

  t('без разделения вторая панель скрыта', r.panelHidden === true && r.second === null);
  t('рамка разделения не занимает место', r.dividerHidden === true);
  // Заметку ужимает проводник справа, поэтому «во всю область» — это ширина
  // #split, а не окна.
  t('без разделения заметка во всю область',
    r.main.left === r.split.left && r.main.right === r.split.right,
    JSON.stringify(r.main) + ' против ' + JSON.stringify(r.split));
  t('порядок: заметка, рамка, вторая панель',
    JSON.stringify(r.order) === JSON.stringify(['main', 'splitDivider', 'panel2']),
    JSON.stringify(r.order));

  // Перетаскивание вкладки в поле заметки разделяет экран
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const tabsEl = document.getElementById('tabs');
    const content = document.getElementById('content');
    // берём первую НЕактивную вкладку
    const inactive = [...document.querySelectorAll('.tab')].find(d => !d.classList.contains('active'));
    const wantId = +inactive.dataset.id;

    const ev = new Event('dragstart', { bubbles: true, cancelable: true });
    ev.dataTransfer = { effectAllowed: '', setData() {}, setDragImage() {} };
    inactive.dispatchEvent(ev);
    await new Promise(r2 => setTimeout(r2, 50));

    // курсор над полем заметки: рамка места разделения должна появиться
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    over.dataTransfer = { dropEffect: '' };
    content.dispatchEvent(over);
    await new Promise(r2 => setTimeout(r2, 50));
    const hinted = document.querySelector('.main').classList.contains('drop-split');

    const drop = new Event('drop', { bubbles: true, cancelable: true });
    drop.dataTransfer = { dropEffect: '' };
    content.dispatchEvent(drop);
    await new Promise(r2 => setTimeout(r2, 500));

    const main = document.querySelector('.main').getBoundingClientRect();
    const panel = document.getElementById('panel2').getBoundingClientRect();
    return JSON.stringify({
      wantId, hinted,
      second: M.secondId(),
      panelHidden: document.getElementById('panel2').hidden,
      dividerHidden: document.getElementById('splitDivider').hidden,
      mainRight: Math.round(main.right),
      panelLeft: Math.round(panel.left),
      panelWidth: Math.round(panel.width),
      headHeight: Math.round(document.querySelector('.second-head').getBoundingClientRect().height),
      headTitle: document.getElementById('secondTitle').textContent,
      pad2: parseFloat(getComputedStyle(document.getElementById('content2')).paddingLeft),
      marked: [...document.querySelectorAll('.tab.in-second')].length,
      markedId: +(document.querySelector('.tab.in-second') || { dataset: {} }).dataset.id,
      contentHas: document.getElementById('content2').innerHTML.length > 20,
      strip: tabsEl.querySelectorAll('.tab').length,
    });
  })()`));

  t('над полем заметки показано место разделения', r.hinted === true);
  t('отпустили в поле — экран разделён', r.second === r.wantId && r.panelHidden === false);
  t('рамка разделения появилась', r.dividerHidden === false);
  t('панели не наезжают друг на друга', r.mainRight <= r.panelLeft + 1,
    r.mainRight + '/' + r.panelLeft);
  t('вторая панель получила заметку', r.contentHas === true);
  t('в шапке — имя заметки', (r.headTitle || '').length > 3, r.headTitle);
  t('шапка узкая', r.headHeight > 0 && r.headHeight <= 40, String(r.headHeight));
  // Регресс: .content объявлен в файле ПОСЛЕ блока разделения, и при равной
  // специфичности побеждал он — общие поля 74px съедали четверть узкой панели,
  // и заголовки ломались на два слова. Поэтому селектор из двух классов.
  t('у второй панели свои, меньшие поля', r.pad2 > 0 && r.pad2 < 40, r.pad2 + 'px');
  t('полоса вкладок общая, вкладок столько же', r.strip === 3, String(r.strip));
  t('в правой панели помечена ровно одна вкладка', r.marked === 1, String(r.marked));
  t('помечена именно та, что справа', r.markedId === r.wantId);

  // Пункты оглавления левой панели относятся к рабочей заметке, а не к правой
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    return JSON.stringify({
      tocTitle: null,
      content2Headings: document.getElementById('content2').querySelectorAll('h1,h2').length,
    });
  })()`));
  t('во второй панели есть свои заголовки', r.content2Headings > 0, String(r.content2Headings));

  // Клик по вкладке правой панели меняет панели местами
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const wasActive = M.active().id;
    const wasSecond = M.secondId();
    document.querySelector('.tab.in-second').click();
    await new Promise(r2 => setTimeout(r2, 500));
    return JSON.stringify({
      wasActive, wasSecond,
      active: M.active().id,
      second: M.secondId(),
      panelHidden: document.getElementById('panel2').hidden,
      mainText: document.getElementById('content').textContent.slice(0, 40),
      secondText: document.getElementById('content2').textContent.slice(0, 40),
    });
  })()`));

  t('клик по правой вкладке вывел её в рабочую область', r.active === r.wasSecond);
  t('прежняя рабочая вкладка ушла вправо', r.second === r.wasActive);
  t('панели после перестановки те же две', r.panelHidden === false);
  t('тексты в панелях разные', r.mainText !== r.secondText);

  // Крестик в шапке убирает правую панель
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    document.getElementById('btnHideSecond').click();
    await new Promise(r2 => setTimeout(r2, 500));
    const main = document.querySelector('.main').getBoundingClientRect();
    return JSON.stringify({
      second: M.secondId(),
      panelHidden: document.getElementById('panel2').hidden,
      dividerHidden: document.getElementById('splitDivider').hidden,
      marked: document.querySelectorAll('.tab.in-second').length,
      mainRight: Math.round(main.right),
      splitRight: Math.round(document.getElementById('split').getBoundingClientRect().right),
    });
  })()`));

  t('крестик убрал правую панель', r.second === null && r.panelHidden === true);
  t('рамка разделения убрана', r.dividerHidden === true);
  t('метка на вкладке снята', r.marked === 0, String(r.marked));
  t('рабочая область вернулась на всю ширину', r.mainRight === r.splitRight, r.mainRight + '/' + r.splitRight);

  // Закрытие вкладки правой панели убирает и панель
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const ids = [...M.tabs.keys()];
    await M.selectTab(ids[0]);
    await M.openSecond(ids[1]);
    await new Promise(r2 => setTimeout(r2, 400));
    const before = { second: M.secondId(), hidden: document.getElementById('panel2').hidden };
    await M.closeTab(ids[1], { silent: true });
    await new Promise(r2 => setTimeout(r2, 400));
    return JSON.stringify({
      before,
      second: M.secondId(),
      hidden: document.getElementById('panel2').hidden,
      marked: document.querySelectorAll('.tab.in-second').length,
      content2: document.getElementById('content2').innerHTML.length,
    });
  })()`));

  t('панель была открыта до закрытия вкладки', r.before.hidden === false);
  t('закрыли вкладку — панель закрылась', r.second === null && r.hidden === true);
  t('в панели ничего не осталось', r.content2 === 0, String(r.content2));
  t('метка на вкладках снята', r.marked === 0, String(r.marked));

  // Разделить одной вкладкой нельзя: нечего показывать рядом
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const D = ${JSON.stringify(TABS_DIR)};
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    await new Promise(r2 => setTimeout(r2, 400));
    // Закрытие последней вкладки оставляет пустую — она и есть единственный
    // источник для splitScreen(), и разделить нечего.
    const one = M.splitScreen();
    // openPath переиспользует пустую вкладку, поэтому одной заметки мало:
    // вкладок всё равно одна.
    await M.openPath(D + '/' + ${JSON.stringify(MANY_FILES[0])}, { newTab: true });
    await new Promise(r2 => setTimeout(r2, 300));
    const afterOne = M.tabs.size;
    await M.openPath(D + '/' + ${JSON.stringify(MANY_FILES[1])}, { newTab: true });
    await new Promise(r2 => setTimeout(r2, 300));
    const two = M.splitScreen();
    await new Promise(r2 => setTimeout(r2, 400));
    const res = { one, two, afterOne, second: M.secondId(), tabs: M.tabs.size };
    M.closeSecond();
    await new Promise(r2 => setTimeout(r2, 300));
    return JSON.stringify(res);
  })()`));

  t('единственную вкладку разделить не с чем', r.one === false);
  t('одна заметка — всё ещё одна вкладка', r.afterOne === 1, String(r.afterOne));
  t('со второй вкладкой разделение получается', r.two === true && r.second !== null);
  t('в разделении две вкладки', r.tabs === 2, String(r.tabs));

  // Меню «Вид»: пункт есть и умеет разделять
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const D = ${JSON.stringify(TABS_DIR)};
    M.closeSecond();
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    await M.openPath(D + '/' + ${JSON.stringify(MANY_FILES[0])}, { newTab: true });
    await M.openPath(D + '/' + ${JSON.stringify(MANY_FILES[1])}, { newTab: true });
    await new Promise(r2 => setTimeout(r2, 500));
    document.querySelectorAll('.ctxmenu').forEach(m => m.remove());
    document.getElementById('appBrand').click();
    await new Promise(r2 => setTimeout(r2, 250));
    [...document.querySelectorAll('.ctxmenu-parent')].find(b => /Вид/.test(b.textContent))
      .dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 350));
    const menus = [...document.querySelectorAll('.ctxmenu')];
    const sub = menus[menus.length - 1];
    const labels = [...sub.querySelectorAll('.ctxmenu-label')].map(x => x.textContent);
    const item = [...sub.querySelectorAll('.ctxmenu-item')].find(b => /Разделить экран/.test(b.textContent));
    const wasDisabled = !item || item.disabled;
    item.click();
    await new Promise(r2 => setTimeout(r2, 500));
    const res = { wasDisabled, second: M.secondId(), labels,
      hidden: document.getElementById('panel2').hidden };
    M.closeSecond();
    await new Promise(r2 => setTimeout(r2, 300));
    return JSON.stringify(res);
  })()`));

  t('пункт «Разделить экран» доступен при двух вкладках', r.wasDisabled === false);
  t('пункт из меню разделяет экран', r.second !== null && r.hidden === false);
  t('пункт «Закрыть правую панель» появился при разделении',
    (r.labels || []).includes('Закрыть правую панель'), JSON.stringify(r.labels));

  // ------------------------------------------------------ масштаб числом
  console.log('\n== масштаб числом ==');

  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const z = document.getElementById('zoomVal');
    const out = {};
    out.tag = z.tagName;
    out.initial = z.value;

    // Ввод числа с клавиатуры. Фокус снимаем и ставим заново на каждый набор:
    // focus() на уже сфокусированном поле не присылает событие focus.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value').set;
    const key = (k) => z.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const type = async (v) => {
      z.blur();
      await new Promise(r2 => setTimeout(r2, 60));
      z.focus();
      z.select();
      setter.call(z, v);
      key('Enter');
      await new Promise(r2 => setTimeout(r2, 220));
    };

    await type('85');
    key('Enter');
    await new Promise(r2 => setTimeout(r2, 250));
    out.after85 = { val: z.value, font: document.getElementById('content').style.fontSize };

    out.after85b = out.after85;
    await type('175%');
    out.after175 = { val: z.value, font: document.getElementById('content').style.fontSize };

    // Запятая как десятичный разделитель: без blur Enter тоже годится
    await type('0,6');
    out.after06 = { val: z.value, font: document.getElementById('content').style.fontSize };

    return JSON.stringify(out);
  })()`));

  t('процент масштаба — поле ввода', r.tag === 'INPUT', r.tag);
  t('исходное значение 100%', r.initial === '100%', r.initial);
  t('вписали 85 — применилось', r.after85.val === '85%'
    && Math.abs(parseFloat(r.after85.font) - 12.75) < 0.1, JSON.stringify(r.after85));
  t('вписали 175% — применилось', r.after175.val === '175%'
    && Math.abs(parseFloat(r.after175.font) - 26.25) < 0.1, JSON.stringify(r.after175));
  t('вписали 0,6 через запятую — это 60%', r.after06.val === '60%'
    && Math.abs(parseFloat(r.after06.font) - 9) < 0.1, JSON.stringify(r.after06));

  // Кнопки продолжают работать, поле показывает их результат
  r = JSON.parse(await js(`(async () => {
    const z = document.getElementById('zoomVal');
    const before = parseFloat(z.value);
    document.getElementById('btnZoomIn').click();
    await new Promise(r2 => setTimeout(r2, 200));
    const up = z.value;
    document.getElementById('btnZoomOut').click();
    await new Promise(r2 => setTimeout(r2, 200));
    return JSON.stringify({ before, up, back: z.value });
  })()`));

  t('кнопка «+» меняет масштаб', parseFloat(r.up) > parseFloat(r.before), r.before + ' -> ' + r.up);
  t('кнопка «−» возвращает', parseFloat(r.back) < parseFloat(r.up), r.up + ' -> ' + r.back);

  // Мусор и выход за границы не применяются молча
  r = JSON.parse(await js(`(async () => {
    const z = document.getElementById('zoomVal');
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value').set;
    const key = (k) => z.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const bad = [];
    const type = async (v) => {
      // focus() на уже сфокусированном элементе не шлёт событие focus
      z.blur();
      await new Promise(r2 => setTimeout(r2, 60));
      z.focus();
      z.select();
      setter.call(z, v);
    };
    const tryVal = async (v) => {
      document.getElementById('btnZoomIn').click();
      await new Promise(r2 => setTimeout(r2, 120));
      const keep = z.value;
      await type(v);
      key('Enter');
      await new Promise(r2 => setTimeout(r2, 220));
      bad.push({ typed: v, kept: keep, now: z.value,
        status: document.getElementById('statusText').textContent });
      return z.value;
    };
    await tryVal('абв');
    await tryVal('900');
    await tryVal('');
    return JSON.stringify(bad);
  })()`));

  t('ерунда не применяется', parseFloat(r[0].now) === parseFloat(r[0].kept), JSON.stringify(r[0]));
  t('на ерунду есть сообщение', /Не понял/.test(r[0].status || ''), r[0].status);
  t('900% отклонено', parseFloat(r[1].now) === parseFloat(r[1].kept), JSON.stringify(r[1]));
  t('на выход за границу есть сообщение', /вне/.test(r[1].status || ''), r[1].status);
  t('пустое поле не обнуляет масштаб', parseFloat(r[2].now) === parseFloat(r[2].kept), JSON.stringify(r[2]));

  // Escape откатывает набор
  r = JSON.parse(await js(`(async () => {
    const z = document.getElementById('zoomVal');
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value').set;
    const M = window.__mdvTest;
    const good = z.value;
    z.blur();
    await new Promise(r2 => setTimeout(r2, 60));
    z.focus();
    z.select();
    setter.call(z, '120');
    z.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    z.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 250));
    return JSON.stringify({ good, after: z.value, zoom: M.zoom(),
      focused: document.activeElement === z,
      modalsLeft: document.querySelectorAll('.modal-back').length });
  })()`));

  t('Escape откатывает набор', r.after === r.good && Math.abs(r.zoom - 0.9) < 0.01,
    r.good + ' -> ' + r.after + ' зум=' + r.zoom + ' окон=' + r.modalsLeft);
  t('Escape снимает фокус с поля', r.focused === false);

  // Пробел не уводит фокус (иначе «85 » не применилось бы)
  r = JSON.parse(await js(`(async () => {
    const z = document.getElementById('zoomVal');
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value').set;
    let bubbled = 0;
    const spy = () => { bubbled++; };
    z.blur();
    await new Promise(r2 => setTimeout(r2, 60));
    z.focus();
    z.select();
    setter.call(z, '70');
    await new Promise(r2 => setTimeout(r2, 60));

    // Слушаем ТОЛЬКО на время пробела: Enter поле обрабатывает сам и тоже не
    // выпускает событие наружу, но проверять это здесь незачем — важен пробел,
    // потому что в обработчике окна он означает «листать вниз».
    document.addEventListener('keydown', spy);
    z.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 120));
    document.removeEventListener('keydown', spy);

    z.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 220));
    return JSON.stringify({ bubbled, val: z.value });
  })()`));

  t('пробел не улетает в обработчик окна', r.bubbled === 0, String(r.bubbled));
  t('пробел внутри числа не мешает', r.val === '70%', r.val);
  // ------------------------------------------------- удаление в корзину
  // Проверяем на НАСТОЯЩЕМ временном файле: реальный вызов shell.trashItem
  // через IPC. Отмену тоже проверяем — файл должен остаться на месте.
  console.log('\n== удаление в корзину ==');
  const doomed = path.join(notesDir, 'doomed.md');
  fs.writeFileSync(doomed, '# удалить меня\n', 'utf8');

  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    const p = ${JSON.stringify(doomed)};
    let asked = null;
    M.setConfirm((title) => { asked = title; return false; });
    await M.trashFile(p, 'doomed.md');
    await new Promise(r2 => setTimeout(r2, 400));
    return JSON.stringify({ asked, stillThere: M.existsSync ? M.existsSync(p) : null });
  })()`));

  t('удаление спрашивает подтверждение', !!r.asked, String(r.asked));
  t('в вопросе есть имя файла', /doomed\.md/.test(String(r.asked)), String(r.asked));
  t('после отказа файл на месте', fs.existsSync(doomed) === true);

  // теперь соглашаемся
  await js(`(async () => {
    const M = window.__mdvTest;
    M.setConfirm(() => true);
    await M.trashFile(${JSON.stringify(doomed)}, 'doomed.md');
    return 1;
  })()`);
  await sleep(700);

  t('после согласия файл исчез с диска', !fs.existsSync(doomed));

  // Несохранённая вкладка блокирует удаление
  const guard = path.join(notesDir, 'guard.md');
  fs.writeFileSync(guard, '# страж\n', 'utf8');
  await js(`(async () => {
    const M = window.__mdvTest;
    await M.openPath(${JSON.stringify(guard)}, { newTab: true });
    const t = M.active();
    t.mode = 'edit'; t.raw = '# мусор'; t.dirty = true;
    M.renderActive();
    return 1;
  })()`);
  await sleep(300);
  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    let asked = null;
    M.setConfirm((t) => { asked = t; return true; });
    await M.trashFile(${JSON.stringify(guard)}, 'guard.md');
    await new Promise(r2 => setTimeout(r2, 400));
    return JSON.stringify({ asked });
  })()`));
  t('несохранённая вкладка блокирует удаление',
    r.asked === null && fs.existsSync(guard) === true, JSON.stringify(r));
  t('при блокировке показан статус с отказом',
    /удаление отменено/.test(await js("document.getElementById('statusText').textContent")),
    await js("document.getElementById('statusText').textContent"));

  // приводим дерево в порядок к следующим секциям
  await js(`(async () => {
    const M = window.__mdvTest;
    M.setConfirm(null);
    for (const id of [...M.tabs.keys()]) await M.closeTab(id, { silent: true });
    document.querySelector('.ctxmenu')?.remove();
    return 1;
  })()`);

  console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL\n');
  c.close();
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('tabs.js упал:', e && e.stack || e); process.exit(1); });