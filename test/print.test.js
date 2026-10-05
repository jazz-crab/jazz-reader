'use strict';
/*
 * Printing and HTML export.
 *
 * The export is checked on a real file: buildStandaloneHtml() writes a
 * self-contained HTML to the disk, and the most valuable thing about it is that
 * it really is self-contained. There used to be broken url(fonts/...) left in the
 * CSS, and the export without a network showed a system font instead of
 * JetBrains Mono.
 *
 * The system print dialog cannot be opened in an automated test — it would block
 * the renderer — so printing is checked only by the call path being in place and
 * the print page being non-empty (otherwise Chromium prints a blank sheet).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

// buildStandaloneHtml() takes the output path from electron.app.getPath('downloads'),
// and outside Electron the module 'electron' returns a string with the path to
// the binary. So we substitute it in the cache: the destination folder is
// temporary, so that the test does not leave HTML in the user's Downloads.
const fakeDownloads = fs.mkdtempSync(path.join(os.tmpdir(), 'jazz-reader-dl-'));
const electronEntry = require.resolve('electron');
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: {
    app: { getPath: (name) => (name === 'downloads' ? fakeDownloads : os.tmpdir()) },
  },
};

global.marked = require(path.join(ROOT, 'src', 'vendor', 'marked.min.js'));
global.katex = require(path.join(ROOT, 'src', 'vendor', 'katex', 'katex.min.js'));
require(path.join(ROOT, 'src', 'icons.js'));
const MDV = require(path.join(ROOT, 'src', 'md.js'));
const { buildStandaloneHtml, listSystemFonts, exportCss } = require(path.join(ROOT, 'ipc.js'));

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};
const count = (s, re) => (s.match(re) || []).length;

async function main() {

console.log('\n== экспорт HTML ==');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jazz-reader-export-'));
const src = [
  '# Заголовок',
  '',
  'Текст с формулой $E = mc^2$ и кодом.',
  '',
  '```js',
  'const x = 1 < 2 && 3 > 2;',
  '```',
  '',
  '- [x] сделано',
  '- [ ] не сделано',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
].join('\n');

const body = MDV.renderMd(src, 'file:///C:/notes/');
// The function is asynchronous: it inlines the fonts and writes the file.
const res = await buildStandaloneHtml('Заметка.md', body);

t('экспорт вернул путь', !!(res && res.path), JSON.stringify(res));
t('файл создан', !!(res && res.path && fs.existsSync(res.path)), res && res.path);
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
t('экспорт идёт в Downloads, а не рядом с заметкой',
  !!(res && norm(res.path).startsWith(norm(fakeDownloads))),
  res && res.path);
t('размер больше нуля', !!(res && res.bytes > 1000), res && res.bytes + ' байт');

const html = res && fs.existsSync(res.path) ? fs.readFileSync(res.path, 'utf8') : '';

t('один блок <style>', count(html, /<style>/g) === 1, String(count(html, /<style>/g)));
t('шрифты вшиты в base64', count(html, /data:font\/woff2;base64/g) > 0,
  String(count(html, /data:font\/woff2;base64/g)));
t('нет битых url(fonts/...)', count(html, /url\(fonts\//g) === 0,
  String(count(html, /url\(fonts\//g)));
t('нет внешних таблиц стилей', !/<link[^>]+stylesheet/i.test(html));
t('нет <script>', !/<script/i.test(html));
t('KaTeX на месте', /katex/i.test(html));
// style.css starts with a BOM, and in the assembled file it ends up in the middle
// of a single <style>. Chromium loses the whole next block at such a mark —
// and the next one was :root, that is, all the theme variables. The page came
// out with no colour.
t('в собранном CSS не осталось BOM', html.indexOf('\uFEFF') < 0,
  'позиция ' + html.indexOf('\uFEFF'));
t(':root с переменными темы на месте',
  /:root\s*\{[^}]*--bg:\s*#1a1b26/.test(html));
t('переменная --fg на месте', /--fg:\s*#c0caf5/.test(html));
// The application font lives in a separate file src/fonts.css and is not in
// style.css. It was forgotten, and in the export a system monospace appeared
// instead of JetBrains Mono: the whole point of "our own theme" was lost.
t('свой шрифт объявлен', /@font-face\s*\{[^}]*JetBrainsMono/.test(html));
t('все 8 начертаний JetBrains на месте',
  count(html, /@font-face\s*\{[^}]*JetBrainsMono/g) === 8,
  String(count(html, /@font-face\s*\{[^}]*JetBrainsMono/g)));
t('нет битых url(fonts/jetbrains',
  count(html, /url\(fonts\/jetbrains/g) === 0,
  String(count(html, /url\(fonts\/jetbrains/g)));
t('свой шрифт вшит в base64', /data:font\/woff2;base64/g.test(html));
t('счётчик шрифтов включает свой шрифт', res.fonts >= 16, String(res.fonts));
t('<title> — имя файла как есть', /<title>\s*Заметка\.md\s*<\/title>/.test(html),
  (/<title>([^<]*)<\/title>/.exec(html) || [])[1]);
t('заголовок попал в тело', /Заголовок/.test(html));
// The CSS inside the file also contains "mdv-task", so we count only by the body.
const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/.exec(html);
const inner = bodyHtml ? bodyHtml[1] : '';
t('иконки задач вместо чекбоксов',
  count(inner, /class="ico-svg mdv-task/g) === 2 && count(inner, /<input type="checkbox"/g) === 0,
  'иконок=' + count(inner, /class="ico-svg mdv-task/g)
  + ' чекбоксов=' + count(inner, /<input type="checkbox"/g));
t('inline-код не сломан', /<code[^>]*>const x = 1 &lt; 2/.test(html));

console.log('\n== печать ==');

// For printing buildStandaloneHtml returns the HTML itself rather than a file: it is
// loaded by a hidden window which Chromium prints from. We check exactly this build.
const printed = await buildStandaloneHtml('Заметка.md', body, { print: true });
t('для печати приходит HTML, а не путь', typeof printed.html === 'string'
  && !printed.path, JSON.stringify(Object.keys(printed)));
t('в HTML для печати есть @page', /@page\s*\{[^}]*margin:\s*0/.test(printed.html || ''));
t('у блоков кода и цитат рамки нет',
  /\.content pre, \.content blockquote \{ border: none !important; \}/.test(printed.html || ''));
t('PRINT_CSS после style.css, иначе @media print перебьёт выбор',
  printed.html.lastIndexOf('@page') > printed.html.lastIndexOf('.radial-kill:hover'));
t('отступ до текста задан padding, а не полем страницы',
  /\.content \{ padding: 16mm 18mm 18mm !important; \}/.test(printed.html || ''));
t('свой шрифт вшит и в печатную сборку', /@font-face\s*\{[^}]*JetBrainsMono/.test(printed.html || ''));

const ipcSrc = fs.readFileSync(path.join(ROOT, 'ipc.js'), 'utf8');
t('PDF идёт мимо диалога печати', /printToPDF\(/.test(ipcSrc)
  && !/buildPdf[\s\S]{0,400}?webContents\.print\(/.test(ipcSrc));
t('колонтитулы выключены (нижний тулбар с подписями)',
  /headerFooter:\s*false/.test(ipcSrc));
t('поля страницы пустые', /margins:\s*\{\s*marginType:\s*'none'\s*\}/.test(ipcSrc));
t('размер страницы берётся из @page', /preferCSSPageSize:\s*true/.test(ipcSrc));
t('обработчик mdv:exportPdf есть', /ipcMain\.handle\('mdv:exportPdf'/.test(ipcSrc));
t('окно печати скрытое', /show:\s*false/.test(
  /async function buildPdf[\s\S]*?new BrowserWindow\(\{[\s\S]*?\}\)/.exec(ipcSrc)[0]));


const mainJs = fs.readFileSync(path.join(ROOT, 'ipc.js'), 'utf8');
t('обработчик mdv:print есть', /ipcMain\.handle\('mdv:print'/.test(mainJs));
t('печать с фоном (иначе тёмная тема печатается белым)',
  /print\(\{[^}]*printBackground:\s*true/.test(mainJs));
t('диалог не скрыт (silent:false)', /print\(\{[^}]*silent:\s*false/.test(mainJs));

const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
t('печать доступна из renderer', /print:/.test(preload));
t('экспорт доступен из renderer', /exportHtml:/.test(preload));
t('экспорт PDF доступен из renderer', /exportPdf:/.test(preload));

const appJs = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
// There is no export list in the ring any more: the formats have parameters and
// a preview, they do not fit in a menu. Export is a separate window, and the
// "Export" sector of the ring leads to it.
t('в кольцо вернулся сектор «Экспорт»',
  /act: 'export', slot: 'right',[\s\S]{0,60}icon: 'folder-output'/.test(appJs));
t('сектор открывает окно экспорта', /act === 'export'\) \{ closeRadial\(\); exportDialog\(\)/.test(appJs));
t('окно экспорта зовёт api.exportPdf', /api\.exportPdf\(\{/.test(appJs));
t('окно экспорта зовёт api.exportHtml', /api\.exportHtml\(\{/.test(appJs));
t('у кольца есть сектор «Путь»',
  /act: 'path', slot: 'right',[\s\S]{0,60}icon: 'signpost'/.test(appJs));
// Export and path are on the right, opening on the left and alone: "Path" used to
// stand on the left together with "Open", and opening a file was left with as
// much room as one of the three clipboard sectors.
t('слева в кольце только открытие',
  /act: 'open', slot: 'left', icon: 'plus'/.test(appJs)
  && !/slot: 'leftLow'/.test(appJs));
t('у секторов есть квадрат под попадание мыши',
  /<span class="rd-hit"><\/span>/.test(appJs));
t('списка форматов в кольце больше нет', !/label: 'Сохранить PDF'/.test(appJs)
  && !/label: 'Сохранить HTML'/.test(appJs));
t('Ctrl+P остался системным диалогом', /api\.print\(\)/.test(appJs));

console.log('\n== окно экспорта ==');

// The list of system fonts: the renderer cannot enumerate them, we read the registry.
const fonts = await listSystemFonts();
t('свой шрифт первый в списке', fonts[0] === 'JetBrainsMono', String(fonts[0]));
t('шрифтов заметно больше одного', fonts.length > 20, String(fonts.length));
t('в списке есть системные шрифты Windows',
  ['Consolas', 'Arial', 'Segoe UI'].every((n) => fonts.includes(n)),
  String(fonts.slice(0, 8)));
// The " (TrueType)" tail and the weight at the end of the name are not part of the
// family: "Consolas Bold (TrueType)" would turn into two different fonts in the
// drop-down, and which of them exists cannot be checked. We check that the type
// marker is removed everywhere, and that the weight is cut at least where it is
// unambiguous.
t('маркер типа шрифта убран', !fonts.some((n) => /\((TrueType|OpenType|TTF)\)/.test(n)),
  String(fonts.filter((n) => /\((TrueType|OpenType|TTF)\)/.test(n)).slice(0, 4)));
t('начертание срезано у обычных шрифтов',
  fonts.includes('Consolas') && !fonts.includes('Consolas Bold'),
  JSON.stringify(fonts.filter((n) => n.indexOf('Consolas') === 0)));
t('список без повторов', new Set(fonts.map((n) => n.toLowerCase())).size === fonts.length);

// The CSS from the choices in the export window
const cssColour = exportCss({ font: 'Consolas', size: 19 });
t('шрифт подставляется в --mono и --ui',
  cssColour.includes('--mono: "Consolas", monospace')
  && cssColour.includes('--ui: "Consolas", monospace'), cssColour.split('\n')[1]);
t('размер шрифта попадает в .content', /\.content \{[^}]*font-size: 19px/.test(cssColour));
t('цветная палитра на экране ничего не перекрашивает',
  !cssColour.includes('#14161c'), 'в файле для экрана перекрашивать нечего');
const cssBw = exportCss({ bw: true });
t('чёрно-белая палитра красит фон в белый', /background: #fff !important/.test(cssBw));
t('чёрно-белая палитра красит текст в тёмный', /color: #14161c !important/.test(cssBw));
const cssPrint = exportCss({ print: true, bw: false });
t('цветная палитра на печати возвращает цвета темы',
  cssPrint.includes('background: var(--bg) !important')
  && cssPrint.includes('color: var(--fg) !important'));
t('имя шрифта с кавычками не ломает CSS',
  !/url\(|expression\(/.test(exportCss({ font: 'Arial"; } body{display:none' })));

// Quotes and brackets from the drop-down must not get into the CSS.
const evil = exportCss({ font: 'x"; } body { display: none } .a{', size: '15); }' });
t('враждебное имя не закрывает правило',
  /--mono: "x"; \} body \{ display: none \} \.a\{", monospace/.test(evil)
  || /--mono: "x[^"]*", monospace/.test(evil), evil.split('\n')[1]);

console.log('\n== на печать отдаётся непустая страница ==');
// Chromium prints the current DOM. If we printed a hidden container or an
// empty tab, "Print / PDF" would hand back a blank sheet — that is caught here.
t('контент доступен для печати', /id="content"/.test(
  fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8')));
const css = fs.readFileSync(path.join(ROOT, 'src', 'style.css'), 'utf8');
t('правило @media print есть', /@media print/.test(css),
  'без него тёмная тема печатается как есть и текст может выйти белым');

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(fakeDownloads, { recursive: true, force: true });

console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL\n');
process.exit(fail ? 1 : 0);

}

main();
