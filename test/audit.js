'use strict';
/* Аудит раскладки, шрифтов и автономного HTML-экспорта. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const ipc = require('../ipc');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

// Библиотека заметок для прогона. Не в репозитории: укажи MDV_NOTES_DIR
// на каталог с .md и MDV_SAMPLE_NOTE на один файл внутри него.
const ROOT = process.env.MDV_NOTES_DIR || '';
const SAMPLE = process.env.MDV_SAMPLE_NOTE || '';
if (!ROOT || !SAMPLE || !fs.existsSync(SAMPLE)) {
  console.error('Нужны MDV_NOTES_DIR и MDV_SAMPLE_NOTE: задай их и прогони снова.');
  app.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

app.whenReady().then(async () => {
  ipc.register();
  const win = new BrowserWindow({
    // show:true обязательно — без отрисованной поверхности Chromium не шлёт
    // события scroll, и проверка scroll-spy была бы ложно-отрицательной.
    width: 1440, height: 900, show: true, backgroundColor: '#1a1b26',
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: false },
  });
  win.webContents.on('console-message', (ev) => {
    const lvl = typeof ev === 'object' ? ev.level : ev;
    const msg = typeof ev === 'object' ? ev.message : String(ev);
    if (lvl === 'error' || lvl === 3) errors.push(msg);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await sleep(800);

  const js = `(async () => {
    const out = {};
    const r = (el) => el ? el.getBoundingClientRect() : null;
    await openPath(${JSON.stringify(SAMPLE)}, { newTab: true });
    await new Promise(x => setTimeout(x, 600));

    // --- шрифты ---
    out.nerdFontLoaded  = document.fonts.check('12px JetBrainsMonoNF');
    out.katexFontLoaded = document.fonts.check('12px KaTeX_Main');
    await document.fonts.ready;

    // --- раскладка ---
    const tb = r(document.querySelector('.tabbar'));
    const top = r(document.querySelector('.topbar'));
    const side = r(document.querySelector('.sidebar'));
    const cont = r(document.getElementById('content'));
    out.tabbarH = tb && Math.round(tb.height);
    out.topbarH = top && Math.round(top.height);
    out.sidebarW = side && Math.round(side.width);
    out.contentW = cont && Math.round(cont.width);

    // вкладки должны умещаться по высоте под системные кнопки окна (40px)
    out.tabbarMatchesOverlay = out.tabbarH === 40;

    // ни один элемент не должен вылезать по ширине
    out.hOverflow = document.getElementById('content').scrollWidth - document.getElementById('content').clientWidth;

    // --- формулы реально размерены и используют KaTeX-шрифты ---
    const blocks = [...document.querySelectorAll('#content .mdv-math-block')];
    out.blockCount = blocks.length;
    out.blocksWithWidth = blocks.filter(b => b.getBoundingClientRect().width > 20 && b.getBoundingClientRect().height > 10).length;
    const kf = blocks[1] && blocks[1].querySelector('.katex');
    out.katexUsesKatexFont = !!(kf && getComputedStyle(kf).fontFamily.indexOf('KaTeX') !== -1);
    // ширина блочной формулы = ширина контейнера (выровнена по центру)
    out.displayCentered = blocks.length ? Math.abs((blocks[0].getBoundingClientRect().left + blocks[0].getBoundingClientRect().width/2) - (cont.left + cont.width/2)) < 6 : null;

    // --- оглавление: scroll-spy ---
    const c = document.getElementById('content');
    out.diag = { scrollH: c.scrollHeight, clientH: c.clientHeight, before: c.scrollTop,
                 behavior: getComputedStyle(c).scrollBehavior,
                 firstHeadOffset: document.querySelector('#content h2') ? document.querySelector('#content h2').offsetTop : null,
                 spyHeads: spyHeads.length,
                 winOuter: [window.outerWidth, window.outerHeight],
                 winInner: [window.innerWidth, window.innerHeight],
                 rects: ['#app','.tabbar','.topbar','.workspace','.sidebar','.main','#content','.statusbar','.welcome']
                   .map(sel => { const e = document.querySelector(sel); const b = e && e.getBoundingClientRect();
                     return sel + '=' + (e ? (b ? Math.round(b.width) + 'x' + Math.round(b.height) + (e.hidden ? ' HIDDEN' : '') : '?') : 'нет'); }) };
    out.tocActive = document.querySelectorAll('#paneToc .toc-item.active').length;
    c.style.scrollBehavior = 'auto';           // иначе smooth-анимация мешает замеру
    c.scrollTop = Math.round(c.scrollHeight * 0.55);
    await new Promise(x => setTimeout(x, 400));
    out.afterScrollTop = c.scrollTop;
    out.tocActiveAfterScroll = document.querySelectorAll('#paneToc .toc-item.active').length;
    out.activeText = (document.querySelector('#paneToc .toc-item.active') || {}).textContent || null;
    out.toTopVisible = !document.getElementById('toTop').hidden;
c.scrollTop = 0;
    await new Promise(x => setTimeout(x, 300));
    c.style.scrollBehavior = '';

    // --- дерево папок + фильтр ---
    const g = await mdv.listMd(ROOT);
    roots.push({ path: g.root, name: path.basename(ROOT), tree: g.tree, total: g.total });
    renderTree();
    await new Promise(x => setTimeout(x, 200));
    out.treeRows = document.querySelectorAll('#paneFiles .tree-item').length;
    document.getElementById('treeFilter').value = 'rgr';
    renderTree();
    await new Promise(x => setTimeout(x, 200));
    out.treeRowsFiltered = document.querySelectorAll('#paneFiles .tree-item').length;
    document.getElementById('treeFilter').value = '';
    renderTree();

    // --- клик по формуле показывает исходник ---
    const m = document.querySelector('#content .mdv-math-block');
    if (m) { m.click(); await new Promise(x => setTimeout(x, 150)); }
    out.statusAfterMathClick = document.getElementById('statusText').textContent.slice(0, 60);
    // --- кнопки назад/вперёд ---
    out.backEnabledNow = !document.getElementById('btnBack').disabled;

    // --- экспорт автономного HTML ---
    const body = MDV.renderMd(active().raw, active().baseUrl);
    const res = await mdv.exportHtml({ title: active().name, body });
    out.exportPath = res.path;
    out.exportBytes = res.bytes;
    out.exportFonts = res.fonts;
    return out;
  })()`;

  let res;
  try { res = await win.webContents.executeJavaScript(js, true); }
  catch (e) { errors.push('js: ' + e.message); res = {}; }

  console.log('\n=== АУДИТ ===');
  console.log(JSON.stringify(res, null, 2));

  // проверяем сам файл экспорта
  if (res.exportPath && fs.existsSync(res.exportPath)) {
    const h = fs.readFileSync(res.exportPath, 'utf8');
    console.log('\n=== ЭКСПОРТ ===');
    console.log('  размер          : ' + (h.length / 1024).toFixed(0) + ' КБ');
    console.log('  data-URI шрифтов : ' + (h.match(/url\(data:font\/(woff2|woff);base64/g) || []).length);
    console.log('  внешних url(fonts: ' + (h.match(/url\(fonts\//g) || []).length + '  (должно быть 0 — иначе шрифты не автономны)');
    console.log('  классов .katex  : ' + (h.match(/class="katex/g) || []).length);
    // \frac в выводе законен: KaTeX хранит исходник в <annotation> MathML
    const ann = (h.match(/annotation encoding="application\/x-tex"/g) || []).length;
    const dataTex = (h.match(/data-tex="/g) || []).length;
    const stripped = h.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, '').replace(/ data-tex="[^"]*"/g, '');
    const strayFrac = (stripped.match(/\\frac/g) || []).length;
    console.log('  data-tex          : ' + dataTex + '  (наш исходник для клика по формуле)');
    console.log('  \\frac вне них     : ' + strayFrac + '  (должно быть 0)');
    console.log('  MathML annotation: ' + ann + '  (исходник TeX, доступен при копировании)');
    console.log('  \\frac вне annotation: ' + strayFrac + '  (должно быть 0)');
    console.log('  содержит <script: ' + (h.includes('<script') ? 'да (не надо)' : 'нет'));
  }

  console.log('\nошибок консоли: ' + (errors.length ? errors.join(' | ') : 'нет'));
  app.exit(0);
});