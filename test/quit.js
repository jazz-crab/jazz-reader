'use strict';
/*
 * Quitting the application: Ctrl+Q asks for confirmation, the "don't ask
 * again" checkbox is remembered, and — above all — quitting does not crash.
 *
 * The crash was real: releaseTabShortcuts() assigned an empty array to a const
 * right in will-quit, and instead of closing, a "JazzReader — failed to start"
 * window appeared on screen. No test caught it: they all closed the instance with
 * kill, not by quitting the application.
 *
 * The settings are read from a separate --user-data-dir, so that the user's
 * settings.json is not touched. The application's answers are read from stderr:
 * log() always writes there, regardless of where the log file ended up.
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
  // The page is visible over CDP before app.js has run: without this wait
  // the check catches "the application is still loading" rather than
  // "the quit is broken".
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

  // --- 1. By default quitting asks; "Cancel" leaves the application alive --
  //
  // The answer is passed as a button index rather than by clicking in the window:
  // the system dialog can only be closed with a real mouse, and a window popping
  // up during automated checks takes focus from whatever the person has open on
  // screen.
  {
    const app = await launch(userData, sample);
    t('приложение поднялось', !!app.page, app.out().slice(-400));
    if (app.page) {
      const dirty = await evaluate(app.page, 'window.mdvDirtyTabs ? window.mdvDirtyTabs() : -1');
      t('renderer отдаёт число несохранённых вкладок', Number(dirty) === 0, String(dirty));

      await evaluate(app.page, 'window.mdv.testQuit(1)');
      await sleep(1500);
      const out = app.out();
      t('выход спрашивает подтверждение',
        /выход: подтверждение получено без диалога/.test(out), out.slice(-300));
      t('после отмены приложение ещё живо', app.child.exitCode === null);
      t('вопрос не приводит к ошибке',
        !/Assignment to constant variable/.test(out), out.slice(-300));

      // The same instance, now with agreement: it should quit without hanging.
      await evaluate(app.page, 'window.mdv.testQuit(0)');
      const code = await waitExit(app.child, 12000);
      t('по согласию приложение выходит', code !== null, 'код ' + code);
      t('выход по согласию без ошибки', code === 0, 'код ' + code + '\n' + app.out().slice(-400));
      if (code === null) app.child.kill();
      await sleep(1200);
    }
  }

  // --- 2. "Don't ask again" -> quitting without a question ---------------------
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

  // --- 3. Statics: the hotkey and the shape of the dialog ---------------------------
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  t('пункт «Выход» на Ctrl+Q',
    /label: tr\('menu\.file\.quit'\), accelerator: 'CmdOrCtrl\+Q'/.test(mainSrc));
  t('у пункта «Выход» нет role: quit',
    !/label: 'Выход'[^\n]*role: 'quit'/.test(mainSrc));
  t('диалог системный, с галочкой',
    /dialog\.showMessageBox\(/.test(mainSrc)
    && /checkboxLabel: tr\('quit\.neverAgain'\)/.test(mainSrc));
  t('у диалога два ответа',
    /buttons: \[tr\('quit\.close'\), tr\('quit\.cancel'\)\]/.test(mainSrc));
  t('крестик в рамке равносилен «Отмена»', /cancelId: 1/.test(mainSrc));
  t('заголовок диалога — «Закрыть?»', /title: tr\('quit\.title'\)/.test(mainSrc));
  // The dialog must stay in requestQuit, and the test answer must go past
  // showMessageBox. Otherwise the checks will start putting a window on screen again.
  t('ответ из теста идёт мимо диалога',
    /async function requestQuit\(answer = null\)/.test(mainSrc)
    && /if \(answer === null\) \{/.test(mainSrc));
  t('тестовый канал передаёт индекс ответа',
    /ipcMain\.handle\('mdv:testQuit', \(_e, answer = null\)/.test(mainSrc));
  // The keys of the quit dialog must exist in both dictionaries: a source check
  // for t('quit.title') otherwise passes even when there is no translation.
  const dictRu = require(path.join(ROOT, 'src', 'i18n', 'ru.js'));
  const dictEn = require(path.join(ROOT, 'src', 'i18n', 'en.js'));
  for (const k of ['quit.title', 'quit.message', 'quit.close', 'quit.cancel',
    'quit.neverAgain', 'quit.detailDirty', 'quit.detailClean',
    'menu.file.quit', 'error.startup']) {
    t('ключ есть в обоих словарях: ' + k, dictRu[k] != null && dictEn[k] != null);
  }
  // The plural forms must cover one/few/many: otherwise the Russian dialog about
  // unsaved changes silently returns English.
  t('quit.detailDirty покрывает русские формы',
    dictRu['quit.detailDirty'] && dictRu['quit.detailDirty'].one
    && dictRu['quit.detailDirty'].few && dictRu['quit.detailDirty'].many);

  t('настройка вопроса читается и пишется',
    /ipc\.setting\('quitAsk'\)/.test(mainSrc)
    && /ipc\.setting\('quitAsk', false\)/.test(mainSrc));
  t('список хоткеев объявлен через let',
    /let shortcuts = \[\];/.test(mainSrc) && !/const shortcuts = \[\];/.test(mainSrc));
  // There used to be a source check for the literal --mdview-hidden next to
  // mdv:testQuit. It broke on any harmless edit: I replaced the inline flag check
  // with the HIDDEN constant, and the regex stopped finding the flag although the
  // meaning had not changed. We now check both parts separately:
  // the channel really is behind `if (HIDDEN)`, and HIDDEN really is derived from
  // the hidden mode — otherwise the check would be empty.
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
