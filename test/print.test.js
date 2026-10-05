'use strict';
/*
 * Печать и экспорт HTML.
 *
 * Экспорт проверяем на настоящем файле: buildStandaloneHtml() пишет автономный
 * HTML на диск, и самое ценное здесь — что он реально автономный. Раньше в
 * CSS оставались битые url(fonts/...) и экспорт без интернета показывал
 * системный шрифт вместо JetBrains Mono.
 *
 * Системный диалог печати в автотесте открывать нельзя — он заблокирует
 * renderer, поэтому печать проверяем только по тому, что путь вызова на месте
 * и страница для печати непустая (иначе Chromium печатает пустоту).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

// buildStandaloneHtml() берёт путь вывода из electron.app.getPath('downloads'),
// а вне Electron модуль 'electron' отдаёт строку с путём к бинарнику. Поэтому
// подменяем его в кэше: папка назначения — временная, чтобы тест не оставлял
// HTML в Загрузках пользователя.
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
// Функция асинхронная: она встраивает шрифты и пишет файл.
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
// style.css начинается с BOM, и в собранном файле он оказывается посередине
// одного <style>. Chromium на таком знаке теряет следующий блок целиком —
// а следующим шёл :root, то есть все переменные темы. Страница собиралась
// без цвета.
t('в собранном CSS не осталось BOM', html.indexOf('\uFEFF') < 0,
  'позиция ' + html.indexOf('\uFEFF'));
t(':root с переменными темы на месте',
  /:root\s*\{[^}]*--bg:\s*#1a1b26/.test(html));
t('переменная --fg на месте', /--fg:\s*#c0caf5/.test(html));
// Шрифт приложения лежит отдельным файлом src/fonts.css и в style.css его
// нет. Про него забыли, и в экспорте вместо JetBrains Mono была системная
// моноширинная: весь смысл «своей темы» терялся.
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
// CSS внутри файла тоже содержит «mdv-task», поэтому считаем только по телу.
const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/.exec(html);
const inner = bodyHtml ? bodyHtml[1] : '';
t('иконки задач вместо чекбоксов',
  count(inner, /class="ico-svg mdv-task/g) === 2 && count(inner, /<input type="checkbox"/g) === 0,
  'иконок=' + count(inner, /class="ico-svg mdv-task/g)
  + ' чекбоксов=' + count(inner, /<input type="checkbox"/g));
t('inline-код не сломан', /<code[^>]*>const x = 1 &lt; 2/.test(html));

console.log('\n== печать ==');

// Для печати buildStandaloneHtml отдаёт сам HTML, а не файл: его грузит
// скрытое окно, из которого Chromium печатает. Проверяем именно эту сборку.
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
// Списка экспорта в кольце больше нет: у форматов есть параметры и
// предпросмотр, они не помещаются в меню. Экспорт — отдельное окно, а из
// кольца в него ведёт сектор «Экспорт».
t('в кольцо вернулся сектор «Экспорт»',
  /act: 'export', slot: 'right',[\s\S]{0,60}icon: 'folder-output'/.test(appJs));
t('сектор открывает окно экспорта', /act === 'export'\) \{ closeRadial\(\); exportDialog\(\)/.test(appJs));
t('окно экспорта зовёт api.exportPdf', /api\.exportPdf\(\{/.test(appJs));
t('окно экспорта зовёт api.exportHtml', /api\.exportHtml\(\{/.test(appJs));
t('у кольца есть сектор «Путь»',
  /act: 'path', slot: 'right',[\s\S]{0,60}icon: 'signpost'/.test(appJs));
// Экспорт и путь — справа, открытие — слева и одно: раньше «Путь» стоял
// слева вместе с «Открыть», и на открытие файла оставалось столько же места,
// сколько на один из трёх секторов буфера обмена.
t('слева в кольце только открытие',
  /act: 'open', slot: 'left', icon: 'plus'/.test(appJs)
  && !/slot: 'leftLow'/.test(appJs));
t('у секторов есть квадрат под попадание мыши',
  /<span class="rd-hit"><\/span>/.test(appJs));
t('списка форматов в кольце больше нет', !/label: 'Сохранить PDF'/.test(appJs)
  && !/label: 'Сохранить HTML'/.test(appJs));
t('Ctrl+P остался системным диалогом', /api\.print\(\)/.test(appJs));

console.log('\n== окно экспорта ==');

// Список системных шрифтов: renderer их не перечислит, читаем реестр.
const fonts = await listSystemFonts();
t('свой шрифт первый в списке', fonts[0] === 'JetBrainsMono', String(fonts[0]));
t('шрифтов заметно больше одного', fonts.length > 20, String(fonts.length));
t('в списке есть системные шрифты Windows',
  ['Consolas', 'Arial', 'Segoe UI'].every((n) => fonts.includes(n)),
  String(fonts.slice(0, 8)));
// Хвост « (TrueType)» и начертание в конце имени — это не часть семейства:
// «Consolas Bold (TrueType)» в списке выбора превратилось бы в два разных
// шрифта, и какой из них есть, не проверить. Проверяем, что маркер типа убран
// везде, а начертание срезано хотя бы там, где это однозначно.
t('маркер типа шрифта убран', !fonts.some((n) => /\((TrueType|OpenType|TTF)\)/.test(n)),
  String(fonts.filter((n) => /\((TrueType|OpenType|TTF)\)/.test(n)).slice(0, 4)));
t('начертание срезано у обычных шрифтов',
  fonts.includes('Consolas') && !fonts.includes('Consolas Bold'),
  JSON.stringify(fonts.filter((n) => n.indexOf('Consolas') === 0)));
t('список без повторов', new Set(fonts.map((n) => n.toLowerCase())).size === fonts.length);

// CSS от выбора в окне экспорта
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

// Кавычки и скобки из выпадающего списка не должны попасть в CSS.
const evil = exportCss({ font: 'x"; } body { display: none } .a{', size: '15); }' });
t('враждебное имя не закрывает правило',
  /--mono: "x"; \} body \{ display: none \} \.a\{", monospace/.test(evil)
  || /--mono: "x[^"]*", monospace/.test(evil), evil.split('\n')[1]);

console.log('\n== на печать отдаётся непустая страница ==');
// Chromium печатает текущий DOM. Если бы мы печатали скрытый контейнер или
// пустую вкладку, «Печать / PDF» отдала бы пустоту — это ловится здесь.
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
