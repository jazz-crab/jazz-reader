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
const fakeDownloads = fs.mkdtempSync(path.join(os.tmpdir(), 'mdview-dl-'));
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
const { buildStandaloneHtml } = require(path.join(ROOT, 'ipc.js'));

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};
const count = (s, re) => (s.match(re) || []).length;

async function main() {

console.log('\n== экспорт HTML ==');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdview-export-'));
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
// Пункта печати в разметке тулбара нет: экспорт живёт в круговом меню
// заметки. В списке экспорта — «Сохранить PDF», он собирает файл сам, без
// системного диалога. А Ctrl+P (api.print) остался: иногда нужен именно
// диалог, чтобы печатать на принтере.
t('в меню экспорта есть «Сохранить PDF»',
  /label: 'Сохранить PDF', icon: 'printer'/.test(appJs));
t('пункт вызывает downloadPdf', /act: \(\) => downloadPdf\(\)/.test(appJs));
t('downloadPdf зовёт api.exportPdf', /api\.exportPdf\(\{/.test(appJs));
t('Ctrl+P остался системным диалогом', /api\.print\(\)/.test(appJs));

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
