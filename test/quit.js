'use strict';
/*
 * Выход из приложения: Ctrl+Q спрашивает подтверждение, галочка «не
 * показывать больше» запоминается, и — главное — выход не падает.
 *
 * Падение было настоящим: releaseTabShortcuts() присваивала пустой массив
 * const'у прямо в will-quit, и вместо закрытия на экране появлялось окно
 * «JazzReader — ошибка при запуске». Ни один тест этого не ловил: все закрывали
 * экземпляр kill'ом, а не через выход из приложения.
 *
 * Настройки читаем из отдельного --user-data-dir, чтобы не трогать
 * пользовательский settings.json. Ответы приложения читаем из stderr:
 * log() пишет туда всегда, независимо от того, куда лег файл журнала.
 *
 *   node test/quit.js
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
    } catch { /* ещё поднимается */ }
    await sleep(300);
  }
  return null;
}

async function evaluate(page, expression) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  await new Promise((r) => { ws.onopen = r; });
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  ws.close();
  if (r.exceptionDetails) return 'EXC ' + JSON.stringify(r.exceptionDetails.exception);
  return r.result.value;
}

async function launch(userData, sample) {
  const port = await freePort();
  const child = spawn(electron, [
    ROOT,
    '--remote-debugging-port=' + port,
    '--no-sandbox',
    '--disable-gpu',
    '--jazzreader-hidden',
    '--user-data-dir=' + userData,
    sample,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '';
  child.stdout.on('data', (b) => { out += b.toString(); });
  child.stderr.on('data', (b) => { out += b.toString(); });
  const page = await waitForPage(port, 25000);
  // Страница видна по CDP раньше, чем отработал app.js: без этого ожидания
  // проверка ловит не «сломанный выход», а «приложение ещё грузится».
  if (page) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const ready = await evaluate(page, 'document.readyState === "complete" && !!window.mdvDirtyTabs');
      if (ready === true) break;
      await sleep(300);
    }
  }
  return { child, page, out: () => out };
}

function waitExit(child, ms) {
  return new Promise((res) => {
    const timer = setTimeout(() => res(null), ms);
    child.on('exit', (code) => { clearTimeout(timer); res(code); });
  });
}

async function main() {
  console.log('\n== выход из приложения ==');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jazz-reader-quit-'));
  const userData = path.join(tmpDir, 'userdata');
  const sample = path.join(tmpDir, 'sample.md');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(sample, '# выход\n', 'utf8');
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };
  process.on('exit', cleanup);

  // --- 1. По умолчанию выход спрашивает, и приложение остаётся жить -----
  {
    const app = await launch(userData, sample);
    t('приложение поднялось', !!app.page, app.out().slice(-400));
    if (app.page) {
      const dirty = await evaluate(app.page, 'window.mdvDirtyTabs ? window.mdvDirtyTabs() : -1');
      t('renderer отдаёт число несохранённых вкладок', Number(dirty) === 0, String(dirty));

      await evaluate(app.page, 'window.mdv.testQuit()');
      await sleep(1500);
      const out = app.out();
      t('выход спрашивает подтверждение',
        /выход: спрашиваем подтверждение/.test(out), out.slice(-300));
      t('после вопроса приложение ещё живо', app.child.exitCode === null);
      t('вопрос не приводит к ошибке',
        !/Assignment to constant variable/.test(out), out.slice(-300));
      app.child.kill();
      await sleep(1200);
    }
  }

  // --- 2. «Не показывать больше» -> выход без вопроса ---------------------
  {
    fs.writeFileSync(path.join(userData, 'settings.json'),
      JSON.stringify({ quitAsk: false }, null, 2), 'utf8');
    const app = await launch(userData, sample);
    t('второй экземпляр поднялся', !!app.page, app.out().slice(-400));
    if (app.page) {
      await evaluate(app.page, 'window.mdv.testQuit()');
      const code = await waitExit(app.child, 12000);
      const out = app.out();
      t('с выключенным вопросом приложение выходит', code !== null, 'код ' + code);
      t('выход прошёл без ошибки', code === 0, 'код ' + code + '\n' + out.slice(-400));
      t('в логе видно «закрываемся сразу»',
        /выход: подтверждение выключено/.test(out), out.slice(-300));
      t('в логе нет ошибки про const',
        !/Assignment to constant variable/.test(out), out.slice(-300));
      if (code === null) app.child.kill();
      await sleep(800);
    }
  }

  // --- 3. Статика: хоткей и структура диалога ---------------------------
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  t('пункт «Выход» на Ctrl+Q',
    /label: 'Выход', accelerator: 'CmdOrCtrl\+Q'/.test(mainSrc));
  t('у пункта «Выход» нет role: quit',
    !/label: 'Выход'[^\n]*role: 'quit'/.test(mainSrc));
  t('диалог системный, с галочкой',
    /dialog\.showMessageBox\(/.test(mainSrc)
    && /checkboxLabel: 'Не показывать больше'/.test(mainSrc));
  t('у диалога два ответа',
    /buttons: \['Закрыть', 'Отмена'\]/.test(mainSrc));
  t('крестик в рамке равносилен «Отмена»', /cancelId: 1/.test(mainSrc));
  t('заголовок диалога — «Закрыть?»', /title: 'Закрыть\?'/.test(mainSrc));
  t('настройка вопроса читается и пишется',
    /ipc\.setting\('quitAsk'\)/.test(mainSrc)
    && /ipc\.setting\('quitAsk', false\)/.test(mainSrc));
  t('список хоткеев объявлен через let',
    /let shortcuts = \[\];/.test(mainSrc) && !/const shortcuts = \[\];/.test(mainSrc));
  // Раньше тут была проверка исходника на литерал --mdview-hidden рядом с
  // mdv:testQuit. Она ломалась от любой безобидной правки: я заменил
  // инлайн-проверку флага на константу HIDDEN, и регулярка перестала находить
  // флаг, хотя смысл не изменился. Проверяем теперь обе части по отдельности:
  // канал действительно за `if (HIDDEN)`, и HIDDEN действительно выводится из
  // скрытого режима — иначе проверка была бы пустой.
  t('тестовый канал выхода есть только в скрытом режиме',
    /if \(HIDDEN\) \{[\s\S]{0,200}mdv:testQuit/.test(mainSrc)
    && /const HIDDEN =[\s\S]{0,400}JAZZREADER_HIDDEN/.test(mainSrc));

  const appJs = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  t('renderer сообщает число несохранённых вкладок',
    /window\.mdvDirtyTabs = \(\) =>/.test(appJs));

  cleanup();
  console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL\n');
  process.exit(fail ? 1 : 0);
}

main();
