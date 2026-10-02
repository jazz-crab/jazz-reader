'use strict';
/* Smoke-тест реального окна Electron под xvfb + скриншот для визуальной проверки. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const ipc = require('../ipc');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const ROOT = '/srv/uchoba';
const SAMPLE = path.join(ROOT, 'Электротехника', 'Готово (вариант 6)', 'РГР-3-задача-1', 'rgr3_z1.md');

const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  ipc.register();   // настоящие обработчики из ipc.js
  const win = new BrowserWindow({
    width: 1440, height: 900, show: true,
    backgroundColor: '#1a1b26',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  win.webContents.on('console-message', (ev, lvl) => {
    const level = typeof ev === 'object' && ev !== null ? ev.level : lvl;
    const msg = typeof ev === 'object' && ev !== null ? ev.message : String(ev);
    if (level === 'error' || level === 3) errors.push('console: ' + msg);
  });
  win.webContents.on('preload-error', (_e, p, err) => errors.push('preload ' + p + ': ' + err.message));
  win.webContents.on('did-fail-load', (_e, c, d) => errors.push('load failed: ' + c + ' ' + d));

  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await sleep(700);

  const script = `(async () => {
    const out = {};
    out.marked = typeof marked !== 'undefined';
    out.katex  = typeof katex !== 'undefined';
    out.api    = typeof window.mdv !== 'undefined';
    out.preloadKeys = Object.keys(window.mdv || {}).sort();

    // 1. читаем реальный файл с формулами
    const t = await openPath(${JSON.stringify(SAMPLE)}, { newTab: true });
    await new Promise(r => setTimeout(r, 400));
    out.opened = !!(t && t.path);
    out.encoding = t && t.encoding;
    out.tabs = tabs.size;
    out.katexBlocks = document.querySelectorAll('#content .katex').length;
    out.mathErrors = document.querySelectorAll('#content .mdv-math-error').length;
    out.displayMath = document.querySelectorAll('#content .mdv-math-block').length;
    out.inlineMath  = document.querySelectorAll('#content .mdv-math-inline').length;
    out.leftoverPlaceholder = /MDVMATH\\d+END/.test(document.getElementById('content').innerHTML);
    out.textSample = document.querySelector('#content .mdv-math') ? document.querySelector('#content .mdv-math').getAttribute('data-tex') : null;
    out.tocItems = document.querySelectorAll('#paneToc .toc-item').length;
    out.filenameShown = document.getElementById('fileName').textContent;

    // 2. перечисление папки
    const tree = await mdv.listMd(${JSON.stringify(ROOT)});
    out.mdFilesFound = tree.total;
    out.firstGroups = tree.tree.slice(0, 3).map(g => g.dir + ':' + (g.items ? g.items.length : 'dir'));

    // 3. навигация назад/вперёд по истории документа
    out.histLen = t.hist.length;
    const heads = [...document.querySelectorAll('#content h2')];
    if (heads.length > 1) {
      document.querySelectorAll('#paneToc .toc-item')[1].click();
      await new Promise(r => setTimeout(r, 250));
      out.histAfterAnchor = t.hist.length;
      await go(-1);
      await new Promise(r => setTimeout(r, 250));
      out.histAfterBack = t.hist.length;
      out.backDisabled = document.getElementById('btnBack').disabled;
    }

    // 4. режим правки
    document.getElementById('btnMode').click();
    await new Promise(r => setTimeout(r, 250));
    out.editorVisible = !document.getElementById('editor').hidden;
    out.editorHasText = document.getElementById('editor').value.length > 100;

    return out;
  })()`;

  let res;
  try { res = await win.webContents.executeJavaScript(script, true); }
  catch (e) { errors.push('executeJavaScript: ' + e.message); res = {}; }

  // скриншот в режиме чтения с формулами
  try {
    await win.webContents.executeJavaScript('document.getElementById("btnMode").click(); void 0');
    await sleep(500);
    const img = await win.webContents.capturePage();
    fs.writeFileSync('/tmp/mdview-shot.png', img.toPNG());
    console.log('скриншот: /tmp/mdview-shot.png');
  } catch (e) { errors.push('capture: ' + e.message); }

  console.log('\n=== РЕЗУЛЬТАТ ===');
  console.log(JSON.stringify(res, null, 2));
  if (errors.length) {
    console.log('\n=== ОШИБКИ (' + errors.length + ') ===');
    for (const e of [...new Set(errors)].slice(0, 15)) console.log('  ' + e);
  } else {
    console.log('\nошибок в консоли нет');
  }
  app.exit(errors.length ? 1 : 0);
});