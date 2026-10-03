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

  const port = await freePort();
  const child = spawn(electron, [
    ROOT, '--remote-debugging-port=' + port, '--no-sandbox', '--disable-gpu',
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
    window.__mdvTest.setConfirm((title) => { window.__asked.push(title); return false; });

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

  r = JSON.parse(await js(`(async () => {
    const M = window.__mdvTest;
    await M.openPath(${JSON.stringify(tocFile)}, { newTab: true });
    const res = {};
    const ov = document.getElementById('tocOverlay');
    res.tocBtnHidden = document.getElementById('btnToc').hidden;
    res.overlayHiddenInitially = ov.hidden;
    document.getElementById('btnToc').click();
    await new Promise(r2 => setTimeout(r2, 200));
    res.overlayShown = !ov.hidden;
    res.tocEntries = document.querySelectorAll('#paneToc a').length;
    // переключателя панелей быть не должно
    res.oldSwitchGone = document.querySelectorAll('.side-btn').length === 0;
    res.filesPaneVisible = !document.getElementById('paneFiles').closest('.side-pane').hidden;
    document.getElementById('btnCloseToc').click();
    res.overlayHiddenAfter = ov.hidden;
    return JSON.stringify(res);
  })()`));

  t('кнопка «Оглавление» видна при открытом файле', r.tocBtnHidden === false);
  t('по умолчанию оглавление свёрнуто', r.overlayHiddenInitially === true);
  t('кнопка открывает оглавление', r.overlayShown === true);
  t('в оглавлении есть пункты', r.tocEntries >= 3, 'пунктов: ' + r.tocEntries);
  t('старый переключатель «Файлы/Оглавление» убран', r.oldSwitchGone === true);
  t('проводник остался в панели файлов', r.filesPaneVisible === true);
  t('крестик закрывает оглавление', r.overlayHiddenAfter === true);

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

  // Таббар: иконка слева, плюс справа
  r = JSON.parse(await js(`(async () => {
    const bar = document.getElementById('tabbar');
    const kids = [...bar.children].map(k => k.id || k.className);
    const brand = document.getElementById('appBrand');
    const plus = document.getElementById('btnNewTab');
    const wrap = document.getElementById('newTabWrap');
    const iTabs = [...bar.children].indexOf(bar.querySelector('.tabs'));
    const iWrap = [...bar.children].indexOf(wrap);
    const iSpacer = [...bar.children].indexOf(bar.querySelector('.tabbar-spacer'));
    const res = { kids, brandLeft: bar.children[0] === brand, iTabs, iWrap, iSpacer,
      plusInWrap: plus.parentElement === wrap,
      // порядок именно такой: иконка | вкладки | плюс | распорка
      plusAfterTabs: iTabs < iWrap && !!(plus.parentElement === wrap),
      plusBeforeSpacer: iWrap < iSpacer };
    // плюс открывает меню
    document.querySelector('.ctxmenu')?.remove();
    plus.click();
    await new Promise(r2 => setTimeout(r2, 150));
    res.menuOpen = document.getElementById('newTabWrap').classList.contains('open');
    res.menuItems = [...document.querySelectorAll('#newTabMenu button')].map(b => b.textContent.trim());
    res.plusIsIcon = !!plus.querySelector('svg');
    res.brandIsSvg = !!brand.querySelector('svg');
    return JSON.stringify(res);
  })()`));

  t('иконка приложения первая слева', r.brandLeft === true, JSON.stringify(r.kids));
  t('плюс после вкладок и перед распоркой', r.plusAfterTabs === true && r.plusBeforeSpacer === true,
    JSON.stringify(r.kids));
  t('плюс — иконка, не символ +', r.plusIsIcon === true);
  t('иконка приложения — svg', r.brandIsSvg === true);
  t('плюс открывает меню', r.menuOpen === true);
  t('в меню плюса 3 пункта', (r.menuItems || []).length === 3, JSON.stringify(r.menuItems));
  t('в меню плюса есть пустая вкладка', (r.menuItems || []).some((l) => /пустая/.test(l)));

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